import * as path from "path"
import { FileFriendStore, isLocalMachineOwnerIdentity, machineOwnerUsername, type FriendRecord } from "@ouro.bot/friends"
import { normalizeMailAddress, type MailroomRegistry } from "../../mailroom/core"
import { readMailroomRegistry, resolveMailroomReaderWithRefresh, type MailroomReaderResolution } from "../../mailroom/reader"
import { confirmMailDraftSend, createMailDraft, resolveOutboundTransport } from "../../mailroom/outbound"
import { emitNervesEvent } from "../../nerves/runtime"
import type { OwnerAlertMessage, OwnerAlertRoute, OwnerAlertSend } from "./owner-channel-outage"

/**
 * The daemon's routes for an owner-channel outage alert (`owner-channel-outage.ts`). The daemon serves many agents, so
 * every route here names its agent explicitly; routes that read the process's own agent (the BlueBubbles and Teams
 * proactive senders) are not offered from the daemon.
 *
 * - Telegram: the Telegram sense's owner notice, the path sync uses.
 * - Mail: from the agent's native mailbox to the owner's address. The address is the owner's own `email-address` id on
 *   their friend record (the family friend linked to this machine's user, as the Shepherd owner notice finds them),
 *   else the owner of the agent's enabled delegated mail source in its mailroom registry. The text is the harness's,
 *   never a model's, and goes only to the owner, so it is sent as a system send recorded in the outbox; the mail
 *   autonomy policy's kill switch still stops it.
 */

export interface OwnerAlertRouteDeps {
  listFriends?: (agentRoot: string) => Promise<FriendRecord[]>
  ownerUsername?: () => string | null
  resolveMailroom?: (agent: string) => Promise<MailroomReaderResolution>
  readRegistry?: (config: Extract<MailroomReaderResolution, { ok: true }>["config"]) => Promise<MailroomRegistry>
  createDraft?: typeof createMailDraft
  confirmSend?: typeof confirmMailDraftSend
  resolveTransport?: typeof resolveOutboundTransport
  providerClient?: (agent: string, transport: ReturnType<typeof resolveOutboundTransport>) => Promise<Parameters<typeof confirmMailDraftSend>[0]["providerClient"]>
  sendTelegram?: (agent: string, input: { noticeId: string; text: string; signal?: AbortSignal; nowOrNever?: boolean }) => Promise<"sent" | "not_sent">
}

const SEND_TIMEOUT_MS = 30_000

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* v8 ignore start -- the live defaults; tests inject each one @preserve */
const defaults = {
  listFriends: (agentRoot: string) => new FileFriendStore(path.join(agentRoot, "friends")).listAll(),
  ownerUsername: machineOwnerUsername,
  resolveMailroom: resolveMailroomReaderWithRefresh,
  readRegistry: readMailroomRegistry,
  createDraft: createMailDraft,
  confirmSend: confirmMailDraftSend,
  resolveTransport: resolveOutboundTransport,
  providerClient: async (agent: string, transport: ReturnType<typeof resolveOutboundTransport>) => (await import("../../repertoire/tools-mail")).outboundProviderClientForTransport(agent, transport),
  sendTelegram: async (agent: string, input: { noticeId: string; text: string; signal?: AbortSignal }) => (await import("../../senses/telegram")).sendTelegramOwnerNotice(agent, input),
}
/* v8 ignore stop */

function withDefaults(deps: OwnerAlertRouteDeps): Required<OwnerAlertRouteDeps> {
  return { ...defaults, ...deps }
}

function idsOf(friend: FriendRecord): FriendRecord["externalIds"] {
  return Array.isArray(friend.externalIds) ? friend.externalIds : []
}

function emailIds(friend: FriendRecord): string[] {
  return idsOf(friend)
    .filter((entry) => entry?.provider === "email-address" && typeof entry.externalId === "string" && entry.externalId.includes("@"))
    .map((entry) => normalizeMailAddress(entry.externalId))
}

/** The owner's mail address, or null when the agent's records name none. */
export async function resolveOwnerAlertAddress(
  agentRoot: string,
  config: Extract<MailroomReaderResolution, { ok: true }>["config"],
  deps: OwnerAlertRouteDeps = {},
): Promise<string | null> {
  const d = withDefaults(deps)
  const username = d.ownerUsername()
  let friends: FriendRecord[] = []
  try {
    friends = await d.listFriends(agentRoot)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.owner_alert_friends_unreadable", message: "could not read friends to find the owner's mail address", meta: { agentRoot, error: errorText(error) } })
  }
  const owners = friends.filter((friend) => friend.trustLevel === "family" && idsOf(friend)
    .some((entry) => typeof entry?.provider === "string" && typeof entry.externalId === "string" && isLocalMachineOwnerIdentity(entry.provider, entry.externalId, username)))
  const fromFriend = owners.flatMap(emailIds).sort()[0]
  if (fromFriend) return fromFriend
  try {
    const registry = await d.readRegistry(config)
    const grants = (registry.sourceGrants ?? []).filter((grant) => grant.enabled && grant.ownerEmail?.includes("@"))
    const fromGrant = grants.map((grant) => normalizeMailAddress(grant.ownerEmail)).sort()[0]
    if (fromGrant) return fromGrant
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "daemon.owner_alert_registry_unreadable", message: "could not read the mailroom registry to find the owner's mail address", meta: { agentRoot, error: errorText(error) } })
  }
  return null
}

export function createOwnerAlertMailSender(agent: string, agentRoot: string, deps: OwnerAlertRouteDeps = {}): OwnerAlertSend {
  const d = withDefaults(deps)
  return async (message: OwnerAlertMessage) => {
    const resolved = await d.resolveMailroom(agent)
    if (!resolved.ok) throw new Error(`mail is not available: ${resolved.error}`)
    if (resolved.config.autonomousSendPolicy?.killSwitch) throw new Error("the mail autonomy kill switch is on")
    const to = await resolveOwnerAlertAddress(agentRoot, resolved.config, deps)
    if (!to) throw new Error("no owner mail address: link the owner's email-address id on their friend record")
    // Transport and provider first, so a send that can't go out leaves no draft behind.
    const transport = d.resolveTransport(resolved.config)
    const providerClient = await d.providerClient(agent, transport)
    const reason = `harness owner-channel outage notice ${message.noticeId}`
    const actor = { kind: "system" as const, agentId: agent }
    const draft = await d.createDraft({
      store: resolved.store,
      agentId: resolved.agentName,
      from: resolved.config.mailboxAddress,
      to: [to],
      subject: message.subject,
      text: message.text,
      actor,
      reason,
    })
    await d.confirmSend({
      store: resolved.store,
      agentId: resolved.agentName,
      draftId: draft.id,
      transport,
      confirmation: "CONFIRM_SEND",
      autonomous: false,
      autonomyPolicy: resolved.config.autonomousSendPolicy,
      providerClient,
      actor,
      reason,
    })
    emitNervesEvent({ component: "daemon", event: "daemon.owner_alert_mail_sent", message: "mailed the owner a harness notice", meta: { agent, noticeId: message.noticeId, draftId: draft.id } })
  }
}

export function createOwnerAlertTelegramSender(agent: string, deps: OwnerAlertRouteDeps = {}): OwnerAlertSend {
  const d = withDefaults(deps)
  return async (message: OwnerAlertMessage) => {
    const outcome = await d.sendTelegram(agent, { noticeId: message.noticeId, text: message.text, signal: AbortSignal.timeout(SEND_TIMEOUT_MS), nowOrNever: true })
    // Quiet hours, a handoff, or an owner route (which may relay over the channel that is down): dropped, not held, so the
    // owner never gets a stale copy later; the next route carries it.
    if (outcome !== "sent") throw new Error("Telegram couldn't send the notice to the owner's chat now")
  }
}

/** Every route the daemon can send an agent's outage alert on; the watcher uses only those whose sense is healthy. */
export function ownerAlertRoutes(agent: string, agentRoot: string, deps: OwnerAlertRouteDeps = {}): Partial<Record<OwnerAlertRoute, OwnerAlertSend>> {
  return {
    telegram: createOwnerAlertTelegramSender(agent, deps),
    mail: createOwnerAlertMailSender(agent, agentRoot, deps),
  }
}
