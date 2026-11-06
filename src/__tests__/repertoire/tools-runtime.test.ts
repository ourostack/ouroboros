import { beforeEach, describe, expect, it, vi } from "vitest"

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

const mockGetAgentName = vi.fn(() => "slugger")
vi.mock("../../heart/identity", () => ({
  getAgentName: () => mockGetAgentName(),
}))

const mockSendDaemonCommand = vi.fn()
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-daemon.sock",
  sendDaemonCommand: (...args: unknown[]) => mockSendDaemonCommand(...args),
}))

import { runtimeToolDefinitions } from "../../repertoire/tools-runtime"

function findTool(name: string) {
  const def = runtimeToolDefinitions.find((d) => d.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

describe("restart_runtime tool", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    mockGetAgentName.mockReturnValue("slugger")
    mockSendDaemonCommand.mockResolvedValue({ ok: true, message: "daemon restarting — launchctl will respawn" })
  })

  describe("schema", () => {
    it("is registered with the correct name", () => {
      const t = findTool("restart_runtime")
      expect(t.tool.function.name).toBe("restart_runtime")
    })

    it("description is first-person and warns about response not being seen", () => {
      const t = findTool("restart_runtime")
      const desc = t.tool.function.description ?? ""
      expect(desc.length).toBeGreaterThan(0)
      expect(/(\bmay\b|\bshould\b|\bprefer\b|if relevant)/i.test(desc)).toBe(false)
      expect(desc.toLowerCase()).toContain("restart")
      // Important UX warning: agent will not see the response.
      expect(desc.toLowerCase()).toContain("will not see")
    })

    it("requires reason", () => {
      const t = findTool("restart_runtime")
      const params = t.tool.function.parameters as { properties: Record<string, unknown>; required: string[] }
      expect(Object.keys(params.properties)).toEqual(["reason"])
      expect(params.required).toEqual(["reason"])
    })
  })

  describe("input validation", () => {
    it("returns error when reason is missing", async () => {
      const t = findTool("restart_runtime")
      const result = JSON.parse(await t.handler({}))
      expect(result.error).toContain("reason is required")
      expect(mockSendDaemonCommand).not.toHaveBeenCalled()
    })

    it("returns error when reason is empty/whitespace", async () => {
      const t = findTool("restart_runtime")
      const r1 = JSON.parse(await t.handler({ reason: "" }))
      const r2 = JSON.parse(await t.handler({ reason: "   " }))
      expect(r1.error).toContain("reason is required")
      expect(r2.error).toContain("reason is required")
      expect(mockSendDaemonCommand).not.toHaveBeenCalled()
    })

    it("trims reason whitespace before sending", async () => {
      const t = findTool("restart_runtime")
      await t.handler({ reason: "  bluebubbles wedged  " })
      const [, cmd] = mockSendDaemonCommand.mock.calls[0]
      expect((cmd as { reason: string }).reason).toBe("bluebubbles wedged")
    })
  })

  describe("daemon command dispatch", () => {
    it("sends daemon.restart with reason + requestedBy=agent", async () => {
      const t = findTool("restart_runtime")
      await t.handler({ reason: "picking up version update" })

      expect(mockSendDaemonCommand).toHaveBeenCalledTimes(1)
      const [socketPath, cmd] = mockSendDaemonCommand.mock.calls[0]
      expect(socketPath).toBe("/tmp/ouroboros-daemon.sock")
      expect(cmd).toEqual({
        kind: "daemon.restart",
        reason: "picking up version update",
        requestedBy: "slugger",
      })
    })

    it("returns success result reflecting daemon's response message", async () => {
      mockSendDaemonCommand.mockResolvedValue({ ok: true, message: "daemon restarting — launchctl will respawn" })
      const t = findTool("restart_runtime")
      const result = JSON.parse(await t.handler({ reason: "wedged" }))
      expect(result.requested).toBe(true)
      expect(result.reason).toBe("wedged")
      expect(result.detail).toContain("launchctl will respawn")
    })

    it("falls back to a default detail when daemon response has no message", async () => {
      mockSendDaemonCommand.mockResolvedValue({ ok: true })
      const t = findTool("restart_runtime")
      const result = JSON.parse(await t.handler({ reason: "x" }))
      expect(result.detail).toBe("daemon restart requested")
    })

    it("returns error JSON when sendDaemonCommand throws", async () => {
      mockSendDaemonCommand.mockRejectedValue(new Error("ECONNREFUSED"))
      const t = findTool("restart_runtime")
      const result = JSON.parse(await t.handler({ reason: "x" }))
      expect(result.error).toBe("failed to reach daemon socket")
      expect(result.detail).toContain("ECONNREFUSED")
    })

    it("returns error JSON when sendDaemonCommand throws a non-Error value", async () => {
      mockSendDaemonCommand.mockRejectedValue("socket gone")
      const t = findTool("restart_runtime")
      const result = JSON.parse(await t.handler({ reason: "x" }))
      expect(result.error).toBe("failed to reach daemon socket")
      expect(result.detail).toBe("socket gone")
    })
  })

  describe("nerves events", () => {
    it("emits repertoire.runtime_restart_requested with agent + reason", async () => {
      const t = findTool("restart_runtime")
      await t.handler({ reason: "deliberate test" })
      const evt = nervesEvents.find((e) => e.event === "repertoire.runtime_restart_requested")
      expect(evt).toBeDefined()
      expect(evt?.meta).toMatchObject({ agent: "slugger", reason: "deliberate test" })
    })

    it("emits the nerves event before sending the daemon command", async () => {
      const order: string[] = []
      mockSendDaemonCommand.mockImplementation(() => {
        order.push("send")
        return Promise.resolve({ ok: true })
      })
      const t = findTool("restart_runtime")
      const eventsCountBefore = nervesEvents.length
      await t.handler({ reason: "ordering check" })
      // Nerves event lands before send call
      const eventIdx = nervesEvents.length - 1
      expect(nervesEvents[eventIdx].event).toBe("repertoire.runtime_restart_requested")
      expect(order).toEqual(["send"])
      expect(eventIdx).toBeGreaterThanOrEqual(eventsCountBefore)
    })

    it("does NOT emit the requested event when validation fails", async () => {
      const t = findTool("restart_runtime")
      await t.handler({})
      expect(nervesEvents.find((e) => e.event === "repertoire.runtime_restart_requested")).toBeUndefined()
    })
  })
})
