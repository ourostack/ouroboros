import * as path from "node:path"
import { FileFriendStore, type FriendRecord } from "@ouro.bot/friends"
import { resolveAlertKey } from "../../heart/awaiting/await-alert"
import { getTeamsConfig, getTeamsSecondaryConfig, type TeamsConfig } from "../../heart/config"
import type { ShepherdNoticePolicy } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { TeamsBotApi } from "../teams"
import type { HostSession } from "./host"
import type { ReturnRecord } from "./returns"

/**
 * The owner notice: after a judged return, the agent's owner hears what happened in one short plain message on their
 * own channel. It is deterministic, written here and sent with no model turn, so the owner hears about every return the
 * policy covers whether or not the Ouro agent decides it matters. Returns that arrive close together share one message.
 */
export const NOTICE_COALESCE_MS = 5_000
/** Returns named one by one in a coalesced message; the rest are counted. */
export const NOTICE_LIST_MAX = 6
const NAME_MAX = 60
const REASON_MAX = 300
const REPLY_MAX = 240

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

function who(record: ReturnRecord, ref: string | undefined): string {
  const agent = record.agent ? plain(record.agent, NAME_MAX) : ""
  const folder = record.cwd ? plain(path.basename(record.cwd), NAME_MAX) : ""
  const where = plain(ref ?? record.session.slice(0, 8), NAME_MAX)
  return `${agent || "A coding agent"}${folder ? ` in ${folder}` : ""}${where ? ` (${where})` : ""}`
}

/** One return as one sentence pair: who returned, what Shepherd did, and why. */
export function noticeLine(record: ReturnRecord, ref?: string): string {
  const subject = who(record, ref)
  const why = `Why: ${plain(record.reason, REASON_MAX) || "no reason given"}`
  switch (record.kind) {
    case "premature":
      if (record.action === "respond" && record.reply) {
        const sent = record.reply.startsWith("key:") ? `pressed ${plain(record.reply.slice(4), 10)}` : `sent it back: "${plain(record.reply, REPLY_MAX)}"`
        return `${subject} stopped early, so I ${sent}. ${why}`
      }
      return `${subject} stopped early, but I did not answer it, so it is waiting for you. ${why}`
    case "gate":
      return `${subject} needs you. ${why}`
    case "done":
      return `${subject} says it is done. ${why}`
    case "loop_guard":
      return `${subject}: I stopped answering it after too many replies, so it is waiting for you. ${why}`
    case "working":
      return `${subject} is still working in the background and has news. ${why}`
    case "unclear":
      return `${subject} stopped and I could not tell what it needs, so I left it. ${why}`
    default:
      return `${subject} stopped but I could not judge it, so I left it. ${why}`
  }
}

/** One message for a burst: a single return is its line; several are a short list, the extra ones counted. */
export function noticeMessage(records: ReturnRecord[], refs: ReadonlyMap<string, string> = new Map()): string {
  const lines = records.slice(0, NOTICE_LIST_MAX).map((record) => noticeLine(record, refs.get(record.session)))
  if (records.length === 1) return lines[0]!
  const more = records.length - lines.length
  return [`${records.length} coding agents stopped:`, ...lines.map((line) => `- ${line}`), ...(more > 0 ? [`- and ${more} more.`] : [])].join("\n")
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

export type NoticeSender = (target: NoticeTarget, text: string) => Promise<{ delivered: boolean; reason?: string }>

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
      { friendId: target.friendId, sessionKey: target.key, text, textFormat: "plain", intent: "generic_outreach" },
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

export interface OwnerNotifier {
  notify(record: ReturnRecord): void
  /** Sends what is waiting now; resolves when it is sent or has failed. */
  flush(): Promise<void>
  stop(): void
}

/** Collects notices for NOTICE_COALESCE_MS after the first, then sends them as one message. It never throws. */
export function createOwnerNotifier(options: OwnerNotifierOptions): OwnerNotifier {
  const { agent, policy } = options
  const resolveTargets = options.resolveTargets ?? (() => resolveNoticeTargets(options.agentRoot))
  const send = options.send ?? createTeamsNoticeSender(options.agentRoot)
  const waiting: ReturnRecord[] = []
  let cancel: (() => void) | null = null

  async function flush(): Promise<void> {
    cancel?.()
    cancel = null
    const records = waiting.splice(0)
    if (records.length === 0) return
    try {
      const refs = new Map<string, string>()
      try {
        for (const session of await options.listSessions()) refs.set(session.id, session.ref)
      } catch {
        // Without the host's handles, each notice names a short session id instead.
      }
      const text = noticeMessage(records, refs)
      const targets = await resolveTargets()
      if (targets.length === 0) {
        emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_notice_no_target", message: "no family friend is reachable on Teams, so the Shepherd owner notice was not sent", meta: { agent, returns: records.length } })
        return
      }
      for (const target of targets) {
        try {
          const result = await send(target, text)
          emitNervesEvent({
            level: result.delivered ? "info" : "warn",
            component: "senses",
            event: result.delivered ? "senses.shepherd_notice_sent" : "senses.shepherd_notice_not_sent",
            message: result.delivered ? "sent the Shepherd owner notice" : "the Shepherd owner notice was not delivered",
            meta: { agent, friendId: target.friendId, returns: records.length, ...(result.delivered ? {} : { reason: result.reason ?? "unknown" }) },
          })
        } catch (error) {
          emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "sending the Shepherd owner notice failed", meta: { agent, friendId: target.friendId, error: (error as Error).message } })
        }
      }
    } catch (error) {
      emitNervesEvent({ level: "error", component: "senses", event: "senses.shepherd_notice_error", message: "preparing the Shepherd owner notice failed", meta: { agent, error: (error as Error).message } })
    }
  }

  return {
    notify(record) {
      if (!noticeWanted(policy, record)) return
      waiting.push(record)
      cancel ??= options.schedule(() => { void flush() }, NOTICE_COALESCE_MS)
    },
    flush,
    stop() {
      cancel?.()
      cancel = null
    },
  }
}
