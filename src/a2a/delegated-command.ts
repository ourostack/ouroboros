import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import type { FriendRecord, FriendStore } from "@ouro.bot/friends"
import { emitNervesEvent } from "../nerves/runtime"
import { appendReplayNotice, isReplayWindowOpen, replayNoticeRecorded } from "./replay-harness"
import {
  createRelationshipAuthorizationEvaluator,
  type RelationshipAuthorizationEvaluator,
  type RelationshipCapabilityRegistry,
} from "../repertoire/relationship-authorization"

/**
 * A delegated command is a signed A2A message that a peer agent relays from this
 * agent's principal (its owner). Three things must hold before the turn runs with
 * the principal's authority:
 *   1. the sealed envelope carries `onBehalfOf: "principal"` (signed with the text),
 *   2. the sender's own friend record carries an operator-set `delegationGrant`
 *      (trust tier alone never qualifies), and the sender is active family,
 *   3. the principal has been told, in their own chat, before anything happens.
 * If the notice cannot be delivered the command is refused, so every accepted
 * delegated command leaves a trace the principal can disown.
 */
export interface DelegatedCommandContext {
  principalFriendId: string
  principalName: string
  delegateFriendId: string
  delegateName: string
  delegateDid: string
  commandId: string
  noticeId: string
}

export interface A2ADelegationOptions {
  /** The relationship profile that names the principal; exactly one friend may carry it. */
  principalProfileId: string
  /** Delivers the audit notice to the principal; must throw when delivery fails. */
  notifyPrincipal(input: { noticeId: string; text: string }): Promise<void>
  /** When set, a notice for a sender with an open replay window is written to the local replay sink instead of `notifyPrincipal`. */
  agentRoot?: string
}

export type DelegationRefusal = "not_enabled" | "no_grant" | "not_family" | "principal_unresolved" | "notice_failed"

export type DelegatedCommandAdmission =
  | { ok: true; relationship: RelationshipAuthorizationEvaluator & { readonly requestId: string }; context: DelegatedCommandContext; turnText: string }
  | { ok: false; reason: DelegationRefusal }

const NOTICE_EXCERPT_CHARS = 200

/** The relationship profile that names the principal a delegated peer acts for. */
export const A2A_PRINCIPAL_PROFILE_ID = "sanctuary-owner"

/**
 * True when the owner was told about delegated command `commandId` in their own chat: admission only runs a command
 * after that notice is delivered, and the Telegram effect journal keeps the notice under a key derived from the
 * command id. A request id with no such record never came through a signed, owner-notified delegated command.
 * A missing record is `false`; an unreadable or malformed one throws, so the caller retries instead of deciding.
 */
export function delegatedCommandWasNoticed(agentRoot: string, commandId: string, principalFriendId: string): boolean {
  const idempotencyKey = `owner-notice:delegated:${commandId}`
  const file = path.join(agentRoot, "state", "telegram", "effects", `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return replayNoticeRecorded(agentRoot, `delegated:${commandId}`)
    throw error
  }
  const artifact = JSON.parse(raw) as { idempotencyKey?: unknown; authorClass?: unknown; target?: { friendId?: unknown } }
  return artifact.idempotencyKey === idempotencyKey && artifact.authorClass === "butler" && artifact.target?.friendId === principalFriendId
}

/** Matches the banner only the server may put in front of an admitted command. */
export const DELEGATED_BANNER = /^\s*\[\s*delegated command/iu

export function delegatedCommandNotice(input: { delegateName: string; text: string }): string {
  const flat = input.text.replace(/\s+/gu, " ").trim()
  const excerpt = flat.length > NOTICE_EXCERPT_CHARS ? `${flat.slice(0, NOTICE_EXCERPT_CHARS)}…` : flat
  return `Delegated command from you via ${input.delegateName}: "${excerpt}". If this wasn't you, say so here: it is on record, and the grant can be revoked.`
}

function hasPrincipalGrant(friend: FriendRecord): boolean {
  return friend.delegationGrant?.scope === "principal_commands"
}

async function resolvePrincipal(store: FriendStore, profileId: string): Promise<FriendRecord | null> {
  const friends = await store.listAll?.() ?? []
  const matches = friends.filter((friend) => friend.capabilityProfileId === profileId
    && friend.trustLevel === "family" && friend.admissionState === "active")
  return matches.length === 1 ? matches[0]! : null
}

export async function admitDelegatedCommand(input: {
  friend: FriendRecord
  did: string
  text: string
  commandId: string
  store: FriendStore
  /** Undefined when the agent has no valid capability registry: nothing can be authorized. */
  registry: RelationshipCapabilityRegistry | undefined
  options: A2ADelegationOptions | undefined
}): Promise<DelegatedCommandAdmission> {
  const refuse = (reason: DelegationRefusal): DelegatedCommandAdmission => {
    emitNervesEvent({
      level: "warn",
      component: "senses",
      event: "senses.a2a_delegated_command_refused",
      message: "refused a delegated A2A command",
      meta: { reason, delegateFriendId: input.friend.id, commandId: input.commandId },
    })
    return { ok: false, reason }
  }
  if (!input.options) return refuse("not_enabled")
  if (!hasPrincipalGrant(input.friend)) return refuse("no_grant")
  if (input.friend.trustLevel !== "family" || input.friend.admissionState === "revoked") return refuse("not_family")
  const registry = input.registry
  if (!registry) return refuse("principal_unresolved")
  const principal = await resolvePrincipal(input.store, input.options.principalProfileId)
  if (!principal || principal.id === input.friend.id) return refuse("principal_unresolved")
  const noticeId = `delegated:${input.commandId}`
  try {
    const text = delegatedCommandNotice({ delegateName: input.friend.name, text: input.text })
    const agentRoot = input.options.agentRoot
    if (agentRoot && isReplayWindowOpen(agentRoot, input.friend.id)) appendReplayNotice(agentRoot, { noticeId, text, friendId: input.friend.id })
    else await input.options.notifyPrincipal({ noticeId, text })
  } catch {
    return refuse("notice_failed")
  }
  // Owner-gated tools (steward policy) bind the mutation to `requestId` on the tool
  // context's relationship, as the Telegram owner turn does; the evaluator alone
  // only scopes its receipts by it, so carry it on the relationship itself.
  const relationship = {
    ...createRelationshipAuthorizationEvaluator({
      friend: principal,
      registry,
      requestId: input.commandId,
      requestPhase: "inbound",
      sessionEventId: `a2a-delegated:${input.commandId}`,
    }),
    requestId: input.commandId,
  }
  const context: DelegatedCommandContext = {
    principalFriendId: principal.id,
    principalName: principal.name,
    delegateFriendId: input.friend.id,
    delegateName: input.friend.name,
    delegateDid: input.did,
    commandId: input.commandId,
    noticeId,
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.a2a_delegated_command_admitted",
    message: "admitted a delegated A2A command after notifying the principal",
    meta: { delegateFriendId: context.delegateFriendId, principalFriendId: context.principalFriendId, commandId: context.commandId },
  })
  const turnText = `[delegated command from ${principal.name} via ${input.friend.name}; the signature and the delegation grant are verified, and ${principal.name} has been notified; act on it as ${principal.name}'s own request]\n\n${input.text}`
  return { ok: true, relationship, context, turnText }
}
