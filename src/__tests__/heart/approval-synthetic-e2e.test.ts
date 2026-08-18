import * as fs from "node:fs"

import { afterEach, describe, expect, it } from "vitest"

import { openApprovalStore, type ApprovalRecord } from "../../heart/approval-store"
import { parseSessionEnvelope, projectProviderMessages } from "../../heart/session-events"
import {
  runSyntheticApprovalScenario,
  syntheticApprovalProductionSeams,
  type SyntheticApprovalArtifacts,
  type SyntheticCrashPoint,
} from "../fixtures/synthetic-approval-harness"

const DOCKER_RESTART = "docker restart calibre-web"
const roots: string[] = []

type TraceEntry = { sequence: number; pid: number; type: string; detail?: string }
type ProviderEntry = { pid: number; kind: "origin" | "continuation"; messages: unknown[] }
type DeliveryEntry = { pid: number; kind: "provider" | "direct" | "indeterminate"; text: string }

function remember(artifacts: SyntheticApprovalArtifacts): SyntheticApprovalArtifacts {
  roots.push(artifacts.root)
  return artifacts
}

function readNdjson<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return []
  const text = fs.readFileSync(filePath, "utf8").trim()
  return text ? text.split("\n").map((line) => JSON.parse(line) as T) : []
}

function readJournal(artifacts: SyntheticApprovalArtifacts): ApprovalRecord | null {
  if (!artifacts.approvalId || !fs.existsSync(artifacts.approvalDatabasePath)) return null
  const store = openApprovalStore({ databasePath: artifacts.approvalDatabasePath })
  try { return store.read(artifacts.approvalId) } finally { store.close() }
}

function readProviderMessages(artifacts: SyntheticApprovalArtifacts) {
  const raw = JSON.parse(fs.readFileSync(artifacts.sessionPath, "utf8"))
  const envelope = parseSessionEnvelope(raw)
  expect(envelope).not.toBeNull()
  return projectProviderMessages(envelope!)
}

function countTerminalPairs(messages: any[]): number {
  let pairs = 0
  for (let index = 0; index < messages.length - 1; index++) {
    if (messages[index]?.role === "assistant" && messages[index]?.tool_calls?.[0]?.id === "call_restart"
      && messages[index + 1]?.role === "tool" && messages[index + 1]?.tool_call_id === "call_restart") pairs++
  }
  return pairs
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("synthetic approval vertical slice", () => {
  it("is explicitly wired to the real production approval and same-loop continuation seams", () => {
    expect(syntheticApprovalProductionSeams).toEqual(expect.objectContaining({
      runAgent: expect.any(Function),
      openApprovalStore,
      commitApprovalProposal: expect.any(Function),
      coordinateApprovalDecision: expect.any(Function),
      executeApprovalDecision: expect.any(Function),
      resumeApprovalContinuation: expect.any(Function),
    }))
  })

  it("protects the exact Docker restart independently of low-risk classification and suspends before execution", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)

    expect(artifacts.initialOutcome).toBe("suspended")
    expect(trace).toContainEqual(expect.objectContaining({ type: "classification", detail: "required:low" }))
    expect(trace).toContainEqual(expect.objectContaining({ type: "proposal_suspended" }))
    expect(trace.some((entry) => entry.type === "handler_start")).toBe(false)
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
  })

  it.each([
    ["malformed JSON", "{\"command\":"],
    ["missing required", "{}"],
    ["wrong type", "{\"command\":7}"],
    ["extra property", "{\"command\":\"docker restart calibre-web\",\"force\":true}"],
    ["non-object", "[\"docker restart calibre-web\"]"],
  ])("rejects %s arguments at the pre-proposal advertised-schema boundary", async (_label, argumentsJson) => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, argumentsJson }))

    expect(artifacts).toMatchObject({ initialOutcome: "rejected", rejectionAt: "pre_proposal_schema", approvalId: null })
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(readNdjson<TraceEntry>(artifacts.traceLogPath).some((entry) => entry.type === "attempted_committed")).toBe(false)
  })

  it.each([
    ["missing required", "require_missing_property"],
    ["wrong type", "wrong_command_type"],
    ["extra property", "treat_command_as_extra"],
  ] as const)("fails closed when the live schema makes frozen arguments %s before attempted", async (_label, liveSchemaMutation) => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "approve", liveSchemaMutation }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)

    expect(readJournal(artifacts)?.state).toBe("drifted")
    expect(trace.some((entry) => entry.type === "attempted_committed" || entry.type === "handler_start")).toBe(false)
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
  })

  it.each(["non_object_arguments", "malformed_record_json"] as const)(
    "rejects structural journal corruption (%s) before claim/revalidation",
    async (corruptJournalAfterProposal) => {
      const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "approve", corruptJournalAfterProposal }))
      const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)

      expect(artifacts.runErrorCode).toMatch(/corrupt_record|invalid_arguments/)
      expect(trace.some((entry) => entry.type === "attempted_committed" || entry.type === "handler_start")).toBe(false)
      expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    },
  )

  it("rejects a protected mixed batch before any handler runs", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      batch: [
        { name: "shell", argumentsJson: JSON.stringify({ command: DOCKER_RESTART }) },
        { name: "read_file", argumentsJson: JSON.stringify({ path: "/tmp/harmless" }) },
      ],
    }))

    expect(artifacts).toMatchObject({ initialOutcome: "rejected", rejectionAt: "protected_batch", approvalId: null })
    expect(readNdjson<TraceEntry>(artifacts.traceLogPath).some((entry) => entry.type === "handler_start")).toBe(false)
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
  })

  it("approves after delay in a fresh process and resumes the existing provider loop exactly once", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      delayMs: 60_000,
      restartBeforeDecision: true,
      handlerMode: "non_idempotent",
    }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)
    const effects = readNdjson(artifacts.effectsLogPath)
    const providers = readNdjson<ProviderEntry>(artifacts.providerLogPath)
    const deliveries = readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)
    const messages = readProviderMessages(artifacts)

    expect(artifacts.decisionPids).toHaveLength(1)
    expect(artifacts.decisionPids[0]).not.toBe(artifacts.originPid)
    expect(readJournal(artifacts)?.state).toBe("succeeded")
    expect(effects).toHaveLength(1)
    expect(trace.findIndex((entry) => entry.type === "attempted_committed"))
      .toBeLessThan(trace.findIndex((entry) => entry.type === "handler_start"))
    expect(providers.filter((entry) => entry.kind === "origin")).toHaveLength(1)
    expect(providers.filter((entry) => entry.kind === "continuation")).toHaveLength(1)
    expect(messages.filter((message: any) => message.role === "user" && message.content === "restart calibre-web")).toHaveLength(1)
    expect(countTerminalPairs(messages)).toBe(1)
    expect(trace.some((entry) => entry.type === "ordinary_orphan_repair" || entry.type === "attempt_retry")).toBe(false)
    expect(deliveries).toEqual([expect.objectContaining({ kind: "provider", text: "calibre-web is back up" })])
  })

  it("denies after restart with zero execution and one coherent correlated continuation", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "deny", restartBeforeDecision: true }))
    const messages = readProviderMessages(artifacts)

    expect(readJournal(artifacts)?.state).toBe("denied")
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(1)
    expect(countTerminalPairs(messages)).toBe(1)
  })

  it("materializes an observable handler failure once and continues the provider with its correlated error", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "approve", handlerMode: "observable_failure" }))
    const messages = readProviderMessages(artifacts)

    expect(readJournal(artifacts)).toMatchObject({ state: "failed", result: expect.stringContaining("error:") })
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(1)
    expect(countTerminalPairs(messages)).toBe(1)
    expect(messages.at(-2)).toEqual(expect.objectContaining({ role: "tool", content: expect.stringContaining("error:") }))
  })

  it("requires two distinct decision claimant processes and permits exactly one winner", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      concurrentDecisionProcesses: 2,
      handlerMode: "non_idempotent",
    }))

    expect(artifacts.decisionPids).toHaveLength(2)
    expect(new Set(artifacts.decisionPids).size).toBe(2)
    expect(artifacts.decisionPids).not.toContain(artifacts.originPid)
    expect(artifacts.callbackOutcomes.filter((outcome) => outcome.accepted)).toHaveLength(1)
    expect(readJournal(artifacts)?.state).toBe("succeeded")
    expect(readNdjson(artifacts.effectsLogPath)).toHaveLength(1)
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(1)
    expect(countTerminalPairs(readProviderMessages(artifacts))).toBe(1)
  })

  it("fails closed on a changed session head and emits a direct notice", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "approve", advanceSessionHeadBeforeDecision: true }))
    const deliveries = readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)

    expect(readJournal(artifacts)?.state).toBe("session_head_changed")
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(0)
    expect(countTerminalPairs(readProviderMessages(artifacts))).toBe(0)
    expect(deliveries).toEqual([expect.objectContaining({ kind: "direct", text: expect.stringContaining("session changed") })])
  })
})

describe("synthetic crash and restart matrix", () => {
  it.each([
    ["after_journal_prepare", "abandoned_before_attempt", true],
    ["after_token_persist", "abandoned_before_attempt", true],
    ["after_checkpoint_write", "awaiting_prompt_binding", false],
    ["after_prompt_accept_before_bind", "awaiting_prompt_binding", false],
    ["after_claim", "abandoned_before_attempt", true],
  ] as const)("recovers %s before attempted with zero execution", async (crashAt, expectedState, freshApprovalRequired) => {
    const artifacts = remember(await runSyntheticApprovalScenario({ command: DOCKER_RESTART, decision: "approve", restartBeforeDecision: true, crashAt }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)
    const deliveries = readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)

    expect(readJournal(artifacts)?.state).toBe(expectedState)
    expect(trace.some((entry) => entry.type === "attempted_committed" || entry.type === "handler_start")).toBe(false)
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(trace.some((entry) => entry.type === "ordinary_orphan_repair" || entry.type === "attempt_retry")).toBe(false)
    expect(trace.some((entry) => entry.type === "fresh_approval_required")).toBe(freshApprovalRequired)
    if (expectedState === "abandoned_before_attempt") {
      expect(deliveries).toEqual([expect.objectContaining({ kind: "direct", text: expect.stringContaining("fresh approval") })])
    }
    if (crashAt === "after_prompt_accept_before_bind") {
      expect(artifacts.callbackOutcomes).toContainEqual(expect.objectContaining({ accepted: false, reason: expect.stringContaining("binding") }))
    }
  })

  it.each(["idempotent", "non_idempotent"] as const)("never retries %s work after attempted CAS", async (handlerMode) => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART, decision: "approve", restartBeforeDecision: true, crashAt: "after_attempt", handlerMode,
    }))

    expect(readJournal(artifacts)?.state).toBe("attempted_indeterminate")
    expect(readNdjson<TraceEntry>(artifacts.traceLogPath).filter((entry) => entry.type === "handler_start")).toHaveLength(0)
    expect(readNdjson(artifacts.effectsLogPath)).toEqual([])
    expect(readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)).toEqual([
      expect.objectContaining({ kind: "indeterminate", text: expect.stringContaining("do not retry") }),
    ])
  })

  it.each(["idempotent", "non_idempotent"] as const)("never retries a %s external effect after handler return", async (handlerMode) => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART, decision: "approve", restartBeforeDecision: true, crashAt: "after_handler", handlerMode,
    }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)

    expect(readJournal(artifacts)?.state).toBe("attempted_indeterminate")
    expect(trace.filter((entry) => entry.type === "handler_start")).toHaveLength(1)
    expect(readNdjson(artifacts.effectsLogPath)).toHaveLength(1)
    expect(trace.some((entry) => entry.type === "attempt_retry")).toBe(false)
    expect(readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)).toEqual([
      expect.objectContaining({ kind: "indeterminate", text: expect.stringContaining("do not retry") }),
    ])
  })

  it.each([
    ["after_terminal_persist", 1],
    ["after_terminal_pair_persist_before_materialized", 1],
    ["after_materialized_marker_before_continuation_attempt", 1],
  ] as const)("recovers %s with one terminal pair and one provider continuation", async (crashAt, continuationCount) => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART, decision: "approve", restartBeforeDecision: true, crashAt: crashAt as SyntheticCrashPoint,
    }))

    expect(readJournal(artifacts)?.state).toBe("succeeded")
    expect(readNdjson(artifacts.effectsLogPath)).toHaveLength(1)
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(continuationCount)
    expect(countTerminalPairs(readProviderMessages(artifacts))).toBe(1)
  })

  it("surfaces an after-continuation-attempt interruption once without retrying provider work", async () => {
    const artifacts = remember(await runSyntheticApprovalScenario({
      command: DOCKER_RESTART, decision: "approve", restartBeforeDecision: true, crashAt: "after_continuation_attempt",
    }))
    const trace = readNdjson<TraceEntry>(artifacts.traceLogPath)

    expect(readJournal(artifacts)?.state).toBe("succeeded")
    expect(readNdjson(artifacts.effectsLogPath)).toHaveLength(1)
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(1)
    expect(trace.filter((entry) => entry.type === "continuation_provider_start")).toHaveLength(1)
    expect(readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)).toEqual([
      expect.objectContaining({ kind: "indeterminate", text: expect.stringContaining("will not be retried") }),
    ])
  })
})
