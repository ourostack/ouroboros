import { emitNervesEvent } from "../../nerves/runtime"
import type { ProviderErrorClassification } from "../core"

// Standard HTTP-error shape used by OpenAI/Anthropic SDKs.
interface HttpError extends Error { status?: number }

// Node socket / DNS error codes that indicate a transient network failure.
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
])

// Substrings the OpenAI/Anthropic SDKs use when wrapping fetch/socket failures
// into Error.message instead of an err.code.
const NETWORK_ERROR_MESSAGE_PATTERNS: readonly string[] = [
  "fetch failed",
  "socket hang up",
  "getaddrinfo",
  "request timed out", // OpenAI SDK timeout — see SDK source
  "request timeout",
  "connection error",
]

// True if the error looks like a transient network issue (no HTTP status, just
// a socket/DNS/timeout failure from the underlying transport).
export function isNetworkError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code || ""
  if (NETWORK_ERROR_CODES.has(code)) return true
  const msg = (error.message || "").toLowerCase()
  return NETWORK_ERROR_MESSAGE_PATTERNS.some((pat) => msg.includes(pat))
}

// Provider-specific overrides for the standard HTTP→classification mapping.
// Each override is consulted before the default rule for its category.
export interface ClassifyHttpOverrides {
  // True iff this error is an auth failure even when the status is missing or
  // ambiguous (e.g. Anthropic OAuth token expiry surfaces with a message but
  // no 401 status).
  isAuthFailure?: (error: Error) => boolean
  // True iff this 429 should be classified as a billing/quota cap rather than
  // a per-second rate limit (OpenAI Codex distinguishes the two by message).
  isUsageLimit?: (error: Error) => boolean
  // True iff this error counts as a server error even though its status is
  // outside the standard 5xx range (Anthropic uses 529 for "overloaded").
  isServerError?: (error: Error) => boolean
}

// Standard HTTP error → ProviderErrorClassification mapping. Providers wrap
// this with their own overrides.
export function classifyHttpError(
  error: Error,
  overrides?: ClassifyHttpOverrides,
): ProviderErrorClassification {
  const status = (error as HttpError).status
  if (overrides?.isAuthFailure?.(error) || status === 401 || status === 403) {
    return "auth-failure"
  }
  if (status === 429) {
    if (overrides?.isUsageLimit?.(error)) return "usage-limit"
    return "rate-limit"
  }
  if (overrides?.isServerError?.(error) || (status !== undefined && status >= 500)) {
    return "server-error"
  }
  if (isNetworkError(error)) return "network-error"
  return "unknown"
}

/* v8 ignore start — module-level observability event */
emitNervesEvent({
  component: "engine",
  event: "engine.error_classification_loaded",
  message: "shared provider error classification loaded",
  meta: {},
})
/* v8 ignore stop */
