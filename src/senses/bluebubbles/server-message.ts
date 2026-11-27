// The BlueBubbles server's own record of one message, read field by field for the letter answer reader. Anything
// missing or of the wrong type stays unset, so a check that needs it fails rather than guessing.
import type { ServerMessage } from "../../heart/letters/answer-reader"
import { emitNervesEvent } from "../../nerves/runtime"

type Json = Record<string, unknown>

const record = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null)
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const time = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined)

/** The message in a `GET /api/v1/message/:guid` reply, or null when the reply holds no message with a GUID. */
export function serverMessageFromPayload(payload: unknown): ServerMessage | null {
  const outer = record(payload)
  const data = record(outer?.data) ?? outer
  const guid = text(data?.guid)
  if (!data || !guid) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.bluebubbles_server_message_missing", message: "the server's reply held no message", meta: {} })
    return null
  }
  const handle = record(data.handle)
  const chats = Array.isArray(data.chats) ? data.chats : []
  const sender = text(handle?.address)
  const service = text(handle?.service)
  const dateCreated = time(data.dateCreated)
  const dateEdited = time(data.dateEdited)
  const dateRetracted = time(data.dateRetracted)
  const dateRead = time(data.dateRead)
  const threadOriginatorGuid = text(data.threadOriginatorGuid)
  return {
    guid,
    text: typeof data.text === "string" ? data.text : "",
    // Kept only as the server states it: a message whose direction isn't stated never counts as the person's.
    ...(typeof data.isFromMe === "boolean" ? { isFromMe: data.isFromMe } : {}),
    ...(sender ? { sender } : {}),
    ...(service ? { service } : {}),
    chatGuids: chats.map((chat) => text(record(chat)?.guid)).filter((chatGuid): chatGuid is string => chatGuid !== undefined),
    ...(dateCreated ? { dateCreated } : {}),
    ...(dateEdited ? { dateEdited } : {}),
    ...(dateRetracted ? { dateRetracted } : {}),
    ...(dateRead ? { dateRead } : {}),
    ...(threadOriginatorGuid ? { threadOriginatorGuid } : {}),
  }
}
