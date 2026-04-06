/**
 * Commerce-specific error types and helpers.
 *
 * These errors carry structured `code` and `meta` fields for nerves event
 * compatibility and provide patterns for common commerce failure modes:
 * retry, price change detection, and partial failure reporting.
 */

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class CommerceError extends Error {
  readonly code: string
  readonly meta: Record<string, unknown>

  constructor(message: string, code: string, meta: Record<string, unknown> = {}) {
    super(message)
    this.name = "CommerceError"
    this.code = code
    this.meta = meta
  }
}

export class PaymentError extends CommerceError {
  constructor(message: string, code: string, meta: Record<string, unknown> = {}) {
    super(message, code, meta)
    this.name = "PaymentError"
  }
}

export class BookingError extends CommerceError {
  constructor(message: string, code: string, meta: Record<string, unknown> = {}) {
    super(message, code, meta)
    this.name = "BookingError"
  }
}

export class ProfileError extends CommerceError {
  constructor(message: string, code: string, meta: Record<string, unknown> = {}) {
    super(message, code, meta)
    this.name = "ProfileError"
  }
}

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

const TRANSIENT_CODES = new Set(["COMMERCE_TRANSIENT", "COMMERCE_TIMEOUT", "COMMERCE_NETWORK"])

function isTransient(err: unknown): boolean {
  return err instanceof CommerceError && TRANSIENT_CODES.has(err.code)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retry a function once on transient failure, then throw.
 * Non-transient errors are thrown immediately without retry.
 */
export async function retryOnce<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    if (!isTransient(err)) throw err
    // One retry
    return fn()
  }
}

/**
 * Throw PaymentError if the actual price differs from the approved price
 * by more than 5%. Used to protect against price changes between search
 * and booking.
 */
export function priceChangeGuard(approved: number, actual: number): void {
  if (approved === 0 && actual === 0) return
  if (approved === 0) {
    throw new PaymentError(
      `price changed from $0 to $${actual} — cannot verify percentage change`,
      "PAYMENT_PRICE_CHANGED",
      { approved, actual },
    )
  }

  const delta = Math.abs(actual - approved) / approved
  if (delta > 0.05) {
    throw new PaymentError(
      `price changed by ${(delta * 100).toFixed(1)}% (approved: $${approved}, actual: $${actual})`,
      "PAYMENT_PRICE_CHANGED",
      { approved, actual, deltaPercent: delta * 100 },
    )
  }
}

/**
 * Format a human-readable status report for multi-service booking attempts.
 * Each entry has a service name, status, and optional error message.
 */
export function partialFailureReport(
  results: Array<{ service: string; status: string; error?: string }>,
): string {
  if (results.length === 0) {
    return "no services attempted."
  }

  const lines = results.map((r) => {
    const status = r.status === "success" ? "success" : "failed"
    const detail = r.error ? ` — ${r.error}` : ""
    return `  ${r.service}: ${status}${detail}`
  })

  const succeeded = results.filter((r) => r.status === "success").length
  const failed = results.length - succeeded

  return [
    `booking status: ${succeeded} succeeded, ${failed} failed`,
    ...lines,
  ].join("\n")
}
