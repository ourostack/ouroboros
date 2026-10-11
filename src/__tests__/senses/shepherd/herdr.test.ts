import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ReturnedControl } from "../../../senses/shepherd/host"
import { createHerdrHost, HERDR_METADATA_SOURCE, herdrRequest } from "../../../senses/shepherd/herdr"
import { agentInfo, HerdrError, paneEvent, paneInfo, startFakeHerdr, statusEvent, type FakeHerdr } from "./fake-herdr"
import { SCREENS } from "./fixtures"

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
    run: async (ms: number) => {
      for (const task of tasks.filter((entry) => !entry.cancelled && entry.ms === ms)) {
        task.cancelled = true
        task.fn()
      }
      await new Promise((resolve) => setTimeout(resolve, 30))
    },
  }
}

const GRACE_MS = 3_000
let server: FakeHerdr
let scheduler: ReturnType<typeof manualScheduler>
let panes: Record<string, unknown>[]
let agents: Record<string, Record<string, unknown>>

const host = () => createHerdrHost({ socketPath: server.socketPath }, { schedule: scheduler.schedule })
const subscriptions = () => server.requests.filter((request) => request.method === "events.subscribe")

beforeEach(async () => {
  scheduler = manualScheduler()
  server = await startFakeHerdr()
  panes = [paneInfo("w1:p1", { agent_status: "working" }), paneInfo("w1:p2", { agent: "copilot", title: "deploy" }), paneInfo("w2:p1", { agent: null, terminal_title_stripped: null })]
  agents = { "w1:p1": agentInfo("w1:p1", { agent_status: "done" }) }
  server.respond("pane.list", () => ({ type: "pane_list", panes }))
  server.respond("agent.get", (params) => {
    const agent = agents[params.target as string]
    if (!agent) throw new HerdrError("not_found", "agent not found")
    return { type: "agent_info", agent }
  })
  server.respond("events.subscribe", () => ({ type: "subscription_started" }))
  server.respond("pane.read", (params) => ({ type: "pane_read", read: { pane_id: params.pane_id, workspace_id: "w1", tab_id: "w1:t1", source: params.source, format: "text", text: SCREENS.codexMenu, revision: 7, truncated: false } }))
  for (const method of ["agent.prompt", "pane.send_keys", "pane.report_metadata"]) server.respond(method, () => ({ type: "ok" }))
  server.respond("notification.show", () => ({ type: "notification_show", shown: true, reason: "shown" }))
})

afterEach(async () => {
  await server.close()
})

describe("Herdr host: panes", () => {
  it("lists panes, reads recent text, prompts, presses keys and shows Shepherd's status", async () => {
    const herdr = host()
    expect(herdr.name).toBe("herdr")
    expect(await herdr.list()).toEqual([
      { id: "w1:p1", ref: "w1:p1", workspace: "w1", title: "codex", agent: "codex" },
      { id: "w1:p2", ref: "w1:p2", workspace: "w1", title: "deploy", agent: "copilot" },
      { id: "w2:p1", ref: "w2:p1", workspace: "w2", title: "", agent: null },
    ])
    expect(await herdr.read("w1:p1", 80)).toBe(SCREENS.codexMenu)
    expect(server.requests.at(-1)).toEqual({ method: "pane.read", params: { pane_id: "w1:p1", source: "recent", lines: 80, strip_ansi: true } })

    await herdr.prompt("w1:p1", "[Ouro for Ari] Go ahead with option 2.")
    expect(server.requests.at(-1)).toEqual({ method: "agent.prompt", params: { target: "w1:p1", text: "[Ouro for Ari] Go ahead with option 2." } })
    await herdr.key("w1:p1", "escape")
    await herdr.key("w1:p1", "2")
    expect(server.requests.slice(-2).map((request) => request.params.keys)).toEqual([["esc"], ["2"]])

    await herdr.signal("w1:p1", "answered for Ari", { title: "Shepherd", body: "answered" })
    await herdr.signal("w1:p1", null)
    expect(server.requests.slice(-3)).toEqual([
      { method: "pane.report_metadata", params: { pane_id: "w1:p1", source: HERDR_METADATA_SOURCE, state_labels: { idle: "answered for Ari", done: "answered for Ari", blocked: "answered for Ari" }, tokens: { ouro: "answered for Ari" } } },
      { method: "notification.show", params: { title: "Shepherd", body: "answered" } },
      { method: "pane.report_metadata", params: { pane_id: "w1:p1", source: HERDR_METADATA_SOURCE, clear_state_labels: true, tokens: { ouro: null } } },
    ])
  })

  it("tolerates sparse results and reports Herdr's errors, silence and a missing socket", async () => {
    server.respond("pane.list", () => ({ type: "pane_list", panes: [{}] }))
    server.respond("pane.read", () => ({ type: "pane_read" }))
    server.respond("agent.prompt", () => { throw new HerdrError("agent_blocked", "agent is blocked") })
    server.respond("pane.send_keys", () => { throw new HerdrError("bad_keys", "") })
    server.respond("ping", () => null)
    const herdr = host()
    expect(await herdr.list()).toEqual([{ id: "", ref: "", workspace: null, title: "", agent: null }])
    expect(await herdr.read("w1:p1", 10)).toBe("")
    await expect(herdr.prompt("w1:p1", "x")).rejects.toThrow("herdr agent.prompt: agent is blocked")
    await expect(herdr.key("w1:p1", "enter")).rejects.toThrow("herdr pane.send_keys: bad_keys")
    await expect(herdrRequest(server.socketPath, "ping", {}, 20)).rejects.toThrow("herdr ping timed out")
    server.respond("pane.list", () => "not an object")
    expect(await herdr.list()).toEqual([])
    await expect(herdrRequest("/tmp/no-such-herdr.sock", "ping", {})).rejects.toThrow(/herdr ping: .*ENOENT/)
  })

  it("reports an error with neither message nor code, and a connection closed without a reply", async () => {
    const net = await import("node:net")
    const fs = await import("node:fs")
    const path = await import("node:path")
    const dir = fs.mkdtempSync("/tmp/hdr-")
    const socketPath = path.join(dir, "raw.sock")
    let reply = (socket: import("node:net").Socket, id: string) => { socket.write(`not json\n${JSON.stringify({ id: "other" })}\n${JSON.stringify({ id, error: {} })}\n`) }
    const raw = net.createServer((socket) => socket.on("data", (chunk) => reply(socket, (JSON.parse(chunk.toString()) as { id: string }).id)))
    await new Promise<void>((resolve) => raw.listen(socketPath, resolve))
    await expect(herdrRequest(socketPath, "ping", {})).rejects.toThrow("herdr ping: error")
    reply = (socket) => { socket.end() }
    await expect(herdrRequest(socketPath, "ping", {})).rejects.toThrow("herdr ping: connection closed")
    await new Promise<void>((resolve) => raw.close(() => resolve()))
  })
})

describe("Herdr host: returned control", () => {
  async function watching() {
    const returned: ReturnedControl[] = []
    const focused: string[] = []
    const watcher = host().watch({ returned: (event) => returned.push(event), focused: (id) => focused.push(id) })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    return { watcher, returned, focused }
  }

  it("subscribes to every pane's agent status and to pane lifecycle", async () => {
    panes.push({ terminal_id: "term_orphan" }, { ...paneInfo("w4:p1"), agent_status: undefined })
    const { watcher } = await watching()
    expect(subscriptions()[0]!.params).toEqual({ subscriptions: [
      { type: "pane.created" }, { type: "pane.closed" }, { type: "pane.focused" },
      { type: "pane.agent_status_changed", pane_id: "w1:p1" }, { type: "pane.agent_status_changed", pane_id: "w1:p2" }, { type: "pane.agent_status_changed", pane_id: "w2:p1" }, { type: "pane.agent_status_changed", pane_id: "w4:p1" },
    ] })
    watcher.close()
  })

  it("turns working to done, idle or blocked into a return after the grace period, keyed by Herdr's state sequence", async () => {
    const { watcher, returned } = await watching()
    server.push(statusEvent("w1:p1", "done"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    expect(returned).toEqual([])
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([{ sessionId: "w1:p1", transitionId: "herdr:w1:p1:41", agent: "codex", cwd: "/Users/a/code/app/pkg", lastBody: null }])

    // A pane already idle when Shepherd subscribed is not a return; one that starts and stops again is.
    server.push(statusEvent("w1:p2", "done", "copilot"))
    server.push(statusEvent("w1:p2", "working", "copilot"))
    server.push(statusEvent("w1:p2", "blocked", "copilot"))
    agents["w1:p2"] = agentInfo("w1:p2", { agent_status: "blocked", agent: "copilot", state_change_seq: 9, foreground_cwd: null })
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)
    expect(returned.at(-1)).toEqual({ sessionId: "w1:p2", transitionId: "herdr:w1:p2:9", agent: "copilot", cwd: "/Users/a/code/app", lastBody: null })
    server.push(statusEvent("w1:p2", "working", "copilot"))
    server.push(statusEvent("w1:p2", "idle", "copilot"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    watcher.close()
    expect(scheduler.due(GRACE_MS)).toBe(0)
  })

  it("drops a stop the agent resumed from, or one Herdr no longer reports, and survives a failed read", async () => {
    const { watcher, returned } = await watching()
    server.push(statusEvent("w1:p1", "idle"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    server.push(statusEvent("w1:p1", "working"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(0))

    agents["w1:p1"] = agentInfo("w1:p1", { agent_status: "working" })
    server.push(statusEvent("w1:p1", "done"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)

    server.push(statusEvent("w1:p1", "working"))
    server.push(statusEvent("w1:p1", "idle"))
    agents["w1:p1"] = { ...agentInfo("w1:p1", { agent_status: "idle", agent: null, cwd: null, foreground_cwd: null }), state_change_seq: undefined }
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)
    expect(returned).toEqual([expect.objectContaining({ sessionId: "w1:p1", agent: null, cwd: null, transitionId: expect.stringMatching(/^herdr:w1:p1:t\d+$/) })])

    server.respond("agent.get", () => ({ type: "agent_info" }))
    server.push(statusEvent("w1:p1", "working"))
    server.push(statusEvent("w1:p1", "done"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)
    delete agents["w1:p1"]
    server.respond("agent.get", (params) => { throw new HerdrError("not_found", `no agent ${String(params.target)}`) })
    server.push(statusEvent("w1:p1", "working"))
    server.push(statusEvent("w1:p1", "done"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    await scheduler.run(GRACE_MS)
    expect(returned).toHaveLength(1)
    watcher.close()
  })

  it("reports focus, resubscribes when panes come and go, and ignores what it does not use", async () => {
    const { watcher, focused } = await watching()
    server.pushRaw("not json\n")
    server.push({ event: "pane.agent_status_changed", data: { agent_status: "done" } })
    server.push({ event: "pane_output_changed", data: { pane_id: "w1:p1", workspace_id: "w1", revision: 8 } })
    server.push({ event: "pane.agent_status_changed" })
    server.push({ event: 7, data: { pane_id: "w1:p1" } })
    server.push({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1" } })
    server.push({ id: "ouro_events", result: { type: "ok" } })
    server.push(paneEvent("pane_focused", "w1:p2"))
    await vi.waitFor(() => expect(focused).toEqual(["w1:p2"]))

    panes.push(paneInfo("w3:p1", { agent_status: "working" }))
    server.push(paneEvent("pane_created", "w3:p1"))
    await vi.waitFor(() => expect(subscriptions()).toHaveLength(2))
    expect(subscriptions()[1]!.params.subscriptions).toContainEqual({ type: "pane.agent_status_changed", pane_id: "w3:p1" })
    expect(scheduler.due(1_000)).toBe(0)

    server.push(statusEvent("w1:p1", "working"))
    server.push(statusEvent("w1:p1", "done"))
    await vi.waitFor(() => expect(scheduler.due(GRACE_MS)).toBe(1))
    panes = panes.filter((pane) => pane.pane_id !== "w1:p1")
    server.push(paneEvent("pane_closed", "w1:p1"))
    await vi.waitFor(() => expect(subscriptions()).toHaveLength(3))
    expect(scheduler.due(GRACE_MS)).toBe(0)
    watcher.close()
  })

  it("resubscribes with backoff after events are lost or Herdr is unreachable, and stops when closed", async () => {
    const { watcher } = await watching()
    server.respond("events.subscribe", () => { throw new HerdrError("events_lost", "subscriber fell behind") })
    server.endStreams()
    await vi.waitFor(() => expect(scheduler.due(1_000)).toBe(1))
    await scheduler.run(1_000)
    await vi.waitFor(() => expect(scheduler.due(2_000)).toBe(1))

    server.respond("pane.list", () => { throw new HerdrError("internal", "server restarting") })
    await scheduler.run(2_000)
    await vi.waitFor(() => expect(scheduler.due(5_000)).toBe(1))
    for (const delay of [5_000, 10_000, 30_000]) {
      await scheduler.run(delay)
      await vi.waitFor(() => expect(scheduler.due(delay === 5_000 ? 10_000 : 30_000)).toBe(1))
    }

    server.respond("pane.list", () => ({ type: "pane_list", panes }))
    server.respond("events.subscribe", () => ({ type: "subscription_started" }))
    await scheduler.run(30_000)
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
    watcher.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(scheduler.due(1_000)).toBe(0)
  })

  it("does not subscribe when closed while listing panes", async () => {
    const watcher = host().watch({ returned: () => undefined, focused: () => undefined })
    watcher.close()
    await vi.waitFor(() => expect(server.requests.some((request) => request.method === "pane.list")).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(subscriptions()).toHaveLength(0)
  })
})
