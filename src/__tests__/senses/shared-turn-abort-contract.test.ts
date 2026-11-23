import { describe, expect, it, vi } from "vitest"

// The process-wide turn queue can stop a queued turn's wait when its signal
// aborts. iMessage asks for that, because it records the outcome of a turn it
// cancels itself. Every other caller keeps the old behaviour: a cancelled
// queued turn waits its turn and then ends with turnOutcome "aborted", which
// callers such as the frontend session service report as a cancellation.

const { withTurnExecutionLease } = vi.hoisted(() => ({
  withTurnExecutionLease: vi.fn(async (_work: () => Promise<unknown>, signal?: AbortSignal) => {
    throw signal?.reason ?? new Error("no signal reached the turn queue")
  }),
}))

vi.mock("../../heart/turn-execution-lease", () => ({ withTurnExecutionLease }))

describe("which turns stop waiting in the turn queue when cancelled", { timeout: 60_000 }, () => {
  it("handleInboundTurn passes the signal when the caller asks to stop waiting on abort", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const controller = new AbortController()
    controller.abort(new Error("turn deadline"))

    await expect(handleInboundTurn({
      signal: controller.signal,
      stopQueueWaitOnAbort: true,
    } as Parameters<typeof handleInboundTurn>[0])).rejects.toThrow("turn deadline")
    expect(withTurnExecutionLease).toHaveBeenLastCalledWith(expect.any(Function), controller.signal)
  })

  it("handleInboundTurn keeps a cancelled queued turn in line by default", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const controller = new AbortController()
    controller.abort(new Error("cancelled by the user"))

    await expect(handleInboundTurn({ signal: controller.signal } as Parameters<typeof handleInboundTurn>[0]))
      .rejects.toThrow("no signal reached the turn queue")
    expect(withTurnExecutionLease).toHaveBeenLastCalledWith(expect.any(Function), undefined)
  })

  it("runSenseTurn keeps a cancelled queued turn in line", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const controller = new AbortController()
    controller.abort(new Error("shutdown"))

    await expect(runSenseTurn({ agentName: "contract-agent", signal: controller.signal } as Parameters<typeof runSenseTurn>[0]))
      .rejects.toThrow("no signal reached the turn queue")
    expect(withTurnExecutionLease).toHaveBeenLastCalledWith(expect.any(Function))
  })
})
