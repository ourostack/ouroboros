import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { resetIdentity } from "../../../heart/identity"
import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import type { HostWatchHandlers, ReturnedControl, ShepherdHost } from "../../../senses/shepherd/host"
import type { JudgeResult, ReturnPacket } from "../../../senses/shepherd/judge"
import { appendReturn, readReturns, returnsLogPath, type ReturnRecord } from "../../../senses/shepherd/returns"
import { escalationContent, field, humanName, queueEscalation, startShepherdSenseApp, wakeForEscalations } from "../../../senses/shepherd/sense"
import { ackFrame, startFakeCmux } from "./fake-cmux"
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
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    name: "fake",
    handlers: null,
    screens: {},
    actions: [],
    list: async () => [],
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
  const app = await startShepherdSenseApp({
    agentName: AGENT,
    now: () => clock,
    createHost: () => host,
    judge,
    escalate: (content) => escalations.push(content),
    wake: async (ids) => { wakes.push(ids) },
    schedule,
  })
  stop = app.stop
  const returned = async (event: Partial<ReturnedControl> & { sessionId: string }) => {
    host.handlers!.returned({ transitionId: `t-${clock}`, agent: "claude", cwd: "/Users/a/code/app", lastBody: null, ...event })
    await vi.waitFor(() => expect(readReturns(agentRoot).some((record) => record.transition === `t-${clock}` || record.transition === event.transitionId)).toBe(true))
  }
  return { host, escalations, wakes, returned, last: () => readReturns(agentRoot).at(-1)! }
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
  it("types the judge's line visibly as the human's Ouro, sets the status, and logs it", async () => {
    const packets: ReturnPacket[] = []
    const { host, escalations, last } = await start(async (packet) => { packets.push(packet); return verdict() })
    host.screens.S1 = [`Desk-Task: old/one\nwork\nDesk-Task: ouro-md/toolbar-polish\nsk-${"a".repeat(30)}\n${SCREENS.claudePremature}`]
    await vi.waitFor(() => expect(host.handlers).not.toBeNull())
    host.handlers!.returned({ sessionId: "S1", transitionId: "cmux:B:101", agent: "claude", cwd: "/Users/a/code/app", lastBody: "token=abc123secret Want me to go ahead?" })
    await vi.waitFor(() => expect(readReturns(agentRoot)).toHaveLength(1))
    expect(packets[0]).toMatchObject({ human: "Ari", agent: "claude", cwd: "/Users/a/code/app", task: "ouro-md/toolbar-polish", lastBody: "token=[redacted] Want me to go ahead?" })
    expect(packets[0]!.screen).not.toContain("sk-aaaa")
    expect(packets[0]!.screen.split("\n")).toHaveLength(SCREENS.claudePremature.split("\n").length + 4)
    expect(host.actions).toEqual(["prompt S1 [Ouro for Ari] Go ahead and implement it.", "status S1 answered for Ari: It stopped after a plan."])
    expect(last()).toEqual({
      at: "2026-10-10T20:00:00.000Z", host: "fake", session: "S1", transition: "cmux:B:101", agent: "claude", cwd: "/Users/a/code/app", task: "ouro-md/toolbar-polish",
      kind: "premature", action: "respond", reason: "It stopped after a plan.", reply: "Go ahead and implement it.", latencyMs: 900, inputTokens: 1200,
    })
    expect(escalations).toEqual([])
    expect(fs.statSync(returnsLogPath(agentRoot)).mode & 0o777).toBe(0o600)
  })

  it("presses a menu key instead of typing text", async () => {
    const { host, returned, last } = await start(async () => verdict({ reply: { key: "2" }, reason: "Mocking the clock is the recommended fix." }))
    host.screens.S2 = [SCREENS.codexMenu]
    await returned({ sessionId: "S2", agent: "codex" })
    expect(host.actions).toEqual(["key S2 2", "status S2 answered for Ari: Mocking the clock is the recommended fix."])
    expect(last()).toMatchObject({ action: "respond", reply: "key:2" })
  })

  it("sends nothing when the screen changed while judging or the human focused the session", async () => {
    const { host, returned, last } = await start(async () => verdict())
    host.screens.S1 = [SCREENS.claudePremature, `${SCREENS.claudePremature}\nAri typed something`]
    await returned({ sessionId: "S1", transitionId: "a" })
    expect(last()).toMatchObject({ action: "let_through", reason: "the screen changed while judging, so nothing was sent: It stopped after a plan." })
    host.handlers!.focused("S1")
    clock += 30_000
    await returned({ sessionId: "S1", transitionId: "b" })
    expect(last()).toMatchObject({ action: "let_through", reason: "Ari focused this session in the last minute, so it is theirs: It stopped after a plan." })
    expect(host.actions).toEqual([])
  })

  it("stops answering after three in a row, escalates once, and starts again when the human focuses the session", async () => {
    const { host, escalations, wakes, returned, last } = await start(async () => verdict())
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

    host.handlers!.focused("S1")
    clock += 120_000
    await returned({ sessionId: "S1", transitionId: "5" })
    expect(last()).toMatchObject({ action: "respond" })
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
    const { host, escalations, wakes, returned } = await start(async () => verdicts.shift()!)
    host.screens.G = [SCREENS.copilotGate]
    host.screens.D = [SCREENS.agencyDone]
    await returned({ sessionId: "G", transitionId: "g", agent: "copilot", cwd: "/Users/a/code/service" })
    await returned({ sessionId: "D", transitionId: "d", agent: null, cwd: null })
    await returned({ sessionId: "X", transitionId: "x" })
    expect(host.actions).toEqual(["status G needs Ari: It needs Ari's Azure sign-in.", "status D done: Merged and released with proof."])
    expect(escalations).toHaveLength(2)
    expect(escalations[0]).toContain("copilot in service handed control back and Shepherd let it through: it needs Ari.")
    expect(escalations[1]).toContain("A coding agent handed control back and Shepherd let it through: it says the work is done.")
    expect(escalations[1]).toContain("task: ouro-md/toolbar-polish")
    expect(tasks).toHaveLength(1)
    tasks.shift()!.fn()
    await vi.waitFor(() => expect(wakes).toEqual([["g", "d"]]))
    expect(readReturns(agentRoot).map((record) => [record.kind, record.action])).toEqual([["gate", "let_through"], ["done", "let_through"], ["unclear", "let_through"]])
  })

  it("logs a judge failure and a failed send, and keeps going", async () => {
    const results: Array<() => Promise<JudgeResult>> = [async () => { throw new Error("provider down") }, async () => verdict()]
    const host = fakeHost()
    host.prompt = async () => { throw new Error("terminal gone") }
    const { returned, last } = await start(() => results.shift()!(), host)
    await returned({ sessionId: "S1", transitionId: "e1" })
    expect(last()).toMatchObject({ kind: "error", action: "let_through", reason: "provider down" })
    await returned({ sessionId: "S1", transitionId: "e2" })
    expect(last()).toMatchObject({ kind: "premature", action: "let_through", reason: "It stopped after a plan.; then terminal gone" })
  })

  it("survives a log it cannot write", async () => {
    fs.mkdirSync(path.join(agentRoot, "state", "senses", "shepherd", "returns.jsonl"), { recursive: true })
    const judged = vi.fn(async () => verdict({ kind: "unclear", reply: null }))
    const { host } = await start(judged)
    host.handlers!.returned({ sessionId: "S1", transitionId: "w", agent: null, cwd: null, lastBody: null })
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
