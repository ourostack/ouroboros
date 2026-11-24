import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { FIRST_SCAN_BYTES, readCard, scanFocus } from "../../../senses/app-sessions/digest-cards"

const ID = "22222222-aaaa-bbbb-cccc-000000000002"
let stateDir: string

beforeEach(() => { stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-digest-cards-")) })
afterEach(() => fs.rmSync(stateDir, { recursive: true, force: true }))

const focus = (track: string, slug: string, extra: Record<string, unknown> = {}) => ({ type: "assistant.message", data: { toolRequests: [{ name: "desk-task_focus", arguments: { track, slug, ...extra } }] } })
const filler = (bytes = 40) => ({ type: "tool.execution_complete", data: { result: "x".repeat(bytes) } })

function log(...events: unknown[]): number {
  const dir = path.join(stateDir, "session-state", ID)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "events.jsonl")
  fs.appendFileSync(file, events.map(event => JSON.stringify(event) + "\n").join(""))
  return fs.statSync(file).size
}

describe("scanFocus", () => {
  it("finds the newest declaration reading backwards, then only what was added since", () => {
    const size = log(focus("eng", "old"), filler(), focus("eng", "kernel"), filler())
    const first = scanFocus(ID, undefined, 1 << 20, { stateDir })
    expect(first.entry).toEqual({ offset: size, track: "eng", slug: "kernel" })
    expect(first.bytes).toBeGreaterThan(0)
    log(filler(), focus("ops", "relays"))
    const next = scanFocus(ID, first.entry, 1 << 20, { stateDir })
    expect(next.entry).toMatchObject({ track: "ops", slug: "relays" })
    expect(scanFocus(ID, next.entry, 1 << 20, { stateDir })).toEqual({ entry: next.entry, bytes: 0 })
  })

  it("forgets the task when the session clears it, and ignores calls it cannot trust", () => {
    const first = scanFocus(ID, { offset: 0, track: "eng", slug: "kernel" }, 1 << 20, { stateDir })
    expect(first).toEqual({ entry: { offset: 0, track: "eng", slug: "kernel" }, bytes: 0 })
    log(focus("eng", "kernel"), focus("a", "b", { clear: true }), focus("..", "escape"), focus("eng", "x/y"), { type: "assistant.message", data: { toolRequests: [{ name: "desk-task_focus" }] } },
      { type: "assistant.message", data: { toolRequests: [{ name: "shell", arguments: { command: "echo task_focus" } }, { arguments: "task_focus" }] } }, { type: "assistant.message", data: {} }, { type: "user.message", data: { content: "task_focus" } })
    const forward = scanFocus(ID, { offset: 0, track: "eng", slug: "kernel" }, 1 << 20, { stateDir })
    expect(forward.entry.track).toBeUndefined()
    expect(forward.entry.slug).toBeUndefined()
    expect(scanFocus(ID, undefined, 1 << 20, { stateDir }).entry.track).toBeUndefined()
  })

  it("reads past a line longer than a chunk, and stops at its budget", () => {
    const size = log(focus("eng", "deep"), filler(600 * 1024), filler(10))
    expect(scanFocus(ID, undefined, 1 << 30, { stateDir }).entry).toEqual({ offset: size, track: "eng", slug: "deep" })
    expect(scanFocus(ID, undefined, 1024, { stateDir }).entry).toEqual({ offset: size })
    expect(FIRST_SCAN_BYTES).toBeGreaterThan(1 << 20)
  })

  it("reads a final line that is longer than a chunk and has no newline yet", () => {
    const dir = path.join(stateDir, "session-state", ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(focus("eng", "tail"))}\n${"y".repeat(600 * 1024)}`)
    expect(scanFocus(ID, undefined, 1 << 30, { stateDir }).entry).toMatchObject({ track: "eng", slug: "tail" })
  })

  it("skips a line it cannot parse and a log with no newline yet, and stays inside a log that shrank", () => {
    const dir = path.join(stateDir, "session-state", ID)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "events.jsonl"), `${JSON.stringify(focus("eng", "kept"))}\n${JSON.stringify(filler())}\nnot json task_focus\n`)
    expect(scanFocus(ID, undefined, 1 << 20, { stateDir }).entry).toMatchObject({ track: "eng", slug: "kept" })
    fs.writeFileSync(path.join(dir, "events.jsonl"), "partial")
    expect(scanFocus(ID, { offset: 999999 }, 1 << 20, { stateDir })).toEqual({ entry: { offset: 7 }, bytes: 0 })
    fs.writeFileSync(path.join(dir, "events.jsonl"), "task_focus no newline yet")
    expect(scanFocus(ID, { offset: 0 }, 1 << 20, { stateDir })).toEqual({ entry: { offset: 0 }, bytes: 25 })
  })

  it("has nothing for a session with no log", () => {
    expect(scanFocus("33333333-aaaa-bbbb-cccc-000000000003", undefined, 1 << 20, { stateDir })).toEqual({ entry: { offset: 0 }, bytes: 0 })
    expect(scanFocus("33333333-aaaa-bbbb-cccc-000000000003", { offset: 7, track: "a", slug: "b" }, 1 << 20, { stateDir }).entry).toEqual({ offset: 7, track: "a", slug: "b" })
  })
})

describe("readCard", () => {
  const card = (title: string, status: string, body = ""): string => `---\nschema_version: 1\ntitle: ${title}\nstatus: ${status}\n---\n\n## Outcome\n\n${body}`

  it("reads the title, status and next step, from the first desk root that has the card", () => {
    fs.mkdirSync(path.join(stateDir, "a", "eng", "kernel"), { recursive: true })
    fs.mkdirSync(path.join(stateDir, "b", "eng", "kernel"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "b", "eng", "kernel", "task.md"), card("'Kernel work'", "processing", "**Next step:** Land the **parser** change and `verify` it.\n"))
    expect(readCard([path.join(stateDir, "a"), path.join(stateDir, "b")], "eng", "kernel")).toMatchObject({ track: "eng", slug: "kernel", title: "Kernel work", status: "processing", next: "Land the parser change and verify it.", file: path.join(stateDir, "b", "eng", "kernel", "task.md") })
  })

  it("cuts a long next step, and falls back to the slug, an unknown status and no next step", () => {
    fs.mkdirSync(path.join(stateDir, "eng", "long"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "eng", "long", "task.md"), `${card("Long", "blocked", `**Next step:** ${"word ".repeat(60)}\n`)}`)
    const long = readCard([stateDir], "eng", "long")!
    expect(long.next!.length).toBe(120)
    expect(long.next!.endsWith("…")).toBe(true)
    fs.mkdirSync(path.join(stateDir, "eng", "bare"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "eng", "bare", "task.md"), "no front matter")
    expect(readCard([stateDir], "eng", "bare")).toMatchObject({ track: "eng", slug: "bare", title: "bare", status: "unknown", next: null })
  })

  it("reads the repository, branch, pull request and session a card names, with its file and age", () => {
    fs.mkdirSync(path.join(stateDir, "eng", "ptr"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "eng", "ptr", "task.md"), "---\ntitle: Ptr\nstatus: processing\nrepo: ourostack/ouroboros\nbranch: fix-x\npr_url: https://github.com/ourostack/ouroboros/pull/9\nsession_id: abc-123\n---\n")
    const withPointers = readCard([stateDir], "eng", "ptr")!
    expect(withPointers).toMatchObject({ repo: "ourostack/ouroboros", branch: "fix-x", pr: "https://github.com/ourostack/ouroboros/pull/9", session: "abc-123" })
    expect(Date.parse(withPointers.updatedAt!)).not.toBeNaN()
    fs.writeFileSync(path.join(stateDir, "eng", "ptr", "task.md"), "---\ntitle: Ptr\npr: https://x/pull/1\nsession: s2\n---\n")
    expect(readCard([stateDir], "eng", "ptr")).toMatchObject({ pr: "https://x/pull/1", session: "s2" })
    expect(readCard([stateDir], "eng", "ptr")).not.toHaveProperty("repo")
  })

  it("finds a card archived under its track, and nothing for a card that is not there", () => {
    fs.mkdirSync(path.join(stateDir, "eng", "_archive", "shipped"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "eng", "_archive", "shipped", "task.md"), card("Shipped", "done"))
    expect(readCard([stateDir], "eng", "shipped")).toMatchObject({ status: "done" })
    expect(readCard([stateDir], "eng", "missing")).toBeNull()
    expect(readCard([], "eng", "shipped")).toBeNull()
  })
})
