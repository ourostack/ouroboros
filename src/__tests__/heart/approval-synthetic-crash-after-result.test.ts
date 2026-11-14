import { afterEach, describe, expect, it } from "vitest"

import { runSyntheticApprovalScenario, type SyntheticCrashPoint } from "../fixtures/synthetic-approval-harness"
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

describe("synthetic crash and restart matrix: after the terminal result", { timeout: 20_000 }, () => {
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
