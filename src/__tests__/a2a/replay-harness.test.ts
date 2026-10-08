import * as fs from "node:fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { appendReplayNotice, isReplayWindowOpen, REPLAY_WINDOW_MAX_MS, replayNoticeRecorded, replaySinkPath, replayWindowPath } from "../../a2a/replay-harness"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))

const NOW = Date.parse("2026-10-08T12:00:00.000Z")
let root = ""

function writeWindow(content: string): void {
  fs.mkdirSync(path.dirname(replayWindowPath(root)), { recursive: true })
  fs.writeFileSync(replayWindowPath(root), content)
  fs.chmodSync(path.dirname(replayWindowPath(root)), 0o755)
  fs.chmodSync(replayWindowPath(root), 0o644)
}
/** The tests are not root: report every file as owned by the uid chosen for its path. */
function owners(uidFor: (file: string) => number): void {
  const lstat = fs.lstatSync
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: unknown) => {
    const stat = (lstat as (f: fs.PathLike, o?: unknown) => fs.Stats)(file, options)
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: uidFor(String(file)) })
  }) as typeof fs.lstatSync)
}
const asOwnedBy = (uid: number) => owners(() => uid)
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString()

describe("replay harness window and sink", () => {
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-harness-")); asOwnedBy(0) })
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }) })

  it("is closed with no window file", () => {
    expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
  })

  it("is open for a listed friend with a future expiry inside the cap", () => {
    writeWindow(JSON.stringify({ friends: { p: { expiresAt: iso(60_000) } } }))
    expect(isReplayWindowOpen(root, "p", NOW)).toBe(true)
    expect(isReplayWindowOpen(root, "other", NOW)).toBe(false)
  })

  it("uses the real clock by default", () => {
    writeWindow(JSON.stringify({ friends: { p: { expiresAt: new Date(Date.now() + 60_000).toISOString() } } }))
    expect(isReplayWindowOpen(root, "p")).toBe(true)
  })

  it.each([
    ["expired", JSON.stringify({ friends: { p: { expiresAt: iso(-1) } } })],
    ["exactly now", JSON.stringify({ friends: { p: { expiresAt: iso(0) } } })],
    ["beyond the cap", JSON.stringify({ friends: { p: { expiresAt: iso(REPLAY_WINDOW_MAX_MS + 1) } } })],
    ["not a date", JSON.stringify({ friends: { p: { expiresAt: "soon" } } })],
    ["non-string expiry", JSON.stringify({ friends: { p: { expiresAt: 5 } } })],
    ["entry is null", JSON.stringify({ friends: { p: null } })],
    ["no friends map", JSON.stringify({})],
    ["friends not an object", JSON.stringify({ friends: "p" })],
    ["null document", "null"],
    ["not JSON", "{oops"],
  ])("is closed when the window is %s", (_name, content) => {
    writeWindow(content)
    expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
  })

  describe("trust in the window files", () => {
    const open = () => JSON.stringify({ friends: { p: { expiresAt: iso(60_000) } } })

    it("is closed when the replay directory is not owned by the trusted uid (the Butler could have replaced it)", () => {
      writeWindow(open())
      vi.restoreAllMocks()
      owners((file) => (file === path.dirname(replayWindowPath(root)) ? 4242 : 0))
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("is closed when the window file is owned by another uid", () => {
      writeWindow(open())
      vi.restoreAllMocks()
      owners((file) => (file === replayWindowPath(root) ? 4242 : 0))
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it.each([["directory", 0o775, 0o644], ["directory", 0o757, 0o644], ["file", 0o755, 0o664], ["file", 0o755, 0o646]])("is closed when the %s is group- or other-writable (%o, %o)", (_what, dirMode, fileMode) => {
      writeWindow(open())
      fs.chmodSync(path.dirname(replayWindowPath(root)), dirMode)
      fs.chmodSync(replayWindowPath(root), fileMode)
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("is closed when the window file is a symlink", () => {
      writeWindow(open())
      const real = path.join(root, "real.json")
      fs.renameSync(replayWindowPath(root), real)
      fs.symlinkSync(real, replayWindowPath(root))
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("is closed when the replay directory is a symlink", () => {
      writeWindow(open())
      const dir = path.dirname(replayWindowPath(root))
      fs.renameSync(dir, path.join(root, "elsewhere"))
      fs.symlinkSync(path.join(root, "elsewhere"), dir)
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("honours an explicit trusted uid", () => {
      writeWindow(open())
      expect(isReplayWindowOpen(root, "p", NOW, 0)).toBe(true)
      expect(isReplayWindowOpen(root, "p", NOW, 1)).toBe(false)
    })
  })

  it("appends notices as 0600 ndjson and finds them by id and friend", () => {
    appendReplayNotice(root, { noticeId: "delegated:c1", text: "hello", friendId: "p" }, NOW)
    appendReplayNotice(root, { noticeId: "delegated:c2", text: "again", friendId: "p" })
    const lines = fs.readFileSync(replaySinkPath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines[0]).toEqual({ at: "2026-10-08T12:00:00.000Z", noticeId: "delegated:c1", text: "hello", friendId: "p" })
    expect(fs.statSync(replaySinkPath(root)).mode & 0o777).toBe(0o600)
    expect(replayNoticeRecorded(root, "delegated:c1", "p")).toBe(true)
    expect(replayNoticeRecorded(root, "delegated:c1", "other")).toBe(false)
    expect(replayNoticeRecorded(root, "delegated:zzz", "p")).toBe(false)
  })

  it("reports no recorded notice for a missing sink and skips blank or malformed lines", () => {
    expect(replayNoticeRecorded(root, "x", "p")).toBe(false)
    fs.mkdirSync(path.dirname(replaySinkPath(root)), { recursive: true })
    fs.writeFileSync(replaySinkPath(root), `\nnot json\n${JSON.stringify({ noticeId: "x", friendId: "p" })}\n`)
    expect(replayNoticeRecorded(root, "x", "p")).toBe(true)
  })

  it("throws when the sink cannot be written", () => {
    fs.mkdirSync(path.dirname(replaySinkPath(root)), { recursive: true })
    fs.mkdirSync(replaySinkPath(root))
    expect(() => appendReplayNotice(root, { noticeId: "a", text: "b", friendId: "p" })).toThrow()
  })
})

describe("replay window is not settable by any model-facing path", () => {
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__tests__" ? [] : walk(path.join(dir, e.name))) : e.name.endsWith(".ts") ? [path.join(dir, e.name)] : [])

  it("only the notice routing files import the harness, and nothing in src writes the window file", () => {
    const sources = walk(path.join(__dirname, "..", ".."))
    const importers = sources.filter((f) => /replay-harness"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(path.join(__dirname, "..", ".."), f)).sort()
    expect(importers).toEqual(["a2a/delegated-command.ts", "heart/awaiting/a2a-await-delivery.ts"])
    const writers = sources.filter((f) => /"window\.json"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f))
    expect(writers).toEqual(["replay-harness.ts"])
  })
})
