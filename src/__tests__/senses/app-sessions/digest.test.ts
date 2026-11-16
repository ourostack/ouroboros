import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest"
import type { AppSessionRow, RunFile } from "../../../senses/app-sessions/client"
import {
  buildDigest, CARD_WINDOW_MS, DIGEST_STALE_MS, digestFiles, EMPTY_DIGEST_STATE, expandHome, isStatusAsk, minutes, readDigestState, readDigestText,
  renderDigest, statusAnswer, writeDigest, type DigestInput, type DigestState,
} from "../../../senses/app-sessions/digest"
import type { RunCommand } from "../../../senses/app-sessions/wake-runner"
import { addArchiveLog } from "../../../senses/app-sessions/store"

const NOW = Date.parse("2026-11-15T22:00:00Z")
const iso = (minutesAgo: number): string => new Date(NOW - minutesAgo * 60_000).toISOString()
let root: string
let desk: string
let stateDir: string
let houseBin: string

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-digest-"))
  houseBin = path.join(root, "housesitter.mjs")
  fs.writeFileSync(houseBin, "")
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

let agentRoot: string
beforeEach(() => {
  agentRoot = fs.mkdtempSync(path.join(root, "agent-"))
  desk = fs.mkdtempSync(path.join(root, "desk-"))
  stateDir = fs.mkdtempSync(path.join(root, "app-"))
})
afterEach(() => undefined)

function row(id: string, name: string, state: AppSessionRow["state"], extra: Partial<AppSessionRow> = {}): AppSessionRow {
  return {
    id, name, kind: "workspace", workspaceId: null, workspaceType: null, project: null, projectId: null, sidebarPlacement: "unknown", state, detail: `${state} detail`,
    isRunning: state === "working", wasInterrupted: false, remote: false, updatedAt: iso(1), lastActivity: iso(1), ...extra,
  }
}

function card(track: string, slug: string, status: string, next = ""): void {
  fs.mkdirSync(path.join(desk, track, slug), { recursive: true })
  fs.writeFileSync(path.join(desk, track, slug, "task.md"), `---\ntitle: ${slug} title\nstatus: ${status}\n---\n${next ? `\n**Next step:** ${next}\n` : ""}`)
}

function declare(id: string, track: string, slug: string): void {
  const dir = path.join(stateDir, "session-state", id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify({ type: "assistant.message", data: { toolRequests: [{ name: "desk-task_focus", arguments: { track, slug } }] } })}\n`)
}

const housesitter = (status: unknown): { housesitterPaths: string[]; runFile: RunFile; stateDir: string } => ({
  stateDir, housesitterPaths: [houseBin], runFile: async () => ({ code: 0, stdout: JSON.stringify(status), stderr: "" }),
})

const healthy = { result: { restarted_at: iso(300) }, resumer: { at: iso(50) }, recovery: { beat_age_s: 12, bad: null, watch: { sessions: { s1: { title: "One", status: "ok" } } } } }

function input(rows: AppSessionRow[], extra: Partial<DigestInput> = {}): DigestInput {
  return {
    agentRoot, config: { deskRoots: [desk] }, client: housesitter(healthy), run: (async () => ({ ok: true, stdout: "{}", error: null })) as RunCommand, now: NOW, home: root,
    rows, appRunning: true, waitingPrompts: [], state: structuredClone(EMPTY_DIGEST_STATE), ...extra,
  }
}

describe("buildDigest and renderDigest", () => {
  it("lists what needs the owner, what is broken, the working sessions with their card's next step, and the machine", async () => {
    const ids = { work: "aaaaaaaa-0000-0000-0000-000000000001", ready: "aaaaaaaa-0000-0000-0000-000000000002", ask: "aaaaaaaa-0000-0000-0000-000000000003", stuck: "aaaaaaaa-0000-0000-0000-000000000004", prompt: "aaaaaaaa-0000-0000-0000-000000000005" }
    card("eng", "kernel", "processing", "Land the parser")
    card("eng", "review", "collaborating", "Pick a layout")
    declare(ids.work, "eng", "kernel")
    declare(ids.ready, "eng", "review")
    const rows = [
      row(ids.work, "Kernel lane", "working", { lastActivity: iso(3) }),
      row(ids.ready, "Review lane", "idle"),
      row(ids.ask, "Asking lane", "waiting", { lastActivity: iso(42), detail: "waiting for your answer" }),
      row(ids.stuck, "Stuck lane", "stuck", { detail: "its history stopped" }),
      row(ids.prompt, "Trust lane", "waiting", { lastActivity: iso(5) }),
      row("aaaaaaaa-0000-0000-0000-000000000006", "Quiet lane", "idle", { lastActivity: iso(60 * 40) }),
      row("aaaaaaaa-0000-0000-0000-000000000007", "Cut lane", "idle"),
    ]
    const digest = await buildDigest(input(rows, { waitingPrompts: [{ session: ids.prompt, name: "Trust lane", requestId: "r1", what: "a repository trust decision", since: NOW - 120 * 60_000 }] }))
    expect(digest.counts).toEqual({ working: 1, idle: 3, waiting: 2, stuck: 1 })
    expect(digest.needsOwner.map(item => item.kind)).toEqual(["prompt", "ready", "waiting"])
    const text = renderDigest(digest, NOW)
    expect(text).toContain("**Needs you**\n- Trust lane — a repository trust decision (2 h)\n- Review lane — ready for you: review title. Next: Pick a layout\n- Asking lane — waiting for your answer (42 min)")
    expect(text).toContain("**Broken**\n- Stuck lane — stuck (its history stopped)")
    expect(text).toContain("**Sessions** 1 working · 2 waiting · 1 stuck · 3 idle\n- Kernel lane — Land the parser; last turn 3 min ago")
    expect(text).toContain("**Machine** heartbeat ok (12 s) · app restarted 5 h ago · last resume 50 min ago · health watch: 1 sessions, 0 not ok")
    expect(text).toMatch(/^\*\*Ouroboros status\*\* · /)
    expect(digest.tokens).toBe(Math.ceil(text.length / 4))
    expect(text.split("\n\n").length).toBeGreaterThanOrEqual(4)
    expect(renderDigest(digest, NOW, true)).toBe(text.replace(/\*\*/g, ""))
  })

  it("lists sessions archived in the last day that this agent did not create, and not older ones", async () => {
    addArchiveLog(agentRoot, { id: "a", name: "Old coordinator", at: iso(60), reason: "handed-off" })
    addArchiveLog(agentRoot, { id: "b", name: "Asked for", at: iso(30), reason: "owner-asked" })
    addArchiveLog(agentRoot, { id: "c", name: "Last week", at: iso(60 * 24 * 7), reason: "handed-off" })
    addArchiveLog(agentRoot, { id: "d", name: "ob home catch-up", at: iso(10), reason: "oversize-idle", note: "1.0 GB; last push `git push -q home/slugger-sticky`" })
    addArchiveLog(agentRoot, { id: "e", name: "Surface manifest runner", at: iso(5), reason: "memory-pressure" })
    const text = renderDigest(await buildDigest(input([])), NOW)
    expect(text).toContain("**Archived** (reversible)\n- Old coordinator — handed off to a successor\n- Asked for — you asked")
    expect(text).toContain("- ob home catch-up — over the size limit and idle 30 min after the hand-off ask (1.0 GB; last push `git push -q home/slugger-sticky`)\n- Surface manifest runner — over the size limit and idle while memory ran short")
    expect(text).not.toContain("Last week")
  })

  it("shows the drains and what merged today, and names a source it could not read", async () => {
    const run: RunCommand = async argv => argv[0] === "drains"
      ? { ok: true, stdout: JSON.stringify({ status: ["issue drain a/b -> x: last ok poll 2026-11-15T21:59:00Z (lag 1m), polled 1m ago, 4 open, 1 waiting, last wake never", "relay r (dispatch) a/b", "quota me: 10/20 calls left"] }), error: null }
      : argv[1] === "personal"
        ? { ok: true, stdout: `HTTP/2.0 200 OK\r\nEtag: "e"\r\n\r\n${JSON.stringify({ total_count: 3, items: [{ number: 7, title: "x".repeat(90), repository_url: "https://api.github.com/repos/o/r" }] })}`, error: null }
        : { ok: false, stdout: "", error: "gh failed: no token" }
    const digest = await buildDigest(input([], { run, config: { drains: ["drains"], mergedToday: [{ label: "personal", command: ["gh", "personal"] }, { label: "work", command: ["gh", "work"] }] }, client: { ...housesitter(healthy), stateDir } }))
    const text = renderDigest(digest, NOW)
    expect(text).toContain("**Drains** 1 polling, 0 stale · 1 relays · 1 issues waiting · quota me 10/20")
    expect(text).toContain("**Merged today** 3 (personal 3, work 0)\n- o/r#7 " + "x".repeat(69) + "…")
    expect(text).toContain("Not read: merged today (work): gh failed: no token")
  })

  it("shows a lone account without a split, an unhealthy Mac, stale drains and an app that is not running", async () => {
    const stale = { recovery: { beat_age_s: 900, bad: null, watch: { sessions: { x: { title: "Bad one", status: "erroring" } } } } }
    const run: RunCommand = async argv => argv[0] === "drains"
      ? { ok: true, stdout: JSON.stringify({ status: ["issue drain a/b -> x: last ok poll 2026-11-15T20:00:00Z (lag 1m), polled 1m ago, 4 open, 0 waiting"] }), error: null }
      : { ok: true, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ total_count: 1, items: [] })}`, error: null }
    const digest = await buildDigest(input([], {
      run, appRunning: false, client: housesitter(stale), config: { drains: ["drains"], mergedToday: [{ label: "me", command: ["gh"] }] },
    }))
    const text = renderDigest(digest, NOW)
    expect(text).toContain("- Mac watcher — heartbeat stale")
    expect(text).toContain("- Bad one — health watch: erroring")
    expect(text).toContain("- drain a/b: 120 min since its last good poll")
    expect(text).toContain("the app is not running")
    expect(text.endsWith("**Merged today** 1")).toBe(true) // no per-account split for one account
    const bad = renderDigest(await buildDigest(input([], { client: housesitter({ recovery: { beat_age_s: 3, bad: "the window is frozen" } }) })), NOW)
    expect(bad).toContain("heartbeat bad: the window is frozen")
  })

  it("reports drains that could not be read, and a Mac whose heartbeat has no age", async () => {
    const digest = await buildDigest(input([], { run: async () => ({ ok: false, stdout: "", error: "drains failed" }), config: { drains: ["drains"] }, client: housesitter({}) }))
    expect(renderDigest(digest, NOW)).toContain("Not read: drains: drains failed")
    expect(renderDigest(digest, NOW)).toContain("**Machine** heartbeat unknown · health watch: 0 sessions, 0 not ok")
  })

  it("lists only the first working sessions and counts the rest", async () => {
    const rows = Array.from({ length: 10 }, (_, index) => row(`cccccccc-0000-0000-0000-00000000000${index}`, `Lane ${index}`, "working", { lastActivity: null }))
    const text = renderDigest(await buildDigest(input(rows)), NOW)
    expect(text).toContain("- Lane 7\n- and 2 more")
  })

  it("says nothing about Housesitter or drains when neither is there, and reads no cards without desk roots", async () => {
    const digest = await buildDigest(input([row("dddddddd-0000-0000-0000-000000000001", "Lane", "working")], { config: {}, client: { stateDir, housesitterPaths: ["/nonexistent/housesitter"], homeDir: root } }))
    expect(digest.machine).toBeNull()
    expect(digest.drains).toBeNull()
    expect(digest.sessions[0]!.card).toBeUndefined()
    expect(renderDigest(digest, NOW)).not.toContain("**Machine**")
  })

  it("reports a machine status it could not read", async () => {
    const failing = { stateDir, housesitterPaths: [houseBin], runFile: (async () => ({ code: 1, stdout: "nope", stderr: "" })) as RunFile }
    const digest = await buildDigest(input([], { client: failing }))
    expect(digest.unread[0]).toContain("machine health")
    expect(digest.machine?.error).toBeTruthy()
  })

  it("expands ~ and writes ages in minutes, hours and days", () => {
    expect(expandHome("~", "/h")).toBe("/h")
    expect(expandHome("~/x", "/h")).toBe("/h/x")
    expect(expandHome("/a/b", "/h")).toBe("/a/b")
    expect([minutes(5 * 60_000), minutes(89 * 60_000), minutes(5 * 3_600_000), minutes(53 * 3_600_000), minutes(-5)]).toEqual(["5 min", "89 min", "5 h", "2 d", "0 min"])
  })
})

describe("card lookup", () => {
  it("looks up a session's card only while it is recent, and keeps what it scanned", async () => {
    const recent = "eeeeeeee-0000-0000-0000-000000000001"
    const old = "eeeeeeee-0000-0000-0000-000000000002"
    const remote = "eeeeeeee-0000-0000-0000-000000000003"
    for (const id of [recent, old, remote]) declare(id, "eng", "kernel")
    card("eng", "kernel", "processing")
    const state: DigestState = structuredClone(EMPTY_DIGEST_STATE)
    state.focus["ffffffff-gone"] = { offset: 1 }
    const rows = [row(old, "Old", "idle", { lastActivity: new Date(NOW - CARD_WINDOW_MS - 1000).toISOString() }), row(remote, "Remote", "working", { remote: true }), row(recent, "Recent", "idle", { lastActivity: iso(10) }), row("eeeeeeee-0000-0000-0000-000000000004", "NoActivity", "idle", { lastActivity: null })]
    const digest = await buildDigest(input(rows, { state }))
    expect(digest.sessions.map(session => session.name)).toEqual(["Remote", "Recent"])
    expect(digest.sessions[0]!.card).toBeUndefined()
    expect(Object.keys(state.focus)).not.toContain("ffffffff-gone")
    expect(state.focus[recent]).toMatchObject({ track: "eng", slug: "kernel" })
    expect(state.focus[old]).toBeUndefined()
  })

  it("reads only what a known session added since, and stops when its budget is spent", async () => {
    const first = "eeeeeeee-0000-0000-0000-000000000020"
    const second = "eeeeeeee-0000-0000-0000-000000000021"
    declare(first, "eng", "one")
    declare(second, "eng", "two")
    card("eng", "one", "processing", "Do one")
    card("eng", "two", "processing", "Do two")
    const state: DigestState = structuredClone(EMPTY_DIGEST_STATE)
    const rows = [row(first, "First", "working"), row(second, "Second", "working")]
    const spent = await buildDigest(input(rows, { state, scanBudgetBytes: 1 }))
    expect(spent.sessions.map(session => session.card?.slug)).toEqual(["one", undefined])
    expect(state.focus[second]).toBeUndefined()
    const later = await buildDigest(input(rows, { state }))
    expect(later.sessions.map(session => session.card?.slug)).toEqual(["one", "two"])
    expect(renderDigest(later, NOW)).toContain("- First — Do one; last turn 1 min ago")
    const again = await buildDigest(input(rows, { state }))
    expect(again.sessions[0]!.card?.slug).toBe("one")
  })

  it("shows a card's title when it has no next step, and a ready card or waiting session with no time", async () => {
    const id = "eeeeeeee-0000-0000-0000-000000000030"
    declare(id, "eng", "plain")
    card("eng", "plain", "collaborating")
    const digest = await buildDigest(input([row(id, "Plain", "waiting", { lastActivity: null })]))
    expect(digest.needsOwner.map(item => item.text)).toEqual(["waiting detail", "ready for you: plain title"])
    expect(digest.needsOwner[0]!.since).toBe(NOW)
    expect(renderDigest({ ...digest, sessions: digest.sessions.map(session => ({ ...session, state: "working" as const })) }, NOW)).toContain("- Plain — plain title\n")
  })

  it("stops reading history when its budget is spent, and finds no card for a task that has none", async () => {
    const id = "eeeeeeee-0000-0000-0000-000000000010"
    declare(id, "eng", "missing")
    const state: DigestState = structuredClone(EMPTY_DIGEST_STATE)
    const rows = [row(id, "Lane", "working")]
    const digest = await buildDigest(input(rows, { state }))
    expect(digest.sessions[0]!.card).toBeUndefined()
    expect(state.focus[id]).toMatchObject({ track: "eng", slug: "missing" })
    const spent = structuredClone(EMPTY_DIGEST_STATE)
    const second = await buildDigest(input([row(id, "Lane", "working"), row("eeeeeeee-0000-0000-0000-000000000011", "Other", "working")], { state: spent, config: { deskRoots: [desk] } }))
    expect(second.sessions).toHaveLength(2)
  })
})

describe("writing and reading the digest", () => {
  it("writes the digest and the state, and reads the digest back as Teams text", async () => {
    const digest = await writeDigest(input([row("abababab-0000-0000-0000-000000000001", "Lane", "working")]))
    const files = digestFiles(agentRoot)
    expect(JSON.parse(fs.readFileSync(files.json, "utf-8")).at).toBe(digest.at)
    expect(readDigestState(agentRoot).seeded).toBe(false)
    expect(readDigestText(agentRoot, NOW)).toContain("**Sessions** 1 working")
    expect(readDigestText(agentRoot, NOW)).not.toContain("old;")
    const old = readDigestText(agentRoot, NOW + DIGEST_STALE_MS + 60_000)!
    expect(old).toMatch(/^The digest is 16 min old; the sense that writes it may be down\.\n\n\*\*Ouroboros status/)
  })

  it("has no digest until one is written", () => {
    expect(readDigestText(agentRoot, NOW)).toBeNull()
    expect(readDigestState(agentRoot)).toEqual(EMPTY_DIGEST_STATE)
  })
})

describe("answering a status ask with no model", () => {
  it("recognises the plain question and nothing longer", () => {
    for (const ask of ["how's it going?", "How is it going", "hows it going", "how’s it going?", "How are things going?", "how are things", "what's the status", "status", "/status".slice(1), "sitrep", "Hey, how's everything going?".replace("Hey, ", "hey "), "update me", "what's up?", "any news"]) expect(isStatusAsk(ask), ask).toBe(true)
    for (const other of ["how's it going with the tax thing?", "can you check the status of my order", "how is", "hello", "status of the drains please", ""]) expect(isStatusAsk(other), other).toBe(false)
  })

  it("answers /status or the question from the last digest, and leaves any other message to the agent", async () => {
    await writeDigest(input([row("cdcdcdcd-0000-0000-0000-000000000001", "Lane", "working")]))
    expect(statusAnswer("/status", agentRoot, NOW)).toContain("**Sessions** 1 working")
    expect(statusAnswer("  How's it going?  ", agentRoot, NOW)).toContain("**Sessions** 1 working")
    expect(statusAnswer("book me a flight", agentRoot, NOW)).toBeNull()
  })

  it("says plainly that no digest exists for /status, and leaves the question to the agent", () => {
    expect(statusAnswer("/status", agentRoot, NOW)).toContain("No status digest yet")
    expect(statusAnswer("how's it going?", agentRoot, NOW)).toBeNull()
  })
})
