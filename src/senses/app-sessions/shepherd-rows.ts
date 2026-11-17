import { emitNervesEvent } from "../../nerves/runtime"
import { shepherd } from "./shepherd-cli"
import type { AppMessage, AppSessionRow, AppSessionState } from "./client"

/**
 * The app's sessions as Shepherd lists them (`shepherd sessions --json`, `shepherd messages --json`), in the shapes the
 * sense and its digest work from. Shepherd reads the app's socket and database; this maps its JSON and adds nothing.
 */
const STATE: Record<string, AppSessionState> = { busy: "working", waiting: "waiting", stuck: "stuck", idle: "idle" }

type Json = Record<string, unknown>
const str = (value: unknown): string | null => (typeof value === "string" && value.length > 0 ? value : null)
const object = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {})

/** One session row from Shepherd's JSON. A permission request the person must answer carries its id as the prompt. */
export function rowOf(item: Json): AppSessionRow {
  const activity = object(item.activity)
  const input = object(item.awaiting_input)
  const kind = str(input.kind)
  const requestId = str(input.request_id)
  const awaiting = kind === "plan" ? "plan" : kind === "user_input" ? "input" : kind === "permission" ? "permission" : undefined
  return {
    id: String(item.id),
    name: str(item.name) ?? "(unnamed)",
    kind: item.type === "chat" ? "chat" : "workspace",
    workspaceId: null,
    workspaceType: null,
    project: str(item.project_name),
    projectId: str(item.project_id),
    projectRepo: str(item.project_repo),
    branch: str(item.branch),
    path: str(item.path),
    parentSessionId: str(item.parent_session_id),
    creatorSessionId: str(item.creator_session_id),
    coordinatingCreatorSessionId: str(item.coordinating_creator_session_id),
    state: STATE[String(activity.status)] ?? "idle",
    detail: str(activity.why) ?? "",
    isRunning: item.is_running === true,
    wasInterrupted: item.was_interrupted === true,
    remote: item.remote === true,
    createdAt: str(item.created_at),
    updatedAt: str(item.updated_at),
    lastActivity: str(activity.last_activity) ?? str(item.updated_at),
    ...(awaiting ? { awaiting } : {}),
    ...(kind === "permission" && requestId ? { prompt: { requestId, what: str(input.what) ?? "a permission", at: null } } : {}),
  }
}

/** Every session in the app's sidebar. Throws when Shepherd cannot read the app. */
export async function sessionRows(): Promise<AppSessionRow[]> {
  const picture = await shepherd(["sessions"])
  const rows = (Array.isArray(picture.sessions) ? picture.sessions : []).map(item => rowOf(object(item)))
  emitNervesEvent({ component: "senses", event: "senses.app_sessions_rows", message: "read the app's session rows through Shepherd", meta: { rows: rows.length } })
  return rows
}

/** The last `count` visible messages of a session, oldest first, as Shepherd reads them. */
export async function sessionMessages(id: string, count: number): Promise<AppMessage[]> {
  const history = await shepherd(["messages", id], { count })
  return (Array.isArray(history.messages) ? history.messages : []).map(item => {
    const message = object(item)
    return {
      at: str(message.at),
      role: message.role === "user" ? "user" : "assistant",
      text: String(message.text ?? ""),
      ...(message.truncated === true ? { truncated: true } : {}),
    }
  })
}
