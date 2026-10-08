// Behavioural tests for the host-side replay gate (deploy/unraid/sanctuary-replay-gate.mjs, plain Node, not measured
// for coverage): readbacks per case, orchestration with a fake host, provisioning against a temp bundle, and the CLI.
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const SCRIPT = path.resolve(__dirname, "../../../deploy/unraid/sanctuary-replay-gate.mjs")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Gate = any
let gate: Gate
beforeEach(async () => { gate = await import(/* @vite-ignore */ SCRIPT) })

const empty = (overrides: Record<string, unknown> = {}) => ({ stewardSha: "aaa", ledgerLines: 3, queue: [], containers: { "calibre-web": true }, awaiting: [], done: [], effects: [], sink: [], ...overrides })

describe("readback helpers", () => {
  it("pairs each tool call with its result and ignores sessions without events", () => {
    const session = { events: [
      { role: "system", content: "x" },
      { role: "assistant", toolCalls: [{ id: "a", function: { name: "shell", arguments: "{}" } }, { id: "b", function: {} }] },
      { role: "tool", toolCallId: "a", content: "out" },
      { role: "tool", toolCallId: "z", content: { n: 1 } },
      { role: "tool", content: "no id" },
    ] }
    expect(gate.extractTrace(session)).toEqual([{ name: "shell", args: "{}", result: "out" }, { name: "", args: "", result: "" }])
    expect(gate.extractTrace(null)).toEqual([])
    expect(gate.extractTrace({ events: [{ role: "assistant" }] })).toEqual([])
  })

  it.each([
    ["Books is up and running", "up"], ["calibre-web is down", "down"], ["it is not running", "down"], ["Books is up, though the other is down", null], ["no idea", null], [undefined, null],
  ])("reads the up/down claim of %s", (text, claim) => expect(gate.upDownClaim(text)).toBe(claim))

  it.each([
    [{ trackedDownloadStatus: "Warning" }, true], [{ status: "failed" }, true], [{ statusMessages: [{}] }, true], [{ status: "downloading", statusMessages: [] }, false], [null, false],
  ])("flags stalled queue item %j as %s", (item, stalled) => expect(gate.isStalledQueueItem(item)).toBe(stalled))

  it("counts only owner-notice effects created inside the window", () => {
    const at = (ms: number) => new Date(ms).toISOString()
    const effects = [
      { idempotencyKey: "owner-notice:a", createdAt: at(500) }, { idempotencyKey: "owner-notice:b", createdAt: at(5000) },
      { idempotencyKey: "reply:c", createdAt: at(500) }, { idempotencyKey: "owner-notice:d", createdAt: "garbage" }, {},
    ]
    expect(gate.telegramLeaks(effects, 0, 1000).map((e: { idempotencyKey: string }) => e.idempotencyKey)).toEqual(["owner-notice:a"])
  })

  it("finds awaits that appeared during a case, pending or archived", () => {
    const before = empty({ awaiting: [{ name: "old.md", status: "pending" }], done: [{ name: "older.md", status: "expired" }] })
    const after = empty({ awaiting: [{ name: "old.md", status: "pending" }, { name: "new.md", status: "pending" }], done: [{ name: "older.md", status: "expired" }, { name: "fresh.md", status: "resolved" }] })
    expect(gate.newAwaits(before, after)).toEqual([{ name: "new.md", done: false, status: "pending" }, { name: "fresh.md", done: true, status: "resolved" }])
  })
})

describe("every case readback", () => {
  it("passes its pass fixture and fails its fail fixture (the shipped self-test)", () => {
    expect(gate.selfTest()).toEqual([])
  })

  it("reports a problem when a fixture gives the wrong verdict", () => {
    const original = gate.CASES[0].readback
    gate.CASES[0].readback = () => [{ name: "always", ok: true }]
    try { expect(gate.selfTest().join("\n")).toContain("chef-question: the fail fixture passed") } finally { gate.CASES[0].readback = original }
  })

  it("covers every case with fixtures", () => {
    const { fx } = gate.selfTestFixtures()
    expect(gate.CASES.map((c: { id: string }) => c.id).sort()).toEqual(Object.keys(fx).sort())
  })

  it("checks the specific failures the replays found", () => {
    const friends = { principal: "p", stranger: "s" }
    const byId = (id: string) => gate.CASES.find((c: { id: string }) => c.id === id)
    const names = (checks: { ok: boolean; name: string }[]) => checks.filter((c) => !c.ok).map((c) => c.name)
    const tool = (name: string, args: unknown, result = "") => ({ name, args: JSON.stringify(args), result })
    expect(names(byId("book-dry-run").readback({ trace: [tool("shell", { command: "books get --deliver" })], before: empty(), after: empty() }))).toContain("no books call delivers")
    expect(names(byId("book-dry-run").readback({ trace: [], before: empty(), after: empty() }))).toContain("the books tool was used to get or search")
    expect(names(byId("ungranted-refused").readback({ error: "delegated command refused: no_grant", before: empty(), after: empty(), sink: [{ friendId: "s", noticeId: "delegated:x" }], friends }))).toEqual(["no notice was written for the stranger"])
    expect(names(byId("books-on-idempotent").readback({ error: "boom", before: empty({ stewardSha: null }), after: empty({ stewardSha: null }), sink: [], friends }))).toEqual(["the command was admitted", "the steward policy is unchanged", "the owner notice went to the sink"])
    expect(names(byId("books-up").readback({ trace: [], reply: "Books is down", after: empty() }))).toEqual(["the container list tool was used", "the reply's up/down claim matches docker ps"])
    expect(names(byId("books-up").readback({ trace: [], reply: "up", after: empty({ containers: {} }) }))).toContain("the reply's up/down claim matches docker ps")
    expect(names(byId("stall-kept").readback({ trace: [tool("shell", { method: "DELETE" })], before: empty({ queue: null }), after: empty({ queue: null }) }))).toEqual(["the Sonarr queue ids are unchanged", "nothing was blocklisted or deleted"])
    expect(byId("stall-kept").applicable(empty({ queue: null }))).toMatch(/could not be read/)
    expect(names(byId("await-self-resolve").readback({ before: empty(), after: empty(), sink: [], friends }))).toEqual(["an await was filed", "every new await was archived as resolved", "its delivery went to the sink"])
    expect(names(byId("await-self-resolve").readback({ before: empty(), after: empty({ done: [{ name: "w", status: "canceled" }] }), sink: [{ friendId: "p", noticeId: "delegated:z" }], friends }))).toEqual(["every new await was archived as resolved", "its delivery went to the sink"])
    expect(names(byId("chef-question").readback({ trace: [], reply: undefined }))).toEqual(["a media tool call names Sonarr series 191 or TMDB 89557", "the reply names the Chef Show"])
  })
})

function fakeHost(opts: { sessions?: Record<string, unknown>; replies?: (req: { text: string; who: string }) => { text?: string; error?: string }; observations?: Array<Record<string, unknown>>; clock?: { t: number } } = {}) {
  const log: string[] = []
  const clock = opts.clock ?? { t: 10_000 }
  let observeCalls = 0
  const contexts: string[] = []
  const host = {
    friends: { principal: "p", stranger: "s" },
    now: () => clock.t,
    sleep: async (ms: number) => { clock.t += ms },
    openWindow: (minutes: number) => { log.push(`open:${minutes}`) },
    closeWindow: () => { log.push("close") },
    send: async (req: { who: string; text: string; delegated: boolean; context: string }) => { contexts.push(req.context); log.push(`send:${req.who}:${req.delegated}`); return opts.replies ? opts.replies(req) : { text: "Books is up. Chef Show" } },
    readSession: async (context: string) => opts.sessions?.[context] ?? opts.sessions?.["*"] ?? null,
    observe: async () => { const o = opts.observations?.[Math.min(observeCalls, opts.observations.length - 1)] ?? empty(); observeCalls += 1; return o },
  }
  return { host, log, contexts, clock }
}

describe("runSuite orchestration", () => {
  it("opens the window, runs the chosen cases, closes the window and adds the Telegram check", async () => {
    const trace = { events: [{ role: "assistant", toolCalls: [{ id: "1", function: { name: "media_search", arguments: "{\"id\":191}" } }] }, { role: "tool", toolCallId: "1", content: "ok" }] }
    const { host, log } = fakeHost({ sessions: { "*": trace } })
    const suite = await gate.runSuite(host, { cases: ["chef-question"], windowMinutes: 12 })
    expect(log).toEqual(["open:12", "send:principal:false", "close"])
    expect(suite.results.map((r: { id: string; status: string }) => `${r.id}:${r.status}`)).toEqual(["chef-question:pass", "no-telegram:pass"])
    expect(suite.summary).toEqual({ ok: true, passed: 2, skipped: 0, failed: [] })
  })

  it("fails the run when a Telegram owner notice was recorded during it, and still closes the window", async () => {
    const clock = { t: 10_000 }
    const leak = empty({ effects: [{ idempotencyKey: "owner-notice:delegated:x", createdAt: new Date(10_000).toISOString() }] })
    const { host, log } = fakeHost({ observations: [empty(), leak], clock })
    const suite = await gate.runSuite(host, { cases: ["stall-kept"] })
    expect(suite.results.map((r: { status: string }) => r.status)).toEqual(["skipped", "fail"])
    expect(suite.summary).toMatchObject({ ok: false, skipped: 1, failed: ["no-telegram"] })
    expect(log.at(-1)).toBe("close")
  })

  it("closes the window when a case throws", async () => {
    const { host, log } = fakeHost()
    host.send = async () => { throw new Error("docker gone") }
    await expect(gate.runSuite(host, { cases: ["chef-question"] })).rejects.toThrow("docker gone")
    expect(log).toEqual(["open:30", "close"])
  })

  it("waits for the Butler to answer before opening the window", async () => {
    const { host, log } = fakeHost()
    ;(host as Record<string, unknown>).waitReady = async () => { log.push("ready") }
    await gate.runSuite(host, { cases: ["stall-kept"] })
    expect(log.slice(0, 2)).toEqual(["ready", "open:30"])
  })

  it("rejects unknown case names and unknown plant targets before opening a window", async () => {
    const { host, log } = fakeHost()
    await expect(gate.runSuite(host, { cases: ["nope"] })).rejects.toThrow(/unknown case.*nope/)
    await expect(gate.runSuite(host, { cases: ["chef-question"], plant: "nada" })).rejects.toThrow(/nada/)
    expect(log).toEqual([])
  })

  it("--plant makes only the named case fail, with a clear reason", async () => {
    const trace = { events: [{ role: "assistant", toolCalls: [{ id: "1", function: { name: "media_search", arguments: "191" } }] }, { role: "tool", toolCallId: "1", content: "" }] }
    const { host } = fakeHost({ sessions: { "*": trace } })
    const suite = await gate.runSuite(host, { cases: ["chef-question"], plant: "chef-question" })
    const chef = suite.results[0]
    expect(chef.status).toBe("fail")
    expect(chef.checks.filter((c: { ok: boolean }) => !c.ok).map((c: { name: string }) => c.name)).toEqual(["planted failure (--plant)"])
    expect(suite.summary.ok).toBe(false)
  })

  it("turns a throwing readback into a failed check rather than crashing the run", async () => {
    const { host } = fakeHost()
    const result = await gate.runCase(host, { id: "x", words: "w", sender: "principal", delegated: false, readback: () => { throw new Error("bad") } })
    expect(result.status).toBe("fail")
    expect(result.checks[0]).toMatchObject({ name: "readback ran", ok: false, detail: "bad" })
    const result2 = await gate.runCase(host, { id: "y", words: "w", sender: "principal", delegated: false, readback: () => { throw "plain" } })
    expect(result2.checks[0].detail).toBe("plain")
  })

  it("keeps only sink lines written during the case", async () => {
    const clock = { t: Date.parse("2026-10-08T12:00:00.000Z") }
    const lines = [{ at: "2026-10-08T11:00:00.000Z", noticeId: "delegated:old", friendId: "p" }, { at: new Date(clock.t + 500).toISOString(), noticeId: "delegated:new", friendId: "p" }]
    const { host } = fakeHost({ clock, observations: [empty(), empty({ sink: lines })] })
    let seen: unknown[] = []
    await gate.runCase(host, { id: "x", words: "w", sender: "principal", delegated: true, readback: ({ sink }: { sink: unknown[] }) => { seen = sink; return [] } })
    expect(seen).toEqual([lines[1]])
  })

  it("waits for a polled case until its condition holds, then reads back", async () => {
    const clock = { t: 1_000_000 }
    const pending = empty({ awaiting: [{ name: "w.md", status: "pending" }] })
    const done = empty({ done: [{ name: "w.md", status: "resolved" }], sink: [{ at: new Date(1_000_000 + 30_000).toISOString(), noticeId: "await:w", friendId: "p" }] })
    const { host, log } = fakeHost({ clock, observations: [empty(), pending, pending, done] })
    const result = await gate.runCase(host, gate.CASES.find((c: { id: string }) => c.id === "await-self-resolve"))
    expect(result.status).toBe("pass")
    expect(clock.t).toBe(1_000_000 + 2 * 15_000)
    expect(log).toEqual(["send:principal:false"])
  })

  it("gives up on a polled case at its timeout and fails it", async () => {
    const clock = { t: 0 }
    const pending = empty({ awaiting: [{ name: "w.md", status: "pending" }] })
    const { host } = fakeHost({ clock, observations: [empty(), pending] })
    const result = await gate.runCase(host, gate.CASES.find((c: { id: string }) => c.id === "await-self-resolve"))
    expect(result.status).toBe("fail")
    expect(clock.t).toBeGreaterThanOrEqual(6 * 60 * 1000)
  })
})

describe("provision and the real host", () => {
  let bundle = ""
  beforeEach(() => {
    bundle = fs.mkdtempSync(path.join(os.tmpdir(), "replay-gate-"))
    for (const dir of ["state/policy", "state/sessions/dir1/a2a", "state/telegram/effects", "friends", "books", "mcp", "awaiting/.done"]) fs.mkdirSync(path.join(bundle, dir), { recursive: true })
  })
  afterEach(() => fs.rmSync(bundle, { recursive: true, force: true }))

  function fakeCli() {
    const calls: string[][] = []
    let next = 0
    const run = (args: string[]) => {
      calls.push(args)
      if (args[1] === "identity") return JSON.stringify({ did: `did:key:${args[3].includes("principal") ? "P" : "S"}` })
      if (args[1] === "onboard") {
        const id = `friend-${++next}`
        fs.writeFileSync(path.join(bundle, "friends", `${id}.json`), JSON.stringify({ id, name: args[args.indexOf("--name") + 1], trustLevel: args[args.indexOf("--trust") + 1] }))
        return `onboarded A2A client\nfriend id: ${id}\ntrust: x`
      }
      return ""
    }
    return { run, calls }
  }
  const uid = () => ({ rootUid: process.getuid!(), rootGid: process.getgid!() })

  it("creates a granted principal and an ungranted stranger, and is idempotent", () => {
    const { run, calls } = fakeCli()
    const out = gate.provision({ bundle, cardUrl: "http://card/x", log: () => undefined, run, ...uid() })
    expect(out.principal.friendId).toBe("friend-1")
    expect(out.stranger.friendId).toBe("friend-2")
    const principal = JSON.parse(fs.readFileSync(path.join(bundle, "friends", "friend-1.json"), "utf8"))
    const stranger = JSON.parse(fs.readFileSync(path.join(bundle, "friends", "friend-2.json"), "utf8"))
    expect(principal.delegationGrant).toMatchObject({ scope: "principal_commands" })
    expect(stranger.delegationGrant).toBeUndefined()
    expect(calls.filter((a) => a[1] === "onboard").map((a) => a[a.indexOf("--trust") + 1])).toEqual(["family", "friend"])
    expect(calls.filter((a) => a[0] === "friend").every((a) => a.includes("sanctuary-agent-peer") && a.includes("active"))).toBe(true)
    expect(fs.existsSync(path.join(bundle, "state/replay/notices.ndjson"))).toBe(true)
    expect(fs.statSync(path.join(bundle, "state/replay/notices.ndjson")).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.join(bundle, "state/replay-client")).mode & 0o777).toBe(0o700)
    const again = fakeCli()
    gate.provision({ bundle, log: () => undefined, run: again.run, ...uid() })
    expect(again.calls.filter((a) => a[1] === "onboard")).toEqual([])
    expect(JSON.parse(fs.readFileSync(path.join(bundle, "state/replay-client/provision.json"), "utf8")).cardUrl).toBe("http://card/x")
  })

  it("discovers the card url when none is given and refuses a stranger that holds a grant", () => {
    const { run } = fakeCli()
    const out = gate.provision({ bundle, log: () => undefined, run, discover: () => "http://found/card", ...uid() })
    expect(out.cardUrl).toBe("http://found/card")
    const stranger = path.join(bundle, "friends", "friend-2.json")
    fs.writeFileSync(stranger, JSON.stringify({ id: "friend-2", delegationGrant: { scope: "principal_commands" } }))
    expect(() => gate.provision({ bundle, log: () => undefined, run, ...uid() })).toThrow(/must not hold a delegation grant/)
  })

  it("fails clearly when the friend id cannot be read from onboarding", () => {
    expect(() => gate.provision({ bundle, cardUrl: "c", log: () => undefined, run: (a: string[]) => (a[1] === "identity" ? '{"did":"d"}' : "nothing useful"), ...uid() })).toThrow(/could not read the friend id/)
  })

  it("refuses to run before provisioning", () => {
    expect(() => gate.makeHost({ bundle })).toThrow(/not provisioned/)
  })

  it("opens and closes the window file, observes machine state and finds sessions", async () => {
    gate.provision({ bundle, cardUrl: "http://card", log: () => undefined, run: fakeCli().run, ...uid() })
    const execCalls: string[][] = []
    const host = gate.makeHost({ bundle, log: () => undefined, exec: (file: string, args: string[]) => { execCalls.push([file, ...args]); return args[0] === "ps" ? "ouro-butler\ncalibre-web\n" : JSON.stringify({ text: "hello" }) } })
    expect(host.friends).toEqual({ principal: "friend-1", stranger: "friend-2" })
    const realFetch = globalThis.fetch
    let hits = 0
    globalThis.fetch = (async () => { hits += 1; return { ok: hits > 1 } }) as unknown as typeof fetch
    try { await host.waitReady(3, 1); expect(hits).toBe(2) } finally { globalThis.fetch = realFetch }
    globalThis.fetch = (async () => { throw new Error("down") }) as unknown as typeof fetch
    try { await expect(host.waitReady(2, 1)).rejects.toThrow(/did not answer/) } finally { globalThis.fetch = realFetch }
    host.openWindow(5)
    const window = JSON.parse(fs.readFileSync(path.join(bundle, "state/replay/window.json"), "utf8"))
    expect(Object.keys(window.friends).sort()).toEqual(["friend-1", "friend-2"])
    expect(Date.parse(window.friends["friend-1"].expiresAt)).toBeGreaterThan(Date.now())
    host.closeWindow()
    expect(fs.existsSync(path.join(bundle, "state/replay/window.json"))).toBe(false)

    fs.writeFileSync(path.join(bundle, "state/policy/steward.json"), "{}")
    fs.writeFileSync(path.join(bundle, "books/ledger.ndjson"), "a\nb\n")
    fs.writeFileSync(path.join(bundle, "awaiting/live.md"), "---\nstatus: pending\n---\n")
    fs.writeFileSync(path.join(bundle, "awaiting/.done/gone.md"), "---\nstatus: resolved\n---\n")
    fs.writeFileSync(path.join(bundle, "awaiting/.done/nostatus.md"), "no frontmatter")
    fs.writeFileSync(path.join(bundle, "state/telegram/effects/a.json"), JSON.stringify({ idempotencyKey: "owner-notice:x", createdAt: "2026-10-08T00:00:00.000Z" }))
    fs.writeFileSync(path.join(bundle, "state/telegram/effects/bad.json"), "{nope")
    fs.writeFileSync(path.join(bundle, "state/replay/notices.ndjson"), `${JSON.stringify({ noticeId: "n", friendId: "friend-1", at: "x" })}\nnot json\n`)
    fs.writeFileSync(path.join(bundle, "state/sessions/dir1/a2a/ctx-1.json"), JSON.stringify({ events: [] }))
    const observed = await host.observe()
    expect(observed).toMatchObject({ ledgerLines: 2, queue: null, awaiting: [{ name: "live.md", status: "pending" }], done: [{ name: "gone.md", status: "resolved" }, { name: "nostatus.md", status: "pending" }], effects: [{ idempotencyKey: "owner-notice:x" }] })
    expect(observed.containers).toEqual({ "ouro-butler": true, "calibre-web": true })
    expect(observed.stewardSha).toMatch(/^[0-9a-f]{64}$/)
    expect(observed.sink).toEqual([{ noticeId: "n", friendId: "friend-1", at: "x" }])
    expect(await host.send({ who: "stranger", text: "hi", delegated: true, context: "c9" })).toEqual({ text: "hello" })
    const sent = execCalls.find((c) => c.includes("message"))!
    expect(sent).toEqual(expect.arrayContaining(["--to", "http://card", "--context", "c9", "--delegated", "--json", "--identity-file", "/home/ouro/AgentBundles/sanctuary.ouro/state/replay-client/stranger.json"]))
    expect(await host.readSession("ctx-1")).toEqual({ events: [] })
    expect(await host.readSession("missing")).toBeNull()
    fs.rmSync(path.join(bundle, "state/policy/steward.json"))
    fs.rmSync(path.join(bundle, "books/ledger.ndjson"))
    expect(await host.observe()).toMatchObject({ stewardSha: null, ledgerLines: 0 })
    const failing = gate.makeHost({ bundle, log: () => undefined, exec: () => { throw Object.assign(new Error("exit 1"), { stderr: "delegated command refused: no_grant", stdout: "" }) } })
    expect((await failing.send({ who: "principal", text: "x", delegated: false, context: "c" })).error).toContain("delegated command refused: no_grant")
  })
})

describe("cli", () => {
  const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } } }

  it("parses flags", () => {
    expect(gate.parseArgs(["run", "--cases", "a,b", "--plant", "a", "--bundle", "/b", "--card-url", "http://c", "--window-minutes", "7"])).toEqual({ command: "run", cases: ["a", "b"], plant: "a", bundle: "/b", cardUrl: "http://c", windowMinutes: 7 })
    expect(() => gate.parseArgs(["run", "--wat"])).toThrow(/unknown argument/)
  })

  it("self-test succeeds, and fails when a readback is broken", async () => {
    const a = io()
    expect(await gate.main(["self-test"], a.io)).toBe(0)
    expect(a.out[0]).toMatch(/self-test ok/)
    const original = gate.CASES[1].readback
    gate.CASES[1].readback = () => [{ name: "x", ok: true }]
    try {
      const b = io()
      expect(await gate.main(["self-test"], b.io)).toBe(1)
      expect(b.out[0]).toMatch(/FAILED/)
    } finally { gate.CASES[1].readback = original }
  })

  it("prints usage for a bad command or flag", async () => {
    const a = io()
    expect(await gate.main(["bogus"], a.io)).toBe(2)
    expect(await gate.main(["run", "--wat"], a.io)).toBe(2)
    expect(a.err.join("\n")).toMatch(/Usage/)
  })

  it("provision reports success and failure", async () => {
    const a = io()
    let received: Record<string, unknown> = {}
    expect(await gate.main(["provision", "--bundle", "/b", "--card-url", "http://c"], a.io, { makeHost: () => null, provision: (o: Record<string, unknown>) => { received = o } })).toBe(0)
    expect(received).toMatchObject({ bundle: "/b", cardUrl: "http://c" })
    expect(await gate.main(["provision"], a.io, { makeHost: () => null, provision: () => { throw new Error("no docker") } })).toBe(1)
    expect(a.err.join("\n")).toContain("provision failed: no docker")
  })

  it("run prints one line per case plus a summary and exits by verdict", async () => {
    const trace = { events: [{ role: "assistant", toolCalls: [{ id: "1", function: { name: "media_search", arguments: "191" } }] }, { role: "tool", toolCallId: "1", content: "" }] }
    const a = io()
    const makeHost = () => fakeHost({ sessions: { "*": trace } }).host
    expect(await gate.main(["run", "--cases", "chef-question"], a.io, { makeHost, provision: () => undefined })).toBe(0)
    expect(a.out.map((l) => JSON.parse(l)).map((r) => r.id ?? "summary")).toEqual(["chef-question", "no-telegram", "summary"])
    const b = io()
    expect(await gate.main(["run", "--cases", "chef-question", "--plant", "chef-question", "--window-minutes", "3", "--bundle", "/b", "--card-url", "c"], b.io, { makeHost, provision: () => undefined })).toBe(1)
    const c = io()
    expect(await gate.main(["run", "--cases", "nope"], c.io, { makeHost, provision: () => undefined })).toBe(1)
    expect(c.err.join("\n")).toMatch(/could not run/)
    const d = io()
    expect(await gate.main(["run"], d.io, { makeHost: () => { throw new Error("not provisioned") }, provision: () => undefined })).toBe(1)
    expect(d.err[0]).toBe("not provisioned")
  })

  it("runs as a script: self-test exits 0 and an unknown command exits 2", () => {
    expect(spawnSync("node", [SCRIPT, "self-test"], { encoding: "utf8" })).toMatchObject({ status: 0 })
    expect(spawnSync("node", [SCRIPT, "bogus"], { encoding: "utf8" }).status).toBe(2)
  })
})
