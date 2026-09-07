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
      expect(input.latencyMode).toBe("live")
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

  it("keeps one logical turn active across approval suspension and continuation", async () => {
    const continued = Promise.withResolvers<void>()
    const authority = {
      approvalCoordinatorFactory: vi.fn((input: any) => {
        input.publish("permission_requested", { requestId: "approval-1" })
        return vi.fn()
      }),
      resumeApproval: vi.fn(async (input: any) => {
        await continued.promise
        input.frontendEventSink.onEvent({ type: "text_delta", data: { text: "done" } })
        return settledResult("done")
      }),
      resolvePermission: vi.fn(() => { continued.resolve(); return true }),
      cancelTurn: vi.fn(),
      close: vi.fn(),
    }
    const suspension = {
      approvalId: "approval-1",
      toolCallId: "call-1",
      checkpointDigest: "a".repeat(64),
      suspendedSessionRevision: "b".repeat(64),
    }
    const runner = vi.fn(async (input: any) => ({
      ...settledResult(""),
      turnOutcome: "suspended" as const,
      suspension,
      approvalFactory: input.approvalCoordinatorFactory,
    }))
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner, authority: authority as never })
    const events: any[] = []
    service.subscribe((event) => events.push(event))

    const running = service.runTurn(request())
    await vi.waitFor(() => expect(authority.resumeApproval).toHaveBeenCalledOnce())
    expect(service.hasTurn("turn-1")).toBe(true)
    await expect(service.runTurn(request("turn-2"))).rejects.toThrow("frontend session already has an active turn")
    expect(events.some((event) => event.type.startsWith("turn_") && event.type !== "turn_started")).toBe(false)

    expect(service.resolvePermission("approval-1", "allow-once")).toBe(true)
    await expect(running).resolves.toMatchObject({ outcome: "settled", response: "done" })
    expect(authority.approvalCoordinatorFactory).toHaveBeenCalledOnce()
    expect(authority.resumeApproval).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({ turnId: "turn-1", sessionKey: "session-1" }),
      suspension,
    }))
    expect(events.at(-1)?.type).toBe("turn_completed")
  })

  it("fails closed when a suspension omits authority metadata", async () => {
    const authority = {
      approvalCoordinatorFactory: vi.fn(() => vi.fn()),
      resumeApproval: vi.fn(),
      resolvePermission: vi.fn(),
      cancelTurn: vi.fn(),
      close: vi.fn(),
    }
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({
      authority: authority as never,
      runner: async () => ({ ...settledResult(""), turnOutcome: "suspended" }),
    })

    await expect(service.runTurn(request())).rejects.toThrow("omitted its approval suspension")
    expect(authority.resumeApproval).not.toHaveBeenCalled()
  })

  it("fails closed when a runner suspends without an authority runtime", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({
      runner: async () => ({
        ...settledResult(""),
        turnOutcome: "suspended",
        suspension: {
          approvalId: "approval-1",
          toolCallId: "call-1",
          checkpointDigest: "a".repeat(64),
          suspendedSessionRevision: "b".repeat(64),
        },
      }),
    })

    expect(service.resolvePermission("approval-1", "reject-once")).toBe(false)
    await expect(service.runTurn(request())).rejects.toThrow("suspended without an authority runtime")
  })

  it("bounds nested approval suspension rounds", async () => {
    const suspended = {
      ...settledResult(""),
      turnOutcome: "suspended" as const,
      suspension: {
        approvalId: "approval-1",
        toolCallId: "call-1",
        checkpointDigest: "a".repeat(64),
        suspendedSessionRevision: "b".repeat(64),
      },
    }
    const authority = {
      approvalCoordinatorFactory: vi.fn(() => vi.fn()),
      resumeApproval: vi.fn(async () => suspended),
      resolvePermission: vi.fn(),
      cancelTurn: vi.fn(),
      close: vi.fn(),
    }
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({
      authority: authority as never,
      runner: async () => suspended,
    })

    await expect(service.runTurn(request())).rejects.toThrow("exceeded its approval suspension limit")
    expect(authority.resumeApproval).toHaveBeenCalledTimes(8)
  })

  it("runs a prepared turn exactly once", async () => {
    const release = Promise.withResolvers<void>()
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({
      runner: async () => {
        await release.promise
        return settledResult()
      },
    })
    const prepared = service.prepareTurn(request())
    const running = service.runPreparedTurn(prepared)

    await expect(service.runPreparedTurn(prepared)).rejects.toThrow("frontend turn already started")
    release.resolve()
    await running
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

  it("forwards hard tool exclusion to the turn runner", async () => {
    const runner = vi.fn(async (input: any) => {
      expect(input.disableTools).toBe(true)
      expect(input.disablePersistence).toBe(true)
      expect(input.runtimeMcpServers).toBeUndefined()
      return settledResult()
    })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner })

    await service.runTurn({ ...request(), disableTools: true, ephemeral: true })
    expect(runner).toHaveBeenCalledOnce()
  })

  it("does not journal ephemeral turn prompts or outcomes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-service-ephemeral-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    const observed: any[] = []
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({
      journal,
      runner: async (input) => {
        input.frontendEventSink?.onEvent({ type: "assistant_delivery", data: { kind: "settle", text: "hold" } })
        return settledResult("hold")
      },
    })
    service.subscribe((event) => observed.push(event))

    await service.runTurn({ ...request(), message: "private worker evidence", disableTools: true, ephemeral: true })

    expect(journal.replay(refFor(request())).events).toEqual([])
    expect(observed.length).toBeGreaterThan(0)
    expect(observed.every((event) => event.journalSequence === null)).toBe(true)
    fs.rmSync(root, { recursive: true, force: true })
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
    const turns = [
      service.runTurn(request("turn-1")),
      service.runTurn({ ...request("turn-2"), sessionKey: "session-2" }),
    ]
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
    const hostile = new FrontendSessionService({
      journal,
      runner: async () => { throw "transport gone" },
    })
    await expect(hostile.runTurn({ ...request("hostile"), sessionKey: "session-3" })).rejects.toBe("transport gone")
    const errored = new FrontendSessionService({
      journal,
      runner: async () => ({ ...settledResult("failed"), turnOutcome: "errored" }),
    })
    await errored.runTurn({ ...request("errored"), sessionKey: "session-4" })

    expect(journal.replay(refFor(request())).events.at(-1)?.type).toBe("turn_failed")
    expect(journal.replay(refFor({ ...request(), sessionKey: "session-2" })).events.at(-1)?.type).toBe("turn_cancelled")
    expect(journal.replay(refFor({ ...request(), sessionKey: "session-3" })).events.at(-1)?.data).toEqual({ error: "transport gone" })
    expect(journal.replay(refFor({ ...request(), sessionKey: "session-4" })).events.at(-1)?.type).toBe("turn_failed")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("isolates frontend listener failures from the turn", async () => {
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner: async () => settledResult() })
    service.subscribe(() => { throw new Error("listener failed") })
    service.subscribe(() => { throw "hostile listener" })

    await expect(service.runTurn(request())).resolves.toMatchObject({ outcome: "settled" })
  })

  it("loads journal history by exact identity and rejects unavailable storage", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-service-load-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    journal.append(refFor(request()), { turnId: "turn-1", type: "turn_started", data: {} })
    journal.append(refFor(request()), { turnId: "turn-1", type: "turn_completed", data: {} })
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner: async () => settledResult(), journal })

    expect(service.loadSession({
      agent: "boss",
      friendId: "friend-1",
      sessionKey: "session-1",
    }, { afterSequence: 1, limit: 1 })).toMatchObject({
      events: [expect.objectContaining({ sequence: 2, type: "turn_completed" })],
      lastSequence: 2,
      hasMore: false,
      degraded: false,
    })
    expect(() => new FrontendSessionService().loadSession({
      agent: "boss",
      friendId: "friend-1",
      sessionKey: "session-1",
    })).toThrow("journal is unavailable")
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("returns only in-memory pending permissions with session replay", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-service-pending-"))
    const { FrontendJournalStore } = await import("../../heart/frontend-journal")
    const journal = new FrontendJournalStore({ agentRoot: (agent) => path.join(root, `${agent}.ouro`) })
    journal.append(refFor(request()), { turnId: "turn-1", type: "turn_started", data: {} })
    const pendingPermissions = [{
      requestId: "approval-1",
      turnId: "turn-1",
      toolCallId: "call-1",
      title: "Approve shell",
      options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
    }]
    const authority = {
      approvalCoordinatorFactory: vi.fn(() => vi.fn()),
      resumeApproval: vi.fn(),
      resolvePermission: vi.fn(),
      cancelTurn: vi.fn(),
      pendingPermissions: vi.fn(() => pendingPermissions),
      close: vi.fn(),
    }
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner: async () => settledResult(), journal, authority: authority as never })

    expect(service.loadSession({
      agent: "boss",
      friendId: "friend-1",
      sessionKey: "session-1",
    })).toMatchObject({ pendingPermissions })
    expect(authority.pendingPermissions).toHaveBeenCalledWith({
      agent: "boss",
      friendId: "friend-1",
      sessionKey: "session-1",
    })
    fs.rmSync(root, { recursive: true, force: true })
  })

  it("closes its owned authority runtime", async () => {
    const authority = {
      approvalCoordinatorFactory: vi.fn(() => vi.fn()),
      resumeApproval: vi.fn(),
      resolvePermission: vi.fn(),
      cancelTurn: vi.fn(),
      close: vi.fn(),
    }
    const { FrontendSessionService } = await import("../../heart/frontend-session-service")
    const service = new FrontendSessionService({ runner: async () => settledResult(), authority: authority as never })

    service.close()
    service.close()

    expect(authority.close).toHaveBeenCalledOnce()
  })
})

function refFor(value: ReturnType<typeof request>) {
  return { agent: value.agent, friendId: value.friendId, sessionId: value.sessionKey }
}
