import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockEmitNervesEvent,
  mockGetAgentName,
  mockGetAgentRoot,
  mockGetPrivateRuntimePendingDir,
  mockHasPendingMessages,
  mockRecordHabitRun,
  mockCreateHabitRunId,
  mockIsSafeHabitRunId,
  mockWriteHabitRunReceipt,
  mockApplyHabitRuntimeState,
  mockReadHabitSessionSummary,
  MockFileFriendStore,
} = vi.hoisted(() => ({
  mockEmitNervesEvent: vi.fn(),
  mockGetAgentName: vi.fn(() => "slugger"),
  mockGetAgentRoot: vi.fn(),
  mockGetPrivateRuntimePendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
  mockHasPendingMessages: vi.fn(() => false),
  mockRecordHabitRun: vi.fn(),
  mockCreateHabitRunId: vi.fn(() => "habit-run-rsvp"),
  mockIsSafeHabitRunId: vi.fn(() => true),
  mockWriteHabitRunReceipt: vi.fn(),
  mockApplyHabitRuntimeState: vi.fn((_agentRoot: string, habit: any) => habit),
  mockReadHabitSessionSummary: vi.fn(() => null),
  MockFileFriendStore: class {
    get = vi.fn(async () => null)
    put = vi.fn(async () => undefined)
    delete = vi.fn(async () => undefined)
    findByExternalId = vi.fn(async () => null)
    listAll = vi.fn(async () => [])
  },
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
}))

vi.mock("../../mind/pending", () => ({
  getPrivateRuntimePendingDir: (...args: any[]) => mockGetPrivateRuntimePendingDir(...args),
  hasPendingMessages: (...args: any[]) => mockHasPendingMessages(...args),
}))

vi.mock("../../heart/habits/habit-runtime-state", () => ({
  applyHabitRuntimeState: (...args: any[]) => mockApplyHabitRuntimeState(...args),
  recordHabitRun: (...args: any[]) => mockRecordHabitRun(...args),
}))

vi.mock("../../heart/habits/habit-session-summary", () => ({
  readHabitSessionSummary: (...args: any[]) => mockReadHabitSessionSummary(...args),
}))

vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    FileFriendStore: MockFileFriendStore,
  }
})

vi.mock("../../arc/flight-recorder", () => ({
  createHabitRunId: (...args: any[]) => mockCreateHabitRunId(...args),
  isSafeHabitRunId: (...args: any[]) => mockIsSafeHabitRunId(...args),
  writeHabitRunReceipt: (...args: any[]) => mockWriteHabitRunReceipt(...args),
}))

import { readRunLedger } from "../../heart/run-ledger"
import { readRsvpSpendLedger } from "../../rsvp/spend-ledger"
import { createPrivateRuntimeWorker } from "../../senses/private-runtime-worker"

function tempAgentRoot(): string {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-run-ledger-"))
  fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "habits", "rsvp.md"), [
    "---",
    "title: RSVP Check",
    "cadence: daily",
    "tools: []",
    "---",
    "",
    "Check the private AislePlanner RSVP state without leaking guest text.",
  ].join("\n"), "utf-8")
  return agentRoot
}

function tempTypedRsvpAgentRoot(): string {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-rsvp-ledger-"))
  fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "habits", "rsvp-wedding.md"), [
    "---",
    "title: Wedding RSVPs",
    "cadence: 0 10 * * *",
    "tools: [rsvp_query, rsvp_summary]",
    "rsvp:",
    "  policyVersion: rsvp-habit/v1",
    "  mode: shadow",
    "  sense: bluebubbles",
    "  source: aisleplanner",
    "  routeRef: rsvp/config.json#bluebubblesRoute",
    "  snapshotRef: state/rsvp/snapshots/latest.json",
    "  outboundStateRef: state/rsvp/outbound-state.json",
    "  budgetRef: state/rsvp/spend-ledger.json",
    "  idempotencyRef: state/rsvp/outbound-state.json",
    "  liveSendEligible: false",
    "---",
    "",
    "Refresh native RSVP state.",
  ].join("\n"), "utf-8")
  return agentRoot
}

describe("private-runtime habit run ledger attribution", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
    mockGetAgentName.mockReset().mockReturnValue("slugger")
    mockGetAgentRoot.mockReset()
    mockGetPrivateRuntimePendingDir.mockReset().mockReturnValue("/mock/pending/self/inner/dialog")
    mockHasPendingMessages.mockReset().mockReturnValue(false)
    mockRecordHabitRun.mockReset()
    mockCreateHabitRunId.mockReset().mockReturnValue("habit-run-rsvp")
    mockIsSafeHabitRunId.mockReset().mockReturnValue(true)
    mockWriteHabitRunReceipt.mockReset()
    mockApplyHabitRuntimeState.mockReset().mockImplementation((_agentRoot: string, habit: any) => habit)
    mockReadHabitSessionSummary.mockReset().mockReturnValue(null)
  })

  it("records content-free habit wrapper rows with provider usage from the habit turn result", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    const runTurn = vi.fn().mockResolvedValue({
      turnOutcome: "settled",
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        reasoning_tokens: 1,
        total_tokens: 30,
      },
      messages: [{ role: "assistant", content: "Guests updated." }],
    })
    const worker = createPrivateRuntimeWorker(runTurn, undefined, () => new Date("2026-07-09T17:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "rsvp", trigger: "scheduled" })

    const rows = readRunLedger(agentRoot)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      agent: "slugger",
      triggerType: "habit",
      sourceKind: "private-runtime",
      senseOrHabit: "rsvp",
      lifecycle: "started",
      contentStored: false,
    })
    expect(rows[1]).toMatchObject({
      agent: "slugger",
      triggerType: "habit",
      sourceKind: "private-runtime",
      senseOrHabit: "rsvp",
      lifecycle: "completed",
      contentStored: false,
      usage: {
        source: "provider",
        inputTokens: 21,
        outputTokens: 8,
        reasoningTokens: 1,
        totalTokens: 30,
      },
    })
    expect(rows[1]?.runId).toBe(rows[0]?.runId)
    expect(rows[1]?.rootRunId).toBe(rows[0]?.rootRunId)

    const serialized = JSON.stringify(rows)
    expect(serialized).not.toContain("Guests updated")
    expect(serialized).not.toContain("AislePlanner RSVP state")
  })

  it("normalizes missing provider reasoning token usage to zero", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    const runTurn = vi.fn().mockResolvedValue({
      turnOutcome: "settled",
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        total_tokens: 29,
      },
      messages: [{ role: "assistant", content: "Guests updated." }],
    })
    const worker = createPrivateRuntimeWorker(runTurn, undefined, () => new Date("2026-07-09T17:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "rsvp", trigger: "scheduled" })

    const rows = readRunLedger(agentRoot)
    expect(rows[1]).toMatchObject({
      lifecycle: "completed",
      usage: {
        source: "provider",
        inputTokens: 21,
        outputTokens: 8,
        reasoningTokens: 0,
        totalTokens: 29,
      },
    })
  })

  it("mirrors typed RSVP habit wrapper rows into the RSVP spend ledger", async () => {
    const agentRoot = tempTypedRsvpAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    const runTurn = vi.fn().mockResolvedValue({
      turnOutcome: "settled",
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        reasoning_tokens: 1,
        total_tokens: 30,
      },
      messages: [{ role: "assistant", content: "RSVP work complete." }],
    })
    const worker = createPrivateRuntimeWorker(runTurn, undefined, () => new Date("2026-07-09T17:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "rsvp-wedding", trigger: "scheduled" })

    const rows = readRunLedger(agentRoot)
    const spendLedger = readRsvpSpendLedger(agentRoot)
    expect(spendLedger.runs).toHaveLength(2)
    expect(spendLedger.runs.map((row) => row.lifecycle)).toEqual(["started", "completed"])
    expect(spendLedger.runs[0]).toMatchObject({
      runId: rows[0]?.runId,
      habitName: "rsvp-wedding",
      contentStored: false,
    })
    expect(spendLedger.runs[1]).toMatchObject({
      runId: rows[1]?.runId,
      habitName: "rsvp-wedding",
      usage: {
        source: "provider",
        inputTokens: 21,
        outputTokens: 8,
        reasoningTokens: 1,
        totalTokens: 30,
      },
      contentStored: false,
    })
    expect(JSON.stringify(spendLedger)).not.toContain("RSVP work complete")
  })
})
