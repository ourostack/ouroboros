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
/** How far before the daemon's delivered time an answer may be dated, when the server's own send time is unknown. */
export const DELIVERY_SLACK_MS = 5 * 60_000
const NOTE_MAX = 200

/** A message as the BlueBubbles server reports it, by GUID. */
export interface ServerMessage {
  guid: string
  text: string
  /** Missing when the server didn't say, and then the message is no answer. */
  isFromMe?: boolean
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
  // The note reaches the agent's turn and the receipt, so format characters (bidi overrides and the like) go, and it is capped.
  const note = (match[3] ?? "").replace(/\p{Cf}/gu, "").trim().slice(0, NOTE_MAX)
  return { code: match[1], option: match[2], ...(note ? { note } : {}) }
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
  const file = path.join(lettersDir, ANSWERED_GUIDS_FILE)
  const fd = fs.openSync(file, "a+", 0o600)
  try {
    // A line a crash tore is ended first, so it can't swallow this GUID.
    const size = fs.fstatSync(fd).size
    const last = Buffer.alloc(1)
    const torn = size > 0 && fs.readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a
    fs.writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify({ guid, letter: letterId, at })}\n`)
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
 * The time an answer must come after, on the server's clock when it can be had: when the server itself dated the
 * letter's sent message. Otherwise the daemon's delivered time less DELIVERY_SLACK_MS, which covers a send that
 * outlasted its deadline (an `unconfirmed` delivery) and clocks that differ. Null when the letter isn't delivered.
 */
export async function deliveryFloor(entry: IndexedLetter, sentAt?: (messageGuid: string) => Promise<number | undefined>): Promise<number | null> {
  const delivered = entry.events.find((event) => event.t === "delivered")
  if (!delivered) return null
  if (delivered.messageId && sentAt) {
    const serverTime = await sentAt(delivered.messageId).catch(() => undefined)
    if (serverTime !== undefined) return serverTime
  }
  return Date.parse(delivered.at) - DELIVERY_SLACK_MS
}

/**
 * Why the server's message doesn't answer this letter, or null when it does. Each check reads only the server's
 * fields and the letter as filed and delivered; the reasons are for the daemon's log, never shown to the sender.
 * `floor` is the letter's deliveryFloor.
 */
export function answerProblem(entry: IndexedLetter, message: ServerMessage, answer: ParsedAnswer, answered: Set<string>, floor: number | null): string | null {
  const letter = entry.letter
  // Expiry is judged by when the person sent the message, so a pass that reads it late still counts it.
  const sentAfterExpiry = letter.expiresAt !== undefined && (message.dateCreated ?? Number.POSITIVE_INFINITY) >= Date.parse(letter.expiresAt)
  if (entry.state !== "waiting" || sentAfterExpiry) return "not-waiting"
  if (!letter.answeringHandle) return "no-answering-handle"
  if (message.isFromMe !== false) return "from-me"
  if (message.service !== "iMessage") return "not-imessage"
  const sender = message.sender ? normalizeAnsweringHandle(message.sender) : null
  if (!sender?.ok || sender.handle !== letter.answeringHandle) return "wrong-sender"
  if (message.chatGuids.length !== 1 || directChatHandle(message.chatGuids[0]) !== letter.answeringHandle) return "wrong-chat"
  if (message.threadOriginatorGuid) return "threaded"
  if (message.dateEdited || message.dateRetracted) return "edited"
  if (floor === null) return "not-delivered"
  if (message.dateCreated === undefined || message.dateCreated <= floor) return "before-delivery"
  if (answered.has(message.guid)) return "guid-answered"
  if (!letter.options.some((option) => option.id === answer.option)) return "no-such-option"
  return null
}

/** Logs a message that looked like an answer and wasn't one, by its reason alone. */
export function noteAnswerRefused(reason: string): void {
  emitNervesEvent({ level: "warn", component: "daemon", event: "letters.answer_refused", message: "a message in answer form didn't answer its letter", meta: { reason } })
}
