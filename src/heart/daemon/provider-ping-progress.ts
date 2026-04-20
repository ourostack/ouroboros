import type { AgentProvider } from "../identity"
import type { ProviderPingOptions } from "../provider-ping"
import type { ProviderAttemptRecord } from "../provider-attempt"
import { emitNervesEvent } from "../../nerves/runtime"

interface ProviderPingProgressContext {
  provider: AgentProvider
  model?: string
}

function formatProviderPingLabel(context: ProviderPingProgressContext): string {
  return context.model ? `${context.provider} / ${context.model}` : context.provider
}

function providerRetryReason(record: ProviderAttemptRecord): string {
  switch (record.classification) {
    case "auth-failure":
      return "credentials were rejected"
    case "usage-limit":
      return "usage limit hit"
    case "rate-limit":
      return "provider asked us to slow down"
    case "server-error":
      return record.httpStatus === 529 ? "provider is busy right now" : "provider is having trouble right now"
    case "network-error":
      return "network connection dropped"
    case "unknown":
      return "last check failed"
    default:
      return "last check failed"
  }
}

function providerRetryTiming(delayMs?: number): string {
  if (!delayMs || delayMs <= 0) return "now"
  const seconds = delayMs / 1000
  const rounded = Number.isInteger(seconds) ? `${seconds.toFixed(0)}s` : `${seconds.toFixed(1).replace(/\.0$/, "")}s`
  return `in ${rounded}`
}

export function formatProviderAttemptProgress(
  context: ProviderPingProgressContext,
  attempt: number,
  maxAttempts: number,
): string {
  return `checking ${formatProviderPingLabel(context)} (attempt ${attempt} of ${maxAttempts})...`
}

export function formatProviderRetryProgress(
  record: ProviderAttemptRecord,
  maxAttempts: number,
): string {
  const nextAttempt = Math.min(record.attempt + 1, maxAttempts)
  return `${formatProviderPingLabel(record)}: ${providerRetryReason(record)}; retrying ${providerRetryTiming(record.delayMs)} (attempt ${nextAttempt} of ${maxAttempts})`
}

export function createProviderPingProgressReporter(
  context: ProviderPingProgressContext,
  onProgress: (message: string) => void,
): Pick<ProviderPingOptions, "onAttemptStart" | "onRetry"> {
  return {
    onAttemptStart: async (attempt, maxAttempts) => {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.provider_ping_progress_reported",
        message: "reported provider ping attempt progress",
        meta: {
          provider: context.provider,
          model: context.model ?? null,
          kind: "attempt",
          attempt,
          maxAttempts,
        },
      })
      onProgress(formatProviderAttemptProgress(context, attempt, maxAttempts))
    },
    onRetry: async (record, maxAttempts) => {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.provider_ping_progress_reported",
        message: "reported provider ping retry progress",
        meta: {
          provider: record.provider,
          model: record.model,
          kind: "retry",
          attempt: record.attempt,
          maxAttempts,
          classification: record.classification ?? "unknown",
        },
      })
      onProgress(formatProviderRetryProgress(record, maxAttempts))
    },
  }
}
