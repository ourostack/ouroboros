import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const gh = vi.hoisted(() => ({ spawnSync: vi.fn() }))
vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), spawnSync: gh.spawnSync }))
const client = vi.hoisted(() => ({ sendToAppSession: vi.fn() }))
vi.mock("../../../senses/app-sessions/client", () => client)

import { emitNervesEvent } from "../../../nerves/runtime"
import {
  connectGithub, DRAIN_STATUS_MARKER, pollDrain, pollIssueDrains, sendWake, wakeMessage,
  type GhComment, type GhIssue, type GithubApi,
} from "../../../senses/app-sessions/issue-drains"
import { drainStatusLines, readDrainStates, type DrainState } from "../../../senses/app-sessions/issue-drain-state"

const DRAIN = { repo: "ourostack/desk", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "arimendelow" }
const NOW = Date.parse("2026-11-13T06:00:00Z")
let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "issue-drains-"))
  // Required by the nerves audit: every test emits at least one event, including the pure ones.
  emitNervesEvent({ component: "senses", event: "senses.issue_drain_test_marker", message: "issue-drains test" })
})
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); vi.unstubAllGlobals() })

const issue = (number: number, updated_at: string, title = `Issue ${number}`): GhIssue => ({ number, title, updated_at })

function world(issues: GhIssue[], comments: Record<number, GhComment[]> = {}) {
  const api: GithubApi = {
    login: "arimendelow",
    openIssues: vi.fn(async () => issues),
    comments: vi.fn(async (_repo, n) => comments[n] ?? []),
  }
  const connect = vi.fn(async () => api)
  const send = vi.fn(async () => ({ ok: true, error: null as string | null }))
  const states: Record<string, DrainState> = {}
  const poll = (at = NOW) => pollDrain(DRAIN, states, () => undefined, { connect, send, now: at })
  return { api, connect, send, states, poll, issues }
}

describe("pollDrain", () => {
  it("records what is already open on the first poll without waking anyone", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z"), issue(2, "2026-11-13T02:00:00Z")])
    await w.poll()
    expect(w.send).not.toHaveBeenCalled()
    expect(w.states[DRAIN.repo]).toMatchObject({ seeded: true, openCount: 2, pending: [], seen: { 1: "2026-11-13T01:00:00Z", 2: "2026-11-13T02:00:00Z" } })
  })

  it("wakes once per new or changed issue revision and never again for the same one", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(1)
    expect(w.send).toHaveBeenCalledWith(DRAIN.session, "New or changed issues in ourostack/desk: #2 New thing. Drain them.")
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(1)
    w.issues[0] = issue(1, "2026-11-13T04:00:00Z", "Issue 1")
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(2)
    expect(w.states[DRAIN.repo]).toMatchObject({ pending: [], lastWakeCount: 1, lastWakeAt: new Date(NOW).toISOString() })
  })

  it("batches every change from one poll into a single message, and drops closed issues from the seen markers", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z"), issue(9, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues.splice(0, 2, issue(1, "2026-11-13T05:00:00Z", "One\nwith\nlines"), issue(3, "2026-11-13T05:01:00Z"), issue(4, "2026-11-13T05:02:00Z"))
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(1)
    expect(w.send).toHaveBeenCalledWith(DRAIN.session, "New or changed issues in ourostack/desk: #1 One with lines, #3 Issue 3, #4 Issue 4. Drain them.")
    expect(Object.keys(w.states[DRAIN.repo]!.seen)).toEqual(["1", "3", "4"])
  })

  it("does not wake for the drain's own status comment, matched by marker, author and revision", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues[0] = issue(1, "2026-11-13T02:00:00Z")
    ;(w.api.comments as ReturnType<typeof vi.fn>).mockResolvedValue([
      { body: `Triaged.\n${DRAIN_STATUS_MARKER}`, updated_at: "2026-11-13T02:00:00Z", user: { login: "ArimenDelow" } },
    ])
    await w.poll()
    expect(w.send).not.toHaveBeenCalled()
    expect(w.api.comments).toHaveBeenCalledWith(DRAIN.repo, 1, "2026-11-13T01:00:00Z")
    expect(w.states[DRAIN.repo]!.seen["1"]).toBe("2026-11-13T02:00:00Z")
  })

  it.each([
    ["a comment by the same account without the marker", [{ body: "Ari says hi", updated_at: "2026-11-13T02:00:00Z", user: { login: "arimendelow" } }]],
    ["a marked comment by someone else", [{ body: DRAIN_STATUS_MARKER, updated_at: "2026-11-13T02:00:00Z", user: { login: "someone" } }]],
    ["a comment with no author", [{ body: DRAIN_STATUS_MARKER, updated_at: "2026-11-13T02:00:00Z" }]],
    ["an external comment beside the status comment", [
      { body: "me too", updated_at: "2026-11-13T01:30:00Z", user: { login: "someone" } },
      { body: DRAIN_STATUS_MARKER, updated_at: "2026-11-13T02:00:00Z", user: { login: "arimendelow" } },
    ]],
    ["a status comment that is not the newest change", [{ body: DRAIN_STATUS_MARKER, updated_at: "2026-11-13T01:30:00Z", user: { login: "arimendelow" } }]],
    ["a change with no comment at all (label, title, state)", []],
    ["a comment that predates the last marker", [{ body: DRAIN_STATUS_MARKER, updated_at: "2026-11-13T01:00:00Z", user: { login: "arimendelow" } }]],
  ])("still wakes for %s", async (_name, comments) => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues[0] = issue(1, "2026-11-13T02:00:00Z")
    ;(w.api.comments as ReturnType<typeof vi.fn>).mockResolvedValue(comments)
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it("an authentication or network failure wakes no one and leaves every marker and pending event alone", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues[0] = issue(1, "2026-11-13T02:00:00Z")
    const before = structuredClone(w.states[DRAIN.repo]!)
    w.connect.mockRejectedValueOnce(new Error("the GitHub CLI has no token for arimendelow"))
    await w.poll(NOW + 1000)
    expect(w.send).not.toHaveBeenCalled()
    expect(w.states[DRAIN.repo]).toEqual({ ...before, lastPollAt: new Date(NOW + 1000).toISOString(), lastError: "the GitHub CLI has no token for arimendelow" })
    ;(w.api.openIssues as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("GitHub answered HTTP 502"))
    await w.poll(NOW + 2000)
    expect(w.send).not.toHaveBeenCalled()
    expect(w.states[DRAIN.repo]).toMatchObject({ seen: before.seen, lastError: "GitHub answered HTTP 502" })
    await w.poll(NOW + 3000)
    expect(w.send).toHaveBeenCalledTimes(1)
    expect(w.states[DRAIN.repo]!.lastError).toBeUndefined()
  })

  it("a failure on the very first poll leaves the drain unseeded, so the next good poll still records without waking", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    w.connect.mockRejectedValueOnce(new Error("GitHub answered HTTP 401 for /user"))
    await w.poll()
    expect(w.states[DRAIN.repo]).toMatchObject({ seeded: false, seen: {}, pending: [], lastError: "GitHub answered HTTP 401 for /user" })
    expect(w.states[DRAIN.repo]!.openCount).toBeUndefined()
    await w.poll()
    expect(w.send).not.toHaveBeenCalled()
    expect(w.states[DRAIN.repo]).toMatchObject({ seeded: true, openCount: 1 })
  })

  it("a failure while reading comments leaves the markers where they were", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z"), issue(2, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues.splice(0, 2, issue(1, "2026-11-13T02:00:00Z"), issue(2, "2026-11-13T02:00:00Z"))
    ;(w.api.comments as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("GitHub answered HTTP 403"))
    await w.poll()
    expect(w.send).not.toHaveBeenCalled()
    expect(w.states[DRAIN.repo]!.seen).toEqual({ 1: "2026-11-13T01:00:00Z", 2: "2026-11-13T01:00:00Z" })
    await w.poll()
    expect(w.send).toHaveBeenCalledTimes(1)
  })

  it("keeps recorded events when the wake is refused, then sends them with the next poll's changes in one message", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues[0] = issue(1, "2026-11-13T02:00:00Z")
    w.send.mockResolvedValueOnce({ ok: false, error: "the app did not answer in time" })
    await w.poll()
    expect(w.states[DRAIN.repo]).toMatchObject({ pending: [{ number: 1, title: "Issue 1", updatedAt: "2026-11-13T02:00:00Z" }], lastError: "could not wake the drain: the app did not answer in time" })
    w.issues[0] = issue(1, "2026-11-13T03:00:00Z")
    w.issues.push(issue(2, "2026-11-13T03:00:00Z"))
    await w.poll()
    expect(w.send).toHaveBeenLastCalledWith(DRAIN.session, "New or changed issues in ourostack/desk: #1 Issue 1, #2 Issue 2. Drain them.")
    expect(w.states[DRAIN.repo]).toMatchObject({ pending: [], lastWakeCount: 2 })
  })

  it("treats a send that throws, or a refusal with no reason, as a failed wake", async () => {
    const w = world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll()
    w.issues[0] = issue(1, "2026-11-13T02:00:00Z")
    w.send.mockRejectedValueOnce(new Error("socket closed"))
    await w.poll()
    expect(w.states[DRAIN.repo]!.lastError).toBe("could not wake the drain: socket closed")
    w.send.mockResolvedValueOnce({ ok: false, error: null })
    await w.poll()
    expect(w.states[DRAIN.repo]!.lastError).toBe("could not wake the drain: the app refused the message")
    expect(w.states[DRAIN.repo]!.pending).toHaveLength(1)
  })
})

describe("wakeMessage", () => {
  it("shortens long titles and long lists", () => {
    const events = Array.from({ length: 22 }, (_, i) => ({ number: i + 1, title: i === 0 ? "x".repeat(200) : "t", updatedAt: "u" }))
    const text = wakeMessage("a/b", events)
    expect(text).toContain(`#1 ${"x".repeat(119)}…, #2 t`)
    expect(text).toMatch(/#20 t, and 2 more\. Drain them\.$/)
  })
})

describe("pollIssueDrains", () => {
  it("persists state across runs, one message per repository, and forgets repositories no longer configured", async () => {
    const other = { repo: "ourostack/ouro-ui", session: "9fd90fff-2ae7-4f49-8356-bd8c0b66d6db" }
    let updated = "2026-11-13T01:00:00Z"
    const connect = vi.fn(async (): Promise<GithubApi> => ({ login: "x", openIssues: async repo => [issue(repo === DRAIN.repo ? 1 : 7, updated)], comments: async () => [] }))
    const send = vi.fn(async () => ({ ok: true, error: null }))
    await pollIssueDrains(root, [DRAIN, other], { connect, send, now: NOW })
    expect(send).not.toHaveBeenCalled()
    updated = "2026-11-13T02:00:00Z"
    await pollIssueDrains(root, [DRAIN, other], { connect, send, now: NOW })
    expect(send.mock.calls.map(call => call[0])).toEqual([DRAIN.session, other.session])
    await pollIssueDrains(root, [DRAIN], { connect, send, now: NOW })
    expect(Object.keys(readDrainStates(root))).toEqual([DRAIN.repo])
  })

  it("reads no state when none was written", () => {
    expect(readDrainStates(root)).toEqual({})
  })
})

describe("connectGithub", () => {
  const response = (body: unknown, init: { status?: number; link?: string } = {}) => ({
    ok: (init.status ?? 200) < 400, status: init.status ?? 200, json: async () => body, headers: { get: () => init.link ?? null },
  })

  it("lists open issues without pull requests across pages, and reads comments since a time, with the account's token", async () => {
    gh.spawnSync.mockReturnValue({ status: 0, stdout: "tok\n" })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response([{ ...issue(1, "u1") }, { ...issue(2, "u2"), pull_request: {} }], { link: '<next>; rel="next"' }))
      .mockResolvedValueOnce(response([issue(3, "u3")]))
      .mockResolvedValueOnce(response([{ body: "c", updated_at: "u" }]))
    vi.stubGlobal("fetch", fetchMock)
    const api = await connectGithub("arimendelow")
    expect(gh.spawnSync).toHaveBeenCalledWith("gh", ["auth", "token", "--hostname", "github.com", "--user", "arimendelow"], expect.objectContaining({ encoding: "utf8" }))
    expect(api.login).toBe("arimendelow")
    expect((await api.openIssues("o/r")).map(item => item.number)).toEqual([1, 3])
    expect(fetchMock.mock.calls[0]![0]).toBe("https://api.github.com/repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100&page=1")
    expect(fetchMock.mock.calls[1]![0]).toContain("&page=2")
    expect(fetchMock.mock.calls[0]![1].headers.Authorization).toBe("Bearer tok")
    expect(await api.comments("o/r", 5, "2026-11-13T01:00:00Z")).toEqual([{ body: "c", updated_at: "u" }])
    expect(fetchMock.mock.calls[2]![0]).toBe("https://api.github.com/repos/o/r/issues/5/comments?since=2026-11-13T01%3A00%3A00Z&per_page=100&page=1")
  })

  it("asks GitHub who the active account is when none is configured", async () => {
    gh.spawnSync.mockReturnValue({ status: 0, stdout: "tok" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ login: "ari" })).mockResolvedValueOnce(response({})))
    expect((await connectGithub(undefined)).login).toBe("ari")
    expect(gh.spawnSync.mock.calls[0]![1]).toEqual(["auth", "token", "--hostname", "github.com"])
    expect((await connectGithub(undefined)).login).toBe("")
  })

  it("fails with a fix when the CLI has no token, and names the HTTP status without the query when GitHub refuses", async () => {
    gh.spawnSync.mockReturnValue({ status: 1, stdout: "" })
    await expect(connectGithub("nobody")).rejects.toThrow("no token for nobody (run `gh auth login --hostname github.com`)")
    await expect(connectGithub(undefined)).rejects.toThrow("its active account")
    gh.spawnSync.mockReturnValue({ status: 0 })
    await expect(connectGithub("nobody")).rejects.toThrow("no token")
    gh.spawnSync.mockReturnValue({ status: 0, stdout: "tok" })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response({ login: "x" })).mockResolvedValue(response({}, { status: 403 })))
    const ok = await connectGithub(undefined)
    await expect(ok.openIssues("o/r")).rejects.toThrow("GitHub answered HTTP 403 for /repos/o/r/issues")
  })
})

describe("sendWake", () => {
  it("queues behind the drain's current work", async () => {
    client.sendToAppSession.mockResolvedValue({ ok: false, error: "archived" })
    expect(await sendWake({ stateDir: "/s" })("sid", "hi")).toEqual({ ok: false, error: "archived" })
    expect(client.sendToAppSession).toHaveBeenCalledWith("sid", "hi", { stateDir: "/s", delivery: "enqueue" })
  })
})

describe("drainStatusLines", () => {
  const drains = [DRAIN, { repo: "gim-home/CIT", session: "48a0f0ab-56ad-406d-8831-5352815be337" }, { repo: "a/b", session: "12345678-0000" }]
  it("shows last poll, open count, events waiting, last wake and last error per drain", () => {
    const states: Record<string, DrainState> = {
      [DRAIN.repo]: { seeded: true, seen: {}, pending: [{ number: 1, title: "t", updatedAt: "u" }], lastPollAt: new Date(NOW - 20_000).toISOString(), openCount: 7, lastWakeAt: new Date(NOW - 12 * 60_000).toISOString(), lastWakeCount: 1, lastError: "GitHub answered HTTP 502" },
      "gim-home/CIT": { seeded: true, seen: {}, pending: [], lastPollAt: new Date(NOW - 4 * 3_600_000).toISOString(), lastWakeAt: new Date(NOW - 3 * 60 * 60_000).toISOString(), lastWakeCount: 3 },
    }
    expect(drainStatusLines(drains, states, NOW)).toEqual([
      "issue drain ourostack/desk -> 58fbd57e: polled just now, 7 open, 1 waiting, last wake 12m ago (1 issue), last error: GitHub answered HTTP 502",
      "issue drain gim-home/CIT -> 48a0f0ab: polled 4h ago, ? open, 0 waiting, last wake 3h ago (3 issues)",
      "issue drain a/b -> 12345678: not polled yet",
    ])
  })

  it("says never when a drain was not woken yet", () => {
    const states = { [DRAIN.repo]: { seeded: true, seen: {}, pending: [], lastPollAt: new Date(NOW).toISOString(), openCount: 0 } }
    expect(drainStatusLines([DRAIN], states, NOW)[0]).toBe("issue drain ourostack/desk -> 58fbd57e: polled just now, 0 open, 0 waiting, last wake never")
  })
})
