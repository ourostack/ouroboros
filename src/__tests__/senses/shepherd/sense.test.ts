import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetIdentity } from "../../../heart/identity"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import type { HostWatchHandlers, ReturnedControl, ShepherdHost } from "../../../senses/shepherd/host"
import type { JudgeResult, ReturnPacket } from "../../../senses/shepherd/judge"
import { appendReturn, readReturns, returnsLogPath, type ReturnRecord } from "../../../senses/shepherd/returns"
import { escalationContent, field, humanName, noticePolicy, queueEscalation, startShepherdSenseApp, wakeForEscalations } from "../../../senses/shepherd/sense"
import { ackFrame, startFakeCmux } from "./fake-cmux"
import { recordShepherdCorrection, setShepherdSessionPause } from "../../../senses/shepherd/guidance"
import { hookEvent, SCREENS, tree } from "./fixtures"

const mockRequestPrivateWake = vi.fn()
vi.mock("../../../heart/daemon/socket-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/daemon/socket-client")>(),
  requestPrivateWake: (...args: unknown[]) => mockRequestPrivateWake(...args),
}))
const mockGetProviderRuntime = vi.fn()
vi.mock("../../../heart/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/core")>(),
  getProviderRuntime: (...args: unknown[]) => mockGetProviderRuntime(...args),
}))

const AGENT = "ouroboros"
const originalHome = process.env.HOME
let home = ""
let agentRoot = ""
let clock = 0
let stop: (() => void) | null = null

interface FakeHost extends ShepherdHost {
  handlers: HostWatchHandlers | null
  screens: Record<string, string[]>
  actions: string[]
  focusedSession: string | null
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    name: "fake",
    handlers: null,
    screens: {},
    actions: [],
    focusedSession: null,
    list: async () => Object.keys(host.screens).map((id) => ({ id, ref: id, workspace: null, title: "", agent: null, focused: id === host.focusedSession })),
    pace: (id, slower) => { host.actions.push(`pace ${id} ${slower ? "slower" : "normal"}`) },
    read: async (id) => {
      const queue = host.screens[id] ?? [""]
      return queue.length > 1 ? queue.shift()! : queue[0]!
    },
    prompt: async (id, line) => { host.actions.push(`prompt ${id} ${line}`) },
    key: async (id, key) => { host.actions.push(`key ${id} ${key}`) },
    signal: async (id, status) => { host.actions.push(`status ${id} ${status}`) },
    watch: (handlers) => {
      host.handlers = handlers
      return { close: () => { host.actions.push("closed") } }
    },
  }
  return host
}

const verdict = (overrides: Partial<JudgeResult> = {}): JudgeResult => ({ kind: "premature", reply: { text: "Go ahead and implement it." }, reason: "It stopped after a plan.", latencyMs: 900, inputTokens: 1200, ...overrides })

interface Task { fn: () => void; ms: number }
const tasks: Task[] = []
const schedule = (fn: () => void, ms: number) => {
  const task = { fn, ms }
  tasks.push(task)
  return () => { tasks.splice(tasks.indexOf(task), 1) }
}

async function start(judge: (packet: ReturnPacket) => Promise<JudgeResult>, host: FakeHost = fakeHost()) {
  const escalations: string[] = []
  const wakes: string[][] = []
  const notices: ReturnRecord[] = []
  const app = await startShepherdSenseApp({
    agentName: AGENT,
    now: () => clock,
    createHost: () => host,
    judge,
    escalate: (content) => escalations.push(content),
    wake: async (ids) => { wakes.push(ids) },
    notifyOwner: (record) => notices.push(record),
    schedule,
  })
  stop = app.stop
  const returned = async (event: Partial<ReturnedControl> & { sessionId: string }) => {
    host.handlers!.returned({ transitionId: `t-${clock}`, agent: "claude", cwd: "/Users/a/code/app", lastBody: null, backgroundWork: null, ...event })
    await vi.waitFor(() => expect(readReturns(agentRoot).some((record) => record.transition === `t-${clock}` || record.transition === event.transitionId)).toBe(true))
  }
  return { host, escalations, wakes, notices, returned, last: () => readReturns(agentRoot).at(-1)! }
}

function writeFriend(name: string, record: Record<string, unknown>): void {
  fs.mkdirSync(path.join(agentRoot, "friends"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "friends", name), typeof record.raw === "string" ? record.raw : JSON.stringify(record))
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-sense-"))
  process.env.HOME = home
  resetIdentity()
  agentRoot = path.join(home, "AgentBundles", `${AGENT}.ouro`)
  writeFriend("ari.json", { name: "Ari", trustLevel: "family", externalIds: [{ provider: "local", externalId: os.userInfo().username }] })
  cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: "/nowhere.sock" } })
  mockRequestPrivateWake.mockReset().mockResolvedValue({ ok: true })
  clock = Date.parse("2026-10-10T20:00:00.000Z")
  tasks.length = 0
})

afterEach(() => {
  stop?.()
  stop = null
  resetRuntimeCredentialConfigCache()
  if (originalHome === undefined) delete process.env.HOME
  else process.env.HOME = originalHome
})

describe("Shepherd sense: answering premature returns", () => {
  const target = { host: "fake", session: "S1", cwd: "/Users/a/code/app", task: null }
  const establish = () => appendReturn(agentRoot, { at: "earlier", host: "fake", session: "S1", transition: "earlier", agent: "claude", cwd: target.cwd, task: null, kind: "gate", action: "let_through", reason: "review", reply: null, latencyMs: 1, inputTokens: 1 })

  it("includes persisted applicable principles in the next judgment but excludes other sessions", async () => {
    establish()
    await recordShepherdCorrection(agentRoot, { actorId: "ari", requestId: "learn", target, feedback: "Review is external", principle: "Wait for review." })
    const packets: ReturnPacket[] = []
    const { host, returned } = await start(async packet => { packets.push(packet); return verdict({ kind: "waiting", reply: null }) })
    host.screens.S1 = ["PR awaiting review"]
    host.screens.S2 = ["other"]
    await returned({ sessionId: "S1", transitionId: "next" })
    await returned({ sessionId: "S2", transitionId: "other" })
    expect(packets[0]!.guidance).toMatchObject({ revision: 1, principles: [{ text: "Wait for review." }] })
    expect(packets[1]!.guidance!.principles).toEqual([])
  })

  it("honors pause and resume with no automatic input while paused", async () => {
    establish()
    await setShepherdSessionPause(agentRoot, { actorId: "ari", requestId: "pause", target, paused: true })
    const { host, returned, last } = await start(async () => verdict())
    host.screens.S1 = [SCREENS.claudePremature]
    await returned({ sessionId: "S1", transitionId: "paused" })
    expect(last().action).toBe("let_through")
    expect(last().reason).toMatch(/paused/)
    expect(host.actions.some(action => action.startsWith("prompt"))).toBe(false)
    await setShepherdSessionPause(agentRoot, { actorId: "ari", requestId: "resume", target, paused: false })
    await returned({ sessionId: "S1", transitionId: "resumed" })
    expect(last().action).toBe("respond")
  })

  it.each(["pause", "revision", "corrupt"])("fails closed when guidance %s changes during an in-flight judgment", async change => {
    establish()
    const { host, returned, last, notices } = await start(async () => {
      if (change === "pause") await setShepherdSessionPause(agentRoot, { actorId: "ari", requestId: "pause", target, paused: true })
      else if (change === "revision") await recordShepherdCorrection(agentRoot, { actorId: "ari", requestId: "learn", target, feedback: "Different", principle: "Do not approve it." })
      else fs.writeFileSync(path.join(agentRoot, "state/senses/shepherd/guidance.json"), "broken")
      return verdict()
    })
    host.screens.S1 = [SCREENS.claudePremature]
    await returned({ sessionId: "S1", transitionId: `change-${change}` })
    expect(host.actions.some(action => /^(prompt|key) /.test(action))).toBe(false)
    expect(last().action).toBe("let_through")
    expect(last().reason).toMatch(/guidance|paused/)
    expect(notices).toHaveLength(1)
  })

  it("reports unreadable guidance before judging and blocks an automatic reply", async () => {
    establish()
    fs.writeFileSync(path.join(agentRoot, "state/senses/shepherd/guidance.json"), "broken")
    let judged = false
    const { host, returned, last } = await start(async () => { judged = true; return verdict() })
    host.screens.S1 = [SCREENS.claudePremature]
    await returned({ sessionId: "S1", transitionId: "corrupt" })
    expect(judged).toBe(false)
    expect(last()).toMatchObject({ kind: "error", action: "let_through" })
    expect(last().reason).toMatch(/Shepherd guidance/)
  })

  it("escalates waiting as an outside dependency, without sending or claiming delivery", async () => {
    const { host, returned, last, escalations, notices } = await start(async () => verdict({ kind: "waiting", reply: null, reason: "PR awaiting someone else's review." }))
    host.screens.S1 = ["PR awaiting review"]
    await returned({ sessionId: "S1", transitionId: "waiting" })
    expect(last()).toMatchObject({ kind: "waiting", action: "let_through" })
    expect(escalations[0]).toContain("waiting on an outside dependency")
    expect(escalations[0]).not.toContain("work is done")
    expect(notices[0]!.kind).toBe("waiting")
    expect(host.actions.some(action => /^(prompt|key) /.test(action))).toBe(false)
  })
  it("types the judge's line visibly as the human's Ouro, sets the status, and logs it", async () => {
    const packets: ReturnPacket[] = []
    const { host, escalations, last } = await start(async (packet) => { packets.push(packet); return verdict() })
    host.screens.S1 = [`Desk-Task: old/one\nwork\nDesk-Task: ouro-md/toolbar-polish\nsk-${"a".repeat(30)}\n${SCREENS.claudePremature}`]
    await vi.waitFor(() => expect(host.handlers).not.toBeNull())
    host.handlers!.returned({ sessionId: "S1", transitionId: "cmux:B:101", agent: "claude", cwd: "/Users/a/code/app", lastBody: "token=abc123secret Want me to go ahead?", backgroundWork: false })
    await vi.waitFor(() => expect(readReturns(agentRoot)).toHaveLength(1))
    expect(packets[0]).toMatchObject({ human: "Ari", agent: "claude", cwd: "/Users/a/code/app", task: "ouro-md/toolbar-polish", lastBody: "token=[redacted] Want me to go ahead?", backgroundWork: false })
    expect(packets[0]!.screen).not.toContain("sk-aaaa")
    expect(packets[0]!.screen.split("\n")).toHaveLength(SCREENS.claudePremature.split("\n").length + 4)
    expect(host.actions.filter((action) => !action.startsWith("pace"))).toEqual(["prompt S1 [Ouro for Ari] Go ahead and implement it.", "status S1 answered for Ari: It stopped after a plan."])
    expect(last()).toEqual({
      at: "2026-10-10T20:00:00.000Z", host: "fake", session: "S1", transition: "cmux:B:101", agent: "claude", cwd: "/Users/a/code/app", task: "ouro-md/toolbar-polish",
      kind: "premature", action: "respond", reason: "It stopped after a plan.", reply: "Go ahead and implement it.", latencyMs: 900, inputTokens: 1200,
      guidanceRevision: 0,
    })
    expect(escalations).toEqual([])
    expect(fs.statSync(returnsLogPath(agentRoot)).mode & 0o777).toBe(0o600)
  })

  it("presses a menu key instead of typing text", async () => {
    const { host, returned, last } = await start(async () => verdict({ reply: { key: "2" }, reason: "Mocking the clock is the recommended fix." }))
    host.screens.S2 = [SCREENS.codexMenu]
    await returned({ sessionId: "S2", agent: "codex" })
    expect(host.actions.filter((action) => !action.startsWith("pace"))).toEqual(["key S2 2", "status S2 answered for Ari: Mocking the clock is the recommended fix."])
    expect(last()).toMatchObject({ action: "respond", reply: "key:2" })
  })

  it("still answers when only a timer or counter ticked on the screen while judging", async () => {
    const { host, returned, last } = await start(async () => verdict({ reply: { key: "1" } }))
    host.screens.S2 = ["Shell Run startup    59s |\nDo you want to run this command?\n> 1. Yes\n  2. No", "Shell Run startup  1m 0s |\nDo you want to run this command?\n> 1. Yes\n  2. No"]
    await returned({ sessionId: "S2", agent: null })
    expect(last()).toMatchObject({ action: "respond", reply: "key:1" })
    // The timer can also be missing from one redraw.
    host.screens.S2 = ["Shell Run startup  40s\nDo you want to run this command?\n> 1. Yes", "Shell Run startup       \nDo you want to run this command?\n> 1. Yes"]
    await returned({ sessionId: "S2", agent: null, transitionId: "timer-gone" })
    expect(last()).toMatchObject({ action: "respond", reply: "key:1" })
  })

  it("sends nothing when the screen changed while judging or the human focused the session", async () => {
    const { host, returned, last } = await start(async () => verdict())
    host.screens.S1 = [SCREENS.claudePremature, `${SCREENS.claudePremature}\nAri typed something`]
    await returned({ sessionId: "S1", transitionId: "a" })
    expect(last()).toMatchObject({ action: "let_through", reason: "the screen changed while judging, so nothing was sent: It stopped after a plan." })
    host.handlers!.focused("S1")
    clock += 30_000
    await returned({ sessionId: "S1", transitionId: "b" })
    expect(last()).toMatchObject({ action: "let_through", reason: "Ari is in this session or just left it, so it is theirs: It stopped after a plan." })
    // Long after the focus event, the human is still in the session: cmux only reports focus when it changes.
    host.focusedSession = "S1"
    clock += 600_000
    await returned({ sessionId: "S1", transitionId: "c" })
    expect(last()).toMatchObject({ action: "let_through", reason: "Ari is in this session or just left it, so it is theirs: It stopped after a plan." })
    expect(host.actions.filter((action) => !action.startsWith("pace"))).toEqual([])
  })

  it("stops answering after three in a row, escalates once, and starts again when the human focuses the session", async () => {
    let judged = 0
    const { host, escalations, wakes, notices, returned, last } = await start(async () => { judged += 1; return verdict() })
    host.screens.S1 = [SCREENS.claudePremature]
    for (const id of ["1", "2", "3", "4"]) {
      clock += 1_000
      await returned({ sessionId: "S1", transitionId: id })
    }
    expect(host.actions.filter((action) => action.startsWith("prompt"))).toHaveLength(3)
    expect(last()).toMatchObject({ kind: "loop_guard", action: "let_through", reason: "loop guard: It stopped after a plan." })
    expect(escalations).toHaveLength(1)
    expect(escalations[0]).toContain("Shepherd answered it 3 times in a row")
    expect(host.actions.at(-1)).toBe("status S1 stopped answering: It stopped after a plan.")
    expect(tasks.map((task) => task.ms)).toEqual([2_000])
    tasks.shift()!.fn()
    await vi.waitFor(() => expect(wakes).toEqual([["4"]]))

    // While tripped, later returns are logged without a judge call or another escalation.
    for (const id of ["4a", "4b"]) {
      clock += 1_000
      await returned({ sessionId: "S1", transitionId: id })
    }
    expect(judged).toBe(4)
    expect(escalations).toHaveLength(1)
    expect(last()).toMatchObject({ kind: "loop_guard", reason: "Shepherd stopped answering this session until Ari focuses it" })

    host.handlers!.focused("S1")
    clock += 120_000
    await returned({ sessionId: "S1", transitionId: "5" })
    expect(last()).toMatchObject({ action: "respond" })
    // The owner hears about every judged return once, and about the tripped guard only when it trips.
    expect(notices.map((record) => [record.transition, record.kind])).toEqual([["1", "premature"], ["2", "premature"], ["3", "premature"], ["4", "loop_guard"], ["5", "premature"]])
  })

  it("also caps automatic answers per session per hour", async () => {
    const { host, returned, last } = await start(async () => verdict())
    host.screens.S1 = [SCREENS.claudePremature]
    for (let index = 0; index < 11; index += 1) {
      clock += 120_000
      if (index % 3 === 0) host.handlers!.focused("S1")
      clock += 61_000
      await returned({ sessionId: "S1", transitionId: `h${index}` })
    }
    expect(host.actions.filter((action) => action.startsWith("prompt"))).toHaveLength(10)
    expect(last()).toMatchObject({ kind: "loop_guard" })
  })
})

describe("Shepherd sense: letting returns through", () => {
  it("brings gates and deliveries to the Ouro agent with one wake per burst, and logs unclear returns only", async () => {
    const verdicts = [
      verdict({ kind: "gate", reply: null, reason: "It needs Ari's Azure sign-in." }),
      verdict({ kind: "done", reply: null, reason: "Merged and released with proof." }),
      verdict({ kind: "unclear", reply: null, reason: "A plain shell." }),
    ]
    const { host, escalations, wakes, notices, returned } = await start(async () => verdicts.shift()!)
    host.screens.G = [SCREENS.copilotGate]
    host.screens.D = [SCREENS.agencyDone]
    await returned({ sessionId: "G", transitionId: "g", agent: "copilot", cwd: "/Users/a/code/service", title: "Ship service", workspaceTitle: "ouro" })
    await returned({ sessionId: "D", transitionId: "d", agent: null, cwd: null })
    await returned({ sessionId: "X", transitionId: "x" })
    expect(host.actions.filter((action) => !action.startsWith("pace"))).toEqual(["status G needs Ari: It needs Ari's Azure sign-in.", "status D done: Merged and released with proof."])
    expect(escalations).toHaveLength(2)
    expect(escalations[0]).toContain("copilot in service handed control back and Shepherd let it through: it needs Ari.")
    expect(escalations[1]).toContain("A coding agent handed control back and Shepherd let it through: it says the work is done.")
    expect(escalations[1]).toContain("task: ouro-md/toolbar-polish")
    expect(tasks).toHaveLength(1)
    tasks.shift()!.fn()
    await vi.waitFor(() => expect(wakes).toEqual([["g", "d"]]))
    expect(readReturns(agentRoot).map((record) => [record.kind, record.action])).toEqual([["gate", "let_through"], ["done", "let_through"], ["unclear", "let_through"]])
    expect(notices.map((record) => record.kind)).toEqual(["gate", "done", "unclear"])
    expect(notices[0]).toMatchObject({ title: "Ship service", workspaceTitle: "ouro" })
  })

  it("treats a stop with the agent's own background work running as working: no reply, no wake, a status update", async () => {
    const packets: ReturnPacket[] = []
    const verdicts = [
      // The judge read the screen: background subagents are running.
      verdict({ kind: "working", reply: null, reason: "Waiting on two background agents; both PRs are open." }),
      // The host said background work is running: whatever the judge says, it is working and never answered.
      verdict({ kind: "premature", reply: { text: "Keep going." }, reason: "It reported partial progress." }),
      // A gate while background work runs is news for the Ouro agent, queued with no wake.
      verdict({ kind: "gate", reply: null, reason: "It asks Ari to approve the spec while its subagent runs." }),
      // News the judge flagged on its own.
      verdict({ kind: "working", reply: null, reason: "The background test run failed on main.", news: true }),
    ]
    const { host, escalations, wakes, notices, returned } = await start(async (packet) => { packets.push(packet); return verdicts.shift()! })
    host.screens.C = [SCREENS.claudeBackground]
    host.screens.X = [SCREENS.codexBackground]
    await returned({ sessionId: "C", transitionId: "c1", agent: "claude" })
    await returned({ sessionId: "C", transitionId: "c2", agent: "claude", backgroundWork: true, lastBody: "Waiting for 2 background agents." })
    // The same background stop with the same last message is not judged again.
    await returned({ sessionId: "C", transitionId: "c3", agent: "claude", backgroundWork: true, lastBody: "Waiting for 2 background agents." })
    await returned({ sessionId: "X", transitionId: "x1", agent: null, backgroundWork: true })
    await returned({ sessionId: "X", transitionId: "x2", agent: "codex", backgroundWork: true, lastBody: "The suite failed." })
    expect(packets.map((packet) => packet.backgroundWork)).toEqual([null, true, true, true])
    expect(host.actions.filter((action) => action.startsWith("status"))).toEqual([
      "status C claude waiting on its background work: Waiting on two background agents; both PRs are open.",
      "status C claude waiting on its background work: It reported partial progress.",
      "status X agent waiting on its background work: It asks Ari to approve the spec while its subagent runs.",
      "status X codex waiting on its background work: The background test run failed on main.",
    ])
    expect(readReturns(agentRoot).map((record) => [record.kind, record.action, record.reply])).toEqual(Array(5).fill(["working", "let_through", null]))
    expect(readReturns(agentRoot)[2]!.reason).toBe("still waiting on its background work; nothing new since the last judgment")
    expect(escalations).toHaveLength(2)
    expect(escalations[0]).toContain("[Shepherd update]")
    expect(escalations[0]).toContain("A coding agent in app ended its turn while its own background work runs, so it is still working")
    expect(tasks).toHaveLength(0)
    expect(wakes).toEqual([])
    // Background work is not a return: the owner hears only the updates that carry news.
    expect(notices.map((record) => record.transition)).toEqual(["x1", "x2"])
  })

  it("checks a quiet terminal less often after it is judged working or not an agent, and at the normal pace otherwise", async () => {
    const verdicts = [verdict({ kind: "unclear", reply: null }), verdict({ kind: "working", reply: null }), verdict({ kind: "gate", reply: null })]
    const { host, returned } = await start(async () => verdicts.shift()!)
    host.screens.Q = [SCREENS.shell]
    for (const id of ["q1", "q2", "q3"]) await returned({ sessionId: "Q", transitionId: id, agent: null })
    expect(host.actions.filter((action) => action.startsWith("pace"))).toEqual(["pace Q slower", "pace Q slower", "pace Q normal"])
  })

  it("logs a judge failure and a failed send, and keeps going", async () => {
    const results: Array<() => Promise<JudgeResult>> = [async () => { throw new Error("provider down") }, async () => verdict()]
    const host = fakeHost()
    host.prompt = async () => { throw new Error("terminal gone") }
    const { returned, last, notices } = await start(() => results.shift()!(), host)
    await returned({ sessionId: "S1", transitionId: "e1" })
    expect(last()).toMatchObject({ kind: "error", action: "let_through", reason: "provider down" })
    expect(notices.map((record) => record.kind)).toEqual(["error"])
    await returned({ sessionId: "S1", transitionId: "e2" })
    expect(last()).toMatchObject({ kind: "premature", action: "let_through", reason: "It stopped after a plan.; then terminal gone" })
  })

  it("survives a log it cannot write", async () => {
    fs.mkdirSync(path.join(agentRoot, "state", "senses", "shepherd", "returns.jsonl"), { recursive: true })
    const judged = vi.fn(async () => verdict({ kind: "unclear", reply: null }))
    const { host } = await start(judged)
    host.handlers!.returned({ sessionId: "S1", transitionId: "w", agent: null, cwd: null, lastBody: null, backgroundWork: null })
    await vi.waitFor(() => expect(judged).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
})

describe("Shepherd sense: wiring", () => {
  it("refuses to start without a terminal host on this machine", async () => {
    resetRuntimeCredentialConfigCache()
    await expect(startShepherdSenseApp({ agentName: AGENT })).rejects.toThrow("no terminal host is attached on this machine")
  })

  it("defaults to the cmux host and the agent-lane judge", async () => {
    const server = await startFakeCmux({ capability: "v1.t.s" })
    try {
      cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
      server.respond("system.tree", () => tree([{ id: "SF-1", ref: "surface:1" }]))
      server.respond("surface.read_text", () => ({ text: SCREENS.copilotGate }))
      server.respond("events.stream", () => ackFrame({ resume: { gap: false, latest_seq: 1 } }))
      server.respond("notification.create", () => ({}))
      server.v1(() => "OK")
      mockGetProviderRuntime.mockResolvedValue({ streamTurn: async () => ({ content: `{"kind":"gate","reply":null,"reason":"Needs Ari's sign-in."}` }) })
      const app = await startShepherdSenseApp({ agentName: AGENT, schedule: (fn, ms) => { const timer = setTimeout(fn, ms === 3_000 || ms === 2_000 ? 0 : ms); return () => clearTimeout(timer) } })
      stop = app.stop
      await vi.waitFor(() => expect(server.streamCount()).toBe(1))
      server.push(hookEvent(2, "Stop", { source: "copilot" }))
      await vi.waitFor(() => expect(readReturns(agentRoot).at(-1)).toMatchObject({ host: "cmux", kind: "gate", agent: "copilot" }), { timeout: 2_000 })
      expect(mockGetProviderRuntime).toHaveBeenCalledWith("agent", { agentName: AGENT, agentRoot })
      expect(fs.readdirSync(path.join(agentRoot, "state", "pending", "self", "inner", "dialog")).length).toBe(1)
      await vi.waitFor(() => expect(mockRequestPrivateWake).toHaveBeenCalledWith(AGENT, undefined, expect.objectContaining({ triggerSource: "shepherd" })))
    } finally {
      stop?.()
      stop = null
      await server.close()
    }
  })

  it("reads the owner notice policy from agent.json, and reports every return when it cannot", () => {
    expect(noticePolicy(AGENT, agentRoot)).toBe("every")
    const config = { version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "m" }, agentFacing: { provider: "anthropic", model: "m" }, phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] }, senses: { shepherd: { enabled: true } } }
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify(config))
    expect(noticePolicy(AGENT, agentRoot)).toBe("every")
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ ...config, senses: { shepherd: { enabled: true, notify: "needs-me" } } }))
    expect(noticePolicy(AGENT, agentRoot)).toBe("needs-me")
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({ ...config, senses: { shepherd: { enabled: true, notify: "loud" } } }))
    expect(noticePolicy(AGENT, agentRoot)).toBe("every")
  })

  it("names the human from the family friend for this OS user, else any family friend", () => {
    writeFriend("bob.json", { name: "Bob", trustLevel: "family" })
    writeFriend("eve.json", { name: "Eve", trustLevel: "stranger" })
    writeFriend("blank.json", { name: " ", trustLevel: "family" })
    writeFriend("broken.json", { raw: "{" })
    expect(humanName(agentRoot)).toBe("Ari")
    expect(humanName(agentRoot, "someone-else")).toBe("Ari")
    expect(humanName(path.join(home, "none"))).toBe("the human")
  })

  it("keeps a bounded log and reads past a torn line", () => {
    const record: ReturnRecord = { at: "t", host: "cmux", session: "S", transition: "x", agent: null, cwd: null, task: null, kind: "done", action: "let_through", reason: "r", reply: null, latencyMs: null, inputTokens: null }
    expect(readReturns(agentRoot)).toEqual([])
    appendReturn(agentRoot, record)
    fs.appendFileSync(returnsLogPath(agentRoot), "{torn\n")
    appendReturn(agentRoot, { ...record, transition: "y" })
    expect(readReturns(agentRoot).map((entry) => entry.transition)).toEqual(["x", "y"])
    fs.writeFileSync(returnsLogPath(agentRoot), "x".repeat(2 * 1024 * 1024 + 1))
    appendReturn(agentRoot, { ...record, transition: "z" })
    expect(readReturns(agentRoot).map((entry) => entry.transition)).toEqual(["z"])
    expect(fs.existsSync(`${returnsLogPath(agentRoot)}.1`)).toBe(true)
    expect(field(`a\n\tb ${"c".repeat(300)}`, 10)).toBe("a b ccccc…")
    expect(escalationContent({ ...record, kind: "gate", agent: "codex\u0007", cwd: "/x/repo" }, "Ari")).toContain("codex in repo handed control back")
  })

  it("queues escalations in the private runtime and wakes it, logging a refused or failed wake", async () => {
    queueEscalation(AGENT, "[Shepherd return]", 1_000)
    const dir = path.join(agentRoot, "state", "pending", "self", "inner", "dialog")
    expect(JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf-8"))).toMatchObject({ from: "shepherd", channel: "shepherd", content: "[Shepherd return]", expiresAt: 1_000 + 30 * 60_000 })

    await wakeForEscalations(AGENT, ["cmux:B:1"])
    expect(mockRequestPrivateWake).toHaveBeenCalledWith(AGENT, undefined, expect.objectContaining({
      reason: "Shepherd return", triggerSource: "shepherd", budgetClass: "interactive",
      originRefs: [{ kind: "shepherd-return", id: "cmux:B:1" }, { kind: "sense", id: "shepherd" }],
    }))
    await wakeForEscalations(AGENT, ["a", "b"])
    expect(mockRequestPrivateWake.mock.calls.at(-1)![2]).toMatchObject({ reason: "2 Shepherd returns" })
    mockRequestPrivateWake.mockResolvedValueOnce({ ok: false, error: "refused" }).mockResolvedValueOnce({ ok: false }).mockRejectedValueOnce(new Error("no daemon"))
    await wakeForEscalations(AGENT, ["c"])
    await wakeForEscalations(AGENT, ["d"])
    await wakeForEscalations(AGENT, ["e"])
    mockRequestPrivateWake.mockResolvedValueOnce(undefined)
    await wakeForEscalations(AGENT, ["f"])
  })

  it("closes the host watch and a pending wake on stop", async () => {
    const { host, returned } = await start(async () => verdict({ kind: "done", reply: null }))
    await returned({ sessionId: "S1", transitionId: "s" })
    expect(tasks).toHaveLength(1)
    stop!()
    stop = null
    expect(tasks).toHaveLength(0)
    expect(host.actions).toContain("closed")
  })
})

describe("Shepherd sense: the default owner notice", () => {
  it("queues a notice for each judged return and names sessions from the host's list", async () => {
    const host = fakeHost()
    host.screens.S1 = [SCREENS.claudePremature]
    const list = vi.spyOn(host, "list")
    const app = await startShepherdSenseApp({ agentName: AGENT, now: () => clock, createHost: () => host, judge: async () => verdict(), escalate: () => undefined, wake: async () => undefined, schedule })
    stop = app.stop
    host.handlers!.returned({ transitionId: "n1", sessionId: "S1", agent: "claude", cwd: "/Users/a/code/app", lastBody: null, backgroundWork: null })
    await vi.waitFor(() => expect(readReturns(agentRoot).some((record) => record.transition === "n1")).toBe(true))
    const notice = tasks.find((task) => task.ms === 5_000)!
    list.mockClear()
    notice.fn()
    // The only family friend has no Teams identity, so nothing is sent; the notifier still asked the host for names.
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1))
  })
})
