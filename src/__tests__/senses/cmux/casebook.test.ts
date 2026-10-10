import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  addCase,
  appendDecision,
  cmuxCasebookPath,
  cmuxDecisionLogPath,
  findPrecedent,
  isShape,
  loadCasebook,
  readCasebook,
  readDecisions,
  repliesInWindow,
  storeShape,
  withDecisionLock,
  type DecisionRecord,
} from "../../../senses/cmux/casebook"
import { readCmuxPrinciples, SEED_CMUX_PRINCIPLES } from "../../../senses/cmux/principles"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync), statSync: vi.fn(actual.statSync), renameSync: vi.fn(actual.renameSync), readFileSync: vi.fn(actual.readFileSync), readdirSync: vi.fn(actual.readdirSync) }
})

let dir = ""
const raw = { repoRoot: "/repo", tool: "Bash", tokens: ["make", "build"] }
const shape = storeShape(raw)

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    at: "2026-10-10T20:00:00.000Z", requestId: "r1", source: "claude", tool: "Bash", cwd: "/repo", outcome: "escalated",
    floor: { verdict: "soft", reason: "make is not on the allowlist" }, shape, precedent: null, authority: "none", detail: "x", ...overrides,
  }
}

beforeEach(() => {
  dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cmux-casebook-")), "state", "senses", "cmux")
})

afterEach(() => {
  fs.rmSync(path.dirname(path.dirname(path.dirname(dir))), { recursive: true, force: true })
})

describe("cmux casebook", () => {
  it("stores precedents privately as digests and matches only the exact shape, newest first", () => {
    const file = cmuxCasebookPath(dir)
    expect(readCasebook(file)).toEqual([])
    const first = addCase(file, { verdict: "once", shape, requestId: "r1", note: "fine, token=abc123", at: "2026-10-10T20:00:00.000Z" })
    expect(first).toMatchObject({ verdict: "once", note: "fine, token=[redacted]", shape: { preview: "make build" } })
    expect(fs.readFileSync(file, "utf-8")).not.toContain("\"tokens\"")
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(findPrecedent(readCasebook(file), raw)?.id).toBe(first.id)
    expect(findPrecedent(readCasebook(file), { ...raw, tokens: ["make", "build", "extra"] })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...raw, tokens: ["make build"] })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...raw, repoRoot: "/other" })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...raw, tool: "Edit" })).toBeNull()
    const second = addCase(file, { verdict: "ask", shape, requestId: "r2", note: "ask me", at: "2026-10-10T21:00:00.000Z" })
    expect(findPrecedent(readCasebook(file), raw)?.id).toBe(second.id)
  })

  it("keeps secrets out of a shape's preview", () => {
    expect(storeShape({ repoRoot: "/r", tool: "Bash", tokens: ["grep", "password=hunter2", "src"] }).preview).toBe("grep password=[redacted] src")
  })

  it("migrates schema-1 cases, including ask precedents, to digests and drops the raw tokens from disk", () => {
    const file = cmuxCasebookPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    const legacyAsk = { id: "case-old-ask", at: "2026-10-01T00:00:00.000Z", verdict: "ask", shape: raw, requestId: "old", note: "ask me" }
    const legacyOnce = { id: "case-old-once", at: "2026-10-01T00:00:01.000Z", verdict: "once", shape: { repoRoot: "/repo", tool: "Bash", tokens: ["grep", "password=hunter2"] }, requestId: "old2", note: "" }
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, cases: [legacyAsk, legacyOnce] }))
    expect(loadCasebook(file)).toMatchObject({ problem: null, migrated: 2 })
    const cases = readCasebook(file)
    expect(findPrecedent(cases, raw)).toMatchObject({ id: "case-old-ask", verdict: "ask", shape: { digest: shape.digest, preview: "make build" } })
    const onDisk = fs.readFileSync(file, "utf-8")
    expect(onDisk).not.toContain("\"tokens\"")
    expect(onDisk).not.toContain("hunter2")
    expect(JSON.parse(onDisk)).toMatchObject({ schemaVersion: 2 })
    expect(loadCasebook(file)).toMatchObject({ problem: null, migrated: 0 })
    expect(fs.existsSync(path.join(dir, "decisions.lock"))).toBe(false)
  })

  it("leaves the migration to whoever got there first", () => {
    const file = cmuxCasebookPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, cases: [{ id: "c", at: "x", verdict: "ask", shape: raw, requestId: "r", note: "" }] }))
    const actual = vi.mocked(fs.readFileSync).getMockImplementation()!
    let reads = 0
    vi.mocked(fs.readFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      // Another process migrates the file between this process's first read and its locked re-read.
      if (String(target) === file && (reads += 1) === 2) fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, cases: [{ id: "c", at: "x", verdict: "ask", shape, requestId: "r", note: "" }] }))
      return actual(target, options as never)
    }) as typeof fs.readFileSync)
    try {
      expect(readCasebook(file)).toEqual([expect.objectContaining({ id: "c", shape })])
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual)
    }
  })

  it("fails closed on a casebook it cannot fully read, instead of skipping cases", () => {
    const file = cmuxCasebookPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    const add = () => addCase(file, { verdict: "ask", shape, requestId: "r", note: "", at: "x" })
    for (const [content, problem] of [
      ["not json", "the cmux casebook is not valid JSON"],
      ["null", "the cmux casebook has no case list"],
      [JSON.stringify({ cases: "nope" }), "the cmux casebook has no case list"],
      [JSON.stringify({ cases: [null] }), "the cmux casebook holds a case it cannot read"],
      [JSON.stringify({ cases: [{ verdict: "always", shape }] }), "the cmux casebook holds a case it cannot read"],
      [JSON.stringify({ cases: [{ verdict: "ask", shape: { ...shape, digest: 1 } }] }), "the cmux casebook holds a case it cannot read"],
      [JSON.stringify({ cases: [{ verdict: "ask", shape: { repoRoot: "/r", tool: "Bash", tokens: [1] } }] }), "the cmux casebook holds a case it cannot read"],
      [JSON.stringify({ cases: [{ verdict: "ask" }] }), "the cmux casebook holds a case it cannot read"],
    ] as const) {
      fs.writeFileSync(file, content)
      expect(loadCasebook(file).problem).toBe(problem)
      expect(() => readCasebook(file)).toThrow(problem)
      expect(add).toThrow(problem)
      expect(fs.readFileSync(file, "utf-8")).toBe(content)
    }
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(loadCasebook(file).problem).toMatch(/^the cmux casebook cannot be read: /)
    fs.rmdirSync(file)
    fs.writeFileSync(file, JSON.stringify({ cases: [{ verdict: "ask", shape: raw }] }))
    const actual = vi.mocked(fs.readFileSync).getMockImplementation()!
    let reads = 0
    vi.mocked(fs.readFileSync).mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
      // The file turns unreadable between the first read and the locked re-read.
      if (String(target) === file && (reads += 1) === 2) fs.writeFileSync(file, "broken")
      return actual(target, options as never)
    }) as typeof fs.readFileSync)
    try {
      expect(() => readCasebook(file)).toThrow("the cmux casebook is not valid JSON")
    } finally {
      vi.mocked(fs.readFileSync).mockImplementation(actual)
    }
  })

  it("recognizes only the stored shape", () => {
    expect(isShape(shape)).toBe(true)
    expect(isShape(raw)).toBe(false)
    expect(isShape(null)).toBe(false)
    expect(isShape({ ...shape, preview: 1 })).toBe(false)
  })
})

describe("cmux decision log", () => {
  it("appends records privately, rotates once, and reads both files", () => {
    const file = cmuxDecisionLogPath(dir)
    expect(readDecisions(file)).toEqual([])
    appendDecision(file, record({ detail: "Bearer abcdefghijk" }))
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(readDecisions(file)[0]!.detail).toBe("Bearer [redacted]")
    fs.appendFileSync(file, "garbage\n{\"no\":\"id\"}\nnull\n")
    fs.appendFileSync(file, `${JSON.stringify(record({ requestId: "big", detail: "x".repeat(2 * 1024 * 1024) }))}\n`)
    appendDecision(file, record({ requestId: "after-rotation" }))
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    expect(readDecisions(file).map((entry) => entry.requestId)).toEqual(["r1", "big", "after-rotation"])
  })

  it("keeps recent reply records through rotation, so the grant's count never loses one inside its window", () => {
    const file = cmuxDecisionLogPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    const line = (entry: DecisionRecord) => `${JSON.stringify(entry)}\n`
    // The old rotated file holds a recent reply, an old reply and other outcomes.
    fs.writeFileSync(`${file}.1`, [
      record({ requestId: "recent-reply", outcome: "reply_sent", at: "2026-10-01T00:00:00.000Z" }),
      record({ requestId: "old-reply", outcome: "reply_sent", at: "2026-08-01T00:00:00.000Z" }),
      record({ requestId: "recent-escalation", outcome: "escalated", at: "2026-10-01T00:00:00.000Z" }),
    ].map(line).join(""))
    fs.writeFileSync(file, line(record({ requestId: "big", detail: "x".repeat(2 * 1024 * 1024) })))
    appendDecision(file, record({ requestId: "new", at: "2026-10-10T20:00:00.000Z" }))
    expect(readDecisions(`${file}`).map((entry) => entry.requestId)).toEqual(["big", "recent-reply", "new"])
    expect(repliesInWindow(readDecisions(file), 30 * 24 * 60 * 60_000, Date.parse("2026-10-10T20:00:00.000Z"))).toBe(1)

    // With nothing recent to keep, the new file starts empty.
    fs.writeFileSync(`${file}.1`, line(record({ requestId: "old-reply", outcome: "reply_sent", at: "2026-08-01T00:00:00.000Z" })))
    fs.writeFileSync(file, line(record({ requestId: "big2", detail: "x".repeat(2 * 1024 * 1024) })))
    appendDecision(file, record({ requestId: "new2", at: "2026-10-10T20:00:00.000Z" }))
    expect(readDecisions(file).map((entry) => entry.requestId)).toEqual(["big2", "new2"])
  })

  it("redacts fields before serializing, so a secret-shaped command never corrupts a line", () => {
    const file = cmuxDecisionLogPath(dir)
    const tricky = storeShape({ repoRoot: "/repo", tool: "Bash", tokens: ["grep", "-r", "password=\"", "src"] })
    for (let index = 0; index < 3; index += 1) {
      appendDecision(file, record({ requestId: `s${index}`, outcome: "reply_sent", shape: tricky, cwd: "/repo?token=abc", floor: { verdict: "allow", reason: "token=abc" }, authority: "secret=xyz", detail: "password=\"" }))
    }
    appendDecision(file, record({ requestId: "nocwd", cwd: null }))
    const records = readDecisions(file)
    expect(records.map((entry) => entry.requestId)).toEqual(["s0", "s1", "s2", "nocwd"])
    expect(records[0]).toMatchObject({ cwd: "/repo?token=[redacted]", floor: { reason: "token=[redacted]" }, authority: "secret=[redacted]" })
    expect(repliesInWindow(records, 3_600_000, Date.parse("2026-10-10T20:30:00.000Z"))).toBe(3)
  })

  it("counts every reply sent inside the window, confirmed or not", () => {
    const now = Date.parse("2026-10-10T20:00:00.000Z")
    const records = [
      record({ outcome: "reply_sent", at: "2026-10-10T19:30:00.000Z" }),
      record({ outcome: "replied_once", at: "2026-10-10T19:30:01.000Z" }),
      record({ outcome: "reply_sent", at: "2026-10-10T18:00:00.000Z" }),
      record({ outcome: "shadow", at: "2026-10-10T19:59:00.000Z" }),
    ]
    expect(repliesInWindow(records, 3_600_000, now)).toBe(1)
  })
})

describe("cmux decision lock", () => {
  it("serializes callers, takes over a stale lock, and gives up when the lock stays held", () => {
    expect(withDecisionLock(dir, () => 7)).toBe(7)
    expect(fs.existsSync(path.join(dir, "decisions.lock"))).toBe(false)
    expect(() => withDecisionLock(dir, () => { throw new Error("inside") })).toThrow("inside")
    expect(fs.existsSync(path.join(dir, "decisions.lock"))).toBe(false)

    const lock = path.join(dir, "decisions.lock")
    fs.mkdirSync(lock)
    expect(() => withDecisionLock(dir, () => 1, 50)).toThrow("the cmux decision log is locked")
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    expect(withDecisionLock(dir, () => 2)).toBe(2)
  })

  it("lets only one of two contenders take over the same stale lock", () => {
    const lock = path.join(dir, "decisions.lock")
    fs.mkdirSync(lock, { recursive: true })
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, old, old)
    const actualStat = vi.mocked(fs.statSync).getMockImplementation()!
    let freshIno = 0
    let raced = false
    vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike, options?: unknown) => {
      const result = actualStat(target, options as never)
      if (String(target) === lock && !raced) {
        // B has just judged the lock stale. Before B renames it, A (another process) takes the same
        // stale lock over the same way and makes a fresh lock of its own.
        raced = true
        const tombstone = `${lock}.stale-${(result as fs.Stats).ino}`
        fs.renameSync(lock, tombstone)
        fs.writeFileSync(path.join(tombstone, "taken-over"), "A")
        fs.mkdirSync(lock)
        freshIno = actualStat(lock).ino
      }
      return result
    }) as typeof fs.statSync)
    try {
      expect(() => withDecisionLock(dir, () => "B ran", 60)).toThrow("the cmux decision log is locked")
    } finally {
      vi.mocked(fs.statSync).mockImplementation(actualStat)
    }
    expect(raced).toBe(true)
    expect(fs.statSync(lock).ino).toBe(freshIno)
    expect(fs.readdirSync(dir).filter((name) => name.startsWith("decisions.lock.stale-"))).toHaveLength(1)
  })

  it("lets a nested call in the same process run under the lock it already holds", () => {
    expect(withDecisionLock(dir, () => withDecisionLock(dir, () => "nested", 0))).toBe("nested")
    expect(fs.existsSync(path.join(dir, "decisions.lock"))).toBe(false)
  })

  it("retries when the lock disappears while it is checked, and keeps a lock someone else now holds", () => {
    const lock = path.join(dir, "decisions.lock")
    fs.mkdirSync(lock, { recursive: true })
    const actualStat = vi.mocked(fs.statSync).getMockImplementation()!
    let first = true
    vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (String(target) === lock && first) {
        first = false
        fs.rmdirSync(lock)
        throw Object.assign(new Error("gone"), { code: "ENOENT" })
      }
      return actualStat(target, options as never)
    }) as typeof fs.statSync)
    try {
      expect(withDecisionLock(dir, () => 3)).toBe(3)
    } finally {
      vi.mocked(fs.statSync).mockImplementation(actualStat)
    }
    // A holder whose lock was taken over leaves the new holder's lock alone, and a missing lock is fine.
    expect(withDecisionLock(dir, () => {
      fs.rmdirSync(lock)
      fs.mkdirSync(lock)
      return 4
    })).toBe(4)
    expect(fs.existsSync(lock)).toBe(true)
    fs.rmdirSync(lock)
    expect(withDecisionLock(dir, () => {
      fs.rmdirSync(lock)
      return 5
    })).toBe(5)
  })

  it("sweeps old tombstones and surfaces unexpected errors while checking or taking over", () => {
    const lock = path.join(dir, "decisions.lock")
    fs.mkdirSync(path.join(dir, "decisions.lock.stale-1"), { recursive: true })
    fs.mkdirSync(path.join(dir, "decisions.lock.stale-2"), { recursive: true })
    fs.writeFileSync(path.join(dir, "decisions.jsonl"), "")
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(path.join(dir, "decisions.lock.stale-1"), old, old)
    const actualStat = vi.mocked(fs.statSync).getMockImplementation()!
    vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (String(target).endsWith("decisions.lock.stale-2")) throw Object.assign(new Error("raced"), { code: "ENOENT" })
      return actualStat(target, options as never)
    }) as typeof fs.statSync)
    try {
      withDecisionLock(dir, () => 1)
    } finally {
      vi.mocked(fs.statSync).mockImplementation(actualStat)
    }
    expect(fs.readdirSync(dir).sort()).toEqual(["decisions.jsonl", "decisions.lock.stale-2"])

    fs.mkdirSync(lock)
    vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike, options?: unknown) => {
      if (String(target) === lock) throw Object.assign(new Error("io"), { code: "EIO" })
      return actualStat(target, options as never)
    }) as typeof fs.statSync)
    try {
      expect(() => withDecisionLock(dir, () => 1)).toThrow("io")
    } finally {
      vi.mocked(fs.statSync).mockImplementation(actualStat)
    }
    fs.rmdirSync(lock)
    expect(() => withDecisionLock(dir, () => {
      vi.mocked(fs.statSync).mockImplementation(((target: fs.PathLike, options?: unknown) => {
        if (String(target) === lock) throw Object.assign(new Error("io on release"), { code: "EIO" })
        return actualStat(target, options as never)
      }) as typeof fs.statSync)
      return 1
    })).toThrow("io on release")
    vi.mocked(fs.statSync).mockImplementation(actualStat)
    fs.rmdirSync(lock)

    fs.mkdirSync(lock)
    const stale = new Date(Date.now() - 60_000)
    fs.utimesSync(lock, stale, stale)
    const actualRename = vi.mocked(fs.renameSync).getMockImplementation()!
    vi.mocked(fs.renameSync).mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(from) === lock) throw Object.assign(new Error("readonly"), { code: "EROFS" })
      return actualRename(from, to)
    }) as typeof fs.renameSync)
    try {
      expect(() => withDecisionLock(dir, () => 1)).toThrow("readonly")
    } finally {
      vi.mocked(fs.renameSync).mockImplementation(actualRename)
    }
  })

  it("surfaces errors other than a held lock", () => {
    const actual = vi.mocked(fs.mkdirSync).getMockImplementation()!
    vi.mocked(fs.mkdirSync).mockImplementation(((target: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(target).endsWith("decisions.lock")) throw Object.assign(new Error("denied"), { code: "EACCES" })
      return actual(target, options)
    }) as typeof fs.mkdirSync)
    try {
      expect(() => withDecisionLock(dir, () => 1)).toThrow("denied")
    } finally {
      vi.mocked(fs.mkdirSync).mockImplementation(actual)
    }
  })
})

describe("cmux principles", () => {
  it("uses the bundle's own principles file, else the seed", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmux-principles-"))
    expect(readCmuxPrinciples(agentRoot)).toEqual({ source: "seed", principles: [...SEED_CMUX_PRINCIPLES] })
    expect(SEED_CMUX_PRINCIPLES).toHaveLength(8)
    fs.writeFileSync(path.join(agentRoot, "cmux-principles.md"), "# Principles\n\n1. Ask about migrations.\n- Tests are fine.\n* Lint is fine.\n")
    expect(readCmuxPrinciples(agentRoot)).toEqual({ source: "bundle", principles: ["Ask about migrations.", "Tests are fine.", "Lint is fine."] })
    fs.writeFileSync(path.join(agentRoot, "cmux-principles.md"), "# only a heading\n")
    expect(readCmuxPrinciples(agentRoot).source).toBe("seed")
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })
})
