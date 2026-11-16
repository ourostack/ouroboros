import { emitNervesEvent } from "../../nerves/runtime"
import { readEventLog, type AppSessionRow, type AppSessionsOptions } from "./client"
import { readSuccessions, successorOf } from "./handoff"

/**
 * Who coordinates a session now. The app records a coordinator once, when the session is made, and never lets another
 * session take that field over: when the coordinator hands off to a fresh successor and is archived, the field still
 * names the archived one, while the lanes have long been reporting to the successor. So the field alone is not the truth.
 * In order:
 *
 * - `app`: the session the app names, when it is still in the sidebar (by session id or project-session id);
 * - `hand-off`: that session's successor, when a hand-off names one that is listed (`successorOf`, owned by `handoff.ts`);
 * - `reports`: the listed session this lane last sent a message to with `send_session_message`, in the end of its history.
 *
 * `gone` means none of these finds one: only then may anyone say the lane has no coordinator.
 */
export const REPORT_SCAN_BYTES = 16 * 1024 * 1024
const SEND_TOOL = /(?:^|-)send_session_message$/

export type CoordinatorVia = "app" | "hand-off" | "reports"
export type Coordinator = { id: string; name: string; via: CoordinatorVia } | { gone: true; recorded: string } | null

export interface CoordinatorDeps {
  client?: AppSessionsOptions
  /** The newest successor of a session that handed off, or null; `handoffSuccessors` reads them from `handoff.ts`. */
  successorOf?: (id: string) => string | null
}

/** `successorOf` over the hand-offs the sense last recorded (`handoff.ts` refreshes them each minute), read once, when first needed. */
export function handoffSuccessors(agentRoot: string): (id: string) => string | null {
  let successions: ReturnType<typeof readSuccessions> | null = null
  return id => successorOf(id, (successions ??= readSuccessions(agentRoot)))
}

const listedAs = (rows: AppSessionRow[], id: string | null | undefined): AppSessionRow | undefined =>
  id ? rows.find(row => row.id === id || row.workspaceId === id) : undefined

/** The session ids this lane sent messages to, oldest first, from the end of its history. */
export function reportTargets(id: string, client: AppSessionsOptions = {}, maxBytes = REPORT_SCAN_BYTES): string[] {
  const targets: string[] = []
  for (const line of readEventLog(id, { ...client, maxBytes }).text.split("\n")) {
    if (!line.includes("send_session_message")) continue
    let event: { data?: { toolRequests?: Array<{ name?: unknown; arguments?: unknown }> } }
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    for (const request of event.data?.toolRequests ?? []) {
      if (typeof request?.name !== "string" || !SEND_TOOL.test(request.name)) continue
      let args = request.arguments
      if (typeof args === "string") {
        try {
          args = JSON.parse(args)
        } catch {
          continue
        }
      }
      const target = (args as { session_id?: unknown } | null)?.session_id
      if (typeof target === "string" && target) targets.push(target)
    }
  }
  return targets
}

export function coordinatorOf(row: AppSessionRow, rows: AppSessionRow[], deps: CoordinatorDeps = {}): Coordinator {
  const recorded = row.coordinatingCreatorSessionId
  if (!recorded) return null
  const named = listedAs(rows, recorded)
  if (named && named.id !== row.id) return { id: named.id, name: named.name, via: "app" }
  const successor = listedAs(rows, deps.successorOf?.(recorded))
  let found: Coordinator = successor && successor.id !== row.id ? { id: successor.id, name: successor.name, via: "hand-off" } : null
  if (!found) {
    const latest = reportTargets(row.id, deps.client).reverse().map(id => listedAs(rows, id)).find(target => target && target.id !== row.id)
    if (latest) found = { id: latest.id, name: latest.name, via: "reports" }
  }
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_coordinator_resolved", message: "worked out who coordinates a lane whose recorded coordinator is not listed", meta: { session: row.id, recorded, found: found && "id" in found ? found.id : null, via: found && "via" in found ? found.via : null } })
  return found ?? { gone: true, recorded }
}
