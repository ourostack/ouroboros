import { emitNervesEvent } from "../../nerves/runtime"
import { plain } from "../shepherd/owner-notice"
import { appUrl } from "./app-interface"
import type { AppSessionRow } from "./client"
import { readCard } from "./digest-cards"
import type { Digest, DigestState } from "./digest"
import type { NotifyOwner } from "./waiting-prompts"

/**
 * What is worth telling the owner unasked, judged with no model turn from the digest: only what only they can act on.
 * That is work ready for them to look at, and a session waiting on their answer. Finished work and things that are
 * broken go in the digest (`/status`), not in a push: a stuck session is shown under Broken there (`shepherd stuck plan` is
 * where it gets fixed), and the machine, the drains and the health watch have owners of their own.
 *
 * A condition must last before it counts, is told once and then not again until it clears and comes back, and is
 * checked live again just before the message goes out. One message carries everything due, at most one per half hour,
 * and the sender holds it while the owner is mid-conversation (`conversation-hold.ts`). Nothing is sent on a timer.
 */
export const PUSH_GAP_MS = 30 * 60_000
export const PUSH_LIST_MAX = 8
/** How long a condition must hold before it is told. A card's state is a fact the moment it is seen. */
export const HOLD_MS = { card: 0, waiting: 10 * 60_000 }
/** Names are never cut short in a push: a cut name ends in an ellipsis, and a push is whole sentences. */
const WHOLE = Number.MAX_SAFE_INTEGER

export type PushKind = "ready" | "needs-you"

export interface PushItem {
  key: string
  kind: PushKind
  /** The session it is about, for its link. */
  session: string
  text: string
  holdMs: number
}

const HEADINGS: Record<PushKind, string> = { "needs-you": "Waiting on you", ready: "Ready for you" }
const ORDER: PushKind[] = ["needs-you", "ready"]

/** Every condition that holds in this digest. Prompts are left out: the waiting-prompt notice already tells those. */
export function conditions(digest: Digest): PushItem[] {
  const items: PushItem[] = []
  for (const item of digest.needsOwner) {
    if (item.kind === "ready") {
      const title = digest.sessions.find(session => session.id === item.session)?.card?.title
      items.push({ key: item.key, kind: "ready", session: item.session, text: `"${plain(item.name, WHOLE)}" has ${title ? `"${plain(title, WHOLE)}"` : "its work"} ready for you to look at.`, holdMs: HOLD_MS.card })
    }
    if (item.kind === "waiting") items.push({ key: item.key, kind: "needs-you", session: item.session, text: `"${plain(item.name, WHOLE)}" is waiting for your answer.`, holdMs: HOLD_MS.waiting })
  }
  return items
}

/** One plain-text message with everything due, grouped by kind, each a whole sentence and the link that opens it. */
export function pushMessage(items: PushItem[]): string {
  const blocks = ORDER.map(kind => {
    const own = items.filter(item => item.kind === kind)
    return own.length ? [`${HEADINGS[kind]}:`, ...own.map(item => `- ${item.text} ${appUrl(item.session)}`)].join("\n") : ""
  }).filter(Boolean)
  return blocks.join("\n\n")
}

/** Which of these still hold when looked at again live, just before sending; tests and the sense supply it. */
export type Recheck = (items: PushItem[]) => Promise<PushItem[]>

/**
 * The items that still hold against a fresh listing of the app's sessions and a fresh read of the cards: the session is
 * still listed, a waiting one still waits on an answer (a prompt has its own notice), a ready card is still ready.
 */
export function stillDue(items: PushItem[], rows: AppSessionRow[], deskRoots: string[]): PushItem[] {
  const fresh = new Map(rows.map(row => [row.id, row]))
  return items.filter(item => {
    const row = fresh.get(item.session)
    if (!row) return false
    if (item.kind === "needs-you") return row.state === "waiting" && !row.prompt
    const [track = "", slug = ""] = item.key.slice("ready:".length).split("/")
    return readCard(deskRoots, track, slug)?.status === "collaborating"
  })
}

export interface PushResult {
  /** The message sent, or null when nothing was due or it had to wait. */
  sent: string | null
  due: number
}

/**
 * Updates the state for this digest and tells the owner what is due. The first digest after a start only records which
 * cards are ready, so a restart never announces old work. A condition that is no longer true is forgotten, so it is told
 * again if it comes back. One that a live recheck no longer finds is dropped from this message, untold.
 */
export async function pushDue(digest: Digest, state: DigestState, now: number, notify: NotifyOwner, recheck: Recheck = async items => items): Promise<PushResult> {
  const present = conditions(digest)
  const keys = new Set(present.map(item => item.key))
  for (const key of Object.keys(state.firstSeen)) if (!keys.has(key)) delete state.firstSeen[key]
  for (const key of Object.keys(state.pushed)) if (!keys.has(key)) delete state.pushed[key]
  for (const item of present) state.firstSeen[item.key] ??= now
  if (!state.seeded) {
    for (const item of present) if (item.kind === "ready") state.pushed[item.key] = new Date(now).toISOString()
    state.seeded = true
  }
  const due = present.filter(item => !state.pushed[item.key] && now - state.firstSeen[item.key]! >= item.holdMs)
  if (!due.length || now - state.lastPushAt < PUSH_GAP_MS) return { sent: null, due: due.length }
  const live = await recheck(due)
  if (!live.length) {
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_digest_push_stale", message: "dropped what was due because a live recheck no longer found it", meta: { due: due.length } })
    return { sent: null, due: 0 }
  }
  const shown = live.slice(0, PUSH_LIST_MAX)
  const extra = live.length - shown.length
  const text = `${pushMessage(shown)}${extra ? `\n\nand ${extra} more in /status` : ""}`
  const outcome = await notify(text, shown.map(item => item.key))
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_digest_push", message: "judged what to tell the owner from the digest", meta: { due: live.length, outcome, tokens: Math.ceil(text.length / 4) } })
  if (outcome === "pending") return { sent: null, due: live.length }
  for (const item of shown) state.pushed[item.key] = new Date(now).toISOString()
  state.lastPushAt = now
  return { sent: text, due: live.length }
}
