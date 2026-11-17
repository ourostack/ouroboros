import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const wake = vi.hoisted(() => ({ requestPrivateWake: vi.fn() }))
vi.mock("../../../heart/daemon/socket-client", () => wake)
const home = vi.hoisted(() => ({ agentRoot: "" }))
vi.mock("../../../heart/identity", async importActual => ({ ...(await importActual<typeof import("../../../heart/identity")>()), getAgentRoot: () => home.agentRoot }))

import { getPrivateRuntimePendingDir } from "../../../mind/pending"
import {
  APP_SESSIONS_WAKE_TRIGGER, checkDigest, checkWatches, DIGEST_IDLE_MS, newReplies, privateRuntimeDeliver, recordSnapshot, replyContent, SNAPSHOT_MS,
  startAppSessionsSense, WATCH_POLL_MS,
} from "../../../senses/app-sessions/sense"
import { appSessionsStateDir, readSnapshot, readWatches, watchSession, WATCH_MS as WATCH_WINDOW_MS } from "../../../senses/app-sessions/store"

const FAKE = fileURLToPath(new URL("./fake-shepherd.mjs", import.meta.url))
const SAVED = process.env.SHEPHERD_BIN
const ID = "11111111-aaaa-bbbb-cccc-000000000001"
const NOW = Date.parse("2026-11-10T03:00:00Z")
const AFTER = new Date(NOW - 60_000).toISOString()
let shepherdDir: string
let stateDir: string
let agentRoot: string

const replies = (map: Record<string, unknown>): void => fs.writeFileSync(path.join(shepherdDir, "reply.json"), JSON.stringify(map))
const sessions = (rows: unknown[]): void => replies({ sessions: { body: { summary: {}, sessions: rows } } })
const idle = { id: ID, name: "Babysitter", activity: { status: "idle", why: "its turn ended" } }
const messageLog = (messages: unknown[]): void => replies({ sessions: { body: { summary: {}, sessions: [idle] } }, messages: { body: { messages } } })
const assistant = (text: string, at: string) => ({ at, role: "assistant", text })
const calls = (): Array<{ argv: string[] }> =>
  fs.existsSync(path.join(shepherdDir, "calls.jsonl")) ? fs.readFileSync(path.join(shepherdDir, "calls.jsonl"), "utf-8").trim().split("\n").map(line => JSON.parse(line)) : []

function manualScheduler() {
  const tasks: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  return {
    tasks,
    schedule: (fn: () => void, ms: number) => {
      const task = { fn, ms, cancelled: false }
      tasks.push(task)
      return () => { task.cancelled = true }
    },
    live: (ms: number) => tasks.filter(task => task.ms === ms && !task.cancelled),
    fire: (ms: number) => {
      for (const task of tasks.filter(entry => entry.ms === ms && !entry.cancelled)) {
        task.cancelled = true
        task.fn()
      }
    },
  }
}

beforeEach(() => {
  shepherdDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-shepherd-"))
  fs.copyFileSync(FAKE, path.join(shepherdDir, "shepherd.mjs"))
  process.env.SHEPHERD_BIN = path.join(shepherdDir, "shepherd.mjs")
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-sense-"))
  agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "app-sessions-agent-"))
  home.agentRoot = agentRoot
  wake.requestPrivateWake.mockReset()
  sessions([idle])
})

afterEach(() => {
  if (SAVED === undefined) delete process.env.SHEPHERD_BIN
  else process.env.SHEPHERD_BIN = SAVED
  fs.rmSync(shepherdDir, { recursive: true, force: true })
  fs.rmSync(stateDir, { recursive: true, force: true })
  fs.rmSync(agentRoot, { recursive: true, force: true })
})

describe("reading a watched session's new replies", () => {
  it("returns the assistant messages after the cursor, and the cursor moved to the latest of them", async () => {
    messageLog([
      assistant("later but listed first", "2026-11-10T02:59:55.000Z"),
      { at: "2026-11-10T02:00:00.000Z", role: "assistant", text: "old" },
      { at: "2026-11-10T02:59:30.000Z", role: "user", text: "asked" },
      assistant("first", "2026-11-10T02:59:40.000Z"),
      { at: null, role: "assistant", text: "undated" },
      assistant("second", "2026-11-10T02:59:50.000Z"),
    ])
    const result = await newReplies(ID, { name: "Babysitter", after: AFTER, until: NOW + 1, offset: 0 } as never)
    expect(result.replies.map(reply => reply.text)).toEqual(["later but listed first", "first", "second"])
    expect(result.after).toBe("2026-11-10T02:59:55.000Z")
    expect(calls()[0]!.argv).toEqual(["messages", ID, "--json", "--input", "-"])
    messageLog([])
    expect((await newReplies(ID, { name: null, after: AFTER, until: NOW + 1, offset: 0 } as never))).toEqual({ after: AFTER, replies: [] })
  })

  it("words the inbound message with the session and how to answer, marking a truncated reply", () => {
    const text = replyContent(ID, "Babysitter", [{ at: "t1", role: "assistant", text: "done", truncated: true }, { at: null, role: "assistant", text: "more" }])
    expect(text).toContain(`"Babysitter" (${ID}) in this Mac's GitHub Copilot app said:`)
    expect(text).toContain("[message at t1] done\n[message truncated]")
    expect(text).toContain("\nmore\n")
    expect(replyContent(ID, null, [])).toContain(`(${ID}) in this Mac's`)
  })
})

describe("delivering to the private runtime", () => {
  it("queues the reply and wakes the private runtime with its reference", async () => {
    wake.requestPrivateWake.mockResolvedValue({ ok: true })
    await privateRuntimeDeliver("slugger", () => NOW)("hello", [`${ID}:10`])
    const dir = getPrivateRuntimePendingDir("slugger")
    const queued = fs.readdirSync(dir).slice(0, 1).map(file => JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as Record<string, unknown>)
    expect(queued).toEqual([expect.objectContaining({ from: "app-sessions", channel: "app-sessions", content: "hello", timestamp: NOW, mode: "reflect" })])
    expect(wake.requestPrivateWake).toHaveBeenCalledWith("slugger", undefined, expect.objectContaining({
      triggerSource: APP_SESSIONS_WAKE_TRIGGER,
      originRefs: [{ kind: "app-session-reply", id: `${ID}:10` }, { kind: "sense", id: "app-sessions" }],
    }))
  })

  it("leaves the message queued when the wake is refused or fails", async () => {
    wake.requestPrivateWake.mockResolvedValueOnce({ ok: false, error: "busy" }).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("no daemon"))
    const deliver = privateRuntimeDeliver("slugger", () => NOW)
    const dir = getPrivateRuntimePendingDir("slugger")
    const before = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0
    for (let index = 0; index < 4; index += 1) await deliver(`m${index}`, [`r${index}`])
    expect(fs.readdirSync(dir).length - before).toBe(4)
  })
})

describe("the watch pass", () => {
  it("delivers a watched session's new reply once, with its current name, and moves the cursor past it", async () => {
    watchSession(agentRoot, ID, "Babysitter", AFTER, NOW + 60_000)
    messageLog([assistant("finished", "2026-11-10T02:59:50.000Z")])
    const deliver = vi.fn(async () => undefined)
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(1)
    expect(deliver.mock.calls[0]![0]).toContain("current name \"Babysitter\", state idle.")
    expect(deliver.mock.calls[0]![0]).toContain("finished")
    expect(readWatches(agentRoot)[ID]).toMatchObject({ after: "2026-11-10T02:59:50.000Z", name: "Babysitter" })
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it("reports a rename without a reply, says the observation has no reply, and drops a one-reply watch once it has replied", async () => {
    watchSession(agentRoot, ID, "Old name", AFTER, NOW + 60_000)
    messageLog([])
    const deliver = vi.fn(async () => undefined)
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(1)
    expect(deliver.mock.calls[0]![0]).toContain("Renamed from \"Old name\"")
    expect(deliver.mock.calls[0]![0]).toContain("[Copilot app session observation; no new reply]")
    expect(readWatches(agentRoot)[ID]).toMatchObject({ name: "Babysitter" })
    watchSession(agentRoot, ID, "Babysitter", AFTER, NOW + 60_000, true)
    messageLog([assistant("answer", "2026-11-10T02:59:50.000Z")])
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(1)
    expect(readWatches(agentRoot)).toEqual({})
  })

  it("says the sidebar is unknown when Shepherd cannot list it, and keeps the watch when a read or delivery fails", async () => {
    watchSession(agentRoot, ID, "Babysitter", AFTER, NOW + 60_000, true)
    replies({ sessions: { code: 1, body: { ok: false, code: "app-down", error: "the app is not running. Fix: open it." } }, messages: { body: { messages: [assistant("x", "2026-11-10T02:59:50.000Z")] } } })
    const deliver = vi.fn(async () => undefined)
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(1)
    expect(deliver.mock.calls[0]![0]).toContain("current sidebar identity unavailable")
    watchSession(agentRoot, ID, "Babysitter", AFTER, NOW + 60_000)
    const failing = vi.fn(async () => { throw new Error("delivery refused") })
    expect(await checkWatches(agentRoot, failing, NOW)).toBe(0)
    expect(readWatches(agentRoot)[ID]).toMatchObject({ after: AFTER })
    replies({ sessions: { body: { summary: {}, sessions: [idle] } }, messages: { code: 1, body: { ok: false, code: "gone", error: "no messages. Fix: check it." } } })
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(0)
  })

  it("skips a watch that has run out", async () => {
    watchSession(agentRoot, ID, "Babysitter", AFTER, NOW - WATCH_WINDOW_MS - 1)
    messageLog([assistant("late", "2026-11-10T02:59:50.000Z")])
    const deliver = vi.fn(async () => undefined)
    expect(await checkWatches(agentRoot, deliver, NOW)).toBe(0)
    expect(deliver).not.toHaveBeenCalled()
  })

  it("does not reschedule a pass that finishes after the sense stopped", async () => {
    const scheduler = manualScheduler()
    const sense = startAppSessionsSense({ agentName: "slugger", agentRoot, client: { stateDir }, now: () => NOW, schedule: scheduler.schedule, deliver: vi.fn(async () => undefined) })
    sense.stop()
    await sense.done()
    expect(scheduler.live(WATCH_POLL_MS)).toHaveLength(0)
    expect(scheduler.live(DIGEST_IDLE_MS)).toHaveLength(0)
  })
})

describe("snapshots", () => {
  it("records counts, stuck sessions and a session waiting on a permission prompt, with its name and since when", async () => {
    sessions([
      idle,
      { id: "s2", name: "Stuck one", activity: { status: "stuck", why: "stopped" } },
      { id: "s3", name: "Asks", activity: { status: "waiting" }, awaiting_input: { kind: "permission", request_id: "r1", what: "run a shell command" } },
    ])
    const snap = await recordSnapshot(agentRoot, NOW)
    expect(snap).toMatchObject({ appRunning: true, counts: { idle: 1, stuck: 1, waiting: 1, working: 0 }, stuck: [{ id: "s2", name: "Stuck one" }] })
    expect(snap.waitingPrompts).toEqual([expect.objectContaining({ session: "s3", name: "Asks", requestId: "r1", what: "run a shell command" })])
    expect(readSnapshot(agentRoot)).toMatchObject({ counts: { idle: 1 } })
  })

  it("records the error when Shepherd cannot read the app, rather than throwing", async () => {
    replies({ sessions: { code: 1, body: { ok: false, code: "app-down", error: "the app is not running. Fix: open it." } } })
    const snap = await recordSnapshot(agentRoot, NOW)
    expect(snap).toMatchObject({ appRunning: false, sessions: [], error: "the app is not running. Fix: open it." })
  })
})

describe("the status digest", () => {
  it("builds it on its cadence, when agent.json asks for one, and waits otherwise", async () => {
    const writeConfig = (appSessions: unknown) => fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
      version: 2, enabled: true,
      humanFacing: { provider: "anthropic", model: "test" }, agentFacing: { provider: "anthropic", model: "test" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] },
      senses: { "app-sessions": appSessions },
    }))
    const notify = vi.fn(async () => "sent" as const)
    const run = vi.fn(async () => ({ ok: true, stdout: "{}", error: null }))
    const deps = { client: { stateDir, housesitterPaths: ["/nonexistent/housesitter"], homeDir: agentRoot }, run, notify, now: NOW, home: agentRoot }
    writeConfig({ enabled: true })
    expect(await checkDigest("slugger", agentRoot, deps)).toBe(DIGEST_IDLE_MS)
    expect(fs.existsSync(path.join(appSessionsStateDir(agentRoot), "digest.json"))).toBe(false)
    writeConfig({ enabled: true, digest: { everySeconds: 120, drains: ["drains", "status"] } })
    expect(await checkDigest("slugger", agentRoot, deps)).toBe(120_000)
    expect(run).toHaveBeenCalledWith(["drains", "status"], 60_000)
    expect(JSON.parse(fs.readFileSync(path.join(appSessionsStateDir(agentRoot), "digest.json"), "utf-8"))).toMatchObject({ counts: { idle: 1 } })
    expect(notify).not.toHaveBeenCalled()
    writeConfig({ enabled: true, digest: { deskRoots: ["~/desk"] } })
    expect(await checkDigest("slugger", agentRoot, deps)).toBe(300_000)
    writeConfig({ enabled: false, digest: {} })
    expect(await checkDigest("slugger", agentRoot, deps)).toBe(DIGEST_IDLE_MS)
    fs.rmSync(path.join(agentRoot, "agent.json"))
    expect(await checkDigest("slugger", agentRoot, deps)).toBe(DIGEST_IDLE_MS)
  })

  it("tells the owner about a session waiting on them once it has waited, after a live check finds it still waiting", async () => {
    sessions([{ id: ID, name: "Asks", activity: { status: "waiting", why: "waiting for the person's answer" }, awaiting_input: { kind: "user_input", request_id: "q1", question: "ok?" } }])
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
      version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "test" }, agentFacing: { provider: "anthropic", model: "test" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] }, senses: { "app-sessions": { enabled: true, digest: { everySeconds: 60 } } },
    }))
    const notify = vi.fn(async () => "sent" as const)
    const deps = { client: { stateDir }, run: vi.fn(async () => ({ ok: true, stdout: "{}", error: null })), notify, now: NOW, home: agentRoot }
    await checkDigest("slugger", agentRoot, deps)
    expect(notify).not.toHaveBeenCalled()
    await checkDigest("slugger", agentRoot, { ...deps, now: NOW + 11 * 60_000 })
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0]![0]).toContain("Asks")
  })

  it("keeps the last digest and tries again when Shepherd cannot list the sessions", async () => {
    fs.writeFileSync(path.join(agentRoot, "agent.json"), JSON.stringify({
      version: 2, enabled: true, humanFacing: { provider: "anthropic", model: "test" }, agentFacing: { provider: "anthropic", model: "test" },
      phrases: { thinking: ["t"], tool: ["t"], followup: ["f"] }, senses: { "app-sessions": { enabled: true, digest: { everySeconds: 60 } } },
    }))
    replies({ sessions: { code: 1, body: { ok: false, code: "app-down", error: "the app is not running. Fix: open it." } } })
    expect(await checkDigest("slugger", agentRoot, { client: { stateDir }, run: vi.fn(), notify: vi.fn(async () => "sent" as const), now: NOW, home: agentRoot })).toBe(DIGEST_IDLE_MS)
  })
})

describe("the sense", () => {
  it("snapshots every minute and checks watches every ten seconds until stopped", async () => {
    const scheduler = manualScheduler()
    const deliver = vi.fn(async () => undefined)
    const sense = startAppSessionsSense({ agentName: "slugger", agentRoot, client: { stateDir }, now: () => NOW, schedule: scheduler.schedule, deliver })
    await sense.done()
    expect(readSnapshot(agentRoot)).toMatchObject({ counts: { idle: 1 } })
    expect(scheduler.live(SNAPSHOT_MS)).toHaveLength(1)
    expect(scheduler.live(WATCH_POLL_MS)).toHaveLength(1)
    expect(scheduler.live(DIGEST_IDLE_MS)).toHaveLength(1)
    scheduler.fire(SNAPSHOT_MS)
    scheduler.fire(WATCH_POLL_MS)
    scheduler.fire(DIGEST_IDLE_MS)
    await sense.done()
    expect(scheduler.tasks).toHaveLength(6)
    sense.stop()
    expect(scheduler.live(DIGEST_IDLE_MS)).toHaveLength(0)
    expect(scheduler.live(SNAPSHOT_MS)).toHaveLength(0)
    expect(scheduler.live(WATCH_POLL_MS)).toHaveLength(0)
    // A tick that fires after the stop does nothing.
    for (const task of [...scheduler.tasks]) task.fn()
    await sense.done()
    expect(scheduler.tasks).toHaveLength(6)
  })

  it("finds its agent's root, and takes its defaults, from its name alone", async () => {
    const scheduler = manualScheduler()
    const sense = startAppSessionsSense({ agentName: "slugger", now: () => NOW, schedule: scheduler.schedule, deliver: vi.fn(async () => undefined) })
    await sense.done()
    sense.stop()
    expect(readSnapshot(agentRoot)).toMatchObject({ counts: { idle: 1 } })
  })

  it("runs with the real clock, scheduler and delivery", async () => {
    const sense = startAppSessionsSense({ agentName: "slugger", agentRoot, client: { stateDir, housesitterPaths: ["/nonexistent/housesitter"] } })
    await sense.done()
    sense.stop()
    expect(readSnapshot(agentRoot)).toMatchObject({ counts: { idle: 1 } })
  })

  it("keeps its schedule when a pass cannot write its state", async () => {
    const notAFolder = path.join(agentRoot, "state-is-a-file")
    fs.writeFileSync(notAFolder, "")
    const scheduler = manualScheduler()
    const sense = startAppSessionsSense({ agentName: "slugger", agentRoot: notAFolder, client: { stateDir }, now: () => NOW, schedule: scheduler.schedule, deliver: vi.fn(async () => undefined), notifyOwner: vi.fn(async () => "sent" as const) })
    await sense.done()
    expect(scheduler.live(WATCH_POLL_MS)).toHaveLength(1)
    expect(scheduler.live(SNAPSHOT_MS)).toHaveLength(1)
    sense.stop()
  })
})
