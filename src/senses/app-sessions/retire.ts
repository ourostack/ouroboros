import { emitNervesEvent } from "../../nerves/runtime"
import { plain } from "../shepherd/owner-notice"
import { archiveRow, deliverMessage, type Asked } from "./app-interface"
import type { AppSessionRow, AppSessionsOptions } from "./client"
import { coordinatorOf } from "./coordinator"
import { refreshSuccessions, successorOf } from "./handoff"
import { whereItLeftOff } from "./size-watch"
import type { ArchiveLogEntry } from "./store"

/**
 * The sidebar shows live jobs only. Each minute, with no model turn, two kinds of session leave it, through the app's
 * archive (reversible, worktree kept), logged and listed in the status digest:
 *
 * - **Handed off.** A session whose job has a newer owner: a later session's first message says `Succeeds: <its id>`
 *   (see `handoff.ts`). It goes once that successor has finished its first turn and it has itself been idle for
 *   `HANDOFF_QUIET_MS`, whatever its size.
 * - **Finished.** An idle session whose coordinator is archived or gone, with no open pull request and no automation,
 *   and no turn for `FINISHED_IDLE_MS`.
 *
 * Neither ever goes while it runs, waits on a person (a question, plan or permission) or is stuck, or while a session it
 * coordinates still does: the app archives a session without its children, which keep running but can no longer report
 * to it, so a predecessor stays until its children are idle, and its successor is then told which children it had.
 */
export const HANDOFF_QUIET_MS = 5 * 60_000
/** A day: an orphan quiet this long has had a full day for its coordinator's successor to pick it up. */
export const FINISHED_IDLE_MS = 24 * 3_600_000

export interface RetireDeps {
  now: number
  client: AppSessionsOptions
  send?: (id: string, text: string) => Promise<Asked>
  archive?: (row: AppSessionRow, reason: ArchiveLogEntry["reason"], note: string) => Promise<boolean>
}

const quietSince = (row: AppSessionRow): number => Math.max(Date.parse(row.lastActivity ?? "") || 0, Date.parse(row.updatedAt ?? "") || 0)
const settled = (row: AppSessionRow): boolean => !row.isRunning && row.state === "idle" && !row.awaiting && !row.remote
const recordedCoordinator = (row: AppSessionRow): string | null => row.coordinatingCreatorSessionId ?? row.parentSessionId
const short = (id: string): string => id.slice(0, 8)

export function childrenNote(predecessor: AppSessionRow, children: AppSessionRow[]): string {
  const list = children.map(child => `"${plain(child.name, 60)}" (${child.id})`).join(", ")
  return `I archived "${plain(predecessor.name, 60)}" (${predecessor.id}), the session you succeed, now that you have taken over and it is idle. It coordinated ${list}. They are idle and can no longer report to it; message them by id if their work continues. The archive is reversible from the app.`
}

/** Archive the handed-off and the finished sessions among `rows`. Returns the ids archived. */
export async function retireSessions(agentRoot: string, rows: AppSessionRow[], deps: RetireDeps): Promise<string[]> {
  const send = deps.send ?? ((id: string, text: string) => deliverMessage(id, text, "immediate", deps.client))
  const archive = deps.archive ?? (async (row: AppSessionRow, reason: ArchiveLogEntry["reason"], note: string) => (await archiveRow(agentRoot, row, reason, deps.client, { note, keepWorktree: true })).ok === true)
  const successions = refreshSuccessions(agentRoot, deps.client, rows.map(row => row.id))
  const listed = new Map(rows.map(row => [row.id, row]))
  const childrenOf = (id: string): AppSessionRow[] => rows.filter(row => recordedCoordinator(row) === id)
  const busyChildren = (id: string, except: string | null): AppSessionRow[] => childrenOf(id).filter(child => child.id !== except && !(settled(child) || (child.remote && !child.isRunning)))
  const archived: string[] = []

  for (const row of rows) {
    if (!settled(row) || deps.now - quietSince(row) < HANDOFF_QUIET_MS) continue
    const direct = Object.entries(successions).find(([, entry]) => entry.predecessor === row.id && entry.turned)?.[0]
    if (!direct) continue
    const successor = successorOf(row.id, successions)
    if (!successor) continue
    const busy = busyChildren(row.id, direct)
    if (busy.length) {
      emitNervesEvent({ component: "senses", event: "senses.app_sessions_handoff_held", message: "held a handed-off session while sessions it coordinates still work", meta: { session: row.id, successor, children: busy.map(child => child.id) } })
      continue
    }
    const heir = listed.get(successor)
    // The app deletes an archived session's automation, and restoring it does not bring it back.
    const note = `succeeded by ${heir ? `"${plain(heir.name, 60)}" ` : ""}(${short(successor)}); ${whereItLeftOff(row, deps.client)}${row.automation ? "; its automation was removed with it" : ""}`
    if (!(await archive(row, "handed-off", note).catch(() => false))) continue
    archived.push(row.id)
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_handoff_archived", message: "archived a session whose successor took over", meta: { session: row.id, successor } })
    const orphans = childrenOf(row.id).filter(child => child.id !== direct && child.id !== successor)
    if (orphans.length && heir) await send(successor, childrenNote(row, orphans)).catch(() => undefined)
  }

  for (const row of rows) {
    if (archived.includes(row.id) || !settled(row) || row.openPullRequest || row.automation) continue
    const coordinator = recordedCoordinator(row)
    if (!coordinator || (listed.has(coordinator) && !archived.includes(coordinator))) continue
    // The recorded coordinator may have handed off: a lane that a live successor or the session it reports to still coordinates is not finished.
    const live = coordinatorOf(row, rows, { client: deps.client, successorOf: id => successorOf(id, successions) })
    if (live && "id" in live && !archived.includes(live.id)) continue
    if (deps.now - quietSince(row) < FINISHED_IDLE_MS || busyChildren(row.id, null).length) continue
    const note = `${row.detail || "idle"}; ${whereItLeftOff(row, deps.client)}`
    if (!(await archive(row, "finished", note).catch(() => false))) continue
    archived.push(row.id)
    emitNervesEvent({ component: "senses", event: "senses.app_sessions_finished_archived", message: "archived an idle session whose coordinator is gone", meta: { session: row.id, coordinator } })
  }
  return archived
}
