/**
 * Soft/hard timeout pattern for boot-path operations — Layer 2.
 *
 * Soft timeout = "log a warning, keep going". The op continues; the consumer
 * records the warning and moves on.
 * Hard timeout = "abort the op via AbortSignal". The underlying op is
 * expected to honour the signal (Node child_process accepts `{ signal }`,
 * fetch accepts `{ signal }`, etc.). When the signal aborts, the op should
 * reject with an AbortError, and the wrapper returns
 * `{ classification: "timeout-hard" }` rather than re-throwing.
 *
Two optional env overrides (currently only `GIT` is consumed):
 *   - `OURO_BOOT_TIMEOUT_GIT_SOFT` / `OURO_BOOT_TIMEOUT_GIT_HARD` — boot
 *     git operations (fetch / pull). Used when `envKey === "GIT"`.
 *
 * Env values are parsed as integer milliseconds. Non-numeric or non-positive
 * values are ignored (the explicit `softMs` / `hardMs` defaults from the
 * caller win in that case).
 *
 * Pattern guarantee: timers cleared on resolve / reject so the function
 * holds no refs after settlement. Important because `ouro up` chains
 * many of these and a leaking timer would block process exit.
 */

export type TimeoutEnvKey = "GIT"

export interface RunWithTimeoutsOptions {
  /** Soft warning threshold in ms — emit a warning, do NOT abort. */
  softMs: number
  /** Hard abort threshold in ms — abort the AbortSignal. */
  hardMs: number
  /** Human-readable label used in warning text. */
  label: string
  /**
   * When set, consult the corresponding env vars
   * (`OURO_BOOT_TIMEOUT_GIT_SOFT` / `OURO_BOOT_TIMEOUT_GIT_HARD` for `"GIT"`)
   * to override `softMs` / `hardMs`.
   */
  envKey?: TimeoutEnvKey
}

export interface RunWithTimeoutsOutcome<T> {
  /** Set when the op resolved before hard timeout. */
  result?: T
  /**
   * Set when the op was aborted via AbortSignal.
   *
   * Note: `runWithTimeouts` only ever produces `"timeout-hard"`. The
   * `"timeout-soft"` literal exists in the union for symmetry with
   * `SyncClassification`, but the soft path is *not* a classification — it's
   * a warning surfaced via `warnings[]` while the op continues.
   */
  classification?: "timeout-soft" | "timeout-hard"
  /** Soft-timeout warnings (one entry per soft trip). */
  warnings: string[]
}

function readEnvMs(name: string): number | null {
  const raw = process.env[name]
  if (raw === undefined || raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed
}

function resolveTimeouts(options: RunWithTimeoutsOptions): { softMs: number; hardMs: number } {
  let softMs = options.softMs
  let hardMs = options.hardMs

  if (options.envKey === "GIT") {
    const envSoft = readEnvMs("OURO_BOOT_TIMEOUT_GIT_SOFT")
    if (envSoft !== null) softMs = envSoft
    const envHard = readEnvMs("OURO_BOOT_TIMEOUT_GIT_HARD")
    if (envHard !== null) hardMs = envHard
  }

  return { softMs, hardMs }
}

/**
 * Run `fn` with soft and hard timeouts.
 *
 * - Returns `{ result }` on success.
 * - Returns `{ classification: "timeout-hard", warnings }` when aborted.
 * - Returns `{ result, warnings: [...] }` when soft tripped but op completed.
 * - Rejects when `fn` throws a non-abort error (callers can wrap with
 *   classifier).
 */
export async function runWithTimeouts<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RunWithTimeoutsOptions,
): Promise<RunWithTimeoutsOutcome<T>> {
  const { softMs, hardMs } = resolveTimeouts(options)
  const controller = new AbortController()
  const warnings: string[] = []

  let softTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    softTimer = null
    warnings.push(`${options.label}: soft timeout exceeded (${softMs}ms) — warning, continuing until hard cut`)
  }, softMs)

  let hardTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    hardTimer = null
    controller.abort()
  }, hardMs)

  const cleanup = (): void => {
    if (softTimer !== null) {
      clearTimeout(softTimer)
      softTimer = null
    }
    if (hardTimer !== null) {
      clearTimeout(hardTimer)
      hardTimer = null
    }
  }

  try {
    const result = await fn(controller.signal)
    cleanup()
    // If the abort fired and the op resolved gracefully (e.g., the inner
    // function caught the AbortError and returned a structured result), we
    // still classify the outcome as timeout-hard — the op was aborted from
    // the caller's perspective even if no exception propagated. The caller
    // can ignore the classification and use `result` if both are present.
    if (controller.signal.aborted) {
      return { classification: "timeout-hard", warnings }
    }
    return { result, warnings }
  } catch (err) {
    cleanup()
    if (controller.signal.aborted) {
      // Hard timeout fired — abort wins over whatever error the op threw.
      return { classification: "timeout-hard", warnings }
    }
    throw err
  }
}
