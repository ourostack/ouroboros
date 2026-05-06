/**
 * Agentic repair flow for degraded agents detected during `ouro up`.
 *
 * Runs known local repair prompts first, then offers AI-assisted diagnosis
 * when no local repair was attempted and a working LLM provider is available.
 * This is a lightweight integration: one diagnostic LLM call, not a chat loop.
 */

import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  hasRunnableInteractiveRepair,
  isAffirmativeAnswer,
  type DegradedAgent,
  type InteractiveRepairDeps,
  type InteractiveRepairResult,
} from "./interactive-repair"
import type { DiscoverWorkingProviderResult } from "./provider-discovery"
import { getRepoRoot, type AgentProvider } from "../identity"
import { createProviderRuntimeForConfig, type ProviderRuntimeConfig } from "../provider-ping"
import type OpenAI from "openai"
import { isKnownReadinessIssue, type RepairAction, type RepairActionKind } from "./readiness-repair"
import type { BootSyncProbeFinding } from "./boot-sync-probe"

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
  /** Skip repair queue summary when it would duplicate the status block */
  skipQueueSummary?: boolean
  /** Whether stdout is a tty-capable interactive surface */
  isTTY?: boolean
  /** Current stdout width for tty rendering */
  stdoutColumns?: number
  /**
   * Layer 3: when true, bypass the typed-issues early-return so the diagnostic
   * LLM call still fires. The cli-exec call site sets this when the activation
   * contract fires solely on typed-stacking (`typedDegraded >= 3`,
   * `untypedDegraded === 0`) — the deterministic typed repair already ran
   * above and the operator now needs RepairGuide-driven advice on the
   * compound situation.
   */
  forceDiagnosis?: boolean
  /**
   * Layer 3: optional override for the repo root the RepairGuide loader
   * reads from. Production wiring leaves this undefined so the loader uses
   * `getRepoRoot()`; tests inject a fixture path.
   */
  repoRootOverride?: string
  /**
   * Layer 3: structured sync-probe findings collected during boot
   * (Layer 2's `runBootSyncProbe`). Threaded into the RepairGuide
   * diagnostic prompt as a JSON block so the `diagnose-broken-remote`
   * and `diagnose-sync-blocked` skills have the actual classification +
   * conflict-files data to reason over. Empty array (or omitted) means
   * no sync findings to report.
   */
  syncFindings?: BootSyncProbeFinding[]
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

function buildUserMessage(
  degraded: DegradedAgent[],
  logsTail: string,
  syncFindings: BootSyncProbeFinding[] = [],
): string {
  const agentDetails = degraded
    .map((d) => `Agent: ${d.agent}\n  Error: ${d.errorReason}\n  Fix hint: ${d.fixHint}`)
    .join("\n\n")

  const sections: string[] = [
    "Here are the degraded agents and recent daemon logs:",
    "",
    agentDetails,
    "",
    "Recent daemon logs:",
    logsTail,
  ]

  // Layer 3: thread Layer 2's structured sync-probe findings into the
  // prompt as a JSON block. `diagnose-broken-remote` (auth/404/network/
  // timeout-hard) and `diagnose-sync-blocked` (dirty/non-fast-forward/
  // merge-conflict/timeout-soft) consume this shape.
  if (syncFindings.length > 0) {
    sections.push(
      "",
      "bootSyncFindings (BootSyncProbeFinding[]):",
      "```json",
      JSON.stringify(syncFindings, null, 2),
      "```",
    )
  }

  sections.push("", "What is the most likely cause and how should I fix it?")
  return sections.join("\n")
}

function makeInteractiveRepairDeps(deps: AgenticRepairDeps): InteractiveRepairDeps {
  return {
    promptInput: deps.promptInput,
    writeStdout: deps.writeStdout,
    /* v8 ignore next -- fallback no-op: tests always inject runAuthFlow; default is for production @preserve */
    runAuthFlow: deps.runAuthFlow ?? (async () => undefined),
    runVaultUnlock: deps.runVaultUnlock,
    skipQueueSummary: deps.skipQueueSummary,
    isTTY: deps.isTTY,
    stdoutColumns: deps.stdoutColumns,
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

/**
 * Layer 3: build the system prompt for the diagnostic call. Prepends
 * RepairGuide bundle content (`psyche/SOUL.md`, `psyche/IDENTITY.md`, all
 * skills) when the bundle is present and readable; falls back to today's
 * pre-RepairGuide prompt when the loader returns null.
 */
function buildSystemPromptWithRepairGuide(
  degraded: DegradedAgent[],
  repairGuide: RepairGuideContent | null,
): string {
  const basePrompt = buildSystemPrompt(degraded)
  if (repairGuide === null) return basePrompt

  const sections: string[] = []
  if (repairGuide.psyche.soul) {
    sections.push("# RepairGuide SOUL\n\n" + repairGuide.psyche.soul)
  }
  if (repairGuide.psyche.identity) {
    sections.push("# RepairGuide IDENTITY\n\n" + repairGuide.psyche.identity)
  }
  for (const [name, body] of Object.entries(repairGuide.skills)) {
    sections.push(`# RepairGuide skill: ${name}\n\n${body}`)
  }
  if (sections.length === 0) return basePrompt
  return [...sections, "---", basePrompt].join("\n\n")
}

async function tryAgenticDiagnosis(
  degraded: DegradedAgent[],
  provider: DiscoverWorkingProviderResult,
  deps: AgenticRepairDeps,
): Promise<boolean> {
  const logsTail = deps.readDaemonLogsTail()
  const runtime = deps.createProviderRuntime(provider)

  // Layer 3: prepend RepairGuide bundle content when present. Loader
  // returns null on missing bundle / I/O error — caller silently falls back
  // to today's pre-RepairGuide prompt.
  const repoRoot = deps.repoRootOverride ?? getRepoRoot()
  const repairGuide = loadRepairGuideContent(repoRoot)
  const systemPrompt = buildSystemPromptWithRepairGuide(degraded, repairGuide)
  const userMessage = buildUserMessage(
    degraded,
    logsTail,
    deps.syncFindings,
  )

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
    // Layer 3: when RepairGuide content was prepended, parse the LLM output
    // through the typed-action catalog. If actions are extracted, surface
    // them as structured proposals; otherwise fall back to today's plain
    // text-blob diagnosis. `parseRepairProposals` handles the unparseable
    // case by returning `fallbackBlob` set to the raw output.
    if (repairGuide !== null) {
      const parsed = parseRepairProposals(result.content)
      if (parsed.actions.length > 0) {
        deps.writeStdout("")
        deps.writeStdout("--- RepairGuide proposals ---")
        for (const action of parsed.actions) {
          deps.writeStdout(`  • ${action.kind}: ${action.label}`)
        }
        for (const warning of parsed.warnings) {
          deps.writeStdout(`  (warning) ${warning}`)
        }
        deps.writeStdout("--- End RepairGuide proposals ---")
        deps.writeStdout("")
      } else if (parsed.fallbackBlob !== undefined) {
        deps.writeStdout("")
        deps.writeStdout("--- AI Diagnosis ---")
        deps.writeStdout(parsed.fallbackBlob)
        deps.writeStdout("--- End Diagnosis ---")
        deps.writeStdout("")
      }
    } else {
      deps.writeStdout("")
      deps.writeStdout("--- AI Diagnosis ---")
      deps.writeStdout(result.content)
      deps.writeStdout("--- End Diagnosis ---")
      deps.writeStdout("")
    }
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
  const forceDiagnosis = deps.forceDiagnosis === true
  if (hasLocalRepair) {
    const interactiveResult = await runDeterministicRepair(degraded, deps)
    if (interactiveResult.repairsAttempted) {
      return { repairsAttempted: true, usedAgentic: false }
    }
    if (hasKnownTypedRepair && !forceDiagnosis) {
      return { repairsAttempted: false, usedAgentic: false }
    }
  } else if (hasKnownTypedRepair && !forceDiagnosis) {
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

// ──────────────────────────────────────────────────────────────────────
// Layer 3: RepairGuide activation contract
// ──────────────────────────────────────────────────────────────────────

/**
 * Threshold for compound typed-degraded findings to activate RepairGuide.
 * Set to 3 (not 2) so that common pairs — vault-locked + provider-auth-needed,
 * for example — do NOT trigger the new path on every boot. Encoded once here;
 * never duplicate at call sites.
 */
const REPAIR_GUIDE_TYPED_THRESHOLD = 3

export interface ShouldFireRepairGuideInput {
  /** Degraded findings whose `issue` is NOT in the typed `RepairAction` catalog. */
  untypedDegraded: DegradedAgent[]
  /** Degraded findings whose `issue` IS in the typed `RepairAction` catalog. */
  typedDegraded: DegradedAgent[]
  /** Operator's `--no-repair` flag — short-circuits the entire decision. */
  noRepair: boolean
}

/**
 * Single decision function for whether to fire the RepairGuide-driven
 * diagnostic flow.
 *
 * Contract (LOCKED, planning O4):
 * - `noRepair: true` → false unconditionally (escape hatch).
 * - `untypedDegraded.length > 0` → true (preserves today's gate at
 *   `cli-exec.ts:6706`).
 * - `typedDegraded.length >= REPAIR_GUIDE_TYPED_THRESHOLD` → true (compound
 *   stack of typed issues; the new behavior this PR introduces).
 * - Otherwise → false.
 */
export function shouldFireRepairGuide(input: ShouldFireRepairGuideInput): boolean {
  if (input.noRepair) return false
  if (input.untypedDegraded.length > 0) return true
  if (input.typedDegraded.length >= REPAIR_GUIDE_TYPED_THRESHOLD) return true
  return false
}

// ──────────────────────────────────────────────────────────────────────
// Layer 3: RepairGuide bundle loader
// ──────────────────────────────────────────────────────────────────────

/**
 * Structured content loaded from `RepairGuide.ouro/`. Returned to callers that
 * want to prepend it to the diagnostic LLM call's system prompt. Both `psyche`
 * fields and the `skills` map may be partially populated — graceful degradation
 * is the rule (any missing piece is OK; a broken bundle returns `null`).
 */
export interface RepairGuideContent {
  psyche: { soul?: string; identity?: string }
  /** Filename → file content. Sorted alphabetically by filename. */
  skills: Record<string, string>
}

/**
 * Read `RepairGuide.ouro/{psyche,skills}/*.md` from the given repo root and
 * return a structured shape suitable for prepending to a diagnostic LLM call.
 *
 * Behavior:
 * - Returns `null` if `RepairGuide.ouro/` does not exist at all (graceful: caller
 *   should fall back to today's pre-RepairGuide pipeline).
 * - Returns `null` on any I/O error (`readdirSync`/`readFileSync` throws).
 * - Returns a populated `RepairGuideContent` when the bundle exists, even if
 *   psyche or skills are partially populated.
 * - Skips files that are not `.md`, are not regular files, or have empty
 *   contents.
 * - `skills` map is iterated in alphabetical order so callers can rely on
 *   deterministic prompt assembly.
 *
 * The loader is intentionally inline in `agentic-repair.ts` per the planning
 * O5 lock — splitting into its own module is allowed only if the validator
 * grows large.
 */
export function loadRepairGuideContent(repoRoot: string): RepairGuideContent | null {
  const bundleRoot = path.join(repoRoot, "RepairGuide.ouro")
  if (!fs.existsSync(bundleRoot)) return null

  try {
    const psyche: RepairGuideContent["psyche"] = {}
    const skills: RepairGuideContent["skills"] = {}

    const psycheDir = path.join(bundleRoot, "psyche")
    if (fs.existsSync(psycheDir)) {
      const psycheEntries = fs.readdirSync(psycheDir, { withFileTypes: true })
      for (const entry of psycheEntries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue
        const content = fs.readFileSync(path.join(psycheDir, entry.name), "utf-8")
        if (entry.name === "SOUL.md") psyche.soul = content
        else if (entry.name === "IDENTITY.md") psyche.identity = content
      }
    }

    const skillsDir = path.join(bundleRoot, "skills")
    if (fs.existsSync(skillsDir)) {
      const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      const sorted = skillEntries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name))
      for (const entry of sorted) {
        const content = fs.readFileSync(path.join(skillsDir, entry.name), "utf-8")
        if (content.length === 0) continue
        skills[entry.name] = content
      }
    }

    return { psyche, skills }
  } catch {
    // Best-effort: any I/O error in the bundle leads to null and the caller
    // falls back to today's pre-RepairGuide diagnostic prompt.
    return null
  }
}

// ──────────────────────────────────────────────────────────────────────
// Layer 3: RepairGuide LLM output parser → typed `RepairAction[]`
// ──────────────────────────────────────────────────────────────────────

/**
 * The set of `RepairActionKind` literals the typed catalog recognizes.
 * Encoded once here; the parser uses this for membership checks. Any other
 * kind in the LLM output is dropped with a warning.
 */
const KNOWN_REPAIR_ACTION_KINDS: ReadonlySet<RepairActionKind> = new Set<RepairActionKind>([
  "vault-create",
  "vault-unlock",
  "vault-replace",
  "vault-recover",
  "provider-auth",
  "provider-retry",
  "provider-use",
])

export interface ParsedRepairProposals {
  actions: RepairAction[]
  warnings: string[]
  /** Set when the entire LLM output cannot be parsed into structured actions —
   * caller surfaces this as today's pre-RepairGuide text-blob. */
  fallbackBlob?: string
}

function extractFirstJsonBlock(text: string): string | null {
  // Look for a triple-backtick fence labeled `json` and grab its body.
  const fenceMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (fenceMatch) return fenceMatch[1]
  // Fallback: the LLM may have emitted a bare JSON object (no fence).
  const objectMatch = text.match(/\{[\s\S]*\}/)
  if (objectMatch) return objectMatch[0]
  return null
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Parse a single LLM-emitted action object into a typed `RepairAction`. Returns
 * `null` when the entry is shaped wrong — the caller logs a warning and drops
 * it. The parser backfills `label`, `command`, and `actor` so the result plugs
 * into the existing interactive-repair surface without further massaging.
 */
function buildRepairAction(entry: Record<string, unknown>): RepairAction | null {
  const kind = entry.kind
  if (typeof kind !== "string") return null
  if (!KNOWN_REPAIR_ACTION_KINDS.has(kind as RepairActionKind)) return null

  const reason = typeof entry.reason === "string" ? entry.reason : "(no reason given)"
  const agent = typeof entry.agent === "string" ? entry.agent : "(unknown agent)"
  const label = `RepairGuide: ${kind} for ${agent}`
  const command = `# ${kind} (${agent}): ${reason}`

  switch (kind as RepairActionKind) {
    case "provider-auth": {
      const provider = typeof entry.provider === "string" ? entry.provider : "anthropic"
      return {
        kind: "provider-auth",
        label,
        command,
        actor: "human-required",
        provider: provider as AgentProvider,
      }
    }
    case "provider-use": {
      // `provider-use` may carry an optional `lane` — pass it through when
      // present and validly typed (`outward` or `inner`).
      const lane = entry.lane === "outward" || entry.lane === "inner" ? entry.lane : undefined
      const action: RepairAction = {
        kind: "provider-use",
        label,
        command,
        actor: "human-choice",
        ...(lane ? { lane } : {}),
      }
      return action
    }
    case "vault-create":
    case "vault-unlock":
    case "vault-replace":
    case "vault-recover":
    case "provider-retry": {
      return {
        kind: kind as "vault-create" | "vault-unlock" | "vault-replace" | "vault-recover" | "provider-retry",
        label,
        command,
        actor: "human-required",
      }
    }
    /* v8 ignore next 4 -- exhaustiveness guard: unreachable since membership
     * was checked above; left in place to satisfy `never` on future
     * RepairActionKind extensions. @preserve */
    default: {
      return null
    }
  }
}

/**
 * Parse RepairGuide LLM output. The persona content (`SOUL.md`) instructs the
 * model to emit exactly one ```json fenced block containing
 * `{ actions: RepairAction[], notes?: string[] }`. The parser extracts that
 * block, walks `actions[]`, drops entries with unknown kinds (with warnings),
 * and falls back to the raw output when no JSON can be extracted at all
 * (preserving today's text-blob behavior).
 */
export function parseRepairProposals(llmOutput: string): ParsedRepairProposals {
  const block = extractFirstJsonBlock(llmOutput)
  if (block === null) {
    return { actions: [], warnings: [], fallbackBlob: llmOutput }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return { actions: [], warnings: [], fallbackBlob: llmOutput }
  }

  if (!isPlainObject(parsed)) {
    return { actions: [], warnings: [] }
  }

  const rawActions = parsed.actions
  if (!Array.isArray(rawActions)) {
    return { actions: [], warnings: [] }
  }

  const actions: RepairAction[] = []
  const warnings: string[] = []

  for (const entry of rawActions) {
    if (!isPlainObject(entry)) {
      warnings.push(`dropped non-object entry from actions[]: ${JSON.stringify(entry)}`)
      continue
    }
    const built = buildRepairAction(entry)
    if (built === null) {
      const kindLabel = typeof entry.kind === "string" ? entry.kind : "(no kind)"
      warnings.push(`dropped action with unknown or missing kind: ${kindLabel}`)
      continue
    }
    actions.push(built)
  }

  return { actions, warnings }
}
