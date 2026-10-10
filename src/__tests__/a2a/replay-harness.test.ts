import * as fs from "node:fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mockOwners } from "../test-helpers/replay-owners"
import { appendReplayNotice, isAnyReplayWindowOpen, isReplayIdentity, replayIdentitiesPath, isReplayWindowOpen, REPLAY_WINDOW_MAX_MS, replayNoticeRecorded, replaySinkPath, replayWindowPath } from "../../a2a/replay-harness"

vi.mock("node:fs", async (original) => ({ ...await original<typeof fs>() }))

const NOW = Date.parse("2026-10-08T12:00:00.000Z")
let root = ""

function writeWindow(content: string): void {
  fs.mkdirSync(path.dirname(replayWindowPath(root)), { recursive: true })
  fs.writeFileSync(replayWindowPath(root), content)
  fs.chmodSync(path.dirname(replayWindowPath(root)), 0o755)
  fs.chmodSync(replayWindowPath(root), 0o644)
}
const owners = (uidFor: (file: string) => number) => mockOwners(fs, uidFor)
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

  it("reports any open window across friends, with the same expiry and trust rules", () => {
    expect(isAnyReplayWindowOpen(root, NOW)).toBe(false)
    writeWindow(JSON.stringify({ friends: { a: { expiresAt: iso(-1) }, b: { expiresAt: iso(60_000) } } }))
    expect(isAnyReplayWindowOpen(root, NOW)).toBe(true)
    writeWindow(JSON.stringify({ friends: { a: { expiresAt: iso(-1) }, b: null, c: { expiresAt: iso(REPLAY_WINDOW_MAX_MS + 1) } } }))
    expect(isAnyReplayWindowOpen(root, NOW)).toBe(false)
    writeWindow(JSON.stringify({}))
    expect(isAnyReplayWindowOpen(root, NOW)).toBe(false)
    writeWindow(JSON.stringify({ friends: { b: { expiresAt: new Date(Date.now() + 60_000).toISOString() } } }))
    expect(isAnyReplayWindowOpen(root)).toBe(true)
    asOwnedBy(501)
    expect(isAnyReplayWindowOpen(root, NOW)).toBe(false)
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

    it("refuses a window file that is not a regular file", () => {
      writeWindow(open())
      fs.rmSync(replayWindowPath(root))
      fs.mkdirSync(replayWindowPath(root))
      fs.chmodSync(replayWindowPath(root), 0o755)
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("judges the file it opened, not the path: a swap after the open cannot change the verdict", () => {
      writeWindow(open())
      vi.restoreAllMocks()
      // lstat of the directory says trusted, but the opened descriptor belongs to another uid (a file swapped in by rename)
      owners((file) => (file === replayWindowPath(root) ? 4242 : 0))
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
    })

    it("reads through the descriptor it checked and closes it, even when reading fails", () => {
      writeWindow(open())
      const closed: number[] = []
      const close = fs.closeSync
      vi.spyOn(fs, "closeSync").mockImplementation(((fd: number) => { closed.push(fd); return close(fd) }) as typeof fs.closeSync)
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(true)
      expect(closed).toHaveLength(1)
      vi.spyOn(fs, "readFileSync").mockImplementation((() => { throw new Error("EIO") }) as typeof fs.readFileSync)
      expect(isReplayWindowOpen(root, "p", NOW)).toBe(false)
      expect(closed).toHaveLength(2)
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

  it("appends a notice id once per friend, so a retry adds nothing", () => {
    appendReplayNotice(root, { noticeId: "n1", text: "hello", friendId: "p" }, NOW)
    appendReplayNotice(root, { noticeId: "n1", text: "hello", friendId: "p" }, NOW)
    appendReplayNotice(root, { noticeId: "n1", text: "hello", friendId: "q" }, NOW)
    expect(fs.readFileSync(replaySinkPath(root), "utf8").trim().split("\n")).toHaveLength(2)
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
    expect(importers).toEqual(["a2a/delegated-command.ts", "heart/awaiting/a2a-await-delivery.ts", "heart/failure-reports.ts", "heart/steward-policy.ts", "repertoire/mcp-write-guard.ts", "repertoire/tools-house-care.ts"])
    const writers = sources.filter((f) => /"window\.json"/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f))
    // The lifecycle only deletes a stale window file when it puts the directory back under root; it never writes one.
    expect(writers).toEqual(["replay-harness.ts", "sanctuary-authority-root-lifecycle.ts"])
    const lifecycle = fs.readFileSync(path.join(__dirname, "..", "..", "heart", "daemon", "sanctuary-authority-root-lifecycle.ts"), "utf8")
    expect(lifecycle).not.toMatch(/(writeFile|appendFile|rename|copyFile|symlink)[A-Za-z]*\([^)]*window\.json/)
  })

})

describe("replay identity marker", () => {
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "replay-identity-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })
  {
    function writeIdentities(content: string): void {
      fs.mkdirSync(path.dirname(replayIdentitiesPath(root)), { recursive: true })
      fs.writeFileSync(replayIdentitiesPath(root), content)
    }

    it("is not a replay identity with no registry and no window", () => {
      expect(isReplayIdentity(root, "p")).toBe(false)
    })

    it("lists permanent replay identities regardless of any window", () => {
      writeIdentities(JSON.stringify({ friends: { p: { name: "replay-principal" } } }))
      expect(isReplayIdentity(root, "p")).toBe(true)
      expect(isReplayIdentity(root, "real-friend")).toBe(false)
    })

    it("counts any window entry, open or expired", () => {
      writeWindow(JSON.stringify({ friends: { p: { expiresAt: iso(-60_000) } } }))
      expect(isReplayIdentity(root, "p")).toBe(true)
      expect(isReplayIdentity(root, "other")).toBe(false)
    })

    it("does not treat inherited object keys as identities", () => {
      writeIdentities(JSON.stringify({ friends: {} }))
      expect(isReplayIdentity(root, "toString")).toBe(false)
    })

    it.each([["no friends map", "{}"], ["friends not an object", JSON.stringify({ friends: "p" })], ["null document", "null"]])("is not a replay identity when the registry has %s", (_name, content) => {
      writeIdentities(content)
      expect(isReplayIdentity(root, "p")).toBe(false)
    })

    it("fails closed when a marker file exists but cannot be parsed", () => {
      writeIdentities("{not json")
      expect(isReplayIdentity(root, "real-friend")).toBe(true)
    })
  }
})
