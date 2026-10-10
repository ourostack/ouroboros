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
  return { ...actual, mkdirSync: vi.fn(actual.mkdirSync) }
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

  it("ignores malformed casebook files and entries", () => {
    const file = cmuxCasebookPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, "not json")
    expect(readCasebook(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ cases: "nope" }))
    expect(readCasebook(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ cases: [null, { verdict: "always", shape }, { verdict: "once", shape: { ...shape, digest: 1 } }, { verdict: "once", shape: { repoRoot: "/r", tool: "Bash", tokens: ["x"] } }, { verdict: "once" }, { verdict: "once", shape }] }))
    expect(readCasebook(file)).toHaveLength(1)
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
