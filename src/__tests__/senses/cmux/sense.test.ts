import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { resetIdentity } from "../../../heart/identity"
import type { ExternalEventInput } from "../../../heart/external-events/router"
import { startCmuxSenseApp, type CmuxSenseApp } from "../../../senses/cmux/sense"
import { ackFrame, feedEvent, startFakeCmux, type FakeCmux } from "./fake-cmux"

const mockSendDaemonCommand = vi.fn()
vi.mock("../../../heart/daemon/socket-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/daemon/socket-client")>(),
  sendDaemonCommand: (...args: unknown[]) => mockSendDaemonCommand(...args),
}))

const AGENT = "ouroboros"
const NOW = Date.parse("2026-10-10T20:00:00.000Z")
const originalHome = process.env.HOME
let home = ""
let server: FakeCmux
let app: CmuxSenseApp | null = null

interface Task { fn: () => void; ms: number; cancelled: boolean }
function manualScheduler() {
  const tasks: Task[] = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const task = { fn, ms, cancelled: false }
      tasks.push(task)
      return () => { task.cancelled = true }
    },
    due: (ms: number) => tasks.filter((task) => !task.cancelled && task.ms === ms).length,
    run: (ms: number) => {
      for (const task of tasks.filter((entry) => !entry.cancelled && entry.ms === ms)) {
        task.cancelled = true
        task.fn()
      }
    },
  }
}

const pending = (requestId: string, extra: Record<string, unknown> = {}) => ({
  kind: "permissionRequest", status: "pending", request_id: requestId, source: "claude", tool_name: "Bash",
  cwd: "/Users/a/code/repo", workstream_id: "claude-s1", created_at: "2026-10-10T19:59:58Z", tool_input: "{\"command\":\"ls\"}", ...extra,
})

function statePath(): string {
  return path.join(home, "AgentBundles", `${AGENT}.ouro`, "state", "senses", "cmux", "state.json")
}

function readState(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(statePath(), "utf-8")) as Record<string, unknown>
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-sense-home-"))
  process.env.HOME = home
  resetIdentity()
  server = await startFakeCmux({ capability: "v1.t.s" })
  cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
  mockSendDaemonCommand.mockResolvedValue({ ok: true })
})

afterEach(async () => {
  await app?.stop()
  app = null
  await server.close()
  resetRuntimeCredentialConfigCache()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
  resetIdentity()
  fs.rmSync(home, { recursive: true, force: true })
  mockSendDaemonCommand.mockReset()
})

describe("cmux sense app", () => {
  it("refuses to start without socket auth and names the repair", async () => {
    resetRuntimeCredentialConfigCache()
    await expect(startCmuxSenseApp({ agentName: AGENT })).rejects.toThrow("ouro vault config set --agent ouroboros --scope machine --key cmux.socketCapability")
  })

  it("follows the event stream, tracks surfaces, and escalates each pending Feed request once", async () => {
    const submitted: ExternalEventInput[] = []
    let items: unknown[] = []
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async (input) => { submitted.push(input) } })

    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(1))
    expect(server.methods.find((entry) => entry.method === "events.stream")!.params).toEqual({ categories: ["feed", "surface"] })

    items = [pending("req-1"), pending("req-2", { kind: "question", tool_name: null })]
    server.push(feedEvent(11, { hook_event_name: "PermissionRequest", tool_name: "Bash" }))
    await vi.waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[0]).toMatchObject({ agent: AGENT, source: "cmux", eventType: "feed.permissionRequest", eventId: "feed:req-1" })
    expect(submitted[0]!.evidence).toContain("surface_id: SF-1")

    server.push(feedEvent(12, { hook_event_name: "Notification" }))
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(3))
    expect(submitted).toHaveLength(2)

    server.push(feedEvent(13, { hook_event_name: "PreToolUse", tool_name: "Read" }))
    await vi.waitFor(() => {
      timers.run(1_000)
      expect(readState()).toMatchObject({ seq: 13, bootId: "BOOT-1", connected: true, escalated: ["req-1", "req-2"] })
    })
    expect((readState().surfaces as Record<string, { lifecycle: string }>)["SF-1"]!.lifecycle).toBe("working")
    expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600)

    timers.run(30_000)
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(4))
    expect(timers.due(30_000)).toBe(1)
  })

  it("resumes after the persisted cursor and reconnects with backoff after the stream drops", async () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 1, bootId: "BOOT-1", seq: 40, surfaces: {}, escalated: [] }))
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async () => undefined })

    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    expect(server.methods.find((entry) => entry.method === "events.stream")!.params).toEqual({ after_seq: 40, categories: ["feed", "surface"] })

    server.respond("events.stream", () => ({ __silent: true }))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(1_000)).toBe(1))
    expect(readState()).toMatchObject({ connected: false, lastError: null })
    timers.run(1_000)
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(2_000)).toBe(1))
    timers.run(2_000)
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))

    server.respond("events.stream", () => ackFrame({ boot_id: "BOOT-2", resume: { gap: true } }))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(5_000)).toBe(1))
    timers.run(5_000)
    await vi.waitFor(() => expect(readState()).toMatchObject({ bootId: "BOOT-2", connected: true }))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(1_000)).toBe(1))
  })

  it("caps the reconnect backoff and records refusals with the repair hint", async () => {
    await server.close()
    server = await startFakeCmux({ denyAll: true })
    cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async () => undefined })

    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]) {
      await vi.waitFor(() => expect(timers.due(delay)).toBe(1))
      timers.run(delay)
    }
    await vi.waitFor(() => expect(readState()).toMatchObject({ connected: false }))
    expect(String(readState().lastError)).toContain("ouro vault config set --agent ouroboros")
  })

  it("keeps an item for the next check when the daemon refuses it, and logs Feed read failures", async () => {
    let fail = true
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => {
      if (fail) throw new Error("feed unavailable")
      return { items: [pending("req-9")] }
    })
    mockSendDaemonCommand.mockResolvedValueOnce({ ok: false, error: "daemon busy" }).mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true })
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule })

    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(1))
    fail = false
    for (let attempt = 0; attempt < 3; attempt += 1) {
      timers.run(30_000)
      await vi.waitFor(() => expect(mockSendDaemonCommand).toHaveBeenCalledTimes(attempt + 1))
    }
    expect(mockSendDaemonCommand).toHaveBeenLastCalledWith("/tmp/ouroboros-daemon.sock", expect.objectContaining({ kind: "external.event.submit", eventId: "feed:req-9", source: "cmux" }))
    await vi.waitFor(() => expect(readState().escalated).toEqual(["req-9"]))
  })

  it("escalates the other pending items when one cannot be recorded", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [pending("bad"), pending("good")] }))
    const submitted: string[] = []
    let refuse = true
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async (input) => {
      if (input.eventId === "feed:bad" && refuse) throw new Error("daemon refused")
      submitted.push(input.eventId)
    } })
    await vi.waitFor(() => expect(submitted).toEqual(["feed:good"]))
    await vi.waitFor(() => expect(readState().escalated).toEqual(["good"]))
    refuse = false
    timers.run(30_000)
    await vi.waitFor(() => expect(submitted).toEqual(["feed:good", "feed:bad"]))
  })

  it("records the cmux version from system.identify, and null when cmux does not say", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    let version: unknown = "0.65.1"
    server.respond("system.identify", () => (version === "throw" ? (() => { throw new Error("nope") })() : { app: "cmux", version }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async () => undefined })
    await vi.waitFor(() => { timers.run(1_000); expect(readState().cmuxVersion).toBe("0.65.1") })
    version = 7
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(1_000)).toBeGreaterThanOrEqual(1))
    await vi.waitFor(() => { timers.run(1_000); expect(readState().cmuxVersion).toBeNull() })
    version = "throw"
    server.endStreams()
    await vi.waitFor(() => { timers.run(1_000); expect(server.methods.filter((entry) => entry.method === "system.identify").length).toBeGreaterThanOrEqual(3) })
    await vi.waitFor(() => { timers.run(1_000); expect(readState().cmuxVersion).toBeNull() })
  })

  it("does not rewrite the state file when nothing changed", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    const timers = manualScheduler()
    let clock = NOW
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => clock, schedule: timers.schedule, submit: async () => undefined })
    await vi.waitFor(() => { timers.run(1_000); expect(readState()).toMatchObject({ connected: true }) })
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list").length).toBeGreaterThanOrEqual(1))
    const before = readState().updatedAt
    clock = NOW + 60_000
    timers.run(30_000)
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list").length).toBeGreaterThanOrEqual(2))
    timers.run(1_000)
    expect(readState().updatedAt).toBe(before)
  })

  it("coalesces Feed checks requested while one is already queued", async () => {
    let calls = 0
    server.respond("events.stream", () => ackFrame({ boot_id: undefined }))
    server.respond("feed.list", () => { calls += 1; return { items: [] } })
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async () => undefined })
    await vi.waitFor(() => expect(calls).toBe(1))

    server.push(feedEvent(11, { hook_event_name: "PermissionRequest" }))
    server.push(feedEvent(12, { hook_event_name: "PermissionRequest" }))
    server.push(feedEvent(13, { hook_event_name: "PermissionRequest" }))
    server.push({ type: "heartbeat", latest_seq: 13 })
    await vi.waitFor(() => {
      timers.run(1_000)
      expect(readState().seq).toBe(13)
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(calls).toBeGreaterThanOrEqual(2)
    expect(calls).toBeLessThanOrEqual(3)
  })

  it("stops cleanly: closes the stream, cancels timers and saves the state", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, submit: async () => undefined })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))

    await app.stop()
    app = null
    await vi.waitFor(() => expect(server.streamCount()).toBe(0))
    expect(timers.due(30_000)).toBe(0)
    expect(timers.due(1_000)).toBe(0)
    expect(readState()).toMatchObject({ connected: false })
  })

  it("uses real timers by default", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    app = await startCmuxSenseApp({ agentName: AGENT, submit: async () => undefined })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
  })
})
