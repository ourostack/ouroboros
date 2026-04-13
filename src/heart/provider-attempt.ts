import { emitNervesEvent } from "../nerves/runtime"
import type { AgentProvider } from "./identity"
import type { ProviderErrorClassification } from "./core"

export interface ProviderAttemptPolicy {
  maxAttempts: number
  baseDelayMs: number
  backoffMultiplier: number
}

export interface ProviderAttemptRecord {
  attempt: number
  provider: AgentProvider
  model: string
  operation: string
  ok: boolean
  classification?: ProviderErrorClassification
  errorMessage?: string
  httpStatus?: number | null
  willRetry: boolean
  delayMs?: number
}

export type ProviderAttemptResult<T> =
  | { ok: true; value: T; attempts: ProviderAttemptRecord[] }
  | { ok: false; error: Error; classification: ProviderErrorClassification; attempts: ProviderAttemptRecord[] }

export interface RunProviderAttemptInput<T> {
  operation: string
  provider: AgentProvider
  model: string
  run: () => Promise<T>
  classifyError: (error: Error) => ProviderErrorClassification
  policy?: Partial<ProviderAttemptPolicy>
  sleep?: (delayMs: number) => Promise<void>
}

interface HttpError extends Error {
  status?: number
}

export const DEFAULT_PROVIDER_ATTEMPT_POLICY: ProviderAttemptPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  backoffMultiplier: 2,
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function normalizePolicy(policy?: Partial<ProviderAttemptPolicy>): ProviderAttemptPolicy {
  return {
    ...DEFAULT_PROVIDER_ATTEMPT_POLICY,
    ...policy,
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function classify(error: unknown, classifyError: (error: Error) => ProviderErrorClassification): ProviderErrorClassification {
  if (!(error instanceof Error)) return "unknown"
  try {
    return classifyError(error)
  } catch {
    return "unknown"
  }
}

function httpStatus(error: Error): number | null {
  const status = (error as HttpError).status
  return typeof status === "number" ? status : null
}

function delayForAttempt(policy: ProviderAttemptPolicy, attempt: number): number {
  return policy.baseDelayMs * Math.pow(policy.backoffMultiplier, attempt - 1)
}

export async function runProviderAttempt<T>(input: RunProviderAttemptInput<T>): Promise<ProviderAttemptResult<T>> {
  const policy = normalizePolicy(input.policy)
  const maxAttempts = Math.max(1, Math.floor(policy.maxAttempts))
  const wait = input.sleep ?? sleep
  const attempts: ProviderAttemptRecord[] = []

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const value = await input.run()
      attempts.push({
        attempt,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        ok: true,
        willRetry: false,
      })
      emitNervesEvent({
        component: "engine",
        event: "engine.provider_attempt_succeeded",
        message: "provider attempt succeeded",
        meta: { provider: input.provider, model: input.model, operation: input.operation, attempt, maxAttempts },
      })
      return { ok: true, value, attempts }
    } catch (caught) {
      const error = toError(caught)
      const classification = classify(caught, input.classifyError)
      const willRetry = attempt < maxAttempts
      const delayMs = willRetry ? delayForAttempt(policy, attempt) : undefined
      attempts.push({
        attempt,
        provider: input.provider,
        model: input.model,
        operation: input.operation,
        ok: false,
        classification,
        errorMessage: error.message,
        httpStatus: httpStatus(error),
        willRetry,
        ...(delayMs !== undefined ? { delayMs } : {}),
      })

      if (!willRetry) {
        emitNervesEvent({
          level: "warn",
          component: "engine",
          event: "engine.provider_attempt_failed",
          message: "provider attempt failed",
          meta: {
            provider: input.provider,
            model: input.model,
            operation: input.operation,
            attempt,
            maxAttempts,
            classification,
            errorMessage: error.message.slice(0, 200),
            httpStatus: httpStatus(error),
          },
        })
        return { ok: false, error, classification, attempts }
      }

      const retryDelayMs = delayMs ?? 0
      emitNervesEvent({
        component: "engine",
        event: "engine.provider_attempt_retry",
        message: "provider attempt failed; retrying",
        meta: {
          provider: input.provider,
          model: input.model,
          operation: input.operation,
          attempt,
          maxAttempts,
          classification,
          errorMessage: error.message.slice(0, 200),
          httpStatus: httpStatus(error),
          delayMs: retryDelayMs,
        },
      })
      await wait(retryDelayMs)
    }
  }

  /* v8 ignore next 2 -- defensive: loop always returns on success or final failure @preserve */
  return { ok: false, error: new Error("provider attempt loop ended unexpectedly"), classification: "unknown", attempts }
}
