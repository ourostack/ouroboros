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

const brandRegex = (): RegExp => new RegExp(BRAND_PATTERN, "gi")

/** Every brand word in `text`, in order; empty when there is none. */
export function brandHits(text: string): string[] {
  const hits = [...text.matchAll(brandRegex())].map((match) => match[0])
  if (hits.length > 0) emitNervesEvent({ component: "eval", level: "warn", event: "eval.interview_brand_hit", message: "found brand words in a text", meta: { count: hits.length } })
  return hits
}

/**
 * Fields whose string value is a provider's ciphertext: `encrypted_content`, the encrypted reasoning a Responses
 * provider returns and takes back. The model never reads it as text, and base64's letters can spell a brand word by
 * chance (the 2026-11-23 H pilot was voided on "GPT" inside one), so the brand scan and the leak check leave it out and
 * no replacement list rewrites it. Every other field, a reasoning item's summary included, is scanned.
 */
export const OPAQUE_FIELDS: ReadonlySet<string> = new Set(["encrypted_content"])

/** Whether `key` holds a provider's ciphertext: an opaque field whose value is a string. */
export const isOpaque = (key: string, value: unknown): boolean => typeof value === "string" && OPAQUE_FIELDS.has(key)

/** `value` as the JSON the brand scan reads: every opaque field's ciphertext left out (as ""), everything else as it is. */
export function scannedText(value: unknown): string {
  return JSON.stringify(value, (key, item: unknown) => isOpaque(key, item) ? "" : item)
}

/** `text` with every brand word replaced by the product's neutral word. */
export function scrubBrands(text: string, product: Product): string {
  return text.replace(brandRegex(), NEUTRAL_WORD[product])
}
