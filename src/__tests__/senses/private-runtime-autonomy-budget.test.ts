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

import {
  AUTONOMY_BUDGET_DEFAULT_POLICY,
  autonomyReceiptsDir,
  readAutonomyBudgetState,
  reserveAutonomyBudget,
} from "../../heart/autonomy-budget"
import { createPrivateRuntimeWorker } from "../../senses/private-runtime-worker"

function tempAgentRoot(): string {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-budget-"))
  fs.mkdirSync(path.join(agentRoot, "habits"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "habits", "rsvp.md"), [
    "---",
    "title: RSVP Check",
    "cadence: daily",
    "tools: []",
    "---",
    "",
    "Check the private RSVP state.",
  ].join("\n"), "utf-8")
  return agentRoot
}

describe("private-runtime autonomy budget", () => {
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

  it("skips an over-budget habit before runTurn and leaves a blocked receipt", async () => {
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    for (let index = 0; index < AUTONOMY_BUDGET_DEFAULT_POLICY.habitPaidTurnsPerDay; index++) {
      expect(reserveAutonomyBudget(agentRoot, {
        agent: "slugger",
        triggerType: "habit",
        sourceKind: "private-runtime",
        senseOrHabit: "rsvp",
        target: { habitName: "rsvp", run: index, body: "do not store habit body" },
        idempotencyKey: `habit:rsvp:${index}`,
        now: "2026-07-09T12:00:00.000Z",
      }).allowed).toBe(true)
    }
    const runTurn = vi.fn().mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 },
    })
    const worker = createPrivateRuntimeWorker(runTurn, undefined, () => new Date("2026-07-09T17:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "rsvp", trigger: "scheduled" })

    expect(runTurn).not.toHaveBeenCalled()
    expect(readAutonomyBudgetState(agentRoot).reservations).toHaveLength(AUTONOMY_BUDGET_DEFAULT_POLICY.habitPaidTurnsPerDay)
    expect(fs.readdirSync(autonomyReceiptsDir(agentRoot)).some((name) => name.endsWith(".json"))).toBe(true)
    expect(JSON.stringify(mockWriteHabitRunReceipt.mock.calls)).toContain("autonomy budget blocked")
    expect(JSON.stringify(readAutonomyBudgetState(agentRoot))).not.toContain("do not store habit body")
  })
})
