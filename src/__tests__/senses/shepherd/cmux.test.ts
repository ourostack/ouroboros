import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createCmuxClient } from "../../../senses/shepherd/client"
import { BACKGROUND_GRACE_MS, createCmuxHost, GRACE_MS, HOOKED_QUIET_MS, POLL_MS, QUIET_MAX_MS, QUIET_MS, readCmuxHookSession, realSchedule } from "../../../senses/shepherd/cmux"
import type { ReturnedControl } from "../../../senses/shepherd/host"
import { identifyTerminalProcesses } from "../../../senses/shepherd/terminal-process"
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
  const uuid = "11111111-1111-4111-8111-111111111111"
  function inspectedHost() {
    const state = {
      id: uuid, tty: "ttys007", cwd: "/synthetic/project", instance: "20:Thu Oct 15 23:00:00 2026",
      focused: false, agent: "Copilot", workspaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", hasIdentity: true,
      onIdentity: null as (() => void) | null,
      screen: ["● Synthetic returned task.", "╭▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄", "┃ ", "╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀", " Interactive · Allow All · / commands · 1 scheduled"].join("\n"),
    }
    const renderTree = () => {
      const result = tree([{ id: state.id, ref: "surface:1", tty: state.tty, focused: state.focused }])
      const window = (result.windows as Array<{ workspaces: Array<{ id: string }> }>)[0]!
      window.workspaces[0]!.id = state.workspaceId
      return result
    }
    server.respond("system.tree", renderTree)
    const readResult = () => ({
      window_id: "WIN-1", window_ref: "window:1", workspace_id: state.workspaceId, workspace_ref: "workspace:1",
      surface_id: state.id.toLowerCase(), surface_ref: "surface:1", text: state.screen,
      base64: Buffer.from(state.screen).toString("base64"),
    })
    server.respond("surface.read_text", readResult)
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }), {
      homeDir: home, schedule: scheduler.schedule,
      identifyTerminals: async () => {
        const result = state.hasIdentity ? new Map([[state.tty, { agent: state.agent, cwd: state.cwd, ...(state.instance ? { instance: state.instance } : {}) }]]) : new Map()
        state.onIdentity?.()
        return result
      },
    })
    return { cmux, state, readResult, renderTree }
  }
  const inputs = () => server.methods.filter(call => call.method === "terminal.paste" || call.method.startsWith("surface.send"))

  it("inspects UUID-bound current process evidence, with no hook-store authority and no focus action", async () => {
    const { cmux, state } = inspectedHost()
    writeSessions("copilot", { newest: { surfaceId: state.id, agentLifecycle: "running", cwd: "/stale" } })
    const inspection = await cmux.inspect!(uuid)
    expect(inspection).toEqual({
      session: expect.objectContaining({ id: uuid, tty: "ttys007", cwd: "/synthetic/project", agent: "Copilot", instance: "20:Thu Oct 15 23:00:00 2026", focused: false }),
      instance: "20:Thu Oct 15 23:00:00 2026", screen: state.screen, activity: "idle", composer: "empty", backgroundWork: false,
    })
    expect(server.methods.filter(call => call.method === "surface.read_text").every(call => call.params.scrollback === false && call.params.surface_id === uuid && call.params.workspace_id === state.workspaceId)).toBe(true)
    expect(inputs()).toEqual([])
    state.instance = ""
    expect((await cmux.inspect!(uuid)).instance).toBeNull()
    await expect(cmux.inspect!("surface:1")).rejects.toThrow()
  })

  it("refuses workspace UUID replacement even when short workspace refs are reused", async () => {
    const { cmux, state } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    state.workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it("leaves unsupported process/composer state unknown without startup failure", async () => {
    const { cmux, state } = inspectedHost()
    state.hasIdentity = false
    expect(await cmux.inspect!(uuid)).toEqual({
      session: expect.objectContaining({ id: uuid, agent: null, cwd: null }),
      instance: null, screen: state.screen, activity: "unknown", composer: "unknown", backgroundWork: null,
    })
    expect((await cmux.list())[0]!.instance).toBeUndefined()
  })

  it.each(["restart", "missing PID", "unsupported start", "ambiguous roots"])("integrates native batched process verification with guarded refusal on %s", async change => {
    inspectedHost()
    let changed = false
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }), {
      schedule: scheduler.schedule,
      identifyTerminals: ttys => identifyTerminalProcesses(ttys, async (command, args) => {
        if (command === "lsof") return "p20\nn/synthetic/project"
        if (args[0] === "-axo") {
          if (changed && change === "missing PID") return ""
          return "20 1 20 20 ttys007 copilot" + (changed && change === "ambiguous roots" ? "\n21 1 20 20 ttys007 copilot" : "")
        }
        if (changed && change === "unsupported start") throw new Error("ps start unsupported")
        return changed && change === "restart"
          ? "20 1 20 20 ttys007 Thu Oct 15 23:01:00 2026 copilot"
          : "20 1 20 20 ttys007 Thu Oct 15 23:00:00 2026 copilot"
      }),
    })
    const expected = await cmux.inspect!(uuid)
    expect(expected.instance).toBe("20:Thu Oct 15 23:00:00 2026")
    changed = true
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it("rejects a read echo mismatch introduced after the expected inspection without input", async () => {
    const { cmux, readResult } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    server.respond("surface.read_text", () => ({ ...readResult(), surface_id: "22222222-2222-4222-8222-222222222222" }))
    await expect(cmux.promptIfUnchanged!(uuid, "continue", expected)).rejects.toThrow("echo")
    expect(inputs()).toEqual([])
  })

  it.each(["instance", "working", "draft", "unknown", "focused", "copied", "background"])("refuses unsafe expected %s evidence with zero input", async mode => {
    const { cmux, state } = inspectedHost()
    if (mode === "instance") state.instance = ""
    if (mode === "working") state.screen = state.screen.replace("Interactive", "Working esc interrupt · Interactive")
    if (mode === "draft") state.screen = state.screen.replace("┃ ", "┃ unfinished")
    if (mode === "unknown") state.screen = "unrecognized terminal"
    if (mode === "focused") state.focused = true
    let expected = await cmux.inspect!(uuid)
    if (mode === "copied") expected = { ...expected }
    if (mode === "background") expected.backgroundWork = null
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it.each(["surface", "workspace", "missing", "text"])("rejects mismatched or absent actual %s read echoes", async mismatch => {
    const { cmux, readResult } = inspectedHost()
    server.respond("surface.read_text", () => ({
      ...readResult(), ...(mismatch === "surface" ? { surface_id: "22222222-2222-4222-8222-222222222222" } :
        mismatch === "workspace" ? { workspace_id: "WS-other" } : mismatch === "text" ? { text: null } : { surface_id: undefined }),
    }))
    await expect(cmux.inspect!(uuid)).rejects.toThrow()
    expect(inputs()).toEqual([])
  })

  it("redacts only exported evidence, preserving draft classification and exact original screen checks", async () => {
    const { cmux, state } = inspectedHost()
    state.screen = state.screen.replace("Synthetic returned task.", "token=first-secret")
    const expected = await cmux.inspect!(uuid)
    expect(expected.screen).toContain("token=[redacted]")
    state.screen = state.screen.replace("first-secret", "other-secret")
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
    state.screen = state.screen.replace("┃ ", "┃ token=draft-secret")
    expect((await cmux.inspect!(uuid)).composer).toBe("draft")
  })

  it.each(["id", "tty", "cwd", "instance", "screen", "draft", "focused", "agent", "missing-instance"])("refuses %s changed during guarded target lookup before any input", async change => {
    const { cmux, state, renderTree } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    let once = false
    server.respond("system.tree", () => {
      if (!once) {
        once = true
        if (change === "id") state.id = "22222222-2222-4222-8222-222222222222"
        if (change === "tty") state.tty = "ttys008"
        if (change === "cwd") state.cwd = "/synthetic/changed"
        if (change === "instance") state.instance = "20:Thu Oct 15 23:01:00 2026"
        if (change === "missing-instance") state.instance = ""
        if (change === "screen") state.screen = state.screen.replace("returned", "changed")
        if (change === "draft") state.screen = state.screen.replace("┃ ", "┃ unfinished\n┃ second line")
        if (change === "focused") state.focused = true
        if (change === "agent") state.agent = "unknown"
      }
      return renderTree()
    })
    // Disappearance can throw before input; that is honestly uncertain to the caller.
    if (change === "id") await expect(cmux.promptIfUnchanged!(uuid, "continue", expected)).rejects.toThrow()
    else expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it.each(["focused", "draft", "instance", "cwd", "screen", "tty"])("refuses %s changing during an awaited screen read", async change => {
    const { cmux, state, readResult } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    server.respond("surface.read_text", () => {
      const reply = readResult()
      if (change === "focused") state.focused = true
      if (change === "draft") state.screen = state.screen.replace("┃ ", "┃ human draft")
      if (change === "instance") state.instance = "20:Thu Oct 15 23:01:00 2026"
      if (change === "cwd") state.cwd = "/changed"
      if (change === "screen") state.screen += "\nnew output"
      if (change === "tty") state.tty = "ttys008"
      return reply
    })
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it.each(["focus", "tty", "workspace"])("rechecks %s after the final awaited process lookup, before paste", async change => {
    const { cmux, state } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    let lookups = 0
    state.onIdentity = () => {
      if (++lookups !== 4) return
      if (change === "focus") state.focused = true
      if (change === "tty") state.tty = "ttys008"
      if (change === "workspace") state.workspaceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    }
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
  })

  it("checks the parent's synchronous guard after awaited lookups and refuses late invalidation before input", async () => {
    const { cmux, state } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    let allowed = true
    state.onIdentity = () => { allowed = false }
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected, () => allowed)).state).toBe("not_sent")
    expect(inputs()).toEqual([])
    state.onIdentity = null
    await expect(cmux.promptIfUnchanged!(uuid, "continue", expected, () => { throw new Error("guidance unavailable") })).rejects.toThrow("guidance unavailable")
    expect(inputs()).toEqual([])
  })

  it("initiates paste immediately after a successful synchronous final parent guard", async () => {
    const { cmux } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    let methodsAtGuard = 0
    let calls = 0
    server.respond("terminal.paste", () => {
      expect(server.methods.length).toBe(methodsAtGuard + 1)
      return {}
    })
    expect((await cmux.promptIfUnchanged!(uuid, "continue", expected, () => {
      calls++
      methodsAtGuard = server.methods.length
      return true
    })).state).toBe("sent")
    expect(calls).toBe(1)
    expect(inputs().map(call => call.method)).toEqual(["terminal.paste", "surface.send_key"])
  })

  it("sends only after a fresh supported idle empty inspection and throws on partial transport effects", async () => {
    const { cmux, state } = inspectedHost()
    const expected = await cmux.inspect!(uuid)
    expect(await cmux.promptIfUnchanged!(uuid, "continue", expected)).toEqual({ state: "sent" })
    expect(inputs()).toEqual([
      { method: "terminal.paste", params: { surface_id: uuid, workspace_id: state.workspaceId, text: "continue", submit_key: "none" } },
      { method: "surface.send_key", params: { surface_id: uuid, workspace_id: state.workspaceId, key: "enter" } },
    ])
    server.respond("surface.send_key", () => { throw new Error("submit disconnected after paste") })
    await expect(cmux.promptIfUnchanged!(uuid, "continue", expected)).rejects.toThrow("submit disconnected")
    server.respond("terminal.paste", () => { throw new Error("paste acceptance uncertain") })
    await expect(cmux.promptIfUnchanged!(uuid, "continue", expected)).rejects.toThrow("paste acceptance uncertain")
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
  it.each(["ttys007", "/dev/ttys007"])("identifies an unhooked terminal with tty %s and keeps its workspace and tab title", async tty => {
    server.respond("system.tree", () => ({
      windows: [{ visible: true, workspaces: [{ id: "WS-1", ref: "workspace:1", title: "ouro", selected: true,
        panes: [{ surfaces: [{ id: "SF-1", ref: "surface:1", title: "Ship Shepherd", type: "terminal", tty }] }],
      }] }],
    }))
    const cmux = createCmuxHost(createCmuxClient({ socketPath: server.socketPath, auth: { kind: "capability", token: "v1.t.s" } }), {
      identifyTerminals: async () => new Map([["ttys007", { agent: "Copilot", cwd: "/Users/a/personal-desk" }]]),
    })
    expect(await cmux.list()).toEqual([expect.objectContaining({
      agent: "Copilot", cwd: "/Users/a/personal-desk", workspaceTitle: "ouro", title: "Ship Shepherd", tty,
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
