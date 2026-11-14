import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const client = vi.hoisted(() => ({ sendToAppSession: vi.fn(), messageDelivered: vi.fn() }))
vi.mock("../../../senses/app-sessions/client", () => client)

import { emitNervesEvent } from "../../../nerves/runtime"
import { parseWakeOutput, runCommand, runWakeRunner, runWakeRunners, sendWake, WAKE_HOLD_MS, wasDelivered, type CommandResult } from "../../../senses/app-sessions/wake-runner"
import { readWakeRunnerStates, wakeRunnerStatusLines, type WakeRunnerState } from "../../../senses/app-sessions/wake-runner-state"

const RUNNER = { name: "drains", command: ["/bin/drains", "poll"], session: "58fbd57e-e371-4169-b013-2f413ab4a046" }
const NOW = Date.parse("2026-11-13T06:00:00Z")
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wake-runner-"))
  // Required by the nerves audit: every test emits at least one event, including the pure ones.
  emitNervesEvent({ component: "senses", event: "senses.wake_runner_test_marker", message: "wake-runner test" })
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })

const printed = (value: unknown): CommandResult => ({ ok: true, stdout: JSON.stringify(value), error: null })

/** A fake command line: `poll` prints what the test set, and every other argv is a `done` report that lands in `reports`. */
function world(output: unknown, send: (session: string, message: string) => Promise<{ ok: boolean; error: string | null }> = async () => ({ ok: true, error: null })) {
  const reports: string[][] = []
  const w = {
    reports,
    sent: [] as Array<[string, string]>,
    reportResult: { ok: true, stdout: "", error: null } as CommandResult,
    output: printed(output) as CommandResult,
    run: vi.fn(async (argv: string[]) => {
      if (argv[1] === "poll") return w.output
      reports.push(argv)
      return w.reportResult
    }),
    send: vi.fn(async (session: string, message: string) => { w.sent.push([session, message]); return send(session, message) }),
    /** Messages the fake session's log shows as delivered. */
    delivered: new Set<string>(),
    deps: (now = NOW) => ({ run: w.run, send: w.send, delivered: (_s: string, message: string) => w.delivered.has(message), now }),
    go: (previous?: WakeRunnerState, now = NOW) => runWakeRunner(RUNNER, w.deps(now), previous),
  }
  return w
}

describe("parseWakeOutput", () => {
  it("reads wakes and status lines, cleaning and bounding the lines", () => {
    const status = ["fine", "bad\u0007line\nwith break", "", 4, "x".repeat(400), ...Array.from({ length: 30 }, (_, i) => `l${i}`)]
    const out = parseWakeOutput(JSON.stringify({ wakes: [{ message: "m", session: "s", done: ["a", "b"] }, { message: "n" }], status }))
    expect(out.wakes).toEqual([{ message: "m", session: "s", done: ["a", "b"] }, { message: "n" }])
    expect(out.status).toHaveLength(20)
    expect(out.status.slice(0, 2)).toEqual(["fine", "bad line with break"])
    expect(out.status[2]).toHaveLength(300)
    expect(parseWakeOutput(JSON.stringify({ wakes: [] })).status).toEqual([])
  })

  it.each([
    ["not json", "the command did not print JSON"],
    ["[]", 'no "wakes" array'],
    ["null", 'no "wakes" array'],
    ['{"wakes":"x"}', 'no "wakes" array'],
    ['{"wakes":[null]}', "wakes[0] has no message"],
    ['{"wakes":[{"message":" "}]}', "wakes[0] has no message"],
    ['{"wakes":[{"message":"m","session":" "}]}', "wakes[0].session"],
    ['{"wakes":[{"message":"m","session":3}]}', "wakes[0].session"],
    ['{"wakes":[{"message":"m","done":[]}]}', "wakes[0].done"],
    ['{"wakes":[{"message":"m","done":"x"}]}', "wakes[0].done"],
    ['{"wakes":[{"message":"m","done":[1]}]}', "wakes[0].done"],
  ])("refuses %s", (stdout, message) => {
    expect(() => parseWakeOutput(stdout)).toThrow(message)
  })
})

describe("runCommand", () => {
  it("runs an argv with no shell and returns what it printed", async () => {
    expect(await runCommand([process.execPath, "-e", "process.stdout.write('$HOME;ok')"], 10_000)).toEqual({ ok: true, stdout: "$HOME;ok", error: null })
  })

  it("names a non-zero exit by its program and first stderr line, a missing program and a timeout", async () => {
    const failed = await runCommand([process.execPath, "-e", "console.error('first\\nsecond'); process.exit(3)"], 10_000)
    expect(failed).toMatchObject({ ok: false, error: expect.stringMatching(/^node failed: first$/) })
    const silent = await runCommand([process.execPath, "-e", "process.exit(2)"], 10_000)
    expect(silent.error).toMatch(/^node failed: Command failed/)
    expect((await runCommand(["/nonexistent/program"], 10_000)).error).toMatch(/^program failed: .*ENOENT/)
    expect((await runCommand([process.execPath, "-e", "setTimeout(() => {}, 5000)"], 100)).ok).toBe(false)
  })
})

describe("runWakeRunner", () => {
  it("delivers each wake to its session, falling back to the runner's, and reports each delivery", async () => {
    const w = world({ wakes: [{ message: "one", session: "other", done: ["/bin/drains", "ack", "1"] }, { message: "two", done: ["/bin/drains", "ack", "2"] }], status: ["issue drain a/b -> other: polled just now"] })
    const state = await w.go()
    expect(w.sent).toEqual([["other", "one"], [RUNNER.session, "two"]])
    expect(w.reports).toEqual([["/bin/drains", "ack", "1"], ["/bin/drains", "ack", "2"]])
    expect(state).toEqual({
      lastRunAt: new Date(NOW).toISOString(), lastWakes: 2, lastDelivered: 2, status: ["issue drain a/b -> other: polled just now"],
      open: { other: { at: new Date(NOW).toISOString(), message: "one" }, [RUNNER.session]: { at: new Date(NOW).toISOString(), message: "two" } },
    })
  })

  it("delivers a wake immediately unless the runner asks for it to wait, so a session that never goes idle still hears of new work", async () => {
    const w = world({ wakes: [{ message: "one" }] })
    await w.go()
    expect(w.send).toHaveBeenLastCalledWith(RUNNER.session, "one", "immediate")
    await runWakeRunner({ ...RUNNER, delivery: "enqueue" }, w.deps())
    expect(w.send).toHaveBeenLastCalledWith(RUNNER.session, "one", "enqueue")
  })

  it("holds a new wake while the last one sent to the session has not reached it, so queued news never stacks up in the app", async () => {
    const w = world({ wakes: [{ message: "first", done: ["/bin/drains", "ack", "1"] }] })
    const first = await w.go()
    w.output = printed({ wakes: [{ message: "second", done: ["/bin/drains", "ack", "2"] }] })
    const second = await w.go(first, NOW + 300_000)
    expect(w.sent).toEqual([[RUNNER.session, "first"]])
    expect(w.reports[1]).toEqual(["/bin/drains", "ack", "2", "--error", "held: the wake sent 5 min ago has not reached the session yet"])
    expect(second).toMatchObject({ lastDelivered: 0, open: { [RUNNER.session]: { message: "first" } }, lastError: expect.stringContaining("held:") })
    // The first wake lands: the next run sends the current one, and records it as the one in flight.
    w.delivered.add("first")
    const third = await w.go(second, NOW + 600_000)
    expect(w.sent).toEqual([[RUNNER.session, "first"], [RUNNER.session, "second"]])
    expect(third.open).toEqual({ [RUNNER.session]: { at: new Date(NOW + 600_000).toISOString(), message: "second" } })
    // Delivered and nothing new to say: nothing is held any more.
    w.delivered.add("second")
    w.output = printed({ wakes: [] })
    expect((await w.go(third, NOW + 900_000)).open).toBeUndefined()
  })

  it("takes a wake that never shows up as lost after the hold, and holds each session on its own", async () => {
    const w = world({ wakes: [{ message: "a", session: "s1" }] })
    const first = await w.go()
    w.output = printed({ wakes: [{ message: "b", session: "s1" }, { message: "c", session: "s2" }] })
    const held = await w.go(first, NOW + 60_000)
    expect(w.sent.map(([session]) => session)).toEqual(["s1", "s2"])
    expect(held.open).toMatchObject({ s1: { message: "a" }, s2: { message: "c" } })
    w.output = printed({ wakes: [{ message: "d", session: "s1" }] })
    const later = await w.go(held, NOW + WAKE_HOLD_MS + 1000)
    expect(w.sent.at(-1)).toEqual(["s1", "d"])
    expect(later.open?.s1?.message).toBe("d")
  })

  it("keeps what is in flight when the command fails", async () => {
    const w = world({ wakes: [{ message: "a" }] })
    const first = await w.go()
    w.output = { ok: false, stdout: "", error: "drains.js failed" }
    expect((await w.go(first, NOW + 1000)).open).toEqual(first.open)
  })

  it("delivers nothing and reports nothing when there are no wakes", async () => {
    const w = world({ wakes: [] })
    expect(await w.go()).toEqual({ lastRunAt: new Date(NOW).toISOString(), lastWakes: 0, lastDelivered: 0, status: [] })
    expect(w.send).not.toHaveBeenCalled()
  })

  it("reports a refused send with its reason, and a refusal with none, so the command keeps the wake", async () => {
    const w = world({ wakes: [{ message: "a", done: ["/bin/drains", "ack", "a"] }, { message: "b", done: ["/bin/drains", "ack", "b"] }] }, async (_s, message) => ({ ok: false, error: message === "a" ? "the app did not answer in time" : null }))
    const state = await w.go()
    expect(w.reports).toEqual([["/bin/drains", "ack", "a", "--error", "the app did not answer in time"], ["/bin/drains", "ack", "b", "--error", "the app refused the message"]])
    expect(state).toMatchObject({ lastDelivered: 0, lastError: "could not deliver a wake: the app did not answer in time" })
  })

  it("treats a send that throws as a failed wake, and keeps going with the next", async () => {
    let calls = 0
    const w = world({ wakes: [{ message: "a" }, { message: "b" }] }, async () => { if (calls++ === 0) throw new Error("socket closed"); return { ok: true, error: null } })
    expect(await w.go()).toMatchObject({ lastDelivered: 1, lastError: "could not deliver a wake: socket closed" })
  })

  it("fails a wake that names no session when the runner has none, without sending", async () => {
    const w = world({ wakes: [{ message: "a", done: ["/bin/drains", "ack", "a"] }] })
    const state = await runWakeRunner({ name: "drains", command: RUNNER.command }, w.deps())
    expect(w.send).not.toHaveBeenCalled()
    expect(w.reports).toEqual([["/bin/drains", "ack", "a", "--error", "the wake names no session and the runner has none"]])
    expect(state.lastError).toContain("names no session")
  })

  it("says when it cannot report a wake's delivery", async () => {
    const w = world({ wakes: [{ message: "a", done: ["/bin/drains", "ack", "a"] }] })
    w.reportResult = { ok: false, stdout: "", error: "drains.js failed: busy" }
    expect(await w.go()).toMatchObject({ lastDelivered: 1, lastError: "could not report a wake's delivery: drains.js failed: busy" })
    w.reportResult = { ok: false, stdout: "", error: null }
    expect((await w.go()).lastError).toBe("could not report a wake's delivery: the command failed")
  })

  it("delivers nothing when the command fails, prints no JSON or prints the wrong shape, and records why", async () => {
    const w = world({ wakes: [{ message: "a" }] })
    w.output = { ok: false, stdout: "", error: "drains.js failed: no token" }
    expect(await w.go()).toEqual({ lastRunAt: new Date(NOW).toISOString(), lastError: "drains.js failed: no token" })
    w.output = { ok: false, stdout: "", error: null }
    expect((await w.go()).lastError).toBe("the command failed")
    w.output = { ok: true, stdout: "oops", error: null }
    expect((await w.go()).lastError).toBe("the command did not print JSON")
    expect(w.send).not.toHaveBeenCalled()
  })
})

describe("runWakeRunners", () => {
  it("saves each runner's state, runs only the due ones, and forgets runners no longer configured", async () => {
    const run = vi.fn(async () => printed({ wakes: [], status: ["ok"] }))
    const deps = { run, send: async () => ({ ok: true, error: null }), delivered: () => false, now: NOW }
    const a = { name: "a", command: ["a"] }
    const b = { name: "b", command: ["b"] }
    await runWakeRunners(root, [a, b], deps)
    expect(Object.keys(readWakeRunnerStates(root))).toEqual(["a", "b"])
    run.mockClear()
    await runWakeRunners(root, [a, b], { ...deps, now: NOW + 1000 }, new Set(["b"]))
    expect(run.mock.calls.map(call => (call as unknown as string[][])[0])).toEqual([["b"]])
    expect(readWakeRunnerStates(root).a!.lastRunAt).toBe(new Date(NOW).toISOString())
    expect(readWakeRunnerStates(root).b!.lastRunAt).toBe(new Date(NOW + 1000).toISOString())
    await runWakeRunners(root, [b], deps, new Set())
    expect(Object.keys(readWakeRunnerStates(root))).toEqual(["b"])
    expect(readWakeRunnerStates(path.join(root, "missing"))).toEqual({})
  })
})

describe("sendWake", () => {
  it("sends with the delivery mode it is given", async () => {
    client.sendToAppSession.mockResolvedValue({ ok: false, error: "archived" })
    expect(await sendWake({ stateDir: "/s" })("sid", "hi", "immediate")).toEqual({ ok: false, error: "archived" })
    expect(client.sendToAppSession).toHaveBeenCalledWith("sid", "hi", { stateDir: "/s", delivery: "immediate" })
    await sendWake({ stateDir: "/s" })("sid", "hi", "enqueue")
    expect(client.sendToAppSession).toHaveBeenLastCalledWith("sid", "hi", { stateDir: "/s", delivery: "enqueue" })
  })
})

describe("wasDelivered", () => {
  it("asks the client whether the session's log shows the message", () => {
    client.messageDelivered.mockReturnValue(true)
    expect(wasDelivered({ stateDir: "/s" })("sid", "hi", 5)).toBe(true)
    expect(client.messageDelivered).toHaveBeenCalledWith("sid", "hi", 5, { stateDir: "/s" })
  })
})

describe("wakeRunnerStatusLines", () => {
  it("shows last run, wakes delivered and last error per runner, then the command's own lines", () => {
    const states: Record<string, WakeRunnerState> = {
      drains: { lastRunAt: new Date(NOW - 20_000).toISOString(), lastWakes: 1, lastDelivered: 1, status: ["issue drain a/b -> 58fbd57e: polled just now, 7 open, 0 waiting"] },
      slow: { lastRunAt: new Date(NOW - 4 * 3_600_000).toISOString(), lastWakes: 3, lastDelivered: 2, lastError: "could not deliver a wake: archived" },
      broken: { lastRunAt: new Date(NOW - 12 * 60_000).toISOString(), lastError: "the command did not print JSON" },
    }
    const runners = ["drains", "slow", "broken", "fresh"].map(name => ({ name, command: ["x"] }))
    expect(wakeRunnerStatusLines(runners, states, NOW)).toEqual([
      "wake runner drains: ran just now, 1/1 wake delivered",
      "issue drain a/b -> 58fbd57e: polled just now, 7 open, 0 waiting",
      "wake runner slow: ran 4h ago, 2/3 wakes delivered, last error: could not deliver a wake: archived",
      "wake runner broken: ran 12m ago, last error: the command did not print JSON",
      "wake runner fresh: not run yet",
    ])
  })
})
