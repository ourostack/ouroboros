import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { createNoticeSender, plain, readEnabledReachChannels, resolveNoticeTargets, type NoticeSender, type NoticeTarget } from "../shepherd/owner-notice"
import type { AppSessionRow } from "./client"
import { appSessionsStateDir, readJson, readSnapshot, writeJson, type SenseSnapshot, type WaitingPrompt } from "./store"
import { ageLabel } from "./waiting-status"

/**
 * A session frozen on a permission prompt looks idle from outside, and only the person can answer it in the app. The
 * snapshot already reads every session's history each minute, so noticing is deterministic and costs no model turn:
 * a prompt open for more than two minutes is told to the owner once, in one plain message, through the same proactive
 * path Shepherd's owner notices use. A prompt older than a day is shown in `ouro status` but never announced: it is
 * most likely left over from a session the app stopped.
 */
export const WAITING_NOTICE_MS = 2 * 60_000
export const WAITING_MAX_AGE_MS = 24 * 3_600_000
/** Prompts named in one message; the rest are counted. */
export const WAITING_LIST_MAX = 6

/** How the owner notice ended: `pending` means nothing reached the owner and the next snapshot tries again. */
export type NotifyOutcome = "sent" | "pending" | "unknown"
export type NotifyOwner = (text: string, keys: string[]) => Promise<NotifyOutcome>

interface WaitingState {
  /** Prompt key → when the owner was told, so one prompt is never announced twice. */
  notified: Record<string, { at: string; name: string }>
}

const stateFile = (agentRoot: string): string => path.join(appSessionsStateDir(agentRoot), "waiting-prompts.json")
export const promptKey = (prompt: Pick<WaitingPrompt, "session" | "requestId">): string => `${prompt.session}:${prompt.requestId}`

/** The open permission prompts in the sidebar. A prompt the app timed without an event time keeps the first time it was seen. */
export function waitingPromptsOf(agentRoot: string, rows: AppSessionRow[], now: number): WaitingPrompt[] {
  const before = new Map((readSnapshot(agentRoot)?.waitingPrompts ?? []).map(prompt => [promptKey(prompt), prompt.since]))
  const prompts: WaitingPrompt[] = []
  for (const row of rows) {
    if (!row.prompt) continue
    const stamped = Date.parse(row.prompt.at ?? "")
    const since = Number.isNaN(stamped) ? before.get(promptKey({ session: row.id, requestId: row.prompt.requestId })) ?? now : stamped
    prompts.push({ session: row.id, name: row.name, requestId: row.prompt.requestId, what: row.prompt.what, since })
  }
  return prompts
}

/** One plain message naming each session, what it waits on and that only the owner can answer. */
export function waitingMessage(prompts: WaitingPrompt[], now: number): string {
  const line = (prompt: WaitingPrompt): string => `"${plain(prompt.name, 60)}" waits on ${plain(prompt.what, 120)}, for ${ageLabel(now - prompt.since)}`
  if (prompts.length === 1) return `${line(prompts[0]!)}. Only you can answer it, in the Copilot app: open that session and approve or decline.`
  const shown = prompts.slice(0, WAITING_LIST_MAX).map(prompt => `- ${line(prompt)}`)
  const more = prompts.length > WAITING_LIST_MAX ? `\n- and ${prompts.length - WAITING_LIST_MAX} more` : ""
  return `${prompts.length} sessions wait on prompts only you can answer, in the Copilot app (open each session and approve or decline):\n${shown.join("\n")}${more}`
}

/**
 * Tell the owner about each prompt open past the threshold that they have not been told about. Returns how many
 * prompts were announced. A snapshot that could not read the app changes nothing, so a blip cannot forget a prompt.
 */
export async function noticeWaitingPrompts(agentRoot: string, snapshot: SenseSnapshot, deps: { notify: NotifyOwner; now: number }): Promise<number> {
  if (snapshot.error) return 0
  const open = snapshot.waitingPrompts ?? []
  const keys = new Set(open.map(promptKey))
  const state = readJson<WaitingState>(stateFile(agentRoot), { notified: {} })
  const kept = Object.fromEntries(Object.entries(state.notified).filter(([key]) => keys.has(key)))
  const due = open.filter(prompt => {
    const age = deps.now - prompt.since
    return age > WAITING_NOTICE_MS && age <= WAITING_MAX_AGE_MS && !kept[promptKey(prompt)]
  })
  let announced = 0
  if (due.length > 0) {
    const dueKeys = due.map(promptKey)
    const outcome = await deps.notify(waitingMessage(due, deps.now), dueKeys)
    if (outcome !== "pending") {
      for (const prompt of due) kept[promptKey(prompt)] = { at: new Date(deps.now).toISOString(), name: prompt.name }
      announced = due.length
      emitNervesEvent({ component: "senses", event: "senses.app_sessions_waiting_notice", message: "told the owner about Copilot app sessions waiting on a prompt", meta: { prompts: due.length, outcome } })
    }
  }
  if (announced > 0 || Object.keys(kept).length !== Object.keys(state.notified).length) writeJson(stateFile(agentRoot), { notified: kept } satisfies WaitingState)
  return announced
}

/** Sends the notice to the owner on the channel Shepherd's notices use. An outcome the transport could not confirm is `unknown`, never retried, so the owner is not told twice. */
export function ownerNotifier(agent: string, agentRoot: string, deps: {
  resolveTargets?: () => Promise<NoticeTarget[]>
  send?: NoticeSender
} = {}): NotifyOwner {
  const resolveTargets = deps.resolveTargets ?? (() => resolveNoticeTargets(agentRoot, undefined, readEnabledReachChannels(agent, agentRoot)))
  const send = deps.send ?? createNoticeSender(agentRoot, { origin: "proactive" })
  return async (text, keys) => {
    const targets = await resolveTargets()
    if (targets.length === 0) {
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.app_sessions_waiting_no_target", message: "no family friend is reachable on any enabled channel, so the waiting-prompt notice waits", meta: { agent } })
      return "pending"
    }
    const outcomes: NotifyOutcome[] = []
    for (const target of targets) {
      try {
        const result = await send(target, text, keys)
        outcomes.push(result.delivered ? "sent"
          : result.delivery ? result.delivery.state === "not_sent" ? "pending" : "unknown"
            : result.reason && result.reason !== "send_error" ? "pending" : "unknown")
      } catch (error) {
        outcomes.push("unknown")
        emitNervesEvent({ level: "error", component: "senses", event: "senses.app_sessions_waiting_notice_error", message: "sending the waiting-prompt notice failed; its outcome is unknown", meta: { agent, friendId: target.friendId, error: (error as Error).message } })
      }
    }
    return outcomes.includes("sent") ? "sent" : outcomes.includes("unknown") ? "unknown" : "pending"
  }
}
