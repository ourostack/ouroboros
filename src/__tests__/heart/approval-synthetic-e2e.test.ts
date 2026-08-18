import { describe, expect, it } from "vitest"

import {
  runSyntheticApprovalScenario,
  type SyntheticCrashPoint,
} from "../fixtures/synthetic-approval-harness"

const DOCKER_RESTART = "docker restart calibre-web"

describe("synthetic approval vertical slice", () => {
  it("protects the exact Docker restart independently of low-risk classification and suspends before execution", async () => {
    const evidence = await runSyntheticApprovalScenario({ command: DOCKER_RESTART })

    expect(evidence).toMatchObject({
      initialOutcome: "suspended",
      protectedByPolicy: true,
      reportedRisk: "low",
      handlerCallsAtSuspension: 0,
      handlerCalls: 0,
      originatingProviderCalls: 1,
    })
  })

  it.each([
    ["wrong type", "{\"command\":7}"],
    ["extra property", "{\"command\":\"docker restart calibre-web\",\"force\":true}"],
    ["non-object", "[\"docker restart calibre-web\"]"],
  ])("rejects %s arguments at the pre-proposal advertised-schema boundary", async (_label, argumentsJson) => {
    const evidence = await runSyntheticApprovalScenario({ command: DOCKER_RESTART, argumentsJson })

    expect(evidence).toMatchObject({
      initialOutcome: "rejected",
      rejectedAt: "pre_proposal_schema",
      journalState: null,
      handlerCalls: 0,
      externalEffects: 0,
    })
  })

  it.each([
    ["wrong type", "{\"command\":7}"],
    ["extra property", "{\"command\":\"docker restart calibre-web\",\"force\":true}"],
    ["non-object", "[\"docker restart calibre-web\"]"],
  ])("rejects %s arguments again after claim at the live pre-attempt boundary", async (_label, liveArgumentsJson) => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      liveArgumentsJson,
    })

    expect(evidence).toMatchObject({
      initialOutcome: "suspended",
      rejectedAt: "pre_attempt_schema",
      journalState: "drifted",
      handlerCalls: 0,
      externalEffects: 0,
    })
  })

  it("rejects a protected mixed batch before any handler runs", async () => {
    const evidence = await runSyntheticApprovalScenario({
      batch: [
        { name: "shell", argumentsJson: JSON.stringify({ command: DOCKER_RESTART }) },
        { name: "read_file", argumentsJson: JSON.stringify({ path: "/tmp/harmless" }) },
      ],
    })

    expect(evidence).toMatchObject({
      initialOutcome: "rejected",
      rejectedAt: "protected_batch",
      handlerCalls: 0,
      externalEffects: 0,
    })
  })

  it("approves after delay in a fresh process, restores one pair, and resumes the existing provider loop once", async () => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      delayMs: 60_000,
      restartBeforeDecision: true,
      handlerMode: "non_idempotent",
    })

    expect(new Set(evidence.processIds).size).toBeGreaterThan(1)
    expect(evidence).toMatchObject({
      initialOutcome: "suspended",
      journalState: "succeeded",
      handlerCallsAtSuspension: 0,
      handlerCalls: 1,
      externalEffects: 1,
      attemptedPersistedBeforeHandler: true,
      originatingProviderCalls: 1,
      continuationProviderCalls: 1,
      originalUserMessageCount: 1,
      correlatedTerminalPairs: 1,
      ordinaryOrphanRepairResults: 0,
      retryableAttemptObserved: false,
    })
    expect(evidence.deliveries).toEqual(["calibre-web is back up"])
  })

  it("denies after suspension without executing and delivers one coherent continuation", async () => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "deny",
      delayMs: 60_000,
      restartBeforeDecision: true,
    })

    expect(evidence).toMatchObject({
      initialOutcome: "suspended",
      journalState: "denied",
      handlerCalls: 0,
      externalEffects: 0,
      continuationProviderCalls: 1,
      correlatedTerminalPairs: 1,
      retryableAttemptObserved: false,
    })
  })

  it("lets exactly one of two decision processes claim, execute, materialize, resume, and deliver", async () => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      concurrentDecisionProcesses: 2,
      handlerMode: "non_idempotent",
    })

    expect(evidence.processIds.length).toBeGreaterThanOrEqual(2)
    expect(evidence).toMatchObject({
      journalState: "succeeded",
      handlerCalls: 1,
      externalEffects: 1,
      continuationProviderCalls: 1,
      correlatedTerminalPairs: 1,
      staleCallbackAccepted: false,
    })
  })

  it("fails closed on a changed session head before attempted", async () => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      advanceSessionHeadBeforeDecision: true,
    })

    expect(evidence).toMatchObject({
      journalState: "session_head_changed",
      handlerCalls: 0,
      externalEffects: 0,
      continuationProviderCalls: 0,
      correlatedTerminalPairs: 0,
      retryableAttemptObserved: false,
    })
  })
})

describe("synthetic crash and restart matrix", () => {
  it.each([
    ["after_journal_prepare", "abandoned_before_attempt", true],
    ["after_token_persist", "abandoned_before_attempt", true],
    ["after_checkpoint_write", "awaiting_prompt_binding", false],
    ["after_prompt_accept_before_bind", "awaiting_prompt_binding", false],
    ["after_claim", "abandoned_before_attempt", true],
  ] as const)("recovers %s before attempted with zero execution", async (crashAt, journalState, freshApprovalRequired) => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      restartBeforeDecision: true,
      crashAt,
    })

    expect(evidence).toMatchObject({
      journalState,
      handlerCalls: 0,
      externalEffects: 0,
      ordinaryOrphanRepairResults: 0,
      freshApprovalRequired,
      retryableAttemptObserved: false,
    })
    if (crashAt === "after_prompt_accept_before_bind") expect(evidence.staleCallbackAccepted).toBe(false)
  })

  it.each(["idempotent", "non_idempotent"] as const)(
    "never retries %s handler work after an after-attempt crash",
    async (handlerMode) => {
      const evidence = await runSyntheticApprovalScenario({
        command: DOCKER_RESTART,
        decision: "approve",
        restartBeforeDecision: true,
        crashAt: "after_attempt",
        handlerMode,
      })

      expect(evidence).toMatchObject({
        journalState: "attempted_indeterminate",
        handlerCalls: 0,
        externalEffects: 0,
        retryableAttemptObserved: false,
      })
    },
  )

  it.each(["idempotent", "non_idempotent"] as const)(
    "never retries a %s external effect after an after-handler crash",
    async (handlerMode) => {
      const evidence = await runSyntheticApprovalScenario({
        command: DOCKER_RESTART,
        decision: "approve",
        restartBeforeDecision: true,
        crashAt: "after_handler",
        handlerMode,
      })

      expect(evidence).toMatchObject({
        journalState: "attempted_indeterminate",
        handlerCalls: 1,
        externalEffects: 1,
        continuationProviderCalls: 0,
        retryableAttemptObserved: false,
      })
    },
  )

  it.each([
    ["after_terminal_persist", 1, 1],
    ["after_continuation_materialize", 1, 1],
    ["after_continuation_attempt", 0, 1],
  ] as const)("recovers %s without duplicate transcript or provider work", async (crashAt, continuationProviderCalls, correlatedTerminalPairs) => {
    const evidence = await runSyntheticApprovalScenario({
      command: DOCKER_RESTART,
      decision: "approve",
      restartBeforeDecision: true,
      crashAt: crashAt as SyntheticCrashPoint,
      handlerMode: "non_idempotent",
    })

    expect(evidence).toMatchObject({
      journalState: "succeeded",
      handlerCalls: 1,
      externalEffects: 1,
      continuationProviderCalls,
      correlatedTerminalPairs,
      originalUserMessageCount: 1,
      retryableAttemptObserved: false,
    })
  })
})
