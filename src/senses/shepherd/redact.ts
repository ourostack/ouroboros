import { createHash } from "node:crypto"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Terminal screens and agents' last messages can show credentials. Everything Shepherd hands to a
 * model or a tool result (screen text, last messages) goes through this first. It is a best-effort net for
 * secret-shaped strings, not a guarantee, so callers also keep their output bounded.
 */
const REDACTED = "[redacted]"

const WHOLE_MATCH: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bv1\.[A-Za-z0-9_-]{40,}\.[A-Za-z0-9_-]{40,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
]

/** Keep the label (group 1), redact the value. */
const LABELLED_VALUE: RegExp[] = [
  /(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{6,}/gi,
  /(\b(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'"&]+)/gi,
  /([?&](?:token|key|api_key|access_token|sig|signature)=)[^&\s]+/gi,
]

export function redactSecrets(text: string): string {
  let result = text
  for (const pattern of WHOLE_MATCH) result = result.replace(pattern, REDACTED)
  for (const pattern of LABELLED_VALUE) result = result.replace(pattern, `$1${REDACTED}`)
  if (result !== text) {
    emitNervesEvent({ component: "senses", event: "senses.shepherd_redacted", message: "redacted secret-shaped text from cmux output", meta: { removedChars: text.length - result.length } })
  }
  return result
}

/** The last `lines` lines of a screen, without its trailing blank space. */
export function screenTail(text: string, lines: number): string {
  return text.replace(/\s+$/, "").split("\n").slice(-lines).join("\n")
}

/**
 * A screen with its numbers taken out: a timer or token counter at a waiting prompt is not the
 * screen moving on. A timer can tick, grow a unit (`59s` to `1m 0s`), and come and go between
 * redraws, shifting the padding beside it, so runs of numbers with time units vanish along with
 * the space around them, and runs of spaces and line-end padding do not count.
 */
export function withoutNumbers(screen: string): string {
  return screen.replace(/[ \t]*(\d+[hms]?[ \t]*)+/g, " ").replace(/[ \t]+/g, " ").replace(/ $/gm, "")
}

/** Lines a screen fingerprint covers, and the fewest lines a read must take to compute one. */
export const FINGERPRINT_LINES = 20
export const FINGERPRINT_READ_LINES = 40

/**
 * A short fingerprint of what a terminal shows now: its last lines, redacted, with numbers blanked so a ticking timer does
 * not count as a change. `shepherd_read` hands it out and `shepherd_send` compares it, so a key is pressed only on the
 * screen someone actually saw.
 */
export function screenFingerprint(text: string): string {
  return createHash("sha256").update(withoutNumbers(screenTail(redactSecrets(text), FINGERPRINT_LINES))).digest("hex").slice(0, 16)
}
