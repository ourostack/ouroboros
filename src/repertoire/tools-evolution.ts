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
import type { ToolDefinition, ToolErrorCard, ToolHandler } from "./tools-base"

const EVOLUTION_ACTIONS: ReadonlySet<EvolutionActionClass> = new Set([
  "create_case",
  "add_evidence",
  "write_record",
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
  "desk_record_note",
  "skill_file",
  "sense_artifact",
  "hosted_audit",
  "human_message",
  "external_doc",
])
const REDACTIONS: ReadonlySet<EvolutionRedaction> = new Set(["none", "summary", "private_ref", "secret_ref"])
const DECISIONS = new Set(["ignore", "defer", "record", "ask", "delegate", "act", "abandon"])
const VERIFICATION_STATUSES = new Set(["not-verified", "partial", "passed", "failed"])
const RATIFICATION_DESTINATIONS = new Set([
  "code",
  "repo_doc",
  "shared_skill",
  "desk_lesson",
  "desk_task",
  "diary",
  "desk_record",
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
  if (!item) return { ok: false, error: `Evolution case not found: ${caseId}`, code: "case-not-found" }
  return { ok: true, case: item }
}

const ORIENTATION_HOLD_ERROR: ToolErrorCard = { code: "orientation-hold", means: "This turn is on a correction hold, so evolution records wait until you know what the person meant.", fix: "Call orientation_get, settle the correction, then record it if it is still right." }

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
    ax: { id: "tool:evolution_status", group: "turn-evolution", when: "Pick this to see every open case and what each one needs next, before opening one with evolution_case.", effect: "read", idempotent: true, errors: [
      { code: "tool-changed", means: "evolution_status is no longer in this turn's tool selection.", fix: "Use the tools this turn offers now; open cases also appear in the active work summary." },
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      const agentRoot = getAgentRoot()
      const result = caseOrError(agentRoot, caseId)
      if (!result.ok) return json(result)
      return json({ ok: true, case: result.case, trace: readEvolutionTrace(agentRoot, caseId) })
    },
    riskProfile: { mutates: "none", risk: "low", reason: "reads a local evolution case and trace" },
    ax: { id: "tool:evolution_case", group: "turn-evolution", when: "Pick this to read one case in full, with every trace event, before deciding, verifying or closing it.", effect: "read", idempotent: true, errors: [
      { code: "bad-argument", means: "caseId is missing.", fix: "Call again with a caseId from evolution_status, such as evo-..." },
      { code: "case-not-found", means: "No evolution case has that id on this agent.", fix: "Call evolution_status for the open case ids, and use one of those." },
    ] },
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
      if (!title) return json({ ok: false, error: "title is required", code: "bad-argument" })
      if (!problemStatement) return json({ ok: false, error: "problemStatement is required", code: "bad-argument" })
      if (!desiredBehavior) return json({ ok: false, error: "desiredBehavior is required", code: "bad-argument" })
      if (!originKindRaw) return json({ ok: false, error: "originKind is required", code: "bad-argument" })
      if (!originLabel) return json({ ok: false, error: "originLabel is required", code: "bad-argument" })
      if (!originLocator) return json({ ok: false, error: "originLocator is required", code: "bad-argument" })
      const originKind = parseEnum(originKindRaw, ORIGIN_KINDS, "originKind")
      if (typeof originKind === "string" && !ORIGIN_KINDS.has(originKind as EvolutionOrigin["kind"])) return json({ ok: false, error: originKind, code: "bad-argument" })
      const budgetProfileRaw = optional(args, "budgetProfile") ?? "conservative"
      const budgetProfile = parseEnum(budgetProfileRaw, BUDGET_PROFILES, "budgetProfile")
      if (typeof budgetProfile === "string" && !BUDGET_PROFILES.has(budgetProfile as EvolutionBudgetProfile)) return json({ ok: false, error: budgetProfile, code: "bad-argument" })
      const evidence = buildEvidence(args)
      if (typeof evidence === "string") return json({ ok: false, error: evidence, code: "bad-argument" })
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
    ax: { id: "tool:evolution_capture", group: "turn-evolution", when: "Pick this when friction or a wished-for behavior in the harness should become a tracked case rather than a passing remark.", effect: "write", errors: [
      { code: "bad-argument", means: "A required field is empty, or originKind, budgetProfile or an evidence field isn't an allowed value; error names it.", fix: "Fill in or correct the field error names; evidence needs all three of evidenceKind, evidenceLocator and evidenceReason." },
      ORIENTATION_HOLD_ERROR,
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      if (!decisionRaw) return json({ ok: false, error: "decision is required", code: "bad-argument" })
      if (!DECISIONS.has(decisionRaw)) return json({ ok: false, error: `invalid decision: ${decisionRaw}`, code: "bad-argument" })
      if (!actionRaw) return json({ ok: false, error: "action is required", code: "bad-argument" })
      const action = parseEnum(actionRaw, EVOLUTION_ACTIONS, "action")
      if (typeof action === "string" && !EVOLUTION_ACTIONS.has(action as EvolutionActionClass)) return json({ ok: false, error: action, code: "bad-argument" })
      if (!reason) return json({ ok: false, error: "reason is required", code: "bad-argument" })
      const agentRoot = getAgentRoot()
      const gate = evaluateEvolutionAction(agentRoot, caseId, action as EvolutionActionClass)
      if (!gate.allowed) {
        return json({ ok: false, blocked: true, caseId, action, code: gate.code, reason: gate.reason })
      }
      const item = recordEvolutionDecision(agentRoot, caseId, {
        decision: decisionRaw as "ignore" | "defer" | "record" | "ask" | "delegate" | "act" | "abandon",
        reason,
        authorityMode: gate.code,
      })
      return json({ ok: true, action, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution decision state" },
    ax: { id: "tool:evolution_decide", group: "turn-evolution", when: "Pick this to choose what to do about a case, such as act, defer or ask, once its authority and budget allow it.", effect: "write", errors: [
      { code: "bad-argument", means: "caseId, decision, action or reason is empty, or decision or action isn't an allowed value; error names it.", fix: "Fill in or correct the field error names; a reply with blocked: true instead carries the gate's own code and reason." },
      ORIENTATION_HOLD_ERROR,
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      if (!statusRaw) return json({ ok: false, error: "status is required", code: "bad-argument" })
      if (!VERIFICATION_STATUSES.has(statusRaw)) return json({ ok: false, error: `invalid status: ${statusRaw}`, code: "bad-argument" })
      if (!objective) return json({ ok: false, error: "objective is required", code: "bad-argument" })
      const commands = parseStringArray(optional(args, "commands"), "commands")
      if (typeof commands === "string") return json({ ok: false, error: commands, code: "bad-argument" })
      const evidenceRefs = parseStringArray(optional(args, "evidenceRefs"), "evidenceRefs")
      if (typeof evidenceRefs === "string") return json({ ok: false, error: evidenceRefs, code: "bad-argument" })
      const missingChecks = parseStringArray(optional(args, "missingChecks"), "missingChecks")
      if (typeof missingChecks === "string") return json({ ok: false, error: missingChecks, code: "bad-argument" })
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
    ax: { id: "tool:evolution_verify", group: "turn-evolution", when: "Pick this after a change is made, to record whether the checks for the case's objective passed and which are still missing.", effect: "write", errors: [
      { code: "bad-argument", means: "caseId, status or objective is empty, status isn't allowed, or a list isn't a JSON array, newline list or comma list.", fix: "Fill in or correct the field error names; send commands and evidenceRefs as a JSON array of strings." },
      ORIENTATION_HOLD_ERROR,
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      const delivery = parseDelivery(optional(args, "delivery"))
      if (typeof delivery === "string") return json({ ok: false, error: delivery, code: "bad-argument" })
      const item = recordEvolutionDelivery(getAgentRoot(), caseId, delivery)
      return json({ ok: true, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution delivery state" },
    ax: { id: "tool:evolution_deliver", group: "turn-evolution", when: "Pick this as a fix ships, to record its branch, commits, pull request, merge, release or install for the case.", effect: "write", errors: [
      { code: "bad-argument", means: "caseId is empty, or delivery is missing, isn't valid JSON or isn't a JSON object.", fix: "Send delivery as a JSON object string keyed by stage, such as pullRequest with its url and openedAt." },
      ORIENTATION_HOLD_ERROR,
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      const ratification = buildRatification(args)
      if (typeof ratification === "string") return json({ ok: false, error: ratification, code: "bad-argument" })
      const item = recordEvolutionRatification(getAgentRoot(), caseId, ratification)
      return json({ ok: true, case: item })
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records durable evolution ratification state" },
    ax: { id: "tool:evolution_ratify", group: "turn-evolution", when: "Pick this once a verified case has taught something, to record where the lesson landed, or none_needed if nowhere.", effect: "write", errors: [
      { code: "bad-argument", means: "caseId, destination, locator or reason is empty, or destination isn't an allowed place.", fix: "Fill in the field error names; use destination none_needed when no lasting lesson should be written." },
      ORIENTATION_HOLD_ERROR,
    ] },
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
      if (!caseId) return json({ ok: false, error: "caseId is required", code: "bad-argument" })
      if (!reason) return json({ ok: false, error: "reason is required", code: "bad-argument" })
      const ratification = optional(args, "destination") ? buildRatification(args) : undefined
      if (typeof ratification === "string") return json({ ok: false, error: ratification, code: "bad-argument" })
      try {
        const item = closeEvolutionCase(getAgentRoot(), caseId, { reason, ...(ratification ? { ratification } : {}) })
        return json({ ok: true, case: item })
      } catch (error) {
        return json({ ok: false, error: (error as Error).message, code: "close-failed" })
      }
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "closes durable evolution case state" },
    ax: { id: "tool:evolution_close", group: "turn-evolution", when: "Pick this to finish a case whose lesson is ratified; pass destination here to ratify and close in one call.", effect: "write", errors: [
      { code: "bad-argument", means: "caseId or reason is empty, or the inline ratification fields are incomplete.", fix: "Fill in the field error names, then close again." },
      ORIENTATION_HOLD_ERROR,
      { code: "close-failed", means: "The case can't close yet, usually because no ratification is recorded; error says why.", fix: "Call again with destination and locator, or destination none_needed, so it ratifies as it closes." },
    ] },
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
