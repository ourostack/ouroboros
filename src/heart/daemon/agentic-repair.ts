/**
 * Agentic repair flow for degraded agents detected during `ouro up`.
 *
 * Runs known local repair prompts first, then offers AI-assisted diagnosis
 * when no local repair was attempted and a working LLM provider is available.
 * This is a lightweight integration: one diagnostic LLM call, not a chat loop.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import {
  hasRunnableInteractiveRepair,
  isAffirmativeAnswer,
  type DegradedAgent,
  type InteractiveRepairDeps,
  type InteractiveRepairResult,
} from "./interactive-repair"
import type { DiscoverWorkingProviderResult } from "./provider-discovery"
import type { AgentProvider } from "../identity"
import { createProviderRuntimeForConfig, type ProviderRuntimeConfig } from "../provider-ping"
import type OpenAI from "openai"
import { isKnownReadinessIssue } from "./readiness-repair"

/** Minimal subset of ProviderRuntime needed for a single diagnostic call. */
export interface AgenticProviderRuntime {
  streamTurn(request: {
    messages: OpenAI.ChatCompletionMessageParam[]
    activeTools: OpenAI.ChatCompletionFunctionTool[]
    callbacks: {
      onModelStart(): void
      onModelStreamStart(): void
      onTextChunk(text: string): void
      onReasoningChunk(text: string): void
      onToolStart(name: string, args: Record<string, string>): void
      onToolEnd(name: string, summary: string, success: boolean): void
      onError(error: Error, severity: "transient" | "terminal"): void
    }
    signal?: AbortSignal
  }): Promise<{ content: string; toolCalls: { id: string; name: string; arguments: string }[] }>
}

export interface AgenticRepairDeps {
  discoverWorkingProvider: (agentName: string) => Promise<DiscoverWorkingProviderResult | null>
  runInteractiveRepair: (degraded: DegradedAgent[], deps: InteractiveRepairDeps) => Promise<InteractiveRepairResult>
  promptInput: (prompt: string) => Promise<string>
  writeStdout: (msg: string) => void
  createProviderRuntime: (provider: DiscoverWorkingProviderResult) => AgenticProviderRuntime
  readDaemonLogsTail: () => string
  /** Auth flow runner passed through to interactive repair fallback */
  runAuthFlow?: (agent: string, provider?: AgentProvider) => Promise<void>
  /** Vault unlock runner passed through to interactive repair fallback */
  runVaultUnlock?: (agent: string) => Promise<void>
}

export interface AgenticRepairResult {
  repairsAttempted: boolean
  usedAgentic: boolean
}

function buildSystemPrompt(degraded: DegradedAgent[]): string {
  const agentList = degraded
    .map((d) => `- ${d.agent}: error="${d.errorReason}", hint="${d.fixHint}"`)
    .join("\n")

  return [
    "You are a diagnostic assistant for the Ouroboros agent daemon.",
    "The daemon detected degraded agents during startup.",
    "Analyze the errors below and provide a concise diagnosis with suggested fixes.",
    "",
    "Degraded agents:",
    agentList,
    "",
    "Keep your response brief and actionable. Focus on the most likely root cause",
    "and the simplest fix the user can apply.",
  ].join("\n")
}

function buildUserMessage(degraded: DegradedAgent[], logsTail: string): string {
  const agentDetails = degraded
    .map((d) => `Agent: ${d.agent}\n  Error: ${d.errorReason}\n  Fix hint: ${d.fixHint}`)
    .join("\n\n")

  return [
    "Here are the degraded agents and recent daemon logs:",
    "",
    agentDetails,
    "",
    "Recent daemon logs:",
    logsTail,
    "",
    "What is the most likely cause and how should I fix it?",
  ].join("\n")
}

function makeInteractiveRepairDeps(deps: AgenticRepairDeps): InteractiveRepairDeps {
  return {
    promptInput: deps.promptInput,
    writeStdout: deps.writeStdout,
    /* v8 ignore next -- fallback no-op: tests always inject runAuthFlow; default is for production @preserve */
    runAuthFlow: deps.runAuthFlow ?? (async () => undefined),
    runVaultUnlock: deps.runVaultUnlock,
  }
}

async function runDeterministicRepair(
  degraded: DegradedAgent[],
  deps: AgenticRepairDeps,
): Promise<InteractiveRepairResult> {
  return deps.runInteractiveRepair(degraded, makeInteractiveRepairDeps(deps))
}

function discoveredProviderModel(provider: DiscoverWorkingProviderResult): string | undefined {
  const model = provider.providerConfig.model?.trim()
  return model ? model : undefined
}

export function createAgenticDiagnosisProviderRuntime(
  provider: DiscoverWorkingProviderResult,
): AgenticProviderRuntime {
  const config = {
    ...provider.providerConfig,
    ...provider.credentials,
  } as unknown as ProviderRuntimeConfig
  return createProviderRuntimeForConfig(provider.provider, config, {
    model: discoveredProviderModel(provider),
  })
}

async function tryAgenticDiagnosis(
  degraded: DegradedAgent[],
  provider: DiscoverWorkingProviderResult,
  deps: AgenticRepairDeps,
): Promise<boolean> {
  const logsTail = deps.readDaemonLogsTail()
  const runtime = deps.createProviderRuntime(provider)

  const systemPrompt = buildSystemPrompt(degraded)
  const userMessage = buildUserMessage(degraded, logsTail)

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ]

  /* v8 ignore start -- no-op callbacks: satisfy interface contract, never invoked by diagnostic call @preserve */
  const noopCallbacks = {
    onModelStart: () => {},
    onModelStreamStart: () => {},
    onTextChunk: () => {},
    onReasoningChunk: () => {},
    onToolStart: () => {},
    onToolEnd: () => {},
    onError: () => {},
  }
  /* v8 ignore stop */

  const result = await runtime.streamTurn({
    messages,
    activeTools: [],
    callbacks: noopCallbacks,
  })

  if (result.content) {
    deps.writeStdout("")
    deps.writeStdout("--- AI Diagnosis ---")
    deps.writeStdout(result.content)
    deps.writeStdout("--- End Diagnosis ---")
    deps.writeStdout("")
  }

  return true
}

export async function runAgenticRepair(
  degraded: DegradedAgent[],
  deps: AgenticRepairDeps,
): Promise<AgenticRepairResult> {
  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.agentic_repair_start",
    message: "agentic repair flow started",
    meta: { degradedCount: degraded.length },
  })

  if (degraded.length === 0) {
    return { repairsAttempted: false, usedAgentic: false }
  }

  const hasLocalRepair = degraded.some(hasRunnableInteractiveRepair)
  const hasKnownTypedRepair = degraded.some((entry) => isKnownReadinessIssue(entry.issue))
  if (hasLocalRepair) {
    const interactiveResult = await runDeterministicRepair(degraded, deps)
    if (interactiveResult.repairsAttempted) {
      return { repairsAttempted: true, usedAgentic: false }
    }
    if (hasKnownTypedRepair) {
      return { repairsAttempted: false, usedAgentic: false }
    }
  } else if (hasKnownTypedRepair) {
    return { repairsAttempted: false, usedAgentic: false }
  }

  // Try to discover a working provider for agentic diagnosis
  let discoveredProvider: DiscoverWorkingProviderResult | null = null
  try {
    discoveredProvider = await deps.discoverWorkingProvider(degraded[0].agent)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.agentic_repair_discovery_error",
      message: `provider discovery failed during agentic repair: ${msg}`,
      meta: { error: msg },
    })
  }

  if (!discoveredProvider) {
    // No working provider — fall back to deterministic repair
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.agentic_repair_no_provider",
      message: "no working provider found, falling back to deterministic repair",
      meta: {},
    })
    if (hasLocalRepair) {
      return { repairsAttempted: false, usedAgentic: false }
    }
    const interactiveResult = await runDeterministicRepair(degraded, deps)
    return { repairsAttempted: interactiveResult.repairsAttempted, usedAgentic: false }
  }

  // Offer agentic diagnosis
  const answer = await deps.promptInput("would you like AI-assisted diagnosis? [y/n] ")

  if (!isAffirmativeAnswer(answer)) {
    // User declined — fall back to deterministic repair
    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.agentic_repair_declined",
      message: "user declined agentic diagnosis",
      meta: {},
    })
    if (hasLocalRepair) {
      return { repairsAttempted: false, usedAgentic: false }
    }
    const interactiveResult = await runDeterministicRepair(degraded, deps)
    return { repairsAttempted: interactiveResult.repairsAttempted, usedAgentic: false }
  }

  // User accepted — run agentic diagnosis then fall through to deterministic repair
  let usedAgentic = false
  try {
    usedAgentic = await tryAgenticDiagnosis(degraded, discoveredProvider, deps)

    emitNervesEvent({
      level: "info",
      component: "daemon",
      event: "daemon.agentic_repair_diagnosis_complete",
      message: "agentic diagnosis completed, proceeding to deterministic repair",
      meta: { provider: discoveredProvider.provider },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    deps.writeStdout(`AI diagnosis failed: ${msg}`)
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.agentic_repair_diagnosis_error",
      message: `agentic diagnosis failed: ${msg}`,
      meta: { error: msg, provider: discoveredProvider.provider },
    })
  }

  // Always fall through to deterministic repair for actionable fixes
  const interactiveResult = hasLocalRepair
    ? { repairsAttempted: false }
    : await runDeterministicRepair(degraded, deps)

  emitNervesEvent({
    level: "info",
    component: "daemon",
    event: "daemon.agentic_repair_end",
    message: "agentic repair flow completed",
    meta: { usedAgentic, repairsAttempted: interactiveResult.repairsAttempted },
  })

  return { repairsAttempted: interactiveResult.repairsAttempted, usedAgentic }
}
