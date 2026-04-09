import type { LogEvent } from "./index"

/**
 * Lowercase key names that trigger structured redaction.
 * Matched case-insensitively against meta object keys.
 */
export const SENSITIVE_KEYS = new Set([
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
  "apikey",
  "oauthaccesstoken",
  "authorization",
  "cookie",
  "set-cookie",
])

/**
 * Regex patterns for string-level fallback redaction.
 * Applied in order; each match is replaced with `[REDACTED:name]`.
 */
export const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9_-]+/g },
  { name: "openai_key", pattern: /sk-proj-[A-Za-z0-9_-]+/g },
  { name: "bearer_token", pattern: /Bearer [A-Za-z0-9\-_.]+/g },
  { name: "api_key_assignment", pattern: /api[_-]?key[=:]\s*["']?[A-Za-z0-9\-_.]+/g },
  { name: "url_token", pattern: /[?&](?:token|key|api_key|access_token)=[A-Za-z0-9\-_.%]+/g },
]

/**
 * Deep-clone meta and replace values at sensitive keys with `[REDACTED:key_name]`.
 * Recurses into nested objects. Case-insensitive key matching.
 */
export function redactMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(meta)) {
    const value = meta[key]
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = `[REDACTED:${key}]`
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[key] = redactMeta(value as Record<string, unknown>)
    } else {
      result[key] = value
    }
  }
  return result
}

/**
 * Apply all regex patterns to a string, replacing matches with `[REDACTED:pattern_name]`.
 */
export function redactString(text: string): string {
  let result = text
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0
    result = result.replace(pattern, `[REDACTED:${name}]`)
  }
  return result
}

/**
 * Full redaction pipeline: redact meta (structured keys), then redact message (regex patterns).
 * Returns a new LogEvent -- never mutates the input.
 */
export function redactLogEntry(entry: LogEvent): LogEvent {
  const redactedMeta = redactMeta(entry.meta)
  const redactedMessage = redactString(entry.message)
  return {
    ...entry,
    meta: redactedMeta,
    message: redactedMessage,
  }
}
