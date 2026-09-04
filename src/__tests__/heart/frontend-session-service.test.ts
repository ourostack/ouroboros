import { describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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
      return { ...settledResult("hello"), sessionPath: "/tmp/session.json" }
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })

    await expect(service.runTurn(request())).resolves.toEqual({
      turnId: "turn-1",
      outcome: "settled",
      response: "hello",
      sessionPath: "/tmp/session.json",
    })
    expect(service.hasTurn("turn-1")).toBe(false)
  })

  it("uses the production runner when no test runner is supplied", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService()

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
    expect(service.cancelTurn("turn-1")).toBe(false)
    expect(service.cancelAllTurns()).toBe(0)
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

  it("forwards runtime MCP configuration and rejects a missing outcome", async () => {
    const runtimeMcpServers = {
      ouro_workbench: { command: "/Applications/OuroWorkbenchMCP", args: [] },
    }
    const runner = vi.fn(async (input: any) => {
      expect(input.runtimeMcpServers).toEqual(runtimeMcpServers)
      return { ...settledResult(), turnOutcome: undefined }
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })

    await expect(service.runTurn({ ...request(), runtimeMcpServers })).rejects.toThrow("omitted its outcome")
    expect(service.hasTurn("turn-1")).toBe(false)
  })

  it("cancels every active frontend turn during daemon shutdown", async () => {
    const entered = [Promise.withResolvers<AbortSignal>(), Promise.withResolvers<AbortSignal>()]
    let index = 0
    const runner = vi.fn(async (input: any) => {
      entered[index++].resolve(input.signal)
      await new Promise<void>((resolve) => input.signal.addEventListener("abort", () => resolve(), { once: true }))
      return { ...settledResult(""), turnOutcome: "aborted" as const }
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })
    const turns = [service.runTurn(request("turn-1")), service.runTurn(request("turn-2"))]
    const signals = await Promise.all(entered.map((item) => item.promise))

    expect(service.cancelAllTurns()).toBe(2)
    expect(signals.every((signal) => signal.aborted)).toBe(true)
    await Promise.all(turns)
    expect(service.cancelAllTurns()).toBe(0)
  })

  it("writes turn-ahead, stable callback, and terminal events to one journal", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-service-journal-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const observed: any[] = []
    const runner = vi.fn(async (input: any) => {
      input.frontendEventSink.onEvent({ type: "text_delta", data: { text: "live" } })
      input.frontendEventSink.onEvent({ type: "assistant_delivery", data: { kind: "speak", text: "first" } })
      input.frontendEventSink.onEvent({ type: "assistant_delivery", data: { kind: "settle", text: "second" } })
      input.frontendEventSink.onEvent({ type: "tool_started", data: { name: "read_file", args: {} } })
      input.frontendEventSink.onEvent({ type: "tool_completed", data: { name: "read_file", summary: "ok", success: true } })
      return settledResult("first\nsecond")
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner, journal })
    const unsubscribe = service.subscribe((event) => observed.push(event))

    await service.runTurn(request())
    unsubscribe()

    expect(journal.replay(refFor(request())).events.map((event) => event.type)).toEqual([
      "user_message",
      "turn_started",
      "assistant_delivery",
      "assistant_delivery",
      "tool_started",
      "tool_completed",
      "turn_completed",
    ])
    expect(observed.some((event) => event.type === "text_delta" && event.journalSequence === null)).toBe(true)
    expect(observed.filter((event) => event.type === "assistant_delivery").map((event) => event.journalSequence)).toEqual([3, 4])
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("journals thrown and aborted terminal outcomes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-service-outcomes-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const failed = new FrontendSessionService({
      journal,
      runner: async () => { throw new Error("provider down") },
    })
    await expect(failed.runTurn(request("failed"))).rejects.toThrow("provider down")
    const aborted = new FrontendSessionService({
      journal,
      runner: async () => ({ ...settledResult(""), turnOutcome: "aborted" }),
    })
    await aborted.runTurn({ ...request("aborted"), sessionKey: "session-2" })

    expect(journal.replay(refFor(request())).events.at(-1)?.type).toBe("turn_failed")
    expect(journal.replay(refFor({ ...request(), sessionKey: "session-2" })).events.at(-1)?.type).toBe("turn_cancelled")
    fs.rmSync(root, { recursive: true, force: true })
  })
})

function refFor(value: ReturnType<typeof request>) {
  return { agent: value.agent, friendId: value.friendId, sessionId: value.sessionKey }
}
