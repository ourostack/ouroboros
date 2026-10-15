import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCmuxClient } from "../../../senses/shepherd/client"
import { BACKGROUND_GRACE_MS, createCmuxHost, GRACE_MS, HOOKED_QUIET_MS, POLL_MS, QUIET_MAX_MS, QUIET_MS, readCmuxHookSession, realSchedule } from "../../../senses/shepherd/cmux"
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
  it.each(["attempt", "title", "entry", "cwd"] as const)("refuses invalid %s continuity launch input before any socket mutation", async bad => {
    const request = { attemptId: "19768d31-24f7-4b9c-9860-0f3c6c039c65", title: "desk / task",
      launchCwd: "/desk", ouroEntry: "/opt/ouro", agent: "ouro", batchId: "batch1", targetId: "target1" }
    if (bad === "attempt") request.attemptId = "not-a-uuid"
    if (bad === "title") request.title = "bad\r"
    if (bad === "entry") request.ouroEntry = "relative"
    if (bad === "cwd") request.launchCwd = "relative"
    await expect(host().launchContinuity!(request)).rejects.toThrow(/Invalid/)
    expect(server.methods).toHaveLength(0)
  })
  it("creates one nonfocused continuity workspace using a durable operation and a quoted wrapper command", async () => {
    const workspaceId = "88e98bdd-01f6-4c58-96ac-641fae36ddaf"
    const surfaceId = "d6f2b0bb-2eab-43c7-b63f-06c3e8a1cf9c"
    server.respond("workspace.create", () => ({ workspace_id: workspaceId, surface_id: surfaceId }))
    server.respond("system.tree", () => ({ windows: [{ workspaces: [{ id: workspaceId, title: "desk / track/task",
      panes: [{ surfaces: [{ id: surfaceId, ref: "surface:9", type: "terminal" }] }] }] }] }))
    const result = await host().launchContinuity!({
      attemptId: "19768d31-24f7-4b9c-9860-0f3c6c039c65", title: "desk / track/task", launchCwd: "/desk with spaces",
      ouroEntry: "/opt/Ouro's tools/ouro", agent: "ouro", batchId: "batch1", targetId: "target1",
    })
    expect(result).toEqual({ workspaceId, surfaceId })
    const calls = server.methods.filter(call => call.method === "workspace.create")
    expect(calls).toHaveLength(1)
    expect(calls[0].params).toEqual({
      operation_id: "19768d31-24f7-4b9c-9860-0f3c6c039c65", title: "desk / track/task",
      working_directory: "/desk with spaces", focus: false, eager_load_terminal: true,
      initial_input: "'/opt/Ouro'\\''s tools/ouro' 'shepherd' 'bootstrap' '--agent' 'ouro' '--batch' 'batch1' '--target' 'target1' '--attempt' '19768d31-24f7-4b9c-9860-0f3c6c039c65'\r",
    })
    expect(server.methods.some(call => ["terminal.paste", "surface.send_key", "surface.send_text", "surface.focus", "workspace.select"].includes(call.method))).toBe(false)
  })
  it.each(["malformed", "missing", "focused"] as const)("refuses %s create readback without retrying a workspace", async problem => {
    const workspaceId = "88e98bdd-01f6-4c58-96ac-641fae36ddaf"
    const surfaceId = "d6f2b0bb-2eab-43c7-b63f-06c3e8a1cf9c"
    server.respond("workspace.create", () => ({ workspace_id: workspaceId, surface_id: problem === "malformed" ? "not-a-uuid" : surfaceId }))
    server.respond("system.tree", () => problem === "missing" ? { windows: [] } : {
      windows: [{ visible: true, workspaces: [{ id: workspaceId, selected: true, panes: [{
        surfaces: [{ id: surfaceId, type: "terminal", focused: true }],
      }] }] }],
    })
    await expect(host().launchContinuity!({
      attemptId: "19768d31-24f7-4b9c-9860-0f3c6c039c65", title: "desk / task", launchCwd: "/desk",
      ouroEntry: "/opt/ouro", agent: "ouro", batchId: "batch1", targetId: "target1",
    })).rejects.toThrow()
    expect(server.methods.filter(call => call.method === "workspace.create")).toHaveLength(1)
  })
  it("hints only the key window's current coding terminal, without weakening visible-window protection", async () => {
    const window = (key: boolean, id: string) => ({
      key, visible: true, workspaces: [{ id: `WS-${id}`, selected: true,
        panes: [{ surfaces: [{ id, ref: id, focused: true, type: "terminal" }] }],
      }],
    })
    server.respond("system.tree", () => ({ windows: [window(false, "SF-1"), window(true, "SF-2")] }))
    const sessions = await host().list()
    expect(sessions.map(session => session.focused)).toEqual([true, true])
    expect(sessions.map(session => session.selected === true)).toEqual([false, true])
  })
  it("identifies unhooked terminals by tty and keeps the workspace and tab title", async () => {
    server.respond("system.tree", () => ({
      windows: [{ visible: true, workspaces: [{ id: "WS-1", ref: "workspace:1", title: "ouro", selected: true,
        panes: [{ surfaces: [{ id: "SF-1", ref: "surface:1", title: "Ship Shepherd", type: "terminal", tty: "ttys007" }] }],
      }] }],
    }))
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }), {
      identifyTerminals: async () => new Map([["ttys007", { agent: "Copilot", cwd: "/Users/a/personal-desk" }]]),
    })
    expect(await cmux.list()).toEqual([expect.objectContaining({
      agent: "Copilot", cwd: "/Users/a/personal-desk", workspaceTitle: "ouro", title: "Ship Shepherd", tty: "ttys007",
    })])
  })

  it("lists terminal surfaces, reads them, types a line then Enter, presses keys and sets the status", async () => {
    const cmux = host()
    expect(cmux.name).toBe("cmux")
    expect(await cmux.list()).toEqual([
      { id: "SF-1", ref: "surface:1", workspace: "workspace:1", workspaceTitle: "app", title: "app", tty: null, cwd: null, agent: null, focused: false },
      { id: "SF-2", ref: "surface:2", workspace: "workspace:1", workspaceTitle: "app", title: "agency", tty: null, cwd: null, agent: null, focused: false },
    ])
    // The human's terminal is the focused surface of the selected workspace.
    server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1", focused: true }]))
    expect((await cmux.list())[0]!.focused).toBe(true)
    server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1", focused: true }], false))
    expect((await cmux.list())[0]!.focused).toBe(false)
    server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1", title: "app" }, { id: "SF-2", ref: "surface:2", title: "agency" }]))
    expect(await cmux.read("SF-2", 80)).toBe(SCREENS.agencyDone)
    expect(server.methods.at(-1)).toEqual({ method: "surface.read_text", params: { surface_id: "SF-2", lines: 80, scrollback: true } })

    await cmux.prompt("surface:1", "[Ouro for Ari] Go ahead.")
    const sends = server.methods.filter((call) => call.method !== "system.tree")
    expect(sends.slice(-2)).toEqual([
      { method: "terminal.paste", params: { workspace_id: "WS-1", surface_id: "SF-1", text: "[Ouro for Ari] Go ahead.", submit_key: "none" } },
      { method: "surface.send_key", params: { workspace_id: "WS-1", surface_id: "SF-1", key: "enter" } },
    ])
    await cmux.key("SF-1", "ctrl-c")
    await cmux.key("SF-1", "down")
    await cmux.key("SF-1", "2")
    expect(server.methods.filter((call) => call.method.startsWith("surface.send")).slice(-3)).toEqual([
      { method: "surface.send_key", params: { workspace_id: "WS-1", surface_id: "SF-1", key: "ctrl+c" } },
      { method: "surface.send_key", params: { workspace_id: "WS-1", surface_id: "SF-1", key: "down" } },
      { method: "surface.send_text", params: { workspace_id: "WS-1", surface_id: "SF-1", text: "2" } },
    ])

    await cmux.signal("SF-1", "answered for Ari: \"plan\" \\ ok")
    await cmux.signal("SF-1", null, { title: "Shepherd", body: "needs Ari" })
    expect(server.lines.filter((line) => line.includes("_status")).map((line) => line.replace("_cmux_capability_v1 v1.t.s ", ""))).toEqual([
      "set_status ouro_surface_1 \"answered for Ari: \\\"plan\\\" \\\\ ok\" --tab=WS-1 --panel=SF-1",
      "clear_status ouro_surface_1 --tab=WS-1",
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
  it("carries the foreground identity and titles through a quiet-screen return without hooks", async () => {
    server.respond("system.tree", () => tree([{ id: "SF-2", ref: "surface:2", title: "Ship agent tools", tty: "ttys007" }]))
    const returned: ReturnedControl[] = []
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }), {
      now: () => clock, schedule: scheduler.schedule,
      identifyTerminals: async () => new Map([["ttys007", { agent: "Copilot", cwd: "/Users/a/personal-desk" }]]),
    })
    const watcher = cmux.watch({ returned: event => returned.push(event), focused: () => undefined })
    await vi.waitFor(() => expect(server.methods.some(call => call.method === "surface.read_text")).toBe(true))
    screens["SF-2"] = "Done. Tests passed."
    clock += POLL_MS
    await scheduler.run(POLL_MS)
    clock += QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toEqual([expect.objectContaining({
      agent: "Copilot", cwd: "/Users/a/personal-desk", title: "Ship agent tools", workspaceTitle: "app", backgroundWork: null,
    })])
    watcher.close()
  })

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
    expect(returned).toEqual([{ sessionId: "SF-1", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:101", agent: "codex", cwd: "/Users/a/code/flaky", lastBody: "Which should I do?", backgroundWork: false }])
    watcher.close()
  })

  it("drops a stop the agent resumed from, and finds a stop's terminal from its session", async () => {
    const { watcher, returned } = await watching()
    server.push(hookEvent(101, "Stop"))
    server.push(hookEvent(102, "SubagentStop"))
    server.push(hookEvent(103, "PreToolUse"))
    server.push(hookEvent(104, "PreToolUse", { surface: "SF-2", session: "claude-s2" }))
    server.push(hookEvent(105, "Stop", { surface: null, session: "claude-s2" }))
    server.push(hookEvent(107, "Stop", { surface: null, session: "claude-unknown" }))
    server.push(hookEvent(108, "Stop", { source: "copilot", surface: "SF-4", session: "copilot-s1", cwd: "/w" }))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(2))
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([
      { sessionId: "SF-2", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:105", agent: "claude", cwd: "/Users/a/code/app", lastBody: null, backgroundWork: false },
      { sessionId: "SF-4", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:108", agent: "copilot", cwd: "/w", lastBody: null, backgroundWork: false },
    ])
    watcher.close()
  })

  it("waits longer on a stop that left background work running, then passes it on marked as still working", async () => {
    // Live cmux names hook sessions `<agent>-<id>` and keys its store by `<id>`.
    writeSessions("claude", { s2: { hadPendingBackgroundWorkAtStop: true, lastBody: "Waiting for 2 background agents." }, s3: { agentLifecycle: "running" } })
    writeSessions("codex", { "codex-s4": { agentLifecycle: "backgroundWorkPending" } })
    const { watcher, returned } = await watching()
    server.push(hookEvent(101, "Stop", { surface: "SF-2", session: "claude-s2" }))
    server.push(hookEvent(102, "Stop", { surface: "SF-3", session: "claude-s3" }))
    server.push(hookEvent(103, "Stop", { source: "codex", surface: "SF-4", session: "codex-s4" }))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(3))
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([])
    expect(scheduler.due(BACKGROUND_GRACE_MS)).toBe(3)
    // The background work reported back and the agent carried on: that stop is dropped; the next real stop is judged afresh.
    server.push(hookEvent(104, "UserPromptSubmit", { surface: "SF-3", session: "claude-s3" }))
    await vi.waitFor(() => expect(scheduler.due(BACKGROUND_GRACE_MS)).toBe(2))
    await scheduler.run(BACKGROUND_GRACE_MS)
    expect(returned).toEqual([
      { sessionId: "SF-2", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:101", agent: "claude", cwd: "/Users/a/code/app", lastBody: "Waiting for 2 background agents.", backgroundWork: true },
      { sessionId: "SF-4", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:103", agent: "codex", cwd: "/Users/a/code/app", lastBody: null, backgroundWork: true },
    ])
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
    expect(returned).toEqual([{ sessionId: "SF-1", transitionId: "cmux:8D4C65E6-1A99-4831-85E4-6B950EE7AB82:3", agent: "claude", cwd: null, lastBody: null, backgroundWork: false }])
    server.push(hookEvent(4, "Stop"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    watcher.close()
    expect(scheduler.due(GRACE_MS)).toBe(0)

    const early = host().watch({ returned: () => undefined, focused: () => undefined })
    early.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(scheduler.due(POLL_MS)).toBe(0)
  })

  it("clears Shepherd's status when the agent resumes or the screen moves again, and tolerates a failed clear", async () => {
    const { cmux, watcher } = await watching()
    const statusLines = () => server.lines.filter((line) => line.includes("_status")).map((line) => line.replace("_cmux_capability_v1 v1.t.s ", "").split(" ").slice(0, 2).join(" "))
    await cmux.signal("SF-1", "answered for Ari")
    server.push(hookEvent(101, "PreToolUse"))
    server.push(hookEvent(102, "PreToolUse"))
    await vi.waitFor(() => expect(statusLines()).toEqual(["set_status ouro_surface_1", "clear_status ouro_surface_1"]))

    // A polled terminal's status clears when its screen changes.
    await cmux.signal("SF-2", "waiting")
    screens["SF-2"] = `${SCREENS.agencyDone}\n more`
    await scheduler.run(POLL_MS)
    await vi.waitFor(() => expect(statusLines().at(-1)).toBe("clear_status ouro_surface_2"))

    await cmux.signal("SF-1", "again")
    server.v1(() => "ERROR: nope")
    server.push(hookEvent(103, "PreToolUse"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    server.push(surfaceEvent(104, "surface.closed", "SF-1"))
    watcher.close()
  })

  it("stretches a quiet terminal's window when asked, up to a cap, until the human focuses it", async () => {
    const { cmux, watcher, returned } = await watching()
    for (let index = 0; index < 8; index += 1) cmux.pace!("SF-2", true)
    const quiet = async (wait: number) => {
      screens["SF-2"] = `${SCREENS.agencyDone}\n${clock}`
      await scheduler.run(POLL_MS)
      clock += wait
      await scheduler.run(POLL_MS)
    }
    await quiet(QUIET_MAX_MS - 1)
    expect(returned).toEqual([])
    clock += 1
    await scheduler.run(POLL_MS)
    expect(returned).toHaveLength(1)
    cmux.pace!("SF-2", true)
    server.push(surfaceEvent(101, "surface.focused", "SF-2"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await quiet(QUIET_MS)
    expect(returned).toHaveLength(2)
    cmux.pace!("SF-2", true)
    cmux.pace!("SF-2", false)
    await quiet(QUIET_MS)
    expect(returned).toHaveLength(3)
    watcher.close()
  })

  it("judges a hooked agent that sits quiet mid-turn (a permission or trust prompt), once, after a longer window", async () => {
    const { watcher, returned } = await watching()
    server.push(hookEvent(101, "PreToolUse"))
    server.push(hookEvent(102, "Notification"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    screens["SF-1"] = "Do you want to run this command?\n> 1. Yes\n  2. No"
    clock += POLL_MS
    await scheduler.run(POLL_MS)
    clock += QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toEqual([])
    clock += HOOKED_QUIET_MS - QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toEqual([{ sessionId: "SF-1", transitionId: `cmux:quiet:SF-1:${1_000_000 + POLL_MS}`, agent: "claude", cwd: "/Users/a/code/app", title: "app", workspaceTitle: "app", lastBody: null, backgroundWork: null }])
    clock += HOOKED_QUIET_MS
    await scheduler.run(POLL_MS)
    expect(returned).toHaveLength(1)
    watcher.close()
  })

  it("does not judge the quiet screen of an idle agent: one that stopped, or a session not given work yet", async () => {
    const { cmux, watcher, returned } = await watching()
    const quietScreen = async (text: string) => {
      screens["SF-1"] = text
      clock += POLL_MS
      await scheduler.run(POLL_MS)
      clock += HOOKED_QUIET_MS
      await scheduler.run(POLL_MS)
    }
    server.push(hookEvent(101, "SessionStart"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await quietScreen("welcome banner")
    expect(returned).toEqual([])
    // Work makes it watched again, and resets a stretched quiet window.
    cmux.pace!("SF-1", true)
    server.push(hookEvent(102, "UserPromptSubmit"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await scheduler.run(POLL_MS)
    await quietScreen("Allow this tool?")
    expect(returned.map((entry) => entry.transitionId)).toEqual([expect.stringContaining("cmux:quiet:SF-1:")])
    // Its stop is the return; the quiet screen after it is not a second one, even with a subagent's stop in between.
    server.push(hookEvent(103, "Stop"))
    server.push(hookEvent(104, "SubagentStop"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await quietScreen("All done.")
    expect(returned).toHaveLength(1)
    await scheduler.run(GRACE_MS)
    expect(returned.map((entry) => entry.transitionId)).toEqual([expect.stringContaining("cmux:quiet:SF-1:"), expect.stringContaining(":103")])
    watcher.close()
  })

  it("leaves a stopped agent's screen to its stop, and watches it again once its session ends", async () => {
    const { watcher } = await watching()
    server.push(hookEvent(100.5, "Stop", { surface: "SF-3", session: "claude-s3" }))
    server.push(hookEvent(101, "Stop"))
    server.push(hookEvent(101.5, "Notification"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const reads = () => server.methods.filter((call) => call.method === "surface.read_text").map((call) => call.params.surface_id)
    await scheduler.run(POLL_MS)
    expect(reads().at(-1)).toBe("SF-2")
    server.push(hookEvent(102, "SessionEnd"))
    server.push(hookEvent(103, "SessionEnd", { surface: "SF-3", session: "claude-s3" }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await scheduler.run(POLL_MS)
    expect(reads().slice(-2)).toEqual(["SF-1", "SF-2"])
    watcher.close()
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
    expect(returned).toEqual([{ sessionId: "SF-2", transitionId: `cmux:quiet:SF-2:${1_000_000 + POLL_MS}`, agent: null, cwd: null, title: "agency", workspaceTitle: "app", lastBody: null, backgroundWork: null }])
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
