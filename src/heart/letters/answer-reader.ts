// How a person's own iMessage answers a letter (design §3.4, "How an answer is recorded"). Only the daemon records
// an answer, from the BlueBubbles server's own copy of the message: the chat ingress hands it a message GUID and
// nothing else, so a forged webhook or socket command can at most point at a real message, which must then pass
// every check below on the server's fields.
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { normalizeAnsweringHandle } from "./answering"
import type { IndexedLetter } from "./letter-index"

export const ANSWERED_GUIDS_FILE = "answered-guids.jsonl"

/** A message as the BlueBubbles server reports it, by GUID. */
export interface ServerMessage {
  guid: string
  text: string
  isFromMe: boolean
  /** The sender's handle as the server names it. */
  sender?: string
  /** The service the sender's handle uses: "iMessage" or "SMS". */
  service?: string
  chatGuids: string[]
  /** Epoch milliseconds. */
  dateCreated?: number
  dateEdited?: number
  dateRetracted?: number
  threadOriginatorGuid?: string
}

export interface ParsedAnswer {
  code: string
  option: string
  note?: string
}

/**
 * The one form an answer takes: the letter's code, a space, the option's number, and optionally a note after a dash,
 * such as `L7 2` or `L7 2 — after lunch`. A bare number, a label or anything else is not an answer.
 */
export function parseAnswer(text: string): ParsedAnswer | null {
  const match = /^(L[1-9]\d*) ([1-5])(?:\s*[—–-]\s*(\S.*))?$/u.exec(text.trim())
  if (!match) return null
  return { code: match[1], option: match[2], ...(match[3] ? { note: match[3].trim() } : {}) }
}

/** The GUIDs that have already answered a letter. */
export function readAnsweredGuids(lettersDir: string): Set<string> {
  let raw = ""
  try {
    raw = fs.readFileSync(path.join(lettersDir, ANSWERED_GUIDS_FILE), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  const guids = new Set<string>()
  for (const line of raw.split("\n")) {
    try {
      const guid = (JSON.parse(line) as { guid?: unknown }).guid
      if (typeof guid === "string") guids.add(guid)
    } catch {
      // A torn last line holds no GUID.
    }
  }
  return guids
}

/** Adds a GUID that answered, synced before the answer is recorded. */
export function addAnsweredGuid(lettersDir: string, guid: string, letterId: string, at: string): void {
  const fd = fs.openSync(path.join(lettersDir, ANSWERED_GUIDS_FILE), "a", 0o600)
  try {
    fs.writeSync(fd, `${JSON.stringify({ guid, letter: letterId, at })}\n`)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** The handle a one-to-one chat GUID such as `iMessage;-;+15551234567` names, normalised, or null for any other chat. */
function directChatHandle(chatGuid: string): string | null {
  const parts = chatGuid.split(";-;")
  if (parts.length !== 2) return null
  const checked = normalizeAnsweringHandle(parts[1])
  return checked.ok ? checked.handle : null
}

/**
 * Why the server's message doesn't answer this letter, or null when it does. Each check reads only the server's
 * fields and the letter as filed and delivered; the reasons are for the daemon's log, never shown to the sender.
 */
export function answerProblem(entry: IndexedLetter, message: ServerMessage, answer: ParsedAnswer, answered: Set<string>, now: number): string | null {
  const letter = entry.letter
  if (entry.state !== "waiting" || (letter.expiresAt !== undefined && Date.parse(letter.expiresAt) <= now)) return "not-waiting"
  if (!letter.answeringHandle) return "no-answering-handle"
  if (message.isFromMe) return "from-me"
  if (message.service !== "iMessage") return "not-imessage"
  const sender = message.sender ? normalizeAnsweringHandle(message.sender) : null
  if (!sender?.ok || sender.handle !== letter.answeringHandle) return "wrong-sender"
  if (message.chatGuids.length !== 1 || directChatHandle(message.chatGuids[0]) !== letter.answeringHandle) return "wrong-chat"
  if (message.threadOriginatorGuid) return "threaded"
  if (message.dateEdited || message.dateRetracted) return "edited"
  const delivered = entry.events.find((event) => event.t === "delivered")
  if (!delivered) return "not-delivered"
  if (message.dateCreated === undefined || message.dateCreated <= Date.parse(delivered.at)) return "before-delivery"
  if (answered.has(message.guid)) return "guid-answered"
  if (!letter.options.some((option) => option.id === answer.option)) return "no-such-option"
  return null
}

/** Logs a message that looked like an answer and wasn't one, by its reason alone. */
export function noteAnswerRefused(reason: string): void {
  emitNervesEvent({ level: "warn", component: "daemon", event: "letters.answer_refused", message: "a message in answer form didn't answer its letter", meta: { reason } })
}
