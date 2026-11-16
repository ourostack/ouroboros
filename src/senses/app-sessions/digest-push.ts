import { emitNervesEvent } from "../../nerves/runtime"
import { plain } from "../shepherd/owner-notice"
import type { Digest, DigestState } from "./digest"
import type { NotifyOwner } from "./waiting-prompts"

/**
 * What is worth telling the owner unasked, judged with no model turn from the digest. Four things only: work that is ready
 * for them, work that finished, something only they can unblock, and something that stays broken. A condition must last
 * before it counts, each is told once until it clears, and one message carries everything due, at most one per half hour.
 * Nothing is ever sent on a timer.
 */
export const PUSH_GAP_MS = 30 * 60_000
export const PUSH_LIST_MAX = 8
/** How long a condition must hold before it is told. A card's state is a fact the moment it is seen. */
export const HOLD_MS = { card: 0, waiting: 10 * 60_000, stuck: 20 * 60_000, machine: 10 * 60_000, drain: 5 * 60_000 }

export type PushKind = "ready" | "done" | "needs-you" | "broken"

export interface PushItem {
  key: string
  kind: PushKind
  text: string
  holdMs: number
}

const HEADINGS: Record<PushKind, string> = { ready: "Ready for you", done: "Done", "needs-you": "Waiting on you", broken: "Still broken" }
const ORDER: PushKind[] = ["needs-you", "ready", "broken", "done"]

/** Every condition that holds in this digest. Prompts are left out: the waiting-prompt notice already tells those. */
export function conditions(digest: Digest, cards: Record<string, string>): PushItem[] {
  const items: PushItem[] = []
  for (const item of digest.needsOwner) {
    if (item.kind === "ready") items.push({ key: item.key, kind: "ready", text: `${plain(item.name, 60)} — ${plain(item.text, 200)}`, holdMs: HOLD_MS.card })
    if (item.kind === "waiting") items.push({ key: item.key, kind: "needs-you", text: `${plain(item.name, 60)} — ${plain(item.text, 120)}`, holdMs: HOLD_MS.waiting })
  }
  for (const session of digest.sessions) {
    const card = session.card
    if (card?.status === "done" && cards[`${card.track}/${card.slug}`] !== undefined && cards[`${card.track}/${card.slug}`] !== "done") {
      items.push({ key: `done:${card.track}/${card.slug}`, kind: "done", text: plain(card.title, 100), holdMs: HOLD_MS.card })
    }
    if (session.state === "stuck") items.push({ key: `stuck:${session.id}`, kind: "broken", text: `${plain(session.name, 60)} is stuck: ${plain(session.detail, 100)}`, holdMs: HOLD_MS.stuck })
  }
  const machine = digest.machine
  if (machine && (machine.heartbeat === "bad" || machine.heartbeat === "stale")) {
    items.push({ key: "machine:heartbeat", kind: "broken", text: `the Mac watcher's heartbeat is ${machine.heartbeat}${machine.bad ? `: ${plain(machine.bad, 100)}` : ""}`, holdMs: HOLD_MS.machine })
  }
  for (const session of machine?.watchBad ?? []) items.push({ key: `watch:${session.id}`, kind: "broken", text: `${plain(session.title, 60)} failed the health watch: ${plain(session.status, 60)}`, holdMs: HOLD_MS.machine })
  for (const stale of digest.drains?.stale ?? []) items.push({ key: `drain:${stale.split(":")[0]}`, kind: "broken", text: `drain ${plain(stale, 80)} since its last good poll`, holdMs: HOLD_MS.drain })
  if (!digest.appRunning) items.push({ key: "app:down", kind: "broken", text: "the Copilot app is not running", holdMs: HOLD_MS.machine })
  return items
}

/** One plain-text message with everything due, grouped by kind: the owner notice path sends plain text, so no markdown. */
export function pushMessage(items: PushItem[]): string {
  const blocks = ORDER.map(kind => {
    const own = items.filter(item => item.kind === kind)
    return own.length ? [`${HEADINGS[kind]}:`, ...own.map(item => `- ${item.text}`)].join("\n") : ""
  }).filter(Boolean)
  return blocks.join("\n\n")
}

export interface PushResult {
  /** The message sent, or null when nothing was due or it had to wait. */
  sent: string | null
  due: number
}

/**
 * Updates the state for this digest and tells the owner what is due. The first digest after a start only records which
 * cards are ready or done, so a restart never announces old work. A condition that is no longer true is forgotten, so it is
 * told again if it comes back.
 */
export async function pushDue(digest: Digest, state: DigestState, now: number, notify: NotifyOwner): Promise<PushResult> {
  const present = conditions(digest, state.cards)
  const keys = new Set(present.map(item => item.key))
  for (const key of Object.keys(state.firstSeen)) if (!keys.has(key)) delete state.firstSeen[key]
  for (const key of Object.keys(state.pushed)) if (!keys.has(key)) delete state.pushed[key]
  for (const item of present) state.firstSeen[item.key] ??= now
  if (!state.seeded) {
    for (const item of present) if (item.kind === "ready" || item.kind === "done") state.pushed[item.key] = new Date(now).toISOString()
    state.seeded = true
  }
  const due = present.filter(item => !state.pushed[item.key] && now - state.firstSeen[item.key]! >= item.holdMs)
  const unsent = new Set<string>(due.map(item => item.key))
  let sent: string | null = null
  if (due.length && now - state.lastPushAt >= PUSH_GAP_MS) {
    const shown = due.slice(0, PUSH_LIST_MAX)
    const extra = due.length - shown.length
    const text = `${pushMessage(shown)}${extra ? `\n\nand ${extra} more` : ""}`
    const outcome = await notify(text, shown.map(item => item.key))
    if (outcome !== "pending") {
      for (const item of shown) {
        state.pushed[item.key] = new Date(now).toISOString()
        unsent.delete(item.key)
      }
      state.lastPushAt = now
      sent = text
    }
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_digest_push", message: "judged what to tell the owner from the digest", meta: { due: due.length, outcome, tokens: Math.ceil(text.length / 4) } })
  }
  for (const session of digest.sessions) {
    const card = session.card
    const key = card ? `${card.track}/${card.slug}` : ""
    if (card && !unsent.has(`done:${key}`)) state.cards[key] = card.status
  }
  return { sent, due: due.length }
}
