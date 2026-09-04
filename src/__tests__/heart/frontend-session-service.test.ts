import { describe, expect, it, vi } from "vitest"

import type { RunSenseTurnResult } from "../../senses/shared-turn"

function settledResult(response = "ok"): RunSenseTurnResult {
  return {
    response,
    ponderDeferred: false,
    deliveries: [],
    deliveryFailures: [],
    turnOutcome: "settled",
  }
}

function request(turnId = "turn-1") {
  return {
    turnId,
    agent: "boss",
    friendId: "friend-1",
    channel: "mcp" as const,
    sessionKey: "session-1",
    message: "hello",
  }
}

describe("frontend session service", () => {
  it("passes an owned signal to the turn and returns the structured result", async () => {
    const runner = vi.fn(async (input: any) => {
      expect(input.signal).toBeInstanceOf(AbortSignal)
      expect(input.signal.aborted).toBe(false)
      return settledResult("hello")
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })

    await expect(service.runTurn(request())).resolves.toEqual({
      turnId: "turn-1",
      outcome: "settled",
      response: "hello",
      sessionPath: null,
    })
    expect(service.hasTurn("turn-1")).toBe(false)
  })

  it("cancels the exact active or queued turn", async () => {
    const entered = Promise.withResolvers<AbortSignal>()
    const runner = vi.fn(async (input: any) => {
      entered.resolve(input.signal)
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { ...settledResult(""), turnOutcome: "aborted" as const }
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })
    const running = service.runTurn(request())
    const signal = await entered.promise

    expect(service.cancelTurn("other-turn")).toBe(false)
    expect(service.cancelTurn("turn-1")).toBe(true)
    expect(signal.aborted).toBe(true)
    await expect(running).resolves.toMatchObject({ turnId: "turn-1", outcome: "aborted" })
    expect(service.cancelTurn("turn-1")).toBe(false)
  })

  it("rejects duplicate and invalid turn IDs without replacing the owner", async () => {
    const release = Promise.withResolvers<void>()
    const runner = vi.fn(async () => {
      await release.promise
      return settledResult()
    })
    const { FrontendSessionService, FrontendTurnConflictError } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })
    const first = service.runTurn(request())

    await expect(service.runTurn(request())).rejects.toBeInstanceOf(FrontendTurnConflictError)
    await expect(service.runTurn(request("   "))).rejects.toThrow("turnId")
    expect(service.hasTurn("turn-1")).toBe(true)

    release.resolve()
    await first
  })

  it("removes failed turns from the active map", async () => {
    const runner = vi.fn(async () => {
      throw new Error("provider down")
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })

    await expect(service.runTurn(request())).rejects.toThrow("provider down")
    expect(service.hasTurn("turn-1")).toBe(false)
  })
})
