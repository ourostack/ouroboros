import { describe, expect, it, vi } from "vitest"

// Every sense runs its turns through one of the two shared runners:
// handleInboundTurn (iMessage, Teams, CLI) or runSenseTurn (Telegram, voice).
// Both must hand the turn's own abort signal to the process-wide turn queue,
// so a turn stuck behind another one stops waiting on its deadline, on
// supersession and on shutdown.

const { withTurnExecutionLease } = vi.hoisted(() => ({
  withTurnExecutionLease: vi.fn(async (_work: () => Promise<unknown>, signal?: AbortSignal) => {
    throw signal?.reason ?? new Error("no signal reached the turn queue")
  }),
}))

vi.mock("../../heart/turn-execution-lease", () => ({ withTurnExecutionLease }))

describe("shared turn runners pass the turn's abort signal to the turn queue", () => {
  it("handleInboundTurn (iMessage, Teams, CLI)", async () => {
    const { handleInboundTurn } = await import("../../senses/pipeline")
    const controller = new AbortController()
    controller.abort(new Error("turn deadline"))

    await expect(handleInboundTurn({ signal: controller.signal } as Parameters<typeof handleInboundTurn>[0]))
      .rejects.toThrow("turn deadline")
    expect(withTurnExecutionLease).toHaveBeenLastCalledWith(expect.any(Function), controller.signal)
  })

  it("runSenseTurn (Telegram, voice)", async () => {
    const { runSenseTurn } = await import("../../senses/shared-turn")
    const controller = new AbortController()
    controller.abort(new Error("shutdown"))

    await expect(runSenseTurn({ agentName: "contract-agent", signal: controller.signal } as Parameters<typeof runSenseTurn>[0]))
      .rejects.toThrow("shutdown")
    expect(withTurnExecutionLease).toHaveBeenLastCalledWith(expect.any(Function), controller.signal)
  })
})
