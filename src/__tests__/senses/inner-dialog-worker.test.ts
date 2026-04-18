import { beforeEach, describe, expect, it, vi } from "vitest"

const mockRunInnerDialogTurn = vi.fn()
const mockEmitNervesEvent = vi.fn()
const mockGetAgentName = vi.fn(() => "slugger")
const mockGetAgentRoot = vi.fn(() => "/bundles/slugger.ouro")
const mockGetInnerDialogPendingDir = vi.fn(() => "/mock/pending/self/inner/dialog")
const mockHasPendingMessages = vi.fn(() => false)
const mockRecordHabitRun = vi.fn()

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
  recordHabitRun: (...args: any[]) => mockRecordHabitRun(...args),
}))

import { createInnerDialogWorker, startInnerDialogWorker } from "../../senses/inner-dialog-worker"

describe("inner-dialog-worker", () => {
  beforeEach(() => {
    mockHasPendingMessages.mockReset().mockReturnValue(false)
    mockGetAgentName.mockReset().mockReturnValue("slugger")
    mockGetAgentRoot.mockReset().mockReturnValue("/bundles/slugger.ouro")
    mockGetInnerDialogPendingDir.mockReset().mockReturnValue("/mock/pending/self/inner/dialog")
    mockRecordHabitRun.mockReset()
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
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "habit", taskId: undefined, habitName: "heartbeat" })
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
    expect(runTurn).toHaveBeenCalledWith({ reason: "habit", taskId: undefined, habitName: "heartbeat" })
  })

  it("handles habit messages with custom habitName", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "habit", habitName: "daily-reflection" })
    expect(runTurn).toHaveBeenCalledWith({ reason: "habit", taskId: undefined, habitName: "daily-reflection" })
  })

  it("backward compat: heartbeat message maps to habit/heartbeat", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "heartbeat" })
    expect(runTurn).toHaveBeenCalledWith({ reason: "habit", taskId: undefined, habitName: "heartbeat" })
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
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "habit", taskId: undefined, habitName: "heartbeat" })
    expect(runTurn).toHaveBeenNthCalledWith(3, { reason: "instinct", taskId: "task-x", habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(4, { reason: "instinct", taskId: undefined, habitName: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(5, { reason: "habit", taskId: undefined, habitName: "daily-check" })
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
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "habit", taskId: undefined, habitName: "heartbeat" })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "habit", taskId: undefined, habitName: "heartbeat" })
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
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "habit", taskId: undefined, habitName: "heartbeat" })
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
      await Promise.resolve()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "habit", taskId: undefined, habitName: "heartbeat" })

      listeners.message?.({ type: "poke", taskId: "check-in" })
      await Promise.resolve()
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
        { definitionPath: "/bundles/slugger.ouro/habits/heartbeat.md" },
      )

      const lastRun = mockRecordHabitRun.mock.calls[0]?.[2] as string
      expect(new Date(lastRun).toISOString()).toBe(lastRun)
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
})
