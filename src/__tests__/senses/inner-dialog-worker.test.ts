import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockRunInnerDialogTurn,
  mockEmitNervesEvent,
  mockGetAgentName,
  mockGetAgentRoot,
  mockGetInnerDialogPendingDir,
  mockHasPendingMessages,
  mockRecordHabitRun,
  mockCreateHabitRunId,
  mockIsSafeHabitRunId,
  mockWriteHabitRunReceipt,
  mockApplyHabitRuntimeState,
  mockReadHabitSessionSummary,
  mockReadFileSync,
  MockFileFriendStore,
} = vi.hoisted(() => ({
  mockRunInnerDialogTurn: vi.fn(),
  mockEmitNervesEvent: vi.fn(),
  mockGetAgentName: vi.fn(() => "slugger"),
  mockGetAgentRoot: vi.fn(() => "/bundles/slugger.ouro"),
  mockGetInnerDialogPendingDir: vi.fn(() => "/mock/pending/self/inner/dialog"),
  mockHasPendingMessages: vi.fn(() => false),
  mockRecordHabitRun: vi.fn(),
  mockCreateHabitRunId: vi.fn(() => "habit-run-id"),
  mockIsSafeHabitRunId: vi.fn(() => true),
  mockWriteHabitRunReceipt: vi.fn(),
  mockApplyHabitRuntimeState: vi.fn((_agentRoot: string, habit: any) => habit),
  mockReadHabitSessionSummary: vi.fn(() => null),
  mockReadFileSync: vi.fn(),
  MockFileFriendStore: class {
    get = vi.fn(async () => null)
    put = vi.fn(async () => undefined)
    delete = vi.fn(async () => undefined)
    findByExternalId = vi.fn(async () => null)
    listAll = vi.fn(async () => [])
  },
}))

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>()
  return {
    ...actual,
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  }
})

vi.mock("../../senses/inner-dialog", () => ({
  runInnerDialogTurn: (...args: any[]) => mockRunInnerDialogTurn(...args),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
}))

vi.mock("../../mind/pending", () => ({
  getInnerDialogPendingDir: (...args: any[]) => mockGetInnerDialogPendingDir(...args),
  hasPendingMessages: (...args: any[]) => mockHasPendingMessages(...args),
}))

vi.mock("../../heart/habits/habit-runtime-state", () => ({
  applyHabitRuntimeState: (...args: any[]) => mockApplyHabitRuntimeState(...args),
  recordHabitRun: (...args: any[]) => mockRecordHabitRun(...args),
}))

vi.mock("../../heart/habits/habit-session-summary", () => ({
  readHabitSessionSummary: (...args: any[]) => mockReadHabitSessionSummary(...args),
}))

// Friends now lives in the @ouro.bot/friends package (a single barrel module).
// Mock the package, spreading the real barrel and overriding FileFriendStore.
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

import { createInnerDialogWorker, HEARTBEAT_OK_REST_SUPPRESSION_MS, startInnerDialogWorker } from "../../senses/inner-dialog-worker"

describe("inner-dialog-worker", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset().mockImplementation((filePath: any) => {
      if (String(filePath).includes("/habits/")) return "habit body"
      return ""
    })
    mockHasPendingMessages.mockReset().mockReturnValue(false)
    mockGetAgentName.mockReset().mockReturnValue("slugger")
    mockGetAgentRoot.mockReset().mockReturnValue("/bundles/slugger.ouro")
    mockGetInnerDialogPendingDir.mockReset().mockReturnValue("/mock/pending/self/inner/dialog")
    mockRecordHabitRun.mockReset()
    mockCreateHabitRunId.mockReset().mockReturnValue("habit-run-id")
    mockIsSafeHabitRunId.mockReset().mockReturnValue(true)
    mockWriteHabitRunReceipt.mockReset()
    mockApplyHabitRuntimeState.mockReset().mockImplementation((_agentRoot: string, habit: any) => habit)
    mockReadHabitSessionSummary.mockReset().mockReturnValue(null)
    mockEmitNervesEvent.mockReset()
  })

  it("runs boot/habit/instinct cycles and ignores unknown messages", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.run("boot")
    await worker.handleMessage({ type: "heartbeat" }) // backward compat -> habit/heartbeat
    await worker.handleMessage({ type: "poke" })
    await worker.handleMessage({ type: "chat" })
    await worker.handleMessage({ type: "message" })
    await worker.handleMessage({ type: "unknown" })
    await worker.handleMessage(null)

    expect(runTurn).toHaveBeenCalledTimes(5)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "boot", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
    expect(runTurn).toHaveBeenNthCalledWith(3, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(4, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(5, { reason: "instinct", taskId: undefined, habitName: undefined })
  })

  it("forwards taskId from poke messages to runTurn", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "poke", taskId: "daily-standup" })

    expect(runTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "daily-standup", habitName: undefined })
  })

  it("passes undefined taskId when poke has no taskId", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "poke" })

    expect(runTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: undefined, habitName: undefined })
  })

  it("does not forward taskId from chat or message types", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "chat", taskId: "should-be-ignored" })
    await worker.handleMessage({ type: "message", taskId: "should-be-ignored" })

    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: undefined, habitName: undefined })
  })

  it("handles habit messages with habitName", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "habit", habitName: "heartbeat" })
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat", awaitName: undefined }))
  })

  it("handles await messages with awaitName", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "await", awaitName: "hey_export" })
    expect(runTurn).toHaveBeenCalledWith({ reason: "await", taskId: undefined, habitName: undefined, awaitName: "hey_export" })
  })

  it("await message with no awaitName defaults to (unnamed) but still runs", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "await" })
    expect(runTurn).toHaveBeenCalledWith({ reason: "await", taskId: undefined, habitName: undefined, awaitName: undefined })
  })

  it("handles habit messages with custom habitName", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "habit", habitName: "daily-reflection" })
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "daily-reflection" }))
  })

  it("passes a single prepared parsed habit context into habit turns", async () => {
    mockReadHabitSessionSummary.mockReturnValue({
      summary: "Prior run asked Ari for deployment input.",
      sources: {
        receipt: "arc/flight-recorder/habit-receipts/run-1.json",
        session: "state/habit-sessions/run-1/session.json",
      },
      warnings: ["session file missing"],
    })
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes("/habits/stateful.md")) {
        return [
          "---",
          "title: Stateful Check",
          "cadence: 1h",
          "continuity:",
          "  mode: stateful",
          "tools: [send_message, session_summary]",
          "---",
          "",
          "Keep durable context between fires.",
        ].join("\n")
      }
      return ""
    })
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "stateful", trigger: "poke" })

    const habitReads = mockReadFileSync.mock.calls.filter(([filePath]) => String(filePath).includes("/habits/stateful.md"))
    expect(habitReads).toHaveLength(1)
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      reason: "habit",
      habitName: "stateful",
      trigger: "poke",
      preparedHabit: expect.objectContaining({
        runId: "habit-run-id",
        trigger: "poke",
        operationId: "habit:stateful",
        priorSessionSummary: {
          mode: "stateful",
          summary: "Prior run asked Ari for deployment input.",
          sources: {
            receipt: "arc/flight-recorder/habit-receipts/run-1.json",
            session: "state/habit-sessions/run-1/session.json",
          },
          warnings: ["session file missing"],
        },
        habit: expect.objectContaining({
          name: "stateful",
          title: "Stateful Check",
          continuity: { mode: "stateful" },
          tools: ["send_message", "session_summary"],
          body: "Keep durable context between fires.",
        }),
      }),
    }))
    expect(mockReadHabitSessionSummary).toHaveBeenCalledWith("/bundles/slugger.ouro", {
      operationId: "habit:stateful",
      which: "latest",
    })
  })

  it("passes an empty prior stateful summary when no matching operation is found", async () => {
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes("/habits/stateful.md")) {
        return [
          "---",
          "title: Stateful Check",
          "cadence: 1h",
          "continuity:",
          "  mode: stateful",
          "---",
          "",
          "Keep durable context between fires.",
        ].join("\n")
      }
      return ""
    })
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "stateful", trigger: "poke" })

    expect(mockReadHabitSessionSummary).toHaveBeenCalledWith("/bundles/slugger.ouro", {
      operationId: "habit:stateful",
      which: "latest",
    })
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      preparedHabit: expect.objectContaining({
        operationId: "habit:stateful",
        priorSessionSummary: {
          mode: "stateful",
          summary: null,
          sources: {},
          warnings: [],
        },
      }),
    }))
  })

  it("degrades prior stateful summary read failures into warnings", async () => {
    mockReadHabitSessionSummary.mockImplementation(() => {
      throw new Error("summary index corrupt")
    })
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes("/habits/stateful.md")) {
        return [
          "---",
          "title: Stateful Check",
          "cadence: 1h",
          "continuity:",
          "  mode: stateful",
          "---",
          "",
          "Keep durable context between fires.",
        ].join("\n")
      }
      return ""
    })
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "stateful", trigger: "poke" })

    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      preparedHabit: expect.objectContaining({
        operationId: "habit:stateful",
        priorSessionSummary: {
          mode: "stateful",
          summary: null,
          sources: {},
          warnings: ["prior summary read failed: Error: summary index corrupt"],
        },
      }),
    }))
  })

  it("applies runtime lastRun before passing prepared habit context", async () => {
    mockReadFileSync.mockImplementation((filePath: any) => {
      if (String(filePath).includes("/habits/heartbeat.md")) {
        return "---\ntitle: Heartbeat\ncadence: 30m\ncreated: 2026-06-01T00:00:00.000Z\n---\n\nCheck in."
      }
      return ""
    })
    mockApplyHabitRuntimeState.mockImplementation((_agentRoot: string, habit: any) => ({
      ...habit,
      lastRun: "2026-06-08T11:30:00.000Z",
    }))
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

    await worker.handleMessage({ type: "habit", habitName: "heartbeat", trigger: "overdue" })

    expect(mockApplyHabitRuntimeState).toHaveBeenCalledWith(
      "/bundles/slugger.ouro",
      expect.objectContaining({ name: "heartbeat", lastRun: null }),
    )
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
      preparedHabit: expect.objectContaining({
        habit: expect.objectContaining({
          name: "heartbeat",
          lastRun: "2026-06-08T11:30:00.000Z",
        }),
      }),
    }))
  })

  it("backward compat: heartbeat message maps to habit/heartbeat", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "heartbeat" })
    expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
  })

  it("queues multiple pokes while busy instead of overwriting", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("boot")
    // While first turn runs, queue multiple pokes
    const second = worker.run("instinct", "task-1")
    const third = worker.run("instinct", "task-2")
    const fourth = worker.run("instinct", "task-3")
    release()
    await Promise.all([first, second, third, fourth])

    // Should have run boot + all 3 queued pokes
    expect(runTurn).toHaveBeenCalledTimes(4)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "boot", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: "task-1", habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(3, { reason: "instinct", taskId: "task-2", habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(4, { reason: "instinct", taskId: "task-3", habitName: undefined })
  })

  it("drains queue in order after current turn completes", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const callOrder: string[] = []
    const runTurn = vi.fn().mockImplementation(async (opts: any) => {
      if (callOrder.length === 0) await gate
      callOrder.push(`${opts.reason}:${opts.taskId ?? "none"}:${opts.habitName ?? "none"}`)
    })
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("boot")
    const poke = worker.handleMessage({ type: "poke", taskId: "task-a" })
    const habit = worker.handleMessage({ type: "habit", habitName: "heartbeat" })
    const chat = worker.handleMessage({ type: "chat" })
    release()
    await Promise.all([first, poke, habit, chat])

    expect(callOrder).toEqual([
      "boot:none:none",
      "instinct:task-a:none",
      "habit:none:heartbeat",
      "instinct:none:none",
    ])
  })

  it("hasPendingWork fallback still works after queue is empty", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const hasPendingWork = vi.fn()
      .mockReturnValueOnce(true) // checked after first turn, queue empty
      .mockReturnValueOnce(false) // checked after second turn
    const worker = createInnerDialogWorker(runTurn, hasPendingWork as any)

    await worker.run("instinct")

    // Two turns: the original + one hasPendingWork-triggered follow-up
    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: undefined, habitName: undefined })
  })

  it("mixes habit + poke + chat messages in queue correctly", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("boot")
    const habit1 = worker.handleMessage({ type: "habit", habitName: "heartbeat" })
    const poke1 = worker.handleMessage({ type: "poke", taskId: "task-x" })
    const chat1 = worker.handleMessage({ type: "chat" })
    const habit2 = worker.handleMessage({ type: "habit", habitName: "daily-check" })
    release()
    await Promise.all([first, habit1, poke1, chat1, habit2])

    expect(runTurn).toHaveBeenCalledTimes(5)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "boot", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
    expect(runTurn).toHaveBeenNthCalledWith(3, { reason: "instinct", taskId: "task-x", habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(4, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(5, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "daily-check" }))
  })

  it("emits an error event when a turn fails", async () => {
    const runTurn = vi.fn().mockRejectedValue(new Error("explode"))
    const worker = createInnerDialogWorker(runTurn)

    await worker.run("habit", undefined, "heartbeat")

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "senses.inner_dialog_worker_error",
      }),
    )
  })

  it("stringifies non-Error failures in worker error metadata", async () => {
    mockEmitNervesEvent.mockReset()
    const runTurn = vi.fn().mockRejectedValue("explode-string")
    const worker = createInnerDialogWorker(runTurn)

    await worker.run("habit", undefined, "heartbeat")

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ error: "explode-string" }),
      }),
    )
  })

  it("handles shutdown messages by exiting the process", async () => {
    const worker = createInnerDialogWorker(vi.fn().mockResolvedValue(undefined))
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    try {
      await expect(worker.handleMessage({ type: "shutdown" })).rejects.toThrow("process.exit called")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("queues overlapping runs instead of coalescing", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("habit", undefined, "heartbeat")
    const second = worker.run("habit", undefined, "heartbeat")
    release()
    await Promise.all([first, second])

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
    expect(runTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
  })

  it("preserves deferred taskId when an overlapping poke arrives during an active run", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementationOnce(() => gate).mockResolvedValueOnce(undefined)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("habit", undefined, "heartbeat")
    const second = worker.handleMessage({ type: "poke", taskId: "daily-standup" })
    release()
    await Promise.all([first, second])

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: "daily-standup", habitName: undefined })
  })

  it("runs a follow-up turn when durable pending work remains after a turn completes (legacy test)", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const hasPendingWork = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const worker = createInnerDialogWorker(runTurn, hasPendingWork as any)

    await worker.run("instinct")

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: undefined, habitName: undefined })
  })

  it("starts worker listeners and triggers boot + event cycles", async () => {
    mockRunInnerDialogTurn.mockReset().mockResolvedValue(undefined)
    const listeners: Record<string, (...args: any[]) => void> = {}
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => void) => {
      listeners[event] = handler
      return process
    }) as any)
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)

    try {
      await startInnerDialogWorker()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "boot", taskId: undefined, habitName: undefined })

      listeners.message?.({ type: "heartbeat" })
      await new Promise((resolve) => setImmediate(resolve))
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))

      listeners.message?.({ type: "poke", taskId: "check-in" })
      await new Promise((resolve) => setImmediate(resolve))
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "check-in", habitName: undefined })

      expect(() => listeners.disconnect?.()).toThrow("process.exit called")
    } finally {
      onSpy.mockRestore()
      mockExit.mockRestore()
    }
  })

  // ── lastRun runtime-state tests ───────────────────────────────────

  describe("lastRun update after habit turn", () => {
    it("records habit lastRun in runtime state after a habit turn", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn)

      await worker.run("habit", undefined, "heartbeat")

      expect(mockRecordHabitRun).toHaveBeenCalledWith(
        "/bundles/slugger.ouro",
        "heartbeat",
        expect.any(String),
        {
          definitionPath: "/bundles/slugger.ouro/habits/heartbeat.md",
          activeOperationId: null,
          latestRunId: "habit-run-id",
          latestReceiptLocator: "arc/flight-recorder/habit-receipts/habit-run-id.json",
        },
      )

      const lastRun = mockRecordHabitRun.mock.calls[0]?.[2] as string
      expect(new Date(lastRun).toISOString()).toBe(lastRun)
    })

    it("writes an Arc habit receipt with outcome and trigger", async () => {
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordProducedRef({ kind: "desk_record", locator: "desk/_record" })
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "daily-record", trigger: "poke" })

      expect(mockCreateHabitRunId).toHaveBeenCalledWith("daily-record", new Date("2026-06-08T12:00:00.000Z"))
      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        schemaVersion: 2,
        runId: "habit-run-id",
        sessionId: "habit-run-id",
        habitName: "daily-record",
        trigger: "poke",
        startedAt: "2026-06-08T12:00:00.000Z",
        endedAt: "2026-06-08T12:00:00.000Z",
        outcome: "wrote_record",
        definitionLocator: "habits/daily-record.md",
        sessionLocator: "state/habit-sessions/habit-run-id/session.json",
        pendingLocator: "state/habit-sessions/habit-run-id/pending",
        runtimeStateLocator: "state/habits/daily-record.json",
        receiptLocator: "arc/flight-recorder/habit-receipts/habit-run-id.json",
        permissionEnvelope: expect.objectContaining({ schemaVersion: 1, canMessageOutward: true }),
        toolPolicy: expect.objectContaining({ requestedTools: null, outwardMessagingAllowed: true }),
        producedRefs: [{ kind: "desk_record", locator: "desk/_record" }],
        surfaceAttempts: [],
        errors: [],
      }))
    })

    it("derives the receipt summary snapshot from the latest assistant result", async () => {
      const runTurn = vi.fn().mockResolvedValue({
        messages: [
          { role: "assistant", content: "checkpoint: Asked Ari for the missing production URL." },
        ],
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "stateful-check", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        habitName: "stateful-check",
        summarySnapshot: {
          summary: "Asked Ari for the missing production URL.",
          decisions: [],
          nextLikelyStep: null,
        },
      }))
      expect(mockRecordHabitRun).toHaveBeenCalledTimes(1)
    })

    it("derives the receipt summary snapshot from multimodal assistant text parts", async () => {
      const runTurn = vi.fn().mockResolvedValue({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "checkpoint: Confirmed the first run summary." },
              { type: "text", text: "Next, compare the second run." },
              { type: "image", image_url: "ignored" },
            ],
          },
        ],
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "stateful-check", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        summarySnapshot: {
          summary: "Confirmed the first run summary.\nNext, compare the second run.",
          decisions: [],
          nextLikelyStep: null,
        },
      }))
    })

    it("ignores non-assistant result messages before using assistant checkpoint text", async () => {
      const runTurn = vi.fn().mockResolvedValue({
        messages: [
          { role: "assistant", content: "checkpoint:" },
          { role: "user", content: "ignore me" },
          null,
        ],
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "stateful-check", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        summarySnapshot: {
          summary: "checkpoint:",
          decisions: [],
          nextLikelyStep: null,
        },
      }))
    })

    it("classifies successful structured surface attempts as surfaced", async () => {
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordSurfaceAttempt({
          recipient: "ari",
          channel: "cli",
          reason: "status",
          result: "queued",
          rawStatus: "queued",
        })
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "surface-check", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        outcome: "surfaced",
        producedRefs: [{ kind: "surface", locator: "surface/ari/cli" }],
      }))
    })

    it("does not classify blocked transcript tool calls as successful surface refs", async () => {
      const runTurn = vi.fn().mockResolvedValue([
        { messages: [] },
        {
          messages: [{
            role: "assistant",
            tool_calls: [
              { id: "tc-1", type: "function", function: { name: "surface", arguments: "{}" } },
            ],
          }],
        },
      ])
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "array-result", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        outcome: "no_change",
        producedRefs: [],
      }))
    })

    it("classifies blocked structured surface attempts as blocked without surface refs", async () => {
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordSurfaceAttempt({
          recipient: "ari",
          channel: "cli",
          reason: "blocked",
          result: "blocked",
          rawStatus: "blocked",
          error: "route denied",
        })
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "blocked-surface", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        outcome: "blocked",
        producedRefs: [],
      }))
    })

    it("classifies structured Desk produced refs as updated desk", async () => {
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordProducedRef({ kind: "desk_task", locator: "desk/main/task" })
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "desk-check", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        outcome: "updated_desk",
        producedRefs: [{ kind: "desk_task", locator: "desk/main/task" }],
      }))
    })

    it("ignores malformed tool call shapes when classifying habit turns", async () => {
      const runTurn = vi.fn().mockResolvedValue({
        messages: [
          { role: "assistant", tool_calls: "not an array" },
          { role: "assistant", tool_calls: [{ id: "tc-1", type: "function", function: { name: 7 } }] },
        ],
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "malformed-tools", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        outcome: "no_change",
        producedRefs: [],
      }))
    })

    it("writes structured recorder refs and surface attempts into the habit receipt", async () => {
      const producedRef = { kind: "claim" as const, locator: "claim:abc123" }
      const surfaceAttempt = {
        recipient: "ari",
        channel: "bluebubbles",
        reason: "answer" as const,
        result: "queued" as const,
        rawStatus: "queued",
        routeKind: "originator" as const,
      }
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordProducedRef(producedRef)
        options.habitSession.recordSurfaceAttempt(surfaceAttempt)
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "structured", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        schemaVersion: 2,
        habitName: "structured",
        producedRefs: [producedRef],
        surfaceAttempts: [surfaceAttempt],
        errors: [],
      }))
    })

    it("records unreadable habit files as receipt errors with a fail-closed session", async () => {
      mockReadFileSync.mockImplementation((filePath: any) => {
        if (String(filePath).includes("/habits/")) throw new Error("habit missing")
        return ""
      })
      const runTurn = vi.fn().mockResolvedValue({ messages: [] })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "missing", trigger: "poke" })

      expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
        habitSession: expect.objectContaining({
          permissionEnvelope: expect.objectContaining({
            canMessageOutward: false,
            deniedTools: ["send_message", "surface"],
          }),
          toolPolicy: expect.objectContaining({
            requestedTools: [],
            grantedTools: [],
          }),
        }),
      }))
      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        habitName: "missing",
        outcome: "error",
        errors: [expect.stringContaining("habit missing")],
      }))
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "senses.habit_file_read_error",
        level: "warn",
      }))
    })

    it("uses executable shell risk when preparing habit tool policy", async () => {
      mockReadFileSync.mockImplementation((filePath: any) => {
        if (String(filePath).includes("/habits/")) return [
          "---",
          "tools: [shell]",
          "---",
          "",
          "try a shell command",
          "",
        ].join("\n")
        return ""
      })
      const runTurn = vi.fn().mockResolvedValue({ messages: [] })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "shell-probe", trigger: "poke" })

      expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({
        habitSession: expect.objectContaining({
          toolPolicy: expect.objectContaining({
            requestedTools: ["shell"],
            grantedTools: [],
            deniedTools: ["shell"],
          }),
        }),
      }))
      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        toolPolicy: expect.objectContaining({
          requestedTools: ["shell"],
          grantedTools: [],
          deniedTools: ["shell"],
        }),
      }))
    })

    it("records non-Error habit file read failures losslessly", async () => {
      mockReadFileSync.mockImplementation((filePath: any) => {
        if (String(filePath).includes("/habits/")) throw "habit missing as string"
        return ""
      })
      const runTurn = vi.fn().mockResolvedValue({ messages: [] })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "string-missing", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        habitName: "string-missing",
        outcome: "error",
        errors: [expect.stringContaining("habit missing as string")],
      }))
    })

    it("writes structured recorder errors into the habit receipt", async () => {
      const runTurn = vi.fn().mockImplementation(async (options) => {
        options.habitSession.recordError("tool metadata failed")
        return { messages: [] }
      })
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.handleMessage({ type: "habit", habitName: "error-recorder", trigger: "poke" })

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledWith("/bundles/slugger.ouro", expect.objectContaining({
        habitName: "error-recorder",
        outcome: "error",
        errors: ["tool metadata failed"],
      }))
    })

    it("records lastRun AFTER the turn completes (not before)", async () => {
      const callOrder: string[] = []

      const runTurn = vi.fn().mockImplementation(async () => {
        callOrder.push("runTurn")
      })
      mockRecordHabitRun.mockImplementation(() => {
        callOrder.push("recordHabitRun")
      })

      const worker = createInnerDialogWorker(runTurn)
      await worker.run("habit", undefined, "heartbeat")

      expect(callOrder).toEqual(["runTurn", "recordHabitRun"])
    })

    it("skips lastRun update gracefully if runtime-state recording fails", async () => {
      mockRecordHabitRun.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory")
      })

      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn)

      // Should not throw
      await worker.run("habit", undefined, "heartbeat")

      expect(mockRecordHabitRun).toHaveBeenCalledTimes(1)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        event: "senses.habit_runtime_state_record_error",
        meta: expect.objectContaining({
          habitName: "heartbeat",
          runId: "habit-run-id",
          error: "Error: ENOENT: no such file or directory",
        }),
      }))
    })

    it("does not advance runtime state when habit receipt writing fails", async () => {
      mockWriteHabitRunReceipt.mockImplementation(() => {
        throw new Error("disk full")
      })
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.run("habit", undefined, "heartbeat")

      expect(mockRecordHabitRun).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "senses.habit_receipt_write_error",
        meta: expect.objectContaining({
          habitName: "heartbeat",
          runId: "habit-run-id",
          error: "Error: disk full",
        }),
      }))
    })

    it("records non-Error habit receipt write failures without advancing runtime state", async () => {
      mockWriteHabitRunReceipt.mockImplementation(() => {
        throw "disk full as string"
      })
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.run("habit", undefined, "heartbeat")

      expect(mockRecordHabitRun).not.toHaveBeenCalled()
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "error",
        event: "senses.habit_receipt_write_error",
        meta: expect.objectContaining({
          habitName: "heartbeat",
          runId: "habit-run-id",
          error: "disk full as string",
        }),
      }))
    })

    it("records non-Error runtime-state failures after receipt write", async () => {
      mockRecordHabitRun.mockImplementation(() => {
        throw "runtime state unavailable"
      })
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn, undefined, () => new Date("2026-06-08T12:00:00.000Z").getTime())

      await worker.run("habit", undefined, "heartbeat")

      expect(mockWriteHabitRunReceipt).toHaveBeenCalledTimes(1)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        level: "warn",
        event: "senses.habit_runtime_state_record_error",
        meta: expect.objectContaining({
          habitName: "heartbeat",
          runId: "habit-run-id",
          error: "runtime state unavailable",
        }),
      }))
    })

    it("does not update lastRun for non-habit turns", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn)

      await worker.run("instinct")
      await worker.run("boot")

      expect(mockRecordHabitRun).not.toHaveBeenCalled()
    })

    it("updates lastRun with ISO timestamp from current time", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const worker = createInnerDialogWorker(runTurn)

      await worker.run("habit", undefined, "daily-reflection")

      const lastRun = mockRecordHabitRun.mock.calls[0]?.[2] as string
      // Should be a valid ISO date string
      expect(lastRun).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    })
  })

  describe("instinct-loop cap (rest-detection backstop)", () => {
    // Real harness friction: a tool that writes to the inner-dialog pending
    // dir during a turn (e.g. a surface tool routing a response) puts the
    // worker into a self-sustaining loop where the next turn's drain produces
    // another write, ad infinitum. The cap breaks the loop after a small
    // number of consecutive instinct turns without external input.
    it("caps consecutive instinct chaining when hasPendingWork keeps returning true", async () => {
      // Always say "fresh work arrived" — simulates the self-sustaining write.
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(true)
      const worker = createInnerDialogWorker(runTurn, hasPendingWork)

      await worker.run("habit", undefined, "heartbeat")

      // Heartbeat turn (1) + 3 same-run habit follow-ups + cap = 4 total turns
      expect(runTurn).toHaveBeenCalledTimes(4)
      expect(runTurn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ reason: "habit", habitName: "heartbeat" }))
      for (let i = 1; i <= 3; i++) {
        expect(runTurn.mock.calls[i]?.[0]).toEqual(expect.objectContaining({ reason: "habit", habitName: "heartbeat" }))
      }
      // Cap event was emitted exactly once
      const capEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.inner_dialog_worker_instinct_loop_capped")
      expect(capEvents).toHaveLength(1)
      expect(capEvents[0]?.[0]).toEqual(expect.objectContaining({
        level: "warn",
        meta: expect.objectContaining({
          consecutiveInstinctTurns: 3,
          cap: 3,
          lastReason: "habit",
        }),
      }))
    })

    it("keeps habit-created follow-on pending work in the same habit run instead of generic instinct", async () => {
      mockCreateHabitRunId
        .mockReturnValueOnce("habit-run-1")
        .mockReturnValueOnce("habit-run-2")
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn()
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
      const worker = createInnerDialogWorker(runTurn, hasPendingWork)

      await worker.run("habit", undefined, "heartbeat", undefined, "poke")

      expect(runTurn).toHaveBeenCalledTimes(2)
      expect(runTurn.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
        reason: "habit",
        habitName: "heartbeat",
      }))
      expect(runTurn.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
        reason: "habit",
        habitName: "heartbeat",
      }))
      expect(mockCreateHabitRunId).toHaveBeenCalledTimes(1)
      expect(runTurn.mock.calls[0]?.[0].habitSession).toEqual(expect.objectContaining({
        runId: "habit-run-1",
        sessionPath: "/bundles/slugger.ouro/state/habit-sessions/habit-run-1/session.json",
        pendingDir: "/bundles/slugger.ouro/state/habit-sessions/habit-run-1/pending",
      }))
      expect(runTurn.mock.calls[1]?.[0].habitSession).toEqual(expect.objectContaining({
        runId: "habit-run-1",
        sessionPath: "/bundles/slugger.ouro/state/habit-sessions/habit-run-1/session.json",
        pendingDir: "/bundles/slugger.ouro/state/habit-sessions/habit-run-1/pending",
      }))
    })

    it("counts the initial instinct entry against the cap", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(true)
      const worker = createInnerDialogWorker(runTurn, hasPendingWork)

      await worker.run("instinct")

      // Initial instinct counts as 1, plus 2 follow-ups, then cap fires
      expect(runTurn).toHaveBeenCalledTimes(3)
    })

    it("resets the instinct counter when an externally-queued message arrives between turns", async () => {
      const runTurn = vi.fn().mockImplementation(async () => {
        // Simulate an external poke arriving during the first turn's runtime.
        if (runTurn.mock.calls.length === 1) {
          void worker.handleMessage({ type: "poke", taskId: "external-poke" })
        }
      })
      const hasPendingWork = vi.fn().mockReturnValue(true)
      const worker = createInnerDialogWorker(runTurn, hasPendingWork)

      await worker.run("habit", undefined, "heartbeat")

      // Sequence: heartbeat (1) → poke arrived (queued) → poke runs as instinct (counter resets to 1)
      // → 2 more instinct via hasPendingWork → cap at 3 instinct chain
      // Total turns: 1 (heartbeat) + 1 (poke) + 2 (chained instinct) = 4
      expect(runTurn).toHaveBeenCalledTimes(4)
      // The second turn was the externally-poked one
      expect(runTurn.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ reason: "instinct", taskId: "external-poke" }))
    })

    it("does not cap when no follow-on work is detected (single happy-path turn)", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      const worker = createInnerDialogWorker(runTurn, hasPendingWork)

      await worker.run("habit", undefined, "heartbeat")

      expect(runTurn).toHaveBeenCalledTimes(1)
      const capEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.inner_dialog_worker_instinct_loop_capped")
      expect(capEvents).toHaveLength(0)
    })
  })

  describe("habit recursion detection", () => {
    it("emits a warn event when two heartbeats arrive within the min-interval window", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 1_000_000
      const nowSource = () => now
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, nowSource)

      await worker.handleMessage({ type: "heartbeat" })
      now += 1_500
      await worker.handleMessage({ type: "heartbeat" })

      const recursionEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.habit_recursion_suspected")
      expect(recursionEvents).toHaveLength(1)
      expect(recursionEvents[0]?.[0]).toEqual(expect.objectContaining({
        level: "warn",
        meta: expect.objectContaining({ habitName: "heartbeat", intervalMs: 1_500 }),
      }))
    })

    it("does not emit when heartbeats are spaced beyond the min-interval window", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 2_000_000
      const nowSource = () => now
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, nowSource)

      await worker.handleMessage({ type: "heartbeat" })
      now += 30_000
      await worker.handleMessage({ type: "heartbeat" })

      const recursionEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.habit_recursion_suspected")
      expect(recursionEvents).toHaveLength(0)
    })

    it("emits a burst event when the configured threshold of habits arrive within the burst window", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 3_000_000
      const nowSource = () => now
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, nowSource)

      for (let i = 0; i < 5; i++) {
        await worker.handleMessage({ type: "habit", habitName: "heartbeat" })
        now += 6_000
      }

      const burstEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.habit_recursion_burst")
      expect(burstEvents.length).toBeGreaterThanOrEqual(1)
      expect(burstEvents[0]?.[0]).toEqual(expect.objectContaining({
        level: "warn",
        meta: expect.objectContaining({ count: 5, lastHabitName: "heartbeat" }),
      }))
    })

    it("trims old fires outside the burst window and does not falsely escalate", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 4_000_000
      const nowSource = () => now
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, nowSource)

      for (let i = 0; i < 4; i++) {
        await worker.handleMessage({ type: "habit", habitName: "heartbeat" })
        now += 6_000
      }
      now += 90_000
      await worker.handleMessage({ type: "habit", habitName: "heartbeat" })

      const burstEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.habit_recursion_burst")
      expect(burstEvents).toHaveLength(0)
    })

    it("tracks per-habit-name independently — two distinct habits firing close together do not trip the min-interval warning", async () => {
      const runTurn = vi.fn().mockResolvedValue(undefined)
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 5_000_000
      const nowSource = () => now
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, nowSource)

      await worker.handleMessage({ type: "habit", habitName: "heartbeat" })
      now += 1_000
      await worker.handleMessage({ type: "habit", habitName: "morning-review" })

      const recursionEvents = mockEmitNervesEvent.mock.calls.filter(([event]) => (event as any).event === "senses.habit_recursion_suspected")
      expect(recursionEvents).toHaveLength(0)
    })
  })

  describe("HEARTBEAT_OK rest shield", () => {
    it("accepts repeated heartbeat fires without another model turn after clean HEARTBEAT_OK", async () => {
      const runTurn = vi.fn().mockResolvedValue({ turnOutcome: "rested", restStatus: "HEARTBEAT_OK" })
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 10_000_000
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })
      now += 60_000
      await worker.handleMessage({ type: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(1)
      expect(runTurn).toHaveBeenCalledWith(expect.objectContaining({ reason: "habit", taskId: undefined, habitName: "heartbeat" }))
      expect(mockRecordHabitRun).toHaveBeenCalledTimes(2)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          level: "info",
          event: "senses.heartbeat_ok_rest_reused",
          meta: expect.objectContaining({ habitName: "heartbeat" }),
        }),
      )
      expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "senses.habit_recursion_suspected" }),
      )
    })

    it("does not reuse HEARTBEAT_OK rest when pending work exists", async () => {
      const runTurn = vi.fn().mockResolvedValue({ turnOutcome: "rested", restStatus: "HEARTBEAT_OK" })
      const hasPendingWork = vi.fn()
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true)
        .mockReturnValue(false)
      let now = 11_000_000
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })
      now += 60_000
      await worker.handleMessage({ type: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(2)
      expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "senses.heartbeat_ok_rest_reused" }),
      )
    })

    it("accepts habit heartbeat fires without another model turn after clean HEARTBEAT_OK", async () => {
      const runTurn = vi.fn().mockResolvedValue({ turnOutcome: "rested", restStatus: "HEARTBEAT_OK" })
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 11_500_000
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })
      now += 60_000
      await worker.handleMessage({ type: "habit", habitName: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(1)
      expect(mockRecordHabitRun).toHaveBeenCalledTimes(2)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "senses.heartbeat_ok_rest_reused" }),
      )
    })

    it("accepts queued heartbeat fires without another model turn after clean HEARTBEAT_OK", async () => {
      let now = 11_750_000
      let worker!: ReturnType<typeof createInnerDialogWorker>
      const runTurn = vi.fn().mockImplementation(async () => {
        if (runTurn.mock.calls.length === 1) {
          now += 60_000
          await worker.handleMessage({ type: "heartbeat" })
        }
        return { turnOutcome: "rested", restStatus: "HEARTBEAT_OK" }
      })
      const hasPendingWork = vi.fn().mockReturnValue(false)
      worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(1)
      expect(mockRecordHabitRun).toHaveBeenCalledTimes(2)
      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({ event: "senses.heartbeat_ok_rest_reused" }),
      )
    })

    it("lets heartbeat run again after the HEARTBEAT_OK quiet window expires", async () => {
      const runTurn = vi.fn().mockResolvedValue({ turnOutcome: "rested", restStatus: "HEARTBEAT_OK" })
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 12_000_000
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })
      now += HEARTBEAT_OK_REST_SUPPRESSION_MS + 1
      await worker.handleMessage({ type: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(2)
    })

    it("does not suppress heartbeat after a non-HEARTBEAT_OK rest", async () => {
      const runTurn = vi.fn().mockResolvedValue({ turnOutcome: "rested", restStatus: "thinking" })
      const hasPendingWork = vi.fn().mockReturnValue(false)
      let now = 13_000_000
      const worker = createInnerDialogWorker(runTurn, hasPendingWork, () => now)

      await worker.handleMessage({ type: "heartbeat" })
      now += 60_000
      await worker.handleMessage({ type: "heartbeat" })

      expect(runTurn).toHaveBeenCalledTimes(2)
    })
  })
})
