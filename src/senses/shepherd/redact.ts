import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Terminal screens and Feed tool input can show credentials. Everything the cmux sense hands to a
 * model (screen text, request previews) goes through this first. It is a best-effort net for
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
