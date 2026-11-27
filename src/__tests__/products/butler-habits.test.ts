import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ProductHabitRunInput } from "../../heart/product/types"

const mocks = vi.hoisted(() => ({
  marker: null as null | { schemaVersion: "sanctuary-acceptance-marker-v1"; label: string; scenarioHandleDigest: string; startedAt: string },
  readCursor: vi.fn(() => ({ sweepCount: 1, deliveryCount: 0 })),
  recordReceipt: vi.fn(),
  sourceReady: vi.fn(async () => undefined),
  runHabit: vi.fn(async (agent: string, _options: unknown) => ({ ok: true, message: `health:${agent}`, data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } })),
}))

vi.mock("../../heart/daemon/sanctuary-acceptance-marker", () => ({ readSanctuaryAcceptanceMarker: () => mocks.marker }))
vi.mock("../../heart/daemon/sanctuary-scheduler-liveness", () => ({
  readSanctuaryHealthCursor: mocks.readCursor,
  recordSanctuarySchedulerLivenessReceipt: mocks.recordReceipt,
}))
vi.mock("../../senses/sanctuary-health-runner", () => ({ runSanctuaryHealthHabit: mocks.runHabit }))
vi.mock("../../senses/sanctuary-runtime", () => ({ ensureSanctuarySourceRuntimeReady: mocks.sourceReady }))
vi.mock("../../senses/telegram-identity-key", () => ({ readOrCreateTelegramIdentityKey: () => "k".repeat(43) }))

import { product } from "../../products/butler"

const health = product.habits!["sanctuary-health"]!
const scenarioHandleDigest = "a".repeat(64)
const cronScenario = { schemaVersion: "sanctuary-acceptance-marker-v1" as const, label: "unit-16f-cron-fingerprint", scenarioHandleDigest, startedAt: "2026-08-21T07:14:00.000Z" }
const schedulerOrigin = { slot: "2026-08-21T07:15:00.000Z", schedulerRunId: "11111111-1111-4111-8111-111111111111", invocationPid: 101, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "a".repeat(64), scenarioHandleDigest, occurrenceId: "cron:2026-08-21T07:15:00.000Z" }
const snapshot = { childPid: 42 } as unknown as ReturnType<ProductHabitRunInput["schedulerSnapshot"]>

function input(overrides: Partial<ProductHabitRunInput> = {}): ProductHabitRunInput {
  return {
    agent: "butler", habitName: "sanctuary-health", trigger: "cron", occurrenceId: schedulerOrigin.occurrenceId, runnerId: "runner-1", schedulerOrigin,
    schedulerSnapshot: () => snapshot, submitExternalEvent: vi.fn(async () => ({ shouldWake: true })),
    ...overrides,
  }
}

describe("the Butler's sanctuary-health habit", () => {
  beforeEach(() => {
    mocks.marker = null
    mocks.readCursor.mockClear()
    mocks.recordReceipt.mockClear()
    mocks.runHabit.mockClear()
  })

  it("binds an attested fire to the cron-fingerprint acceptance run only", () => {
    expect(health.attestationScenario!("butler")).toBeNull()
    mocks.marker = { ...cronScenario, label: "unit-16a-other" }
    expect(health.attestationScenario!("butler")).toBeNull()
    mocks.marker = cronScenario
    expect(health.attestationScenario!("butler")).toBe(scenarioHandleDigest)
  })

  it("sweeps the house and files what changed through the daemon, with no receipt outside an acceptance run", async () => {
    const run = input()
    await expect(health.run(run)).resolves.toEqual({ ok: true, message: "health:butler", data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } })
    expect(mocks.runHabit).toHaveBeenCalledWith("butler", { submitEvidence: run.submitExternalEvent })
    expect(mocks.readCursor).not.toHaveBeenCalled()
    expect(mocks.recordReceipt).not.toHaveBeenCalled()
  })

  it("records the liveness receipt for a scheduler fire during the cron-fingerprint run, counting paid work", async () => {
    mocks.marker = cronScenario
    mocks.runHabit.mockImplementationOnce(async (agent: string, options: unknown) => {
      const metrics = (options as { acceptanceMetrics: { onPrivateTurnStart(): void; onProviderInvocation(): void } }).acceptanceMetrics
      metrics.onPrivateTurnStart()
      metrics.onProviderInvocation()
      return { ok: true, message: `health:${agent}`, data: { incidentCount: 0, submitted: 0, wakesRequested: 0 } }
    })
    await expect(health.run(input())).resolves.toMatchObject({ ok: true })
    expect(mocks.readCursor).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`${path.sep}butler\\.ouro$`, "u")))
    expect(mocks.recordReceipt).toHaveBeenCalledWith(expect.objectContaining({
      trigger: "cron", occurrenceId: schedulerOrigin.occurrenceId, runnerId: "runner-1", scenario: cronScenario, supervisor: snapshot,
      before: { sweepCount: 1, deliveryCount: 0 }, providerInvocationCount: 1, privateTurnCount: 1, schedulerOrigin, identityKey: "k".repeat(43),
    }))
  })

  it("refuses to attest a run during the cron-fingerprint run without its scheduler provenance", async () => {
    mocks.marker = cronScenario
    const unavailable = "Sanctuary scheduler liveness supervisor provenance is unavailable"
    await expect(health.run(input({ schedulerSnapshot: () => null }))).rejects.toThrow(unavailable)
    await expect(health.run(input({ schedulerOrigin: undefined }))).rejects.toThrow(unavailable)
    await expect(health.run(input({ occurrenceId: undefined }))).rejects.toThrow(unavailable)
    mocks.readCursor.mockReturnValueOnce(null as never)
    await expect(health.run(input())).rejects.toThrow(unavailable)
    expect(mocks.recordReceipt).not.toHaveBeenCalled()
  })
})

describe("the Butler's event sources", () => {
  it("holds house-check and Usenet events until the Butler's machine credentials are complete", async () => {
    expect(Object.keys(product.eventSources!)).toEqual(["sanctuary-health", "sanctuary-usenet"])
    await product.eventSources!["sanctuary-health"]!.ready("butler")
    await product.eventSources!["sanctuary-usenet"]!.ready("butler")
    expect(mocks.sourceReady.mock.calls).toEqual([["butler", "sanctuary-health"], ["butler", "sanctuary-usenet"]])
    mocks.sourceReady.mockRejectedValueOnce(new Error("[agent-runnable] unlock the vault"))
    await expect(product.eventSources!["sanctuary-health"]!.ready("butler")).rejects.toThrow("[agent-runnable] unlock the vault")
  })
})
