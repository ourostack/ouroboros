import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  DRAIN_STALE_MS, isFolder, MERGED_TTL_MS, mergedCacheFile, parseDrains, parseHttp, readDrains, readMachine, readMergedToday, sourceFailed, startOfToday,
} from "../../../senses/app-sessions/digest-sources"
import type { RunCommand } from "../../../senses/app-sessions/wake-runner"
import type { RunFile } from "../../../senses/app-sessions/client"

const NOW = Date.parse("2026-11-15T22:00:00Z")
let dir: string
const bin = () => path.join(dir, "housesitter.mjs")

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-digest-sources-"))
  fs.writeFileSync(bin(), "")
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

const housesitter = (stdout: string, code = 0): { housesitterPaths: string[]; runFile: RunFile } => ({
  housesitterPaths: [bin()],
  runFile: async () => ({ code, stdout, stderr: "" }),
})

describe("readMachine", () => {
  it("reads the heartbeat, the last restart and resume, and the sessions the health watch found broken", async () => {
    const status = {
      result: { restarted_at: "2026-11-15T17:18:44Z" },
      resumer: { at: "2026-11-15T21:10:41Z" },
      recovery: { beat_age_s: 20, bad: null, watch: { sessions: { aaa: { title: "One", status: "ok" }, bbb: { title: "Two", status: "erroring" }, ccc: { status: "stuck busy" }, ddd: {}, eee: { title: "Handed off", status: "gone" }, fff: { status: "archived" }, ggg: { status: "oversize" } } } },
    }
    expect(await readMachine(housesitter(JSON.stringify(status)))).toEqual({
      installed: true, heartbeat: "ok", beatAgeS: 20, bad: null, restartedAt: "2026-11-15T17:18:44Z", resumedAt: "2026-11-15T21:10:41Z", watched: 7,
      watchBad: [{ id: "bbb", title: "Two", status: "erroring" }, { id: "ccc", title: "ccc", status: "stuck busy" }],
    })
  })

  it("calls a heartbeat that is old stale, one that names a problem bad, and a missing one unknown", async () => {
    expect((await readMachine(housesitter(JSON.stringify({ recovery: { beat_age_s: 400 } })))).heartbeat).toBe("stale")
    const bad = await readMachine(housesitter(JSON.stringify({ recovery: { beat_age_s: 5, bad: "the app's window does not answer" } })))
    expect(bad).toMatchObject({ heartbeat: "bad", bad: "the app's window does not answer" })
    expect((await readMachine(housesitter("{}"))).heartbeat).toBe("unknown")
    expect((await readMachine(housesitter("[]"))).watched).toBe(0)
  })

  it("says Housesitter is not on this Mac, and reports a status it could not read", async () => {
    expect(await readMachine({ housesitterPaths: ["/nonexistent/housesitter"], homeDir: dir })).toMatchObject({ installed: false, heartbeat: "unknown" })
    const failed = await readMachine(housesitter("not json", 2))
    expect(failed.error).toBeTruthy()
    expect(failed.installed).toBe(false)
  })
})

describe("parseDrains", () => {
  const poll = (repo: string, at: string, waiting = 0) => `issue drain ${repo} -> 58fbd57e: last ok poll ${at} (lag 1m), polled 1m ago, 23 open, ${waiting} waiting, last wake 2h ago (1 issue)`

  it("counts the drains that poll, the issues waiting, the relays and each account's quota", () => {
    const facts = parseDrains([
      "desk 3.2.174 (the launcher's own copy)",
      "quota arimendelow: 12214/15000 calls left, resets soon",
      poll("a/b", "2026-11-15T21:59:00Z", 2),
      poll("c/d", "2026-11-15T21:50:00Z"),
      "relay one (dispatch) a/b x.yml -> c/d: polled 43s ago",
    ], NOW)
    expect(facts).toEqual({ polling: 2, waiting: 2, relays: 1, stale: [], quota: ["arimendelow 12214/15000"] })
  })

  it("names a drain whose last good poll is old or unreadable", () => {
    const facts = parseDrains([poll("a/b", new Date(NOW - DRAIN_STALE_MS - 5 * 60_000).toISOString()), poll("c/d", "never")], NOW)
    expect(facts.stale).toEqual(["a/b: 20 min", "c/d: never polled"])
    expect(facts.polling).toBe(0)
  })
})

describe("readDrains", () => {
  const ok = (stdout: string): RunCommand => async () => ({ ok: true, stdout, error: null })

  it("reads nothing when no command is configured", async () => {
    expect(await readDrains(undefined, ok(""), NOW)).toBeNull()
  })

  it("runs the command and parses its status lines", async () => {
    const facts = await readDrains(["drains", "status"], ok(JSON.stringify({ status: ["relay x", 7] })), NOW)
    expect(facts).toMatchObject({ relays: 1, polling: 0 })
    expect((await readDrains(["drains"], ok("{}"), NOW))?.relays).toBe(0)
  })

  it("reports a command that failed or printed something else", async () => {
    expect((await readDrains(["drains"], async () => ({ ok: false, stdout: "", error: "drains failed: boom" }), NOW))?.error).toBe("drains failed: boom")
    expect((await readDrains(["drains"], async () => ({ ok: false, stdout: "", error: null }), NOW))?.error).toBe("the drains command failed")
    expect((await readDrains(["drains"], ok("nope"), NOW))?.error).toBe("the drains command did not print JSON")
  })
})

describe("parseHttp", () => {
  it("splits gh api -i output into status, ETag and body", () => {
    expect(parseHttp('HTTP/2.0 200 OK\r\nEtag: W/"abc"\r\nX-A: b\r\n\r\n{"x":1}\n')).toEqual({ status: 200, etag: 'W/"abc"', body: '{"x":1}' })
    expect(parseHttp("HTTP/2.0 304 Not Modified\r\nEtag: W/\"abc\"")).toEqual({ status: 304, etag: 'W/"abc"', body: "" })
    expect(parseHttp("garbage")).toEqual({ status: 0, etag: null, body: "" })
  })
})

describe("readMergedToday", () => {
  const account = { label: "personal", command: ["gh-runner", "personal"] }
  const answer = (items: unknown[], extra: Record<string, unknown> = {}, etag = 'W/"e1"'): string => `HTTP/2.0 200 OK\r\n${etag ? `Etag: ${etag}\r\n` : ""}\r\n${JSON.stringify({ total_count: 12, items, ...extra })}`
  const item = (n: number) => ({ number: n, title: `PR ${n}`, repository_url: "https://api.github.com/repos/ourostack/ouroboros" })
  const recording = (replies: Array<{ ok?: boolean; stdout: string; error?: string }>): RunCommand & { calls: string[][] } => {
    const calls: string[][] = []
    const run = (async (argv: string[]) => {
      calls.push(argv)
      const reply = replies.shift() ?? { stdout: "" }
      return { ok: reply.ok ?? true, stdout: reply.stdout, error: reply.error ?? null }
    }) as RunCommand & { calls: string[][] }
    run.calls = calls
    return run
  }

  it("counts today's merged pull requests, lists the first ones and asks for midnight in this time zone", async () => {
    const file = mergedCacheFile(dir)
    fs.rmSync(file, { force: true })
    const run = recording([{ stdout: answer([item(1), item(2)]) }])
    expect(await readMergedToday(account, run, file, NOW)).toEqual({ label: "personal", count: 12, prs: [{ repo: "ourostack/ouroboros", number: 1, title: "PR 1" }, { repo: "ourostack/ouroboros", number: 2, title: "PR 2" }] })
    expect(run.calls[0]!.slice(0, 3)).toEqual(["gh-runner", "personal", "api"])
    expect(decodeURIComponent(run.calls[0]!.at(-1)!)).toContain(`merged:>=${startOfToday(NOW)}`)
  })

  it("reuses a recent answer, then asks conditionally and keeps the cached list on a 304", async () => {
    const file = mergedCacheFile(dir)
    const run = recording([{ stdout: "HTTP/2.0 304 Not Modified\r\n\r\n" }])
    expect((await readMergedToday(account, run, file, NOW + 60_000)).count).toBe(12)
    expect(run.calls).toHaveLength(0)
    const later = NOW + MERGED_TTL_MS + 1
    expect((await readMergedToday(account, run, file, later)).count).toBe(12)
    expect(run.calls[0]).toContain('If-None-Match: W/"e1"')
  })

  it("reads a body with no total and an answer with no ETag", async () => {
    const file = path.join(dir, "no-etag.json")
    const run = recording([{ stdout: answer([{}], { total_count: undefined }, "") }])
    expect(await readMergedToday(account, run, file, NOW)).toEqual({ label: "personal", count: 1, prs: [{ repo: "", number: 0, title: "" }] })
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).personal.etag).toBeNull()
    const second = recording([{ stdout: "HTTP/2.0 200 OK\r\n\r\n{}" }])
    expect(await readMergedToday(account, second, file, NOW + MERGED_TTL_MS + 1)).toEqual({ label: "personal", count: 0, prs: [] })
    expect(second.calls[0]!.join(" ")).not.toContain("If-None-Match")
  })

  it("says so when GitHub did not answer or answered something that is not JSON, keeping the last count", async () => {
    const file = path.join(dir, "failing.json")
    const failed = await readMergedToday(account, recording([{ ok: false, stdout: "", error: "gh failed: no token" }]), file, NOW)
    expect(failed).toEqual({ label: "personal", count: 0, prs: [], error: "gh failed: no token" })
    expect((await readMergedToday(account, recording([{ stdout: "HTTP/2.0 502 Bad Gateway\r\n\r\n" }]), file, NOW)).error).toBe("GitHub answered 502")
    expect((await readMergedToday(account, recording([{ stdout: "" }]), file, NOW)).error).toBe("GitHub answered nothing")
    expect((await readMergedToday(account, recording([{ stdout: "HTTP/2.0 200 OK\r\n\r\nhtml" }]), file, NOW)).error).toBe("GitHub's answer was not JSON")
    fs.writeFileSync(file, JSON.stringify({ personal: { since: startOfToday(NOW), at: 0, etag: null, count: 5, prs: [] } }))
    expect(await readMergedToday(account, recording([{ stdout: "HTTP/2.0 500 x\r\n\r\n" }]), file, NOW)).toMatchObject({ count: 5, error: "GitHub answered 500" })
  })

  it("forgets yesterday's answer", async () => {
    const file = path.join(dir, "yesterday.json")
    fs.writeFileSync(file, JSON.stringify({ personal: { since: "2026-11-14T08:00:00Z", at: NOW, etag: "x", count: 99, prs: [] } }))
    const run = recording([{ stdout: answer([]) }])
    expect((await readMergedToday(account, run, file, NOW)).count).toBe(12)
    expect(run.calls[0]).not.toContain("If-None-Match: x")
  })
})

describe("small helpers", () => {
  it("startOfToday is local midnight, as a GitHub timestamp", () => {
    const start = new Date(startOfToday(NOW))
    expect(start.getTime()).toBeLessThanOrEqual(NOW)
    expect(NOW - start.getTime()).toBeLessThan(25 * 3_600_000)
    expect(startOfToday(NOW)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  })

  it("names a failed source in one short line", () => {
    expect(sourceFailed("drains", "boom")).toBe("drains: boom")
  })

  it("tells a folder from a missing one", () => {
    expect(isFolder(dir)).toBe(true)
    expect(isFolder(path.join(dir, "missing"))).toBe(false)
  })
})
