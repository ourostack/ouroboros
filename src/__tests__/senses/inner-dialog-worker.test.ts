import { beforeEach, describe, expect, it, vi } from "vitest"

const mockRunInnerDialogTurn = vi.fn()
const mockEmitNervesEvent = vi.fn()
const mockGetAgentName = vi.fn(() => "slugger")
const mockGetInnerDialogPendingDir = vi.fn(() => "/mock/pending/self/inner/dialog")
const mockHasPendingMessages = vi.fn(() => false)

vi.mock("../../senses/inner-dialog", () => ({
  runInnerDialogTurn: (...args: any[]) => mockRunInnerDialogTurn(...args),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
}))

vi.mock("../../mind/pending", () => ({
  getInnerDialogPendingDir: (...args: any[]) => mockGetInnerDialogPendingDir(...args),
  hasPendingMessages: (...args: any[]) => mockHasPendingMessages(...args),
}))

import { createInnerDialogWorker, startInnerDialogWorker } from "../../senses/inner-dialog-worker"

describe("inner-dialog-worker", () => {
  beforeEach(() => {
    mockHasPendingMessages.mockReset().mockReturnValue(false)
    mockGetAgentName.mockReset().mockReturnValue("slugger")
    mockGetInnerDialogPendingDir.mockReset().mockReturnValue("/mock/pending/self/inner/dialog")
  })

  it("runs boot/heartbeat/instinct cycles and ignores unknown messages", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.run("boot")
    await worker.handleMessage({ type: "heartbeat" })
    await worker.handleMessage({ type: "poke" })
    await worker.handleMessage({ type: "chat" })
    await worker.handleMessage({ type: "message" })
    await worker.handleMessage({ type: "unknown" })
    await worker.handleMessage(null)

    expect(runTurn).toHaveBeenCalledTimes(5)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "boot", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "heartbeat", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(3, { reason: "instinct", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(4, { reason: "instinct", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(5, { reason: "instinct", taskId: undefined })
  })

  it("forwards taskId from poke messages to runTurn", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "poke", taskId: "habits/daily-standup" })

    expect(runTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "habits/daily-standup" })
  })

  it("passes undefined taskId when poke has no taskId", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "poke" })

    expect(runTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: undefined })
  })

  it("does not forward taskId from chat or message types", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const worker = createInnerDialogWorker(runTurn)

    await worker.handleMessage({ type: "chat", taskId: "should-be-ignored" })
    await worker.handleMessage({ type: "message", taskId: "should-be-ignored" })

    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "instinct", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: undefined })
  })

  it("emits an error event when a turn fails", async () => {
    const runTurn = vi.fn().mockRejectedValue(new Error("explode"))
    const worker = createInnerDialogWorker(runTurn)

    await worker.run("heartbeat")

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

    await worker.run("heartbeat")

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

  it("coalesces overlapping runs into one guaranteed follow-up turn", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementation(() => gate)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("heartbeat")
    const second = worker.run("heartbeat")
    release()
    await Promise.all([first, second])

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "heartbeat", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "heartbeat", taskId: undefined })
  })

  it("preserves deferred taskId when an overlapping poke arrives during an active run", async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runTurn = vi.fn().mockImplementationOnce(() => gate).mockResolvedValueOnce(undefined)
    const worker = createInnerDialogWorker(runTurn)

    const first = worker.run("heartbeat")
    const second = worker.handleMessage({ type: "poke", taskId: "habits/daily-standup" })
    release()
    await Promise.all([first, second])

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "heartbeat", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: "habits/daily-standup" })
  })

  it("runs a follow-up turn when durable pending work remains after a turn completes", async () => {
    const runTurn = vi.fn().mockResolvedValue(undefined)
    const hasPendingWork = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const worker = createInnerDialogWorker(runTurn, hasPendingWork as any)

    await worker.run("instinct")

    expect(runTurn).toHaveBeenCalledTimes(2)
    expect(runTurn).toHaveBeenNthCalledWith(1, { reason: "instinct", taskId: undefined })
    expect(runTurn).toHaveBeenNthCalledWith(2, { reason: "instinct", taskId: undefined })
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
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "boot", taskId: undefined })

      listeners.message?.({ type: "heartbeat" })
      await Promise.resolve()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "heartbeat", taskId: undefined })

      listeners.message?.({ type: "poke", taskId: "habits/check-in" })
      await Promise.resolve()
      expect(mockRunInnerDialogTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "habits/check-in" })

      expect(() => listeners.disconnect?.()).toThrow("process.exit called")
    } finally {
      onSpy.mockRestore()
      mockExit.mockRestore()
    }
  })
})
