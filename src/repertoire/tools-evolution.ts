import { getAgentRoot } from "../heart/identity"
import {
  closeEvolutionCase,
  createEvolutionCase,
  evaluateEvolutionAction,
  listOpenEvolutionCases,
  nextEvolutionActionForStatus,
  readEvolutionCase,
  readEvolutionTrace,
  recordEvolutionDecision,
  recordEvolutionDelivery,
  recordEvolutionRatification,
  recordEvolutionVerification,
  summarizeOpenEvolutionCases,
  type EvolutionActionClass,
  type EvolutionBudgetProfile,
  type EvolutionDeliveryState,
  type EvolutionEvidenceKind,
  type EvolutionEvidenceRef,
  type EvolutionOrigin,
  type EvolutionRatification,
  type EvolutionRedaction,
} from "../arc/evolution"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolDefinition, ToolHandler } from "./tools-base"

const EVOLUTION_ACTIONS: ReadonlySet<EvolutionActionClass> = new Set([
  "create_case",
  "add_evidence",
  "write_journal",
  "write_desk",
  "write_diary",
  "spawn_coding",
  "create_branch",
  "commit",
  "open_pr",
  "merge_pr",
  "release_publish",
  "install_local",
  "mutate_shared_skill",
  "mutate_identity",
  "mutate_voice",
  "mutate_credentials",
  "mutate_provider_config",
  "send_external_message",
  "change_hosted_infra",
  "ratify",
])

const ORIGIN_KINDS: ReadonlySet<EvolutionOrigin["kind"]> = new Set(["session", "mcp", "sense", "desk", "habit", "human", "coding", "runtime"])
const BUDGET_PROFILES: ReadonlySet<EvolutionBudgetProfile> = new Set(["capture", "conservative", "trusted-local"])
const EVIDENCE_KINDS: ReadonlySet<EvolutionEvidenceKind> = new Set([
  "session_event",
  "session_envelope",
  "nerves_event",
  "ponder_packet",
  "obligation",
  "return_obligation",
  "coding_session",
  "coding_artifact",
  "desk_doc",
  "desk_friction",
  "git_commit",
  "pull_request",
  "ci_run",
  "release",
  "installed_runtime",
  "diary_entry",
  "journal_file",
  "skill_file",
  "sense_artifact",
  "hosted_audit",
  "human_message",
  "external_doc",
])
const REDACTIONS: ReadonlySet<EvolutionRedaction> = new Set(["none", "summary", "private_ref", "secret_ref"])
const DECISIONS = new Set(["ignore", "defer", "journal", "ask", "delegate", "act", "abandon"])
const VERIFICATION_STATUSES = new Set(["not-verified", "partial", "passed", "failed"])
const RATIFICATION_DESTINATIONS = new Set([
  "code",
  "repo_doc",
  "shared_skill",
  "desk_lesson",
  "desk_task",
  "diary",
  "journal",
  "habit",
  "policy",
  "agent_config",
  "hosted_substrate",
  "none_needed",
])

function nowIso(): string {
  return new Date().toISOString()
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function withEvolutionToolTelemetry(toolName: string, handler: ToolHandler): ToolHandler {
  return (args, ctx) => {
    emitNervesEvent({
      component: "repertoire",
      event: "repertoire.evolution_tool_call",
      message: "evolution tool invoked",
      meta: { toolName },
    })
    return handler(args, ctx)
  }
}

function required(args: Record<string, string>, name: string): string | null {
  const value = args[name]
  if (typeof value !== "string" || value.trim().length === 0) return null
  return value.trim()
}

function optional(args: Record<string, string>, name: string): string | null {
  const value = args[name]
  if (typeof value !== "string" || value.trim().length === 0) return null
  return value.trim()
}

function parseEnum<T extends string>(value: string, allowed: ReadonlySet<T>, label: string): T | string {
  return allowed.has(value as T) ? value as T : `invalid ${label}: ${value}`
}

function parseStringArray(value: string | null, label: string): string[] | string {
  if (value === null) return []
  try {
    const parsed = JSON.parse(value) as unknown
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed.map((item) => item.trim()).filter(Boolean)
  } catch {
    return value
      .split(/\n|,/)
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return `${label} must be a JSON string array, newline list, or comma list`
}

function parseDelivery(value: string | null): EvolutionDeliveryState | string {
  if (value === null) return "delivery is required"
  try {
    const parsed = JSON.parse(value) as unknown
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as EvolutionDeliveryState
  } catch {
    return "delivery must be valid JSON"
  }
  return "delivery must be a JSON object"
}

function buildRatification(args: Record<string, string>): EvolutionRatification | string {
  const destinationRaw = required(args, "destination")
  if (!destinationRaw) return "destination is required"
  const destination = parseEnum(destinationRaw, RATIFICATION_DESTINATIONS, "destination")
  if (typeof destination === "string" && !RATIFICATION_DESTINATIONS.has(destination as EvolutionRatification["destination"])) return destination
  const locator = required(args, "locator")
  if (!locator) return "locator is required"
  const reason = required(args, "reason")
  if (!reason) return "reason is required"
  return {
    destination: destination as EvolutionRatification["destination"],
    locator,
    landedAt: optional(args, "landedAt") ?? nowIso(),
    reason,
  }
}

function buildEvidence(args: Record<string, string>): EvolutionEvidenceRef | string | null {
  const kindRaw = optional(args, "evidenceKind")
  const locator = optional(args, "evidenceLocator")
  const reason = optional(args, "evidenceReason")
  if (!kindRaw && !locator && !reason) return null
  if (!kindRaw) return "evidenceKind is required when evidence is provided"
  if (!locator) return "evidenceLocator is required when evidence is provided"
  if (!reason) return "evidenceReason is required when evidence is provided"
  const kind = parseEnum(kindRaw, EVIDENCE_KINDS, "evidenceKind")
  if (typeof kind === "string" && !EVIDENCE_KINDS.has(kind as EvolutionEvidenceKind)) return kind
  const redactionRaw = optional(args, "evidenceRedaction") ?? "summary"
  const redaction = parseEnum(redactionRaw, REDACTIONS, "evidenceRedaction")
  if (typeof redaction === "string" && !REDACTIONS.has(redaction as EvolutionRedaction)) return redaction
  return {
    kind: kind as EvolutionEvidenceKind,
    locator,
    capturedAt: optional(args, "evidenceCapturedAt") ?? nowIso(),
    redaction: redaction as EvolutionRedaction,
    reason,
  }
}

function caseOrError(agentRoot: string, caseId: string) {
  const item = readEvolutionCase(agentRoot, caseId)
  if (!item) return { ok: false, error: `Evolution case not found: ${caseId}` }
  return { ok: true, case: item }
}

const rawEvolutionToolDefinitions: ToolDefinition[] = [
  {
    /* v8 ignore next -- static OpenAI tool schema is validated by the registry contract */
    tool: {
      type: "function",
      function: {
        name: "evolution_status",
        description: "list open evolution cases with their status, next action, and budget profile.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: () => {
      const openCases = summarizeOpenEvolutionCases(getAgentRoot())
      return json({ ok: true, count: openCases.length, openCases })
    },
    riskProfile: { mutates: "none", risk: "low", reason: "reads evolution case summaries" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_case",
        description: "show one evolution case with its trace events.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string", description: "evolution case id, such as evo-..." },
          },
          required: ["caseId"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      const agentRoot = getAgentRoot()
      const result = caseOrError(agentRoot, caseId)
      if (!result.ok) return json(result)
      return json({ ok: true, case: result.case, trace: readEvolutionTrace(agentRoot, caseId) })
    },
    riskProfile: { mutates: "none", risk: "low", reason: "reads a local evolution case and trace" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_capture",
        description: "capture a new harness evolution case from observed friction or desired behavior.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            problemStatement: { type: "string" },
            desiredBehavior: { type: "string" },
            originKind: { type: "string" },
            originLabel: { type: "string" },
            originLocator: { type: "string" },
            budgetProfile: { type: "string" },
            frictionSignature: { type: "string" },
            packetId: { type: "string" },
            obligationId: { type: "string" },
            evidenceKind: { type: "string" },
            evidenceLocator: { type: "string" },
            evidenceReason: { type: "string" },
            evidenceRedaction: { type: "string" },
            evidenceCapturedAt: { type: "string" },
          },
          required: ["title", "problemStatement", "desiredBehavior", "originKind", "originLabel", "originLocator"],
        },
      },
    },
    handler: (args) => {
      const title = required(args, "title")
      const problemStatement = required(args, "problemStatement")
      const desiredBehavior = required(args, "desiredBehavior")
      const originKindRaw = required(args, "originKind")
      const originLabel = required(args, "originLabel")
      const originLocator = required(args, "originLocator")
      if (!title) return json({ ok: false, error: "title is required" })
      if (!problemStatement) return json({ ok: false, error: "problemStatement is required" })
      if (!desiredBehavior) return json({ ok: false, error: "desiredBehavior is required" })
      if (!originKindRaw) return json({ ok: false, error: "originKind is required" })
      if (!originLabel) return json({ ok: false, error: "originLabel is required" })
      if (!originLocator) return json({ ok: false, error: "originLocator is required" })
      const originKind = parseEnum(originKindRaw, ORIGIN_KINDS, "originKind")
      if (typeof originKind === "string" && !ORIGIN_KINDS.has(originKind as EvolutionOrigin["kind"])) return json({ ok: false, error: originKind })
      const budgetProfileRaw = optional(args, "budgetProfile") ?? "conservative"
      const budgetProfile = parseEnum(budgetProfileRaw, BUDGET_PROFILES, "budgetProfile")
      if (typeof budgetProfile === "string" && !BUDGET_PROFILES.has(budgetProfile as EvolutionBudgetProfile)) return json({ ok: false, error: budgetProfile })
      const evidence = buildEvidence(args)
      if (typeof evidence === "string") return json({ ok: false, error: evidence })
      const frictionSignature = optional(args, "frictionSignature")
      const packetId = optional(args, "packetId")
      const obligationId = optional(args, "obligationId")
      const item = createEvolutionCase(getAgentRoot(), {
        title,
        problemStatement,
        desiredBehavior,
        origin: { kind: originKind as EvolutionOrigin["kind"], label: originLabel, locator: originLocator },
        budgetProfile: budgetProfile as EvolutionBudgetProfile,
        evidenceRefs: evidence ? [evidence] : [],
        ...(frictionSignature ? { frictionSignature } : {}),
        ...(packetId ? { packetId } : {}),
        ...(obligationId ? { obligationId } : {}),
      })
      return json({ ok: true, case: item, nextAction: nextEvolutionActionForStatus(item.status) })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates durable evolution case and trace state" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_decide",
        description: "record an evolution decision after checking the action against case authority and budget.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string" },
            decision: { type: "string" },
            action: { type: "string" },
            reason: { type: "string" },
          },
          required: ["caseId", "decision", "action", "reason"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      const decisionRaw = required(args, "decision")
      const actionRaw = required(args, "action")
      const reason = required(args, "reason")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      if (!decisionRaw) return json({ ok: false, error: "decision is required" })
      if (!DECISIONS.has(decisionRaw)) return json({ ok: false, error: `invalid decision: ${decisionRaw}` })
      if (!actionRaw) return json({ ok: false, error: "action is required" })
      const action = parseEnum(actionRaw, EVOLUTION_ACTIONS, "action")
      if (typeof action === "string" && !EVOLUTION_ACTIONS.has(action as EvolutionActionClass)) return json({ ok: false, error: action })
      if (!reason) return json({ ok: false, error: "reason is required" })
      const agentRoot = getAgentRoot()
      const gate = evaluateEvolutionAction(agentRoot, caseId, action as EvolutionActionClass)
      if (!gate.allowed) {
        return json({ ok: false, blocked: true, caseId, action, code: gate.code, reason: gate.reason })
      }
      const item = recordEvolutionDecision(agentRoot, caseId, {
        decision: decisionRaw as "ignore" | "defer" | "journal" | "ask" | "delegate" | "act" | "abandon",
        reason,
        authorityMode: gate.code,
      })
      return json({ ok: true, action, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution decision state" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_verify",
        description: "record verification status, commands, evidence, residual risk, and missing checks for a case.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string" },
            status: { type: "string" },
            objective: { type: "string" },
            commands: { type: "string" },
            evidenceRefs: { type: "string" },
            residualRisk: { type: "string" },
            missingChecks: { type: "string" },
            checkedAt: { type: "string" },
          },
          required: ["caseId", "status", "objective"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      const statusRaw = required(args, "status")
      const objective = required(args, "objective")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      if (!statusRaw) return json({ ok: false, error: "status is required" })
      if (!VERIFICATION_STATUSES.has(statusRaw)) return json({ ok: false, error: `invalid status: ${statusRaw}` })
      if (!objective) return json({ ok: false, error: "objective is required" })
      const commands = parseStringArray(optional(args, "commands"), "commands")
      if (typeof commands === "string") return json({ ok: false, error: commands })
      const evidenceRefs = parseStringArray(optional(args, "evidenceRefs"), "evidenceRefs")
      if (typeof evidenceRefs === "string") return json({ ok: false, error: evidenceRefs })
      const missingChecks = parseStringArray(optional(args, "missingChecks"), "missingChecks")
      if (typeof missingChecks === "string") return json({ ok: false, error: missingChecks })
      const item = recordEvolutionVerification(getAgentRoot(), caseId, {
        status: statusRaw as "not-verified" | "partial" | "passed" | "failed",
        checkedAt: optional(args, "checkedAt") ?? nowIso(),
        objective,
        commands,
        evidenceRefs,
        residualRisk: optional(args, "residualRisk"),
        missingChecks,
      })
      return json({ ok: true, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution verification state" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_deliver",
        description: "record branch, commit, pull request, merge, release, publish, install, or runtime-refresh delivery state from a JSON object.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string" },
            delivery: { type: "string" },
          },
          required: ["caseId", "delivery"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      const delivery = parseDelivery(optional(args, "delivery"))
      if (typeof delivery === "string") return json({ ok: false, error: delivery })
      const item = recordEvolutionDelivery(getAgentRoot(), caseId, delivery)
      return json({ ok: true, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution delivery state" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_ratify",
        description: "record where the verified lesson landed, including none_needed when no durable lesson should be written.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string" },
            destination: { type: "string" },
            locator: { type: "string" },
            landedAt: { type: "string" },
            reason: { type: "string" },
          },
          required: ["caseId", "destination", "locator", "reason"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      const ratification = buildRatification(args)
      if (typeof ratification === "string") return json({ ok: false, error: ratification })
      const item = recordEvolutionRatification(getAgentRoot(), caseId, ratification)
      return json({ ok: true, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution ratification state" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "evolution_close",
        description: "close a ratified evolution case. can include inline ratification fields, including destination none_needed.",
        parameters: {
          type: "object",
          properties: {
            caseId: { type: "string" },
            reason: { type: "string" },
            destination: { type: "string" },
            locator: { type: "string" },
            landedAt: { type: "string" },
          },
          required: ["caseId", "reason"],
        },
      },
    },
    handler: (args) => {
      const caseId = required(args, "caseId")
      const reason = required(args, "reason")
      if (!caseId) return json({ ok: false, error: "caseId is required" })
      if (!reason) return json({ ok: false, error: "reason is required" })
      const ratification = optional(args, "destination") ? buildRatification(args) : undefined
      if (typeof ratification === "string") return json({ ok: false, error: ratification })
      try {
        const item = closeEvolutionCase(getAgentRoot(), caseId, { reason, ...(ratification ? { ratification } : {}) })
        return json({ ok: true, case: item })
      } catch (error) {
        return json({ ok: false, error: (error as Error).message })
      }
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "closes durable evolution case state" },
  },
]

export const evolutionToolDefinitions: ToolDefinition[] = rawEvolutionToolDefinitions.map((definition) => ({
  ...definition,
  handler: withEvolutionToolTelemetry(definition.tool.function.name, definition.handler),
}))

export function getOpenEvolutionCasesForActiveWork(agentRoot = getAgentRoot()) {
  return listOpenEvolutionCases(agentRoot).map((item) => ({
    id: item.id,
    title: item.title,
    status: item.status,
    nextAction: nextEvolutionActionForStatus(item.status),
    budgetProfile: item.budget.profile,
  }))
}
