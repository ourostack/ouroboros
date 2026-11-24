// A letter: a request from an agent to its person that only that person can answer (design §3.1). This module holds
// the types, the checks a sender's letter must pass and the folding those checks use. It reads and writes nothing.
import { emitNervesEvent } from "../../nerves/runtime"

export type LetterKind = "decide" | "do" | "accept" | "know"
export type Urgency = "now" | "today" | "whenever"
export type LetterState = "waiting" | "answered" | "withdrawn" | "expired"

export interface LetterOption { id: string; label: string; effect: string }
export interface LetterLink { label: string; url: string }

/** What the sender writes. Ouro adds the rest: id, code, to, from and the time. */
export interface LetterDraft {
  kind: LetterKind
  subject: string
  whyOnlyYou?: string
  body: string
  options: LetterOption[]
  links: LetterLink[]
  dedupeKey?: string
  urgency: Urgency
  holdUntil?: string
  expiresAt?: string
  /** The sender's own label for where it asks from, such as a desk task path or an MCP caller. */
  lane?: string
}

export interface Letter extends Omit<LetterDraft, "lane"> {
  v: 1
  id: `ltr_${string}`
  /** Short, per person, human-typable ("L7"); monotonic, never reused. */
  code: string
  answeringHandle?: string
  /** The person's friend id. Ouro sets it, never the caller. */
  to: string
  from: {
    agent: string
    session?: { friendId: string; channel: string; key: string }
    peer?: { did: string; taskId: string; contextId?: string }
    lane?: string
  }
  createdAt: string
}

export type LetterEvent =
  | { t: "delivered"; at: string; via: "chat"; channel: string; key: string; messageId: string }
  | { t: "seen"; at: string; via: "chat" | "web" }
  | {
    t: "answered"; at: string; option: string; note?: string; via: "chat"
    evidence: { friendId: string; channel: string; chatGuid: string; messageGuid: string; dateCreated: string }
    hostTrust: "shared-apple-id" | "separate"
  }
  | { t: "refiled"; at: string; by: string }
  | { t: "withdrawn"; at: string; reason: string }
  | { t: "expired"; at: string }
  | { t: "returned"; at: string; to: "session" | "peer" | "waiter"; ok: boolean; detail?: string }

export const LETTER_KINDS: readonly LetterKind[] = ["decide", "do", "accept", "know"]
const URGENCIES: readonly Urgency[] = ["now", "today", "whenever"]

export const LETTER_LIMITS = {
  subject: 80,
  whyOnlyYou: 200,
  body: 4000,
  label: 40,
  effect: 160,
  linkLabel: 80,
  url: 500,
  dedupeKey: 120,
  lane: 120,
  reason: 200,
} as const

/** Every letter has options, so "answered" means the same for every kind (review B3). Only decide letters bring their own. */
export const DEFAULT_OPTIONS: Readonly<Record<Exclude<LetterKind, "decide">, LetterOption[]>> = {
  do: [{ id: "1", label: "done", effect: "It is done." }, { id: "2", label: "can't", effect: "It can't be done; the sender is told." }],
  accept: [{ id: "1", label: "accept", effect: "The work is accepted." }, { id: "2", label: "send back", effect: "The work goes back to the sender." }],
  know: [{ id: "1", label: "got it", effect: "The sender knows you have read it." }],
}

/** Fields Ouro sets from who calls, never the caller (R4-M4). */
const SET_BY_OURO = new Set(["to", "from", "session", "id", "code", "createdAt", "answeringHandle", "v"])
const SENDER_FIELDS = new Set(["kind", "subject", "whyOnlyYou", "body", "options", "links", "dedupeKey", "urgency", "holdUntil", "expiresAt", "lane"])

/**
 * Letters from other scripts that look like Latin ones. Only letters are folded, never digits, so a code written with
 * look-alikes still reads as a code while text in another script's digits stays as it is.
 */
const LOOK_ALIKES: Readonly<Record<string, string>> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i",
  "ј": "j", "ӏ": "l", "Ӏ": "l", "ѕ": "s", "ԁ": "d", "ԛ": "q", "ԝ": "w",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P",
  "С": "C", "Т": "T", "Х": "X", "Ѕ": "S", "І": "I", "Ј": "J",
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M",
  "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "ο": "o", "ι": "i",
  "ν": "v", "ρ": "p", "ı": "i", "ʟ": "L",
}

const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const HIDDEN_RUNS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu

/** The copy sender text is checked on: NFKC, then look-alike letters folded, then hidden characters removed. */
export function fold(text: string): string {
  return [...text.normalize("NFKC")].map((char) => LOOK_ALIKES[char] ?? char).join("").replace(HIDDEN, "")
}

/** Text as it is stored: each run of control, format and line or paragraph separators becomes one space. */
export function storedText(text: string): string {
  return text.replace(HIDDEN_RUNS, " ")
}

// An L that doesn't follow a letter or digit, up to three characters that are neither, then a digit: L8, L 8, L-8, L·8.
const CODE_TOKEN = /(?<![\p{L}\p{N}])[Ll][^\p{L}\p{N}]{0,3}\p{Nd}/u
const LETTER_NUMBER = /(?<![\p{L}\p{N}])letter[^\p{L}\p{N}]{0,3}\p{Nd}/iu
const OPTIONS_LINE = /options\s*\(\s*from\s+ouro\s*\)\s*:/iu

/** Whether text could pass for a letter code or Ouro's own answer block once folded (design §3.4, R8-M1). */
export function hasLetterCode(text: string): boolean {
  const folded = fold(text)
  return CODE_TOKEN.test(folded) || LETTER_NUMBER.test(folded) || OPTIONS_LINE.test(folded)
}

export type LetterCheck = { ok: true; letter: LetterDraft } | { ok: false; problem: string }

class Refusal extends Error {}

function refuse(problem: string): never {
  throw new Refusal(problem)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Sender text: required or not, at most `limit` characters (counted as the schemas count them, by code point). */
function plain(name: string, value: unknown, limit: number, required: boolean): string | undefined {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) {
    if (required) refuse(`${name} is required.`)
    return undefined
  }
  if (typeof value !== "string") refuse(`${name} must be text.`)
  if ([...value].length > limit) refuse(`${name} is longer than ${limit} characters.`)
  return value
}

/** Sender text the person reads: plain, with no letter code or answer form, and hidden characters collapsed. */
function text(name: string, input: unknown, limit: number, required: boolean): string | undefined {
  const value = plain(name, input, limit, required)
  if (value === undefined) return undefined
  if (hasLetterCode(value)) refuse(`${name} contains a letter code or Ouro's answer form, which only Ouro writes. Fix: say it without a code such as L8.`)
  return storedText(value)
}

function options(kind: LetterKind, value: unknown): LetterOption[] {
  if (kind !== "decide") {
    if (value !== undefined) refuse("only a decide letter takes options; the others have Ouro's own.")
    return DEFAULT_OPTIONS[kind].map((option) => ({ ...option }))
  }
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) refuse("a decide letter needs 2 to 5 options.")
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const at = `option ${index + 1}`
    if (!isObject(entry)) refuse(`${at} must be { label, effect }.`)
    const label = text(`${at}'s label`, entry.label, LETTER_LIMITS.label, true)!
    const folded = fold(label).trim()
    if (/^\p{Nd}+$/u.test(folded)) refuse(`${at}'s label is only digits, which would read as an answer. Fix: name the choice in words.`)
    if (/[\p{Pd}\u2212]/u.test(folded)) refuse(`${at}'s label contains a dash, which Ouro uses between a label and its effect. Fix: drop the dash.`)
    const key = folded.toLowerCase()
    if (seen.has(key)) refuse(`${at}'s label repeats another label. Fix: give each option its own label.`)
    seen.add(key)
    const effect = text(`${at}'s effect`, entry.effect, LETTER_LIMITS.effect, true)!
    return { id: String(index + 1), label, effect }
  })
}

function links(value: unknown): LetterLink[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuse("links must be a list of { label, url }.")
  return value.map((entry, index) => {
    const at = `link ${index + 1}`
    if (!isObject(entry)) refuse(`${at} must be { label, url }.`)
    const label = text(`${at}'s label`, entry.label, LETTER_LIMITS.linkLabel, true)!
    const url = text(`${at}'s url`, entry.url, LETTER_LIMITS.url, true)!
    if (!/^https?:\/\//.test(url)) refuse(`${at}'s url must start with https:// or http://.`)
    return { label, url }
  })
}

function isoTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))
}

function draft(input: unknown): LetterDraft {
  if (!isObject(input)) refuse("a letter must be an object.")
  for (const key of Object.keys(input)) {
    if (SET_BY_OURO.has(key)) refuse(`${key} is set by Ouro from who calls, never by the caller. Fix: leave ${key} out.`)
    if (!SENDER_FIELDS.has(key)) refuse(`${key} is not a letter field.`)
  }
  const kind = input.kind as LetterKind
  if (!LETTER_KINDS.includes(kind)) refuse(`kind must be one of ${LETTER_KINDS.join(", ")}.`)
  const subject = text("subject", input.subject, LETTER_LIMITS.subject, true)!
  const whyOnlyYou = text("whyOnlyYou", input.whyOnlyYou, LETTER_LIMITS.whyOnlyYou, false)
  if (!whyOnlyYou && kind !== "know") refuse(`whyOnlyYou is required for a ${kind} letter. Fix: say in one line why only the person can answer.`)
  const body = text("body", input.body, LETTER_LIMITS.body, false) ?? ""
  const letterOptions = options(kind, input.options)
  const letterLinks = links(input.links)
  const urgency = (input.urgency ?? "whenever") as Urgency
  if (!URGENCIES.includes(urgency)) refuse(`urgency must be one of ${URGENCIES.join(", ")}.`)
  const holdUntil = input.holdUntil
  if (holdUntil !== undefined && (typeof holdUntil !== "string" || (holdUntil !== "interactive" && !isoTime(holdUntil)))) refuse('holdUntil must be "interactive" or an ISO time.')
  const expiresAt = input.expiresAt
  if (expiresAt !== undefined && (typeof expiresAt !== "string" || !isoTime(expiresAt))) refuse("expiresAt must be an ISO time.")
  // The person never sees the dedupe key, so it may hold anything, a code such as L2 included.
  const dedupeKey = input.dedupeKey === undefined ? undefined : plain("dedupeKey", input.dedupeKey, LETTER_LIMITS.dedupeKey, true)
  const lane = text("lane", input.lane, LETTER_LIMITS.lane, false)
  return {
    kind,
    subject,
    ...(whyOnlyYou ? { whyOnlyYou } : {}),
    body,
    options: letterOptions,
    links: letterLinks,
    ...(dedupeKey ? { dedupeKey } : {}),
    urgency,
    ...(holdUntil ? { holdUntil: holdUntil as string } : {}),
    ...(expiresAt ? { expiresAt: expiresAt as string } : {}),
    ...(lane ? { lane } : {}),
  }
}

/** Checks a sender's letter. A refusal names the field and, where it helps, the fix. */
export function checkLetterInput(input: unknown): LetterCheck {
  let result: LetterCheck
  try {
    result = { ok: true, letter: draft(input) }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error
    result = { ok: false, problem: error.message }
  }
  emitNervesEvent({
    component: "daemon",
    event: "letters.letter_checked",
    message: result.ok ? "letter accepted" : "letter refused",
    meta: { ok: result.ok, ...(result.ok ? { kind: result.letter.kind } : {}) },
  })
  return result
}

/** Checks a withdraw's reason, which the person reads like any sender text. */
export function checkWithdrawReason(input: unknown): { ok: true; reason: string } | { ok: false; problem: string } {
  try {
    return { ok: true, reason: text("reason", input, LETTER_LIMITS.reason, true)! }
  } catch (error) {
    // text() throws only a Refusal.
    return { ok: false, problem: (error as Error).message }
  }
}

/** A letter's state, derived from its events and never stored: the first closing event decides it. */
export function letterState(events: readonly LetterEvent[]): LetterState {
  for (const event of events) {
    if (event.t === "answered") return "answered"
    if (event.t === "withdrawn") return "withdrawn"
    if (event.t === "expired") return "expired"
  }
  return "waiting"
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/**
 * A new letter id: `ltr_` and a ULID, 10 characters of milliseconds then 16 random ones, so ids sort by when they were
 * filed. `random` returns a value in [0, 1); tests pass their own.
 */
export function newLetterId(now: number, random: () => number = Math.random): `ltr_${string}` {
  let time = ""
  let rest = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[rest % 32]! + time
    rest = Math.floor(rest / 32)
  }
  let tail = ""
  for (let i = 0; i < 16; i++) tail += CROCKFORD[Math.floor(random() * 32)]!
  return `ltr_${time}${tail}`
}
