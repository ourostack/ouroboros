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

  describe("the canonical v1 desk card (task-card-format)", () => {
    const write = (slug: string, front: string, body = ""): string[] => {
      fs.mkdirSync(path.join(stateDir, "eng", slug), { recursive: true })
      fs.writeFileSync(path.join(stateDir, "eng", slug, "task.md"), `---\nschema_version: 1\ntitle: T\nstatus: processing\n${front}\n---\n${body}`)
      return [stateDir]
    }

    it("takes the PR from evidence.ref, the repo and branch from Resources, and the session from bridge_sessions", () => {
      const roots = write("c1", `evidence:\n  kind: pr\n  ref: https://github.com/ourostack/ouroboros/pull/77\n  recorded_at: 2026-04-21T09:00:00Z\nrepos:\n  - name: ouroboros\n    local_path: ~/code/ouroboros\n    mode: local\nbridge_sessions: ["sess-1", "sess-2"]`,
        "## Resources\n\n| Identity | Step | Owner |\n| --- | --- | --- |\n| `worktree:/w/x` | | me |\n| `branch:ourostack/ouroboros#fix-sync` | step a | me |\n")
      expect(readCard(roots, "eng", "c1")).toMatchObject({ repo: "ourostack/ouroboros", branch: "fix-sync", pr: "https://github.com/ourostack/ouroboros/pull/77", session: "sess-1" })
    })

    it("falls back to artifacts, then to the active iteration's PR number in the repo's clone URL, and keeps flat fields first", () => {
      const art = write("c2", `artifacts:\n  - https://github.com/o/r/blob/main/x.md\n  - "https://github.com/o/r/pull/5"  # the PR`)
      expect(readCard(art, "eng", "c2")).toMatchObject({ pr: "https://github.com/o/r/pull/5", repo: "o/r" })
      const inline = write("c3", "artifacts: [https://github.com/o/r/pull/6]")
      expect(readCard(inline, "eng", "c3")).toMatchObject({ pr: "https://github.com/o/r/pull/6" })
      const iter = write("c4", `repos:\n  - name: svc\n    url: https://github.com/acme/svc.git\n    mode: local\niterations:\n  active: ./svc/2026-04-21-b\n  history:\n    - slug: 2026-04-13-a\n      repo: svc\n      pr: 11\n      path: ./svc/_archive/2026-04-13-a\n    - slug: 2026-04-21-b\n      repo: svc\n      pr: 12\n      path: ./svc/2026-04-21-b\n    - slug: 2026-05-01-c\n      repo: svc\n      pr: null\n      path: ./svc/2026-05-01-c`)
      expect(readCard(iter, "eng", "c4")).toMatchObject({ repo: "acme/svc", pr: "https://github.com/acme/svc/pull/12" })
      const lastWithPr = write("c5", "repos:\n  - name: svc\n    mode: remote\niterations:\n  active: null\n  history:\n    - slug: a\n      repo: svc\n      pr: 3\n      path: ./svc/a")
      expect(readCard(lastWithPr, "eng", "c5")).toMatchObject({ repo: "svc", pr: "https://github.com/svc/pull/3" })
      const flat = write("c6", "repo: flat/repo\npr: https://x/pull/1\nsession: s9\nartifacts: [https://github.com/o/r/pull/6]\nbridge_sessions: [b]")
      expect(readCard(flat, "eng", "c6")).toMatchObject({ repo: "flat/repo", pr: "https://x/pull/1", session: "s9" })
    })

    it("reads nothing from a card with no pointers or an empty iteration history", () => {
      const roots = write("c7", "iterations:\n  active: null\n  history: []\nrepos:\n  mode: local")
      const card = readCard(roots, "eng", "c7")!
      expect(card).not.toHaveProperty("repo")
      expect(card).not.toHaveProperty("pr")
      expect(card).not.toHaveProperty("session")
    })
  })

  it("finds a card archived under its track, and nothing for a card that is not there", () => {
    fs.mkdirSync(path.join(stateDir, "eng", "_archive", "shipped"), { recursive: true })
    fs.writeFileSync(path.join(stateDir, "eng", "_archive", "shipped", "task.md"), card("Shipped", "done"))
    expect(readCard([stateDir], "eng", "shipped")).toMatchObject({ status: "done" })
    expect(readCard([stateDir], "eng", "missing")).toBeNull()
    expect(readCard([], "eng", "shipped")).toBeNull()
  })
})
