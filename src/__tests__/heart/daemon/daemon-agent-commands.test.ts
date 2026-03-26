import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"

import { OuroDaemon } from "../../../heart/daemon/daemon"

function tmpSocketPath(name: string): string {
  return path.join(os.tmpdir(), `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`)
}

function sendRaw(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath)
    let raw = ""
    client.on("connect", () => {
      client.write(payload)
      client.end()
    })
    client.on("data", (chunk) => {
      raw += chunk.toString("utf-8")
    })
    client.on("error", reject)
    client.on("end", () => resolve(raw))
  })
}

describe("daemon agent service command routing", () => {
  const make = (socketPath: string) => {
    const processManager = {
      listAgentSnapshots: vi.fn(() => []),
      startAutoStartAgents: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      startAgent: vi.fn(async () => undefined),
      sendToAgent: vi.fn(),
    }

    const scheduler = {
      listJobs: vi.fn(() => []),
      triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
      reconcile: vi.fn(async () => undefined),
    }

    const healthMonitor = {
      runChecks: vi.fn(async () => [{ name: "agent-processes", status: "ok" as const, message: "good" }]),
    }

    const router = {
      send: vi.fn(async () => ({ id: "msg-1", queuedAt: "2026-03-05T23:00:00.000Z" })),
      pollInbox: vi.fn(() => []),
    }

    const senseManager = {
      startAutoStartSenses: vi.fn(async () => undefined),
      stopAll: vi.fn(async () => undefined),
      listSenseRows: vi.fn(() => []),
    }

    const daemon = new OuroDaemon({
      socketPath,
      processManager,
      scheduler,
      healthMonitor,
      router,
      senseManager,
    } as any)
    return { daemon }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("routes agent.status command through to agent service", async () => {
    const socketPath = tmpSocketPath("agent-status")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.status routing",
      meta: {},
    })

    const raw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.status",
      agent: "test-agent",
      friendId: "friend-1",
    }))
    const response = JSON.parse(raw)
    expect(response.ok).toBe(true)
    expect(response.data.agent).toBe("test-agent")

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.status routing test complete",
      meta: {},
    })
  })

  it("routes agent.ask command through to agent service", async () => {
    const socketPath = tmpSocketPath("agent-ask")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.ask routing",
      meta: {},
    })

    const raw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.ask",
      agent: "test-agent",
      friendId: "friend-1",
      question: "What is the project about?",
    }))
    const response = JSON.parse(raw)
    expect(response.ok).toBe(true)
    expect(response.message).toBeDefined()

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.ask routing test complete",
      meta: {},
    })
  })

  it("routes agent.delegate command and validates params", async () => {
    const socketPath = tmpSocketPath("agent-delegate")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing agent.delegate routing",
      meta: {},
    })

    // Missing task should fail
    const failRaw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.delegate",
      agent: "test-agent",
      friendId: "friend-1",
    }))
    const failResponse = JSON.parse(failRaw)
    expect(failResponse.ok).toBe(false)
    expect(failResponse.error).toContain("task")

    // With task should succeed
    const successRaw = await sendRaw(socketPath, JSON.stringify({
      kind: "agent.delegate",
      agent: "test-agent",
      friendId: "friend-1",
      task: "Fix the build",
    }))
    const successResponse = JSON.parse(successRaw)
    expect(successResponse.ok).toBe(true)

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "agent.delegate routing test complete",
      meta: {},
    })
  })

  it("routes all 13 agent command kinds", async () => {
    const socketPath = tmpSocketPath("agent-all-commands")
    const { daemon } = make(socketPath)
    await daemon.start()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_start",
      message: "testing all agent command routing",
      meta: {},
    })

    const commands = [
      { kind: "agent.ask", agent: "a", friendId: "f", question: "q" },
      { kind: "agent.status", agent: "a", friendId: "f" },
      { kind: "agent.catchup", agent: "a", friendId: "f" },
      { kind: "agent.delegate", agent: "a", friendId: "f", task: "t" },
      { kind: "agent.getContext", agent: "a", friendId: "f" },
      { kind: "agent.searchMemory", agent: "a", friendId: "f", query: "q" },
      { kind: "agent.getTask", agent: "a", friendId: "f" },
      { kind: "agent.checkScope", agent: "a", friendId: "f", item: "i" },
      { kind: "agent.requestDecision", agent: "a", friendId: "f", topic: "t" },
      { kind: "agent.checkGuidance", agent: "a", friendId: "f", topic: "t" },
      { kind: "agent.reportProgress", agent: "a", friendId: "f", summary: "s" },
      { kind: "agent.reportBlocker", agent: "a", friendId: "f", blocker: "b" },
      { kind: "agent.reportComplete", agent: "a", friendId: "f", summary: "s" },
    ]

    for (const command of commands) {
      const raw = await sendRaw(socketPath, JSON.stringify(command))
      const response = JSON.parse(raw)
      expect(response.ok).toBe(true)
    }

    await daemon.stop()

    emitNervesEvent({
      component: "daemon",
      event: "daemon.agent_command_test_end",
      message: "all agent command routing test complete",
      meta: {},
    })
  })
})
