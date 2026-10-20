import * as path from "node:path"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { resolveAlertKey } from "../../heart/awaiting/await-alert"
import { getTeamsConfig, getTeamsSecondaryConfig, type TeamsConfig } from "../../heart/config"
import type { ShepherdNoticePolicy } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { TeamsBotApi } from "../teams"
import type { HostSession } from "./host"
import type { ReturnRecord, ShepherdActionBlockReason } from "./returns"
import { claimPendingNotices, declareNoticeTargets, enqueueNotice, noticeDeliveryState, readNoticeOutbox, recordNoticeDelivery } from "./notice-outbox"

/**
 * The owner notice: after a judged return, the agent's owner hears what happened in one short plain message on their
 * own channel. It is deterministic, written here and sent with no model turn, so the owner hears about every return the
 * policy covers whether or not the Ouro agent decides it matters. Returns that arrive close together share one message.
 */
export const NOTICE_COALESCE_MS = 5_000
/** Distinct sessions named in a digest; the remaining sessions are counted. */
export const NOTICE_LIST_MAX = 6
export const NOTICE_RETRY_MS = 30_000
const NAME_MAX = 60
const REASON_MAX = 300
const REPLY_MAX = 240
const BLOCK_DESCRIPTION: Record<ShepherdActionBlockReason, string> = {
  reply_invalid: "the suggested reply was invalid",
  menu_disallowed: "scheduled continuation cannot approve a menu",
  host_unverified: "the host could not verify safe input state",
  guidance: "operator guidance blocked input",
  loop_guard: "the reply limit was reached",
  focus: "the human owns the focused session",
  state_changed: "the target state changed",
  custody: "input delivery was already claimed or needs reconciliation",
  stopped: "Shepherd stopped",
}

/** Kinds a "needs-me" owner still hears about. */
const NEEDS_ME = new Set<ReturnRecord["kind"]>(["gate", "done", "loop_guard"])

export function noticeWanted(policy: ShepherdNoticePolicy, record: ReturnRecord): boolean {
  if (policy === "off") return false
  return policy === "every" || NEEDS_ME.has(record.kind)
}

/**
 * Untrusted terminal text as one bounded plain line: no control or invisible characters, and nothing Teams could read as
 * markup, a mention or code (`< > [ ] * ~ # | \ @` and backticks). Double quotes become single, so a quoted reply stays one quote.
 */
export function plain(value: string, max: number): string {
  const flat = value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/[<>[\]*~#|\\@`]+/g, " ")
    .replace(/"/g, "'")
    .replace(/\s+/g, " ")
    .trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

function who(record: ReturnRecord, location: string | HostSession | undefined): string {
  const session = typeof location === "object" ? location : undefined
  const agentName = record.agent ?? session?.agent
  const cwd = record.cwd ?? session?.cwd
  const agent = agentName ? plain(agentName, NAME_MAX) : ""
  const folder = cwd ? plain(path.basename(cwd), NAME_MAX) : ""
  const ref = typeof location === "string" ? location : session?.ref
  const handle = plain(ref ?? record.session.slice(0, 8), NAME_MAX)
  const labels = [record.workspaceTitle ?? session?.workspaceTitle, record.title ?? session?.title].filter((label): label is string => !!label).map((label) => plain(label, NAME_MAX))
  const where = labels.length ? `${labels.join(" / ")}; ${handle}` : handle
  return `${agent || "A coding agent"}${folder ? ` in ${folder}` : ""}${where ? ` (${where})` : ""}`
}

/** One return as one sentence pair: who returned, what Shepherd did, and why. */
export function noticeLine(record: ReturnRecord, location?: string | HostSession): string {
  const subject = who(record, location)
  const why = `Why: ${plain(record.reason, REASON_MAX) || "no reason given"}`
  switch (record.kind) {
    case "premature":
      if (record.action === "respond" && record.reply) {
        const sent = record.reply.startsWith("key:") ? `pressed ${plain(record.reply.slice(4), 10)}` : `sent it back: "${plain(record.reply, REPLY_MAX)}"`
        return `${subject} stopped early, so I ${sent}. ${why}`
      }
      if (record.actionBlockReason) return `${subject} stopped early; no input sent because ${BLOCK_DESCRIPTION[record.actionBlockReason]}. ${why}`
      return `${subject} stopped early, but I did not answer it, so it is waiting for you. ${why}`
    case "gate":
      return `${subject} needs you. ${why}`
    case "done":
      return `${subject} says it is done. ${why}`
    case "waiting":
      return `${subject} is waiting on an outside dependency; the work is not yet delivered. ${why}`
    case "loop_guard":
      return `${subject}: I stopped answering it after too many replies, so it is waiting for you. ${why}`
    case "working":
      return `${subject} is still working in the background and has news. ${why}`
    case "unclear":
      return `Shepherd could not determine the current state of ${subject}. ${why}`
    default:
      return `Shepherd could not complete its observation of ${subject}; the agent's state was not determined. ${why}`
  }
}

/** A bounded display of latest observations; all input records retain delivery custody. */
export function noticeMessage(records: ReturnRecord[], refs: ReadonlyMap<string, string | HostSession> = new Map(), context: { recovered?: boolean } = {}): string {
  const latest = new Map<string, ReturnRecord>()
  for (const record of records) {
    const key = JSON.stringify([record.host, record.session])
    const previous = latest.get(key)
    const at = Date.parse(record.at)
    const previousAt = previous ? Date.parse(previous.at) : NaN
    if (!previous || (Number.isFinite(at) && (!Number.isFinite(previousAt) || at > previousAt))
      || ((!Number.isFinite(at) && !Number.isFinite(previousAt) || at === previousAt) && record.transition > previous.transition)) latest.set(key, record)
  }
  const sessions = [...latest].sort(([a], [b]) => a < b ? -1 : 1).map(([, record]) => record)
  const lines = sessions.slice(0, NOTICE_LIST_MAX).map(record => {
    const line = noticeLine(record, refs.get(record.session))
    if (!context.recovered) return line
    const at = Date.parse(record.at)
    return `${line} (${Number.isFinite(at) ? `observed at ${new Date(at).toISOString()}` : "observation time unknown"})`
  })
  const more = sessions.length - lines.length
  const body = sessions.length === 1 ? lines[0]!
    : [`Updates from ${sessions.length} coding sessions:`, ...lines.map(line => `- ${line}`), ...(more > 0 ? [`- and ${more} more.`] : [])].join("\n")
  return context.recovered ? `Includes recovered historical observations, not live status:\n${body}` : body
}

export interface NoticeTarget {
  friendId: string
  name: string
  /** The session key the send is logged under: the friend's Teams session when there is one. */
  key: string
  tenantId?: string
}

function teamsAadId(friend: FriendRecord): { id: string; tenantId?: string } | null {
  const ext = friend.externalIds.find((entry) => entry.provider === "aad" && !entry.externalId.startsWith("group:"))
  return ext ? { id: ext.externalId.toLowerCase(), tenantId: ext.tenantId } : null
}

/**
 * Who hears the notice: every family friend reachable on Teams (a Teams user id the bot can open a chat with), once per
 * Teams user even when several friend records share one. Teams is the only proactive channel wired today.
 */
export async function resolveNoticeTargets(agentRoot: string, store: { listAll(): Promise<FriendRecord[]> } = new FileFriendStore(path.join(agentRoot, "friends"))): Promise<NoticeTarget[]> {
  const seen = new Set<string>()
  const targets: NoticeTarget[] = []
  for (const friend of await store.listAll()) {
    if (friend.trustLevel !== "family") continue
    const aad = teamsAadId(friend)
    if (!aad || seen.has(aad.id)) continue
    seen.add(aad.id)
    targets.push({ friendId: friend.id, name: friend.name, key: resolveAlertKey(agentRoot, friend.id, "teams") ?? "shepherd", ...(aad.tenantId ? { tenantId: aad.tenantId } : {}) })
  }
  emitNervesEvent({ component: "senses", event: "senses.shepherd_notice_targets", message: "resolved Shepherd owner notice targets", meta: { count: targets.length } })
  return targets
}

export type NoticeSender = (target: NoticeTarget, text: string) => Promise<{
  delivered: boolean
  reason?: string
  delivery?: { state: "accepted" | "not_sent" | "unknown"; messageId?: string; conversationId?: string }
}>

/** The bot whose tenant is the friend's: the secondary bot when it serves that tenant, else the primary. */
export function chooseTeamsBot(tenantId: string | undefined, primary: TeamsConfig, secondary: TeamsConfig): TeamsConfig | null {
  if (tenantId && secondary.clientId && secondary.tenantId === tenantId) return secondary
  return primary.clientId ? primary : null
}

/* v8 ignore start -- the live Teams SDK client; its token and REST calls need a real bot registration @preserve */
async function liveBotApi(config: TeamsConfig): Promise<TeamsBotApi> {
  const { App } = await import("@microsoft/teams.apps")
  const app = new App({
    clientId: config.clientId,
    ...(config.clientSecret ? { clientSecret: config.clientSecret } : {}),
    tenantId: config.tenantId,
    ...(config.managedIdentityClientId ? { managedIdentityClientId: config.managedIdentityClientId } : {}),
  } as ConstructorParameters<typeof App>[0])
  return { id: app.id!, conversations: app.api.conversations }
}
/* v8 ignore stop */

/**
 * Sends through the Teams sense's own proactive path (`sendProactiveTeamsMessageToSession`: trust check, internal-content
 * guard, 1:1 chat with the friend's Teams id) with a bot client of this process's own, built from the agent's Teams
 * credentials. Nothing listens on a port: the client only acquires a bot token and calls the Bot Framework.
 */
export function createTeamsNoticeSender(agentRoot: string, deps: {
  primary?: () => TeamsConfig
  secondary?: () => TeamsConfig
  botApi?: (config: TeamsConfig) => Promise<TeamsBotApi>
} = {}): NoticeSender {
  const bots = new Map<string, Promise<TeamsBotApi>>()
  return async (target, text) => {
    const config = chooseTeamsBot(target.tenantId, (deps.primary ?? getTeamsConfig)(), (deps.secondary ?? getTeamsSecondaryConfig)())
    if (!config) return { delivered: false, reason: "no_teams_bot" }
    let bot = bots.get(config.clientId)
    if (!bot) {
      /* v8 ignore next -- tests inject the bot client; the live Bot Framework client is built only in the running sense @preserve */
      bot = (deps.botApi ?? liveBotApi)(config)
      bots.set(config.clientId, bot)
      // A client that could not be built is built again for the next notice.
      bot.catch(() => bots.delete(config.clientId))
    }
    const { sendProactiveTeamsMessageToSession } = await import("../teams")
    return sendProactiveTeamsMessageToSession(
      { friendId: target.friendId, sessionKey: target.key, text, textFormat: "plain", intent: "generic_outreach", captureReceipt: true },
      { botApi: await bot, store: new FileFriendStore(path.join(agentRoot, "friends")) },
    )
  }
}

export interface OwnerNotifierOptions {
  agent: string
  agentRoot: string
  policy: ShepherdNoticePolicy
  schedule: (fn: () => void, ms: number) => () => void
  /** The host's sessions, for the short handle (`surface:12`) each notice names. */
  listSessions: () => Promise<HostSession[]>
  resolveTargets?: () => Promise<NoticeTarget[]>
  send?: NoticeSender
}

export type NoticeIntentAcceptance =
  | { state: "queued"; noticeId: string }
  | { state: "suppressed"; reason: "policy" | "stopped" }

export interface OwnerNotifier {
  notify(record: ReturnRecord): Promise<NoticeIntentAcceptance>
  /** Sends what is waiting now; resolves when it is sent or has failed. */
  flush(): Promise<void>
  stop(): void
}

/** Collects durable notice intents; acceptance is distinct from transport delivery. */
export function createOwnerNotifier(options: OwnerNotifierOptions): OwnerNotifier {
  const { agent, policy } = options
  const resolveTargets = options.resolveTargets ?? (() => resolveNoticeTargets(options.agentRoot))
  const send = options.send ?? createTeamsNoticeSender(options.agentRoot)
  const retryWrites = new Map<string, ReturnRecord>()
  const recoveredNoticeIds = new Set<string>()
  const writes = new Set<Promise<string>>()
  let cancel: (() => void) | null = null
  let stopped = false
  let flushing: Promise<void> | null = null
  let drainRequested = false

  function schedule(ms: number): void {
    if (!stopped && policy !== "off") cancel ??= options.schedule(() => {
      cancel?.()
      cancel = null
      if (flushing) drainRequested = true
      else void flush()
    }, ms)
  }

  function persistIntent(record: ReturnRecord): Promise<string> {
    const key = `${record.host}:${record.session}:${record.transition}:${record.at}`
    retryWrites.set(key, record)
    const write = enqueueNotice(options.agentRoot, record).then(id => {
      retryWrites.delete(key)
      return id
    }).catch(error => {
      emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "could not persist a Shepherd owner notice intent; it remains waiting", meta: { agent, error: (error as Error).message } })
      schedule(NOTICE_RETRY_MS)
      throw error
    })
    writes.add(write)
    // Observe cleanup immediately, while the producer still receives the rejecting promise.
    void write.then(() => { writes.delete(write) }, () => { writes.delete(write) })
    return write
  }

  async function runFlush(): Promise<void> {
    cancel?.()
    cancel = null
    if (stopped || policy === "off") return
    try {
      await Promise.allSettled([...writes])
      const retried = await Promise.allSettled([...retryWrites.values()].map(persistIntent))
      if (retried.some(result => result.status === "rejected")) schedule(NOTICE_RETRY_MS)
      const entries = readNoticeOutbox(options.agentRoot).filter(entry =>
        noticeWanted(policy, entry.record) && (Object.keys(entry.deliveries).length === 0 || Object.values(entry.deliveries).some(value => value.state !== "sent")),
      )
      if (entries.length === 0) return
      const refs = new Map<string, HostSession>()
      try {
        for (const session of await options.listSessions()) refs.set(session.id, session)
      } catch {
        // Without the host's handles, each notice names a short session id instead.
      }
      const targets = await resolveTargets()
      if (stopped) return
      if (targets.length === 0) {
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_notice_no_target", message: "no family friend is reachable on Teams, so the Shepherd owner notice was not sent", meta: { agent, returns: entries.length } })
        schedule(NOTICE_RETRY_MS)
        return
      }
      await declareNoticeTargets(options.agentRoot, entries.map(entry => entry.id), targets.map(target => target.friendId), new Date().toISOString())
      const reachable = new Set(targets.map(target => target.friendId))
      let retry = entries.some(entry => Object.entries(entry.deliveries).some(([friendId, delivery]) =>
        delivery.state === "pending" && !reachable.has(friendId),
      ))
      for (const target of targets) {
        if (stopped) break
        const pending = entries.filter(entry => noticeDeliveryState(entry, target.friendId) === "pending")
        if (pending.length > 0) {
          // Only the worker that atomically claims a pending entry may initiate transport.
          const batch = await claimPendingNotices(options.agentRoot, pending.map(entry => entry.id), target.friendId, new Date().toISOString())
          if (batch.length === 0) continue
          const ids = batch.map(entry => entry.id)
          if (stopped) {
            await recordNoticeDelivery(options.agentRoot, ids, target.friendId, { state: "pending", at: new Date().toISOString(), reason: "stopped before transport" })
            break
          }
          try {
            const result = await send(target, noticeMessage(batch.map(entry => entry.record), refs, { recovered: ids.some(id => recoveredNoticeIds.has(id)) }))
            const state = result.delivered ? "sent"
              : result.delivery ? result.delivery.state === "not_sent" ? "pending" : "unknown"
                : result.reason && result.reason !== "send_error" ? "pending" : "unknown"
            await recordNoticeDelivery(options.agentRoot, ids, target.friendId, {
              state, at: new Date().toISOString(), ...(result.reason ? { reason: result.reason } : {}),
              ...(result.delivery?.messageId ? { messageId: result.delivery.messageId } : {}),
            })
            retry ||= state === "pending"
            emitNervesEvent({
              level: result.delivered ? "info" : "warn", component: "senses",
              event: result.delivered ? "senses.shepherd_notice_sent" : "senses.shepherd_notice_not_sent",
              message: result.delivered ? "sent the Shepherd owner notice" : "the Shepherd owner notice was not delivered",
              meta: { agent, friendId: target.friendId, returns: batch.length, ...(result.delivered ? {} : { reason: result.reason ?? "unknown" }) },
            })
          } catch (error) {
            emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "sending the Shepherd owner notice failed; its outcome remains unknown", meta: { agent, friendId: target.friendId, error: (error as Error).message } })
          }
        }
      }
      if (retry) schedule(NOTICE_RETRY_MS)
    } catch (error) {
      emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "preparing the Shepherd owner notice failed", meta: { agent, error: (error as Error).message } })
      schedule(NOTICE_RETRY_MS)
    }
  }

  function flush(): Promise<void> {
    if (flushing) return flushing
    flushing = runFlush().finally(() => {
      flushing = null
      if (drainRequested) {
        drainRequested = false
        schedule(NOTICE_COALESCE_MS)
      }
    })
    return flushing
  }

  try {
    const existing = readNoticeOutbox(options.agentRoot)
    for (const entry of existing) recoveredNoticeIds.add(entry.id)
    if (existing.some(entry => Object.keys(entry.deliveries).length === 0 || Object.values(entry.deliveries).some(value => value.state === "pending"))) schedule(NOTICE_RETRY_MS)
  } catch (error) {
    emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "could not read waiting Shepherd owner notices", meta: { agent, error: (error as Error).message } })
    schedule(NOTICE_RETRY_MS)
  }

  return {
    notify(record) {
      if (stopped) return Promise.resolve({ state: "suppressed", reason: "stopped" })
      if (!noticeWanted(policy, record)) return Promise.resolve({ state: "suppressed", reason: "policy" })
      const write = persistIntent(record)
      schedule(NOTICE_COALESCE_MS)
      return write.then(noticeId => ({ state: "queued", noticeId }))
    },
    flush,
    stop() {
      stopped = true
      cancel?.()
      cancel = null
    },
  }
}
