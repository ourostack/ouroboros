import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCmuxClient } from "../../../senses/shepherd/client"
import { createCmuxHost, GRACE_MS, POLL_MS, QUIET_MS, readCmuxHookSession, realSchedule } from "../../../senses/shepherd/cmux"
import type { ReturnedControl } from "../../../senses/shepherd/host"
import { ackFrame, startFakeCmux, type FakeCmux } from "./fake-cmux"
import { hookEvent, SCREENS, surfaceEvent, tree } from "./fixtures"

interface Task { fn: () => void; ms: number; cancelled: boolean }
function manualScheduler() {
  const tasks: Task[] = []
  return {
    schedule: (fn: () => void, ms: number) => {
      const task = { fn, ms, cancelled: false }
      // The submit delay inside prompt() runs on its own; the rest wait for the test.
      if (ms === 300) setTimeout(fn, 0)
      else tasks.push(task)
      return () => { task.cancelled = true }
    },
    due: (ms: number) => tasks.filter((task) => !task.cancelled && task.ms === ms).length,
    run: async (ms: number) => {
      for (const task of tasks.filter((entry) => !entry.cancelled && entry.ms === ms)) {
        task.cancelled = true
        task.fn()
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    },
  }
}

let server: FakeCmux
let home: string
let clock: number
let scheduler: ReturnType<typeof manualScheduler>
let screens: Record<string, string>

function host() {
  const client = createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } })
  return createCmuxHost(client, { homeDir: home, now: () => clock, schedule: scheduler.schedule })
}

function writeSessions(agent: string, sessions: Record<string, unknown>): void {
  fs.mkdirSync(path.join(home, ".cmuxterm"), { recursive: true })
  fs.writeFileSync(path.join(home, ".cmuxterm", `${agent}-hook-sessions.json`), JSON.stringify({ version: 1, sessions }))
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-cmux-"))
  clock = 1_000_000
  scheduler = manualScheduler()
  screens = { "SF-1": SCREENS.claudePremature, "SF-2": SCREENS.agencyDone }
  server = await startFakeCmux({ capability: "v1.t.s" })
  server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1", title: "app" }, { id: "SF-2", ref: "surface:2", title: "agency" }, { id: "BR-1", ref: "surface:3", type: "browser" }]))
  server.respond("surface.read_text", (params) => ({ text: screens[params.surface_id as string] ?? "" }))
  server.respond("events.stream", () => ackFrame({ boot_id: "8D4C65E6-1A99-4831-85E4-6B950EE7AB82", resume: { gap: false, latest_seq: 100 } }))
  for (const method of ["terminal.paste", "surface.send_key", "surface.send_text", "notification.create"]) server.respond(method, () => ({}))
})

afterEach(async () => {
  await server.close()
})

describe("cmux host: terminals", () => {
  it("lists terminal surfaces, reads them, types a line then Enter, presses keys and sets the status", async () => {
    const cmux = host()
    expect(cmux.name).toBe("cmux")
    expect(await cmux.list()).toEqual([
      { id: "SF-1", ref: "surface:1", workspace: "workspace:1", title: "app", agent: null },
      { id: "SF-2", ref: "surface:2", workspace: "workspace:1", title: "agency", agent: null },
    ])
    expect(await cmux.read("SF-2", 80)).toBe(SCREENS.agencyDone)
    expect(server.methods.at(-1)).toEqual({ method: "surface.read_text", params: { surface_id: "SF-2", lines: 80, scrollback: true } })

    await cmux.prompt("surface:1", "[Ouro for Ari] Go ahead.")
    const sends = server.methods.filter((call) => call.method !== "system.tree")
    expect(sends.slice(-2)).toEqual([
      { method: "terminal.paste", params: { workspace_id: "WS-1", surface_id: "SF-1", text: "[Ouro for Ari] Go ahead.", submit_key: "none" } },
      { method: "surface.send_key", params: { workspace_id: "WS-1", surface_id: "SF-1", key: "enter" } },
    ])
    await cmux.key("SF-1", "down")
    await cmux.key("SF-1", "2")
    expect(server.methods.filter((call) => call.method.startsWith("surface.send")).slice(-2)).toEqual([
      { method: "surface.send_key", params: { workspace_id: "WS-1", surface_id: "SF-1", key: "down" } },
      { method: "surface.send_text", params: { workspace_id: "WS-1", surface_id: "SF-1", text: "2" } },
    ])

    await cmux.signal("SF-1", "answered for Ari: \"plan\" \\ ok")
    await cmux.signal("SF-1", null, { title: "Shepherd", body: "needs Ari" })
    expect(server.lines.filter((line) => line.includes("_status")).map((line) => line.replace("_cmux_capability_v1 v1.t.s ", ""))).toEqual([
      "set_status ouro \"answered for Ari: \\\"plan\\\" \\\\ ok\" --tab=WS-1",
      "clear_status ouro --tab=WS-1",
    ])
    expect(server.methods.find((call) => call.method === "notification.create")?.params).toEqual({ title: "Shepherd", subtitle: "", body: "needs Ari", workspace_id: "WS-1" })
    await expect(cmux.prompt("SF-9", "x")).rejects.toThrow("no cmux terminal SF-9")
  })

  it("reads an empty screen when cmux sends no text, and a tree with no windows", async () => {
    server.respond("surface.read_text", () => ({}))
    server.respond("system.tree", () => ({}))
    const cmux = host()
    expect(await cmux.read("SF-1", 10)).toBe("")
    expect(await cmux.list()).toEqual([])
  })

  it("tolerates a sparse tree and runs real timers that can be cancelled", async () => {
    server.respond("system.tree", () => ({ windows: [{ workspaces: [{ panes: [{ surfaces: [{}] }] }] }] }))
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }))
    expect(await cmux.list()).toEqual([])
    const fired: string[] = []
    realSchedule(() => fired.push("kept"), 1)
    realSchedule(() => fired.push("cancelled"), 1)()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(fired).toEqual(["kept"])
  })

  it("reads cmux's hook session store and tolerates a missing or odd one", () => {
    writeSessions("codex", { "codex-s1": { lastBody: "Done." }, odd: 5 })
    expect(readCmuxHookSession(home, "codex", "codex-s1")).toEqual({ lastBody: "Done." })
    writeSessions("claude", { "9ef94c36": { lastBody: "Waiting on the review." } })
    expect(readCmuxHookSession(home, "claude", "claude-9ef94c36")).toEqual({ lastBody: "Waiting on the review." })
    expect(readCmuxHookSession(home, "codex", "odd")).toBeNull()
    expect(readCmuxHookSession(home, "copilot", "x")).toBeNull()
    fs.writeFileSync(path.join(home, ".cmuxterm", "grok-hook-sessions.json"), "[]")
    expect(readCmuxHookSession(home, "grok", "x")).toBeNull()
  })
})

describe("cmux host: returned control", () => {
  async function watching() {
    const returned: ReturnedControl[] = []
    const focused: string[] = []
    const cmux = host()
    const watcher = cmux.watch({ returned: (event) => returned.push(event), focused: (id) => focused.push(id) })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    return { cmux, watcher, returned, focused }
  }

  it("turns any hooked agent's Stop into a return after the grace period, with cmux's summary of its last message", async () => {
    writeSessions("codex", { "codex-s1": { lastBody: "Which should I do?", cwd: "/Users/a/code/flaky", agentLifecycle: "idle" } })
    const { watcher, returned } = await watching()
    expect(server.methods.find((call) => call.method === "events.stream")?.params).toEqual({ categories: ["agent", "surface"], include_heartbeats: false })
    server.push(hookEvent(101, "Stop", { source: "codex" }))
    server.push(hookEvent(102, "Stop", { source: "codex", phase: "completed" }))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    expect(returned).toEqual([])
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([{ sessionId: "SF-1", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:101", agent: "codex", cwd: "/Users/a/code/flaky", lastBody: "Which should I do?" }])
    watcher.close()
  })

  it("drops a stop the agent resumed from, or one with background work pending, and finds a stop's terminal from its session", async () => {
    writeSessions("claude", { "claude-s2": { hadPendingBackgroundWorkAtStop: true }, "claude-s3": { agentLifecycle: "running" } })
    const { watcher, returned } = await watching()
    server.push(hookEvent(101, "Stop"))
    server.push(hookEvent(102, "SubagentStop"))
    server.push(hookEvent(103, "PreToolUse"))
    server.push(hookEvent(104, "PreToolUse", { surface: "SF-2", session: "claude-s2" }))
    server.push(hookEvent(105, "Stop", { surface: null, session: "claude-s2" }))
    server.push(hookEvent(106, "Stop", { surface: "SF-3", session: "claude-s3" }))
    server.push(hookEvent(107, "Stop", { surface: null, session: "claude-unknown" }))
    server.push(hookEvent(108, "Stop", { source: "copilot", surface: "SF-4", session: "copilot-s1", cwd: "/w" }))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(3))
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([{ sessionId: "SF-4", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:108", agent: "copilot", cwd: "/w", lastBody: null }])
    watcher.close()
  })

  it("reports focus, forgets closed terminals, ignores replayed and unrelated frames, and resumes after a reconnect", async () => {
    const { watcher, returned, focused } = await watching()
    server.push(hookEvent(90, "Stop"))
    server.push({ type: "heartbeat" })
    server.push({ type: "event", seq: "x" })
    server.push(surfaceEvent(101, "surface.focused", "SF-1"))
    server.push(hookEvent(102, "Stop"))
    server.push(surfaceEvent(103, "surface.closed", "SF-1"))
    server.push({ ...surfaceEvent(104, "surface.created", "SF-5"), payload: null, surface_id: null })
    await vi.waitFor(() => expect(focused).toEqual(["SF-1"]))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduler.due(GRACE_MS)).toBe(0)

    server.endStreams()
    await vi.waitFor(() => expect(scheduler.due(1_000)).toBe(1))
    await scheduler.run(1_000)
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    expect(server.methods.filter((call) => call.method === "events.stream").at(-1)?.params).toMatchObject({ after_seq: 104 })
    server.push(hookEvent(105, "Stop", { source: "mystery", session: "m1" }))
    server.push({ ...hookEvent(106, "Stop", { surface: "SF-6", session: "n1" }), payload: { session_id: "n1", surface_id: "SF-6" }, source: undefined })
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(2))
    await scheduler.run(GRACE_MS)
    expect(returned.map((event) => [event.sessionId, event.agent, event.cwd])).toEqual([["SF-1", "mystery", "/Users/a/code/app"], ["SF-6", "unknown", null]])
    watcher.close()
    server.endStreams()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduler.due(2_000)).toBe(0)
  })

  it("ignores sparse frames, and stops cleanly when closed before its first poll finishes", async () => {
    server.respond("events.stream", () => ackFrame({ resume: undefined }))
    const { watcher, returned } = await watching()
    server.push({ type: "event", seq: 1 })
    server.push({ ...hookEvent(2, "Stop", { surface: null }), payload: { phase: "received", surface_id: null } })
    server.push({ ...hookEvent(3, "Stop"), payload: { phase: "received", surface_id: "SF-1" } })
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([{ sessionId: "SF-1", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:3", agent: "claude", cwd: null, lastBody: null }])
    server.push(hookEvent(4, "Stop"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    watcher.close()
    expect(scheduler.due(GRACE_MS)).toBe(0)

    const early = host().watch({ returned: () => undefined, focused: () => undefined })
    early.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(scheduler.due(POLL_MS)).toBe(0)
  })

  it("starts from cmux's latest event after a gap", async () => {
    let acks = 0
    server.respond("events.stream", () => ackFrame({ resume: acks++ === 0 ? { gap: false, latest_seq: 100 } : { gap: true } }))
    const { watcher, returned } = await watching()
    server.endStreams()
    await vi.waitFor(() => expect(scheduler.due(1_000)).toBe(1))
    await scheduler.run(1_000)
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    server.push(hookEvent(5, "Stop"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(scheduler.due(GRACE_MS)).toBe(0)
    expect(returned).toEqual([])
    watcher.close()
  })

  it("polls terminals no hook speaks for, and counts output that held still for the quiet window as one return", async () => {
    const { watcher, returned } = await watching()
    // The first poll learns each screen; an unchanged, never-active screen is not a return.
    expect(server.methods.filter((call) => call.method === "surface.read_text").map((call) => call.params.surface_id)).toEqual(["SF-1", "SF-2"])
    server.push(hookEvent(101, "PreToolUse"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    screens["SF-2"] = `${SCREENS.agencyDone}\n working…`
    clock += POLL_MS
    await scheduler.run(POLL_MS)
    expect(server.methods.filter((call) => call.method === "surface.read_text").at(-1)?.params.surface_id).toBe("SF-2")
    clock += POLL_MS
    await scheduler.run(POLL_MS)
    expect(returned).toEqual([])
    clock += QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toEqual([{ sessionId: "SF-2", transitionId: `cmux:quiet:SF-2:${1_000_000 + POLL_MS}`, agent: null, cwd: null, lastBody: null }])
    clock += QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toHaveLength(1)

    server.respond("system.tree", () => tree([]))
    await scheduler.run(POLL_MS)
    server.respond("system.tree", () => { throw new Error("tree broke") })
    await scheduler.run(POLL_MS)
    watcher.close()
    await scheduler.run(POLL_MS)
    expect(scheduler.due(POLL_MS)).toBe(0)
  })
})
