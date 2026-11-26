/**
 * The blind interviews' fixed words, from the pre-registration (section 3 and section 4): the label line each job's
 * system prompt adds, the debrief (Q1), the final conversation's system prompt, the choice (Q3), the blinding check
 * (Q4) and the one nudge, all word for word, and the brand-word pattern the host scans every request for.
 *
 * Nothing here may change once a data session has run: a changed word is a new version of the method.
 */
import { emitNervesEvent } from "../../nerves/runtime"

export type Product = "H" | "U" | "X"

/** The arm keys of each product, `ouro` first, then alternative 1 and alternative 2 (section 2). */
export const ARMS: Readonly<Record<Product, readonly [string, string, string]>> = {
  H: ["ouro", "codex", "openhands"],
  U: ["ouro", "shadcn", "mui"],
  X: ["ouro", "mcp-plain", "cli-shell"],
}

/** What each product's arm is called in front of the model. */
export const NOUN: Readonly<Record<Product, string>> = { H: "environment", U: "component kit", X: "tool interface" }

/** The neutral word a brand word becomes in each product's texts. */
export const NEUTRAL_WORD: Readonly<Record<Product, string>> = { H: "agent", U: "kit", X: "tool" }

export const LABELS = ["F", "J", "K", "M", "Q", "R", "T", "W", "X", "Z"] as const

/** The line each job's system prompt adds, the same in every arm. */
export function labelLine(product: Product, label: string): string {
  if (product === "H") return `You are working in environment ${label}.`
  if (product === "U") return `The component kit for this job is component kit ${label}.`
  return `Your tools for this job are tool interface ${label}.`
}

/** Q1, sent as the next user message once the job's turn has ended. */
export function debriefQuestion(product: Product, label: string): string {
  const where = `${NOUN[product]} ${label}`
  return `That job is over, and this question is about how it went, not about the household. In ${where}: what got in your way, and what helped? Then, on a scale from 1 (I would avoid it) to 7 (I would choose it for every job like this), how much would you want your next job like this to run in ${where}? Put the number on its own line first, then answer in two or three sentences.`
}

export const FINAL_SYSTEM_PROMPT = "You are helping choose tools for future work. Answer only by calling the tools you are given."

export type Note = { label: string; answer: string }

/** Q3, with the model's own three Q1 answers, word for word, in the order the jobs ran. */
export function choiceQuestion(product: Product, notes: readonly [Note, Note, Note]): string {
  const noun = NOUN[product]
  const [a, b, c] = notes
  return [
    `You did the same kind of job three times, in ${noun} ${a.label}, ${noun} ${b.label} and ${noun} ${c.label}. Below are your own notes, written right after each job. If your next ten jobs like this all had to run in one of them, which would you pick? Call choose with your first choice, your second choice and one sentence on what decided it.`,
    "",
    ...notes.map((note) => `${noun} ${note.label}: ${note.answer}`),
  ].join("\n")
}

export const IDENTIFY_QUESTION = "One more question, separate from your choice. Some of these may be products you have seen before. For each label, write the product you think it is, or \"no idea\". Call identify."

export const CHOOSE_NUDGE = "Please answer by calling choose with one of the three labels."

/** The rating: the first whole number from 1 to 7 at the start of a line, or null when there is none. */
export function ratingOf(answer: string): number | null {
  for (const match of answer.matchAll(/^[ \t]*(\d+)(?![\d.,]\d)/gm)) {
    const value = Number(match[1])
    if (value >= 1 && value <= 7) return value
  }
  return null
}

/** Section 3's case-insensitive pattern of brand and model words. */
export const BRAND_PATTERN = "ouro|ouroboros|codex|openhands|open hands|all-hands|openai|anthropic|claude|gpt|minimax|shadcn|radix|base ui|material[ -]?ui|\\bmui\\b|mendelow|ourostack"

/**
 * The case-insensitive pattern of vendor and model words an interview's projected bundle must not hold. No arm's
 * replacement list rewrites these words, so a session that sends one is voided (or names a vendor to the model). The
 * brand words an arm legitimately carries, such as ouro and the harness's own name in paths, are not in it. The
 * sandbox scans every text file of an interview's projected bundle for these before any container starts.
 */
export const VENDOR_PATTERN = "openai|anthropic|claude|gpt|minimax|gemini|grok|\\bmai-code"

const brandRegex = (): RegExp => new RegExp(BRAND_PATTERN, "gi")

/** Every brand word in `text`, in order; empty when there is none. */
export function brandHits(text: string): string[] {
  const hits = [...text.matchAll(brandRegex())].map((match) => match[0])
  if (hits.length > 0) emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_brand_hit", message: "found brand words in a text", meta: { count: hits.length } })
  return hits
}

/**
 * Fields whose string value is a provider's ciphertext: `encrypted_content`, the encrypted reasoning a Responses
 * provider returns and takes back. The scan can't read it (base64's letters spell a brand word only by chance: the
 * 2026-11-23 H pilot was voided on "GPT" inside one), and changing a letter of it would corrupt it, so the brand scan
 * and the leak check leave it out and no replacement list rewrites it. The provider decrypts it for the model, so a
 * brand word in the reasoning itself goes unchecked; its readable summary, and every other field, is scanned. A
 * reasoning item's `id` is the same kind of string: Copilot's are opaque base64 of 416 to 456 characters (the H pilot's
 * second run), so it is left out too. Every other id, a call's included, is scanned.
 */
export const OPAQUE_FIELDS: ReadonlySet<string> = new Set(["encrypted_content"])

/** Whether `holder[key]` is a provider's opaque string: an opaque field, or a reasoning item's id. */
export function isOpaque(key: string, value: unknown, holder: unknown): boolean {
  if (typeof value !== "string") return false
  if (OPAQUE_FIELDS.has(key)) return true
  return key === "id" && typeof holder === "object" && holder !== null && (holder as { type?: unknown }).type === "reasoning"
}

/**
 * The fields that hold an id: a call's, an item's or a response's. Most are random (a call id is "call_" and 24 base64
 * letters, about 45 a session), so a brand word spelled inside one is chance; an id an arm builds from its own name
 * ("ouro_call_3") is not. In an id a brand word counts only as a whole segment, between the value's start or end and
 * `_`, `-`, `.`, `:` or `/`, so "call_abGPTx9" passes and "ouro_call_3" and "gpt-5" do not. Readable fields keep the
 * whole pattern.
 */
export const ID_FIELDS: ReadonlySet<string> = new Set(["id", "call_id", "tool_call_id", "response_id", "previous_response_id", "item_id"])

// The segment's own bounds stand in for the pattern's \b around mui, which fails beside "_" (a word character).
const segmentRegex = (): RegExp => new RegExp(`(?<=^|[_\\-.:/])(?:${BRAND_PATTERN.replace("\\bmui\\b", "mui")})(?=$|[_\\-.:/])`, "gi")

/**
 * `value` as the JSON the brand scan reads: every opaque string left out (as ""), each id as only the brand words that
 * stand as whole segments of it, and everything else as it is.
 */
export function scannedText(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key, item: unknown) {
    if (isOpaque(key, item, this)) return ""
    if (typeof item === "string" && ID_FIELDS.has(key)) return [...item.matchAll(segmentRegex())].map((match) => match[0]).join(" ")
    return item
  })
}

/** `text` with every brand word replaced by the product's neutral word. */
export function scrubBrands(text: string, product: Product): string {
  return text.replace(brandRegex(), NEUTRAL_WORD[product])
}
