import { afterEach, describe, expect, it } from "vitest"

import { runSyntheticApprovalScenario } from "../fixtures/synthetic-approval-harness"
import {
  DOCKER_RESTART,
  countTerminalPairs,
  readJournal,
  readNdjson,
  readProviderMessages,
  remember,
  removeRememberedRoots,
  type DeliveryEntry,
  type ProviderEntry,
  type TraceEntry,
} from "../fixtures/synthetic-approval-readers"

afterEach(removeRememberedRoots)

describe("synthetic crash and restart matrix: before and at the attempt", { timeout: 20_000 }, () => {
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
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(0)
    const messages = readProviderMessages(artifacts)
    expect(countTerminalPairs(messages)).toBe(1)
    expect(messages.filter((message: any) => message.role === "user" && message.content === "restart calibre-web")).toHaveLength(1)
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
    expect(readNdjson<ProviderEntry>(artifacts.providerLogPath).filter((entry) => entry.kind === "continuation")).toHaveLength(0)
    const messages = readProviderMessages(artifacts)
    expect(countTerminalPairs(messages)).toBe(1)
    expect(messages.filter((message: any) => message.role === "user" && message.content === "restart calibre-web")).toHaveLength(1)
    expect(readNdjson<DeliveryEntry>(artifacts.deliveryLogPath)).toEqual([
      expect.objectContaining({ kind: "indeterminate", text: expect.stringContaining("do not retry") }),
    ])
  })
})
