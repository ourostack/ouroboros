import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { cacheMachineRuntimeCredentialConfig, resetRuntimeCredentialConfigCache } from "../../../heart/runtime-credentials"
import { resetIdentity } from "../../../heart/identity"
import type { CmuxEscalation } from "../../../senses/cmux/attention"
import { readStewardPolicy, updateStewardPolicy } from "../../../heart/steward-policy"
import { CMUX_GRANT_ACTION, CMUX_GRANT_KEY } from "../../../senses/cmux/answer"
import { cmuxDecisionLogPath, readDecisions } from "../../../senses/cmux/casebook"
import { startCmuxSenseApp, type CmuxSenseApp } from "../../../senses/cmux/sense"
import { ackFrame, feedEvent, startFakeCmux, type FakeCmux } from "./fake-cmux"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, realpathSync: vi.fn(actual.realpathSync) }
})

const mockRequestPrivateWake = vi.fn()
vi.mock("../../../heart/daemon/socket-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../heart/daemon/socket-client")>(),
  requestPrivateWake: (...args: unknown[]) => mockRequestPrivateWake(...args),
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
  mockRequestPrivateWake.mockResolvedValue({ ok: true })
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
  mockRequestPrivateWake.mockReset()
})

describe("cmux sense app", () => {
  it("refuses to start without socket auth and names the repair", async () => {
    resetRuntimeCredentialConfigCache()
    await expect(startCmuxSenseApp({ agentName: AGENT })).rejects.toThrow("ouro vault config set --agent ouroboros --scope machine --key cmux.socketCapability")
  })

  it("follows the event stream, tracks surfaces, and escalates each pending Feed request once", async () => {
    const submitted: CmuxEscalation[] = []
    let items: unknown[] = []
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => { submitted.push(input) } })

    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(1))
    expect(server.methods.find((entry) => entry.method === "events.stream")!.params).toEqual({ categories: ["feed", "surface"] })

    items = [pending("req-1"), pending("req-2", { kind: "question", tool_name: null })]
    server.push(feedEvent(11, { hook_event_name: "PermissionRequest", tool_name: "Bash" }))
    await vi.waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[0]).toMatchObject({ requestId: "req-1" })
    expect(submitted[0]!.content).toContain("surface_id: SF-1")

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
    const surface = { workspaceId: "WS-1", agent: "claude", sessionId: "s1", cwd: "/repo", lifecycle: "working", lastHook: "PreToolUse", lastTool: "Bash", at: "2026-10-10T19:00:00.000Z" }
    fs.writeFileSync(statePath(), JSON.stringify({ schemaVersion: 1, bootId: "BOOT-1", seq: 40, surfaces: { "SF-1": surface }, escalated: [] }))
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async () => undefined })

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

    expect(readState()).toMatchObject({ seq: 40, surfaces: { "SF-1": surface } })

    // cmux restarted and the cursor fell out of its window: the picture is dropped and the cursor jumps to latest_seq.
    server.respond("events.stream", () => ackFrame({ boot_id: "BOOT-2", resume: { gap: true, latest_seq: 77 } }))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(5_000)).toBe(1))
    timers.run(5_000)
    await vi.waitFor(() => expect(readState()).toMatchObject({ bootId: "BOOT-2", seq: 77, surfaces: {}, connected: true }))
    server.endStreams()
    await vi.waitFor(() => expect(timers.due(1_000)).toBe(1))
    timers.run(1_000)
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "events.stream").at(-1)!.params).toEqual({ after_seq: 77, categories: ["feed", "surface"] }))
  })

  it("caps the reconnect backoff and records refusals with the repair hint", async () => {
    await server.close()
    server = await startFakeCmux({ denyAll: true })
    cacheMachineRuntimeCredentialConfig(AGENT, { cmux: { socketCapability: "v1.t.s", socketPath: server.socketPath } })
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async () => undefined })

    for (const delay of [1_000, 2_000, 5_000, 10_000, 30_000, 30_000]) {
      await vi.waitFor(() => expect(timers.due(delay)).toBe(1))
      timers.run(delay)
    }
    await vi.waitFor(() => expect(readState()).toMatchObject({ connected: false }))
    expect(String(readState().lastError)).toContain("ouro vault config set --agent ouroboros")
  })

  it("delivers like mail by default: pending messages in the private runtime plus one wake per check pass, kept even when the wake is refused", async () => {
    let fail = true
    let items = [pending("req-9"), pending("req-10"), pending("req-11")]
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => {
      if (fail) throw new Error("feed unavailable")
      return { items }
    })
    mockRequestPrivateWake.mockResolvedValueOnce({ ok: false, error: "daemon busy" }).mockRejectedValueOnce(new Error("socket gone")).mockResolvedValueOnce({ ok: false }).mockResolvedValue(null)
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule })

    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list")).toHaveLength(1))
    expect(mockRequestPrivateWake).not.toHaveBeenCalled()
    fail = false
    timers.run(30_000)
    await vi.waitFor(() => expect(readState().escalated).toEqual(["req-9", "req-10", "req-11"]))
    // A burst of three requests costs one wake, and so one private turn that reads all three.
    await vi.waitFor(() => expect(mockRequestPrivateWake).toHaveBeenCalledTimes(1))
    expect(mockRequestPrivateWake).toHaveBeenCalledWith(AGENT, undefined, {
      reason: "3 cmux Feed requests",
      triggerSource: "cmux-feed",
      budgetClass: "interactive",
      idempotencyKey: expect.stringMatching(/^cmux-feed:ouroboros:3:[0-9a-f]{32}$/),
      originRefs: [{ kind: "cmux-feed", id: "req-9" }, { kind: "cmux-feed", id: "req-10" }, { kind: "cmux-feed", id: "req-11" }, { kind: "sense", id: "cmux" }],
    })
    const pendingDir = path.join(home, "AgentBundles", `${AGENT}.ouro`, "state", "pending", "self", "inner", "dialog")
    const queued = fs.readdirSync(pendingDir).map((name) => JSON.parse(fs.readFileSync(path.join(pendingDir, name), "utf-8")) as Record<string, unknown>)
    expect(queued).toHaveLength(3)
    expect(queued[0]).toMatchObject({ from: "cmux", friendId: "self", channel: "cmux", key: "feed", timestamp: NOW, expiresAt: NOW + 30 * 60_000, mode: "reflect" })
    expect(queued.map((entry) => String(entry.content))).toEqual(expect.arrayContaining([expect.stringContaining("request_id: req-9"), expect.stringContaining("request_id: req-11")]))

    // A pass with nothing new sends no wake.
    timers.run(30_000)
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list").length).toBeGreaterThanOrEqual(3))
    expect(mockRequestPrivateWake).toHaveBeenCalledTimes(1)
    // A single request wakes under its own id; a rejected wake, a refusal without a message and no daemon socket (null) all leave the message queued.
    for (const [index, id] of ["req-12", "req-13", "req-14"].entries()) {
      items = [...items, pending(id)]
      timers.run(30_000)
      await vi.waitFor(() => expect(mockRequestPrivateWake).toHaveBeenCalledTimes(index + 2))
      expect(mockRequestPrivateWake).toHaveBeenLastCalledWith(AGENT, undefined, expect.objectContaining({ reason: "cmux Feed request", idempotencyKey: `cmux-feed:ouroboros:${id}` }))
    }
    await vi.waitFor(() => expect(readState().escalated).toEqual(["req-9", "req-10", "req-11", "req-12", "req-13", "req-14"]))
  })

  it("keeps checking the Feed after a state write fails, and writes again once it can", async () => {
    server.respond("events.stream", () => ackFrame())
    let items = [pending("first")]
    server.respond("feed.list", () => ({ items }))
    const submitted: string[] = []
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => { submitted.push(input.requestId) } })
    await vi.waitFor(() => expect(readState().escalated).toEqual(["first"]))
    // A non-empty directory where the state file goes makes every write fail.
    fs.unlinkSync(statePath())
    fs.mkdirSync(path.join(statePath(), "blocker"), { recursive: true })
    items = [pending("second")]
    timers.run(30_000)
    await vi.waitFor(() => expect(submitted).toEqual(["first", "second"]))
    items = [pending("third")]
    timers.run(30_000)
    await vi.waitFor(() => expect(submitted).toEqual(["first", "second", "third"]))
    fs.rmSync(statePath(), { recursive: true })
    items = []
    timers.run(30_000)
    await vi.waitFor(() => expect(readState().escalated).toEqual(["first", "second", "third"]))
  })

  it("escalates the other pending items when one cannot be recorded", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [pending("bad"), pending("good")] }))
    const submitted: string[] = []
    let refuse = true
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => {
      if (input.requestId === "bad" && refuse) throw new Error("queue unavailable")
      submitted.push(input.requestId)
    } })
    await vi.waitFor(() => expect(submitted).toEqual(["good"]))
    await vi.waitFor(() => expect(readState().escalated).toEqual(["good"]))
    refuse = false
    timers.run(30_000)
    await vi.waitFor(() => expect(submitted).toEqual(["good", "bad"]))
  })

  it("records the cmux version from system.identify, and null when cmux does not say", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    let version: unknown = "0.65.1"
    server.respond("system.identify", () => (version === "throw" ? (() => { throw new Error("nope") })() : { app: "cmux", version }))
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async () => undefined })
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
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => clock, schedule: timers.schedule, escalate: async () => undefined })
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
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async () => undefined })
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
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async () => undefined })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))

    await app.stop()
    app = null
    await vi.waitFor(() => expect(server.streamCount()).toBe(0))
    expect(timers.due(30_000)).toBe(0)
    expect(timers.due(1_000)).toBe(0)
    expect(readState()).toMatchObject({ connected: false })
  })

  it("answers an allowlisted request once under a standing grant, and escalates with the reason otherwise", async () => {
    const agentRoot = path.join(home, "AgentBundles", `${AGENT}.ouro`)
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "repo-")))
    fs.mkdirSync(path.join(repo, ".git"))
    fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n")
    updateStewardPolicy(agentRoot, {
      expectedVersion: readStewardPolicy(agentRoot).version,
      actor: { friendId: "ari", trustLevel: "family", sessionEventId: "evt-grant", authorization: { profileId: "sanctuary-owner", profileVersion: 1, requestId: "req-grant", sessionKey: "cli", receiptId: "auth-1" } },
      mutation: { kind: "grant_routine_action", key: CMUX_GRANT_KEY, action: CMUX_GRANT_ACTION, targets: [repo], maxCount: 5, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    let items: Array<Record<string, unknown>> = [
      pending("auto-1", { cwd: repo, tool_input: JSON.stringify({ command: "git status" }) }),
      pending("hard-1", { cwd: repo, tool_input: JSON.stringify({ command: "rm -rf src" }) }),
      pending("fail-1", { cwd: repo, tool_input: JSON.stringify({ command: "git log" }) }),
      pending("odd-1", { cwd: path.join(repo, "odd"), tool_input: JSON.stringify({ command: "ls" }) }),
      pending("chg-1", { cwd: repo, tool_input: JSON.stringify({ command: "git status" }) }),
    ]
    let pendingLists = 0
    server.respond("events.stream", () => ackFrame())
    server.respond("system.identify", () => ({ app: "cmux", version: "0.65.0" }))
    server.respond("feed.list", (params) => {
      const listed = structuredClone(params.pending_only ? items.filter((entry) => entry.status === "pending") : items)
      // chg-1 changes after the sense first reads it, so its re-check right before the reply finds a different request.
      if (params.pending_only && (pendingLists += 1) === 1) Object.assign(items.find((entry) => entry.request_id === "chg-1")!, { tool_input: JSON.stringify({ command: "git status --porcelain" }) })
      return { items: listed }
    })
    server.respond("feed.permission.reply", (params) => {
      if (params.request_id === "fail-1") throw new Error("reply refused")
      const entry = items.find((candidate) => candidate.request_id === params.request_id)!
      Object.assign(entry, { status: "resolved", decision: { kind: "permission", mode: params.mode } })
      return { delivered: true }
    })
    // A judging failure for one item must not stop the others.
    fs.mkdirSync(path.join(repo, "odd"))
    const realpath = vi.mocked(fs.realpathSync).getMockImplementation()!
    vi.mocked(fs.realpathSync).mockImplementation(((target: fs.PathLike) => {
      if (String(target).endsWith(`${path.sep}odd`)) throw new Error("judge blew up")
      return realpath(target)
    }) as typeof fs.realpathSync)
    const submitted: CmuxEscalation[] = []
    const timers = manualScheduler()
    try {
      app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => { submitted.push(input) } })
      await vi.waitFor(() => expect(submitted).toHaveLength(4))
    } finally {
      vi.mocked(fs.realpathSync).mockImplementation(realpath)
    }
    const replies = server.methods.filter((entry) => entry.method === "feed.permission.reply")
    expect(replies.map((entry) => entry.params)).toEqual([{ request_id: "auto-1", mode: "once" }, { request_id: "fail-1", mode: "once" }])
    expect(submitted.map((input) => input.requestId)).toEqual(["hard-1", "fail-1", "odd-1", "chg-1"])
    expect(submitted[0]!.content).toContain("why it was not answered automatically: floor: rm is never answered for the human")
    expect(submitted[1]!.content).toContain("why it was not answered automatically: the sense's reply may or may not have reached cmux, and cmux does not show the request resolved by it")
    expect(submitted[2]!.content).toContain("why it was not answered automatically: the sense could not judge or answer it: judge blew up")
    expect(submitted[3]!.content).toContain("why it was not answered automatically: the sense's own reply did not go out")
    const log = readDecisions(cmuxDecisionLogPath(path.join(agentRoot, "state", "senses", "cmux")))
    expect(log.map((entry) => [entry.requestId, entry.outcome])).toEqual([
      ["auto-1", "reply_sent"], ["auto-1", "replied_once"], ["hard-1", "escalated"], ["fail-1", "reply_sent"], ["fail-1", "reply_failed"], ["fail-1", "escalated"],
      ["chg-1", "reply_failed"], ["chg-1", "escalated"],
    ])

    timers.run(30_000)
    await vi.waitFor(() => expect(server.methods.filter((entry) => entry.method === "feed.list" && entry.params.pending_only).length).toBeGreaterThanOrEqual(2))
    expect(server.methods.filter((entry) => entry.method === "feed.permission.reply")).toHaveLength(2)
    expect(submitted).toHaveLength(4)
  })

  it("escalates an unconfirmed reply, and observes without answering on cmux older than 0.65.0", async () => {
    const agentRoot = path.join(home, "AgentBundles", `${AGENT}.ouro`)
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(home, "repo-")))
    fs.mkdirSync(path.join(repo, ".git"))
    fs.writeFileSync(path.join(repo, ".git", "config"), "[core]\n\tbare = false\n")
    updateStewardPolicy(agentRoot, {
      expectedVersion: readStewardPolicy(agentRoot).version,
      actor: { friendId: "ari", trustLevel: "family", sessionEventId: "evt-grant", authorization: { profileId: "sanctuary-owner", profileVersion: 1, requestId: "req-grant", sessionKey: "cli", receiptId: "auth-1" } },
      mutation: { kind: "grant_routine_action", key: CMUX_GRANT_KEY, action: CMUX_GRANT_ACTION, targets: [repo], maxCount: 5, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    let version = "0.65.0"
    const items = [pending("stuck-1", { cwd: repo, tool_input: JSON.stringify({ command: "git status" }) })]
    server.respond("events.stream", () => ackFrame())
    server.respond("system.identify", () => ({ app: "cmux", version }))
    server.respond("feed.list", () => ({ items }))
    server.respond("feed.permission.reply", () => ({ delivered: true }))
    const submitted: CmuxEscalation[] = []
    const timers = manualScheduler()
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => { submitted.push(input) } })
    await vi.waitFor(() => expect(submitted).toHaveLength(1))
    expect(submitted[0]!.content).toContain("why it was not answered automatically: the sense's reply may or may not have reached cmux, and cmux does not show the request resolved by it")

    await app.stop()
    app = null
    fs.writeFileSync(path.join(agentRoot, "state", "senses", "cmux", "state.json"), "{}")
    version = "0.64.22"
    items[0] = pending("old-1", { cwd: repo, tool_input: JSON.stringify({ command: "git status" }) })
    app = await startCmuxSenseApp({ agentName: AGENT, now: () => NOW, schedule: timers.schedule, escalate: async (input) => { submitted.push(input) } })
    await vi.waitFor(() => expect(submitted).toHaveLength(2))
    expect(submitted[1]!.content).toContain("why it was not answered automatically: would answer once (floor: git status only reads), but cmux 0.64.22 is older than 0.65.0")
    expect(server.methods.filter((entry) => entry.method === "feed.permission.reply")).toHaveLength(1)
  })

  it("uses real timers by default", async () => {
    server.respond("events.stream", () => ackFrame())
    server.respond("feed.list", () => ({ items: [] }))
    app = await startCmuxSenseApp({ agentName: AGENT, escalate: async () => undefined })
    await vi.waitFor(() => expect(server.streamCount()).toBe(1))
  })
})
