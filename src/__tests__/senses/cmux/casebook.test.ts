import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  addCase,
  appendDecision,
  cmuxCasebookPath,
  cmuxDecisionLogPath,
  findPrecedent,
  readCasebook,
  readDecisions,
  repliesInWindow,
  type DecisionRecord,
} from "../../../senses/cmux/casebook"
import { readCmuxPrinciples, SEED_CMUX_PRINCIPLES } from "../../../senses/cmux/principles"

let dir = ""
const shape = { repoRoot: "/repo", tool: "Bash", tokens: ["make", "build"] }

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
  it("stores precedents privately and matches only the exact shape, newest first", () => {
    const file = cmuxCasebookPath(dir)
    expect(readCasebook(file)).toEqual([])
    const first = addCase(file, { verdict: "once", shape, requestId: "r1", note: "fine, token=abc123", at: "2026-10-10T20:00:00.000Z" })
    expect(first).toMatchObject({ verdict: "once", note: "fine, token=[redacted]" })
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(findPrecedent(readCasebook(file), shape)?.id).toBe(first.id)
    expect(findPrecedent(readCasebook(file), { ...shape, tokens: ["make", "build", "extra"] })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...shape, tokens: ["make", "test"] })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...shape, repoRoot: "/other" })).toBeNull()
    expect(findPrecedent(readCasebook(file), { ...shape, tool: "Edit" })).toBeNull()
    const second = addCase(file, { verdict: "ask", shape, requestId: "r2", note: "ask me", at: "2026-10-10T21:00:00.000Z" })
    expect(findPrecedent(readCasebook(file), shape)?.id).toBe(second.id)
  })

  it("ignores malformed casebook files and entries", () => {
    const file = cmuxCasebookPath(dir)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, "not json")
    expect(readCasebook(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ cases: "nope" }))
    expect(readCasebook(file)).toEqual([])
    fs.writeFileSync(file, JSON.stringify({ cases: [null, { verdict: "always", shape }, { verdict: "once", shape: { repoRoot: "/r", tool: "Bash", tokens: [1] } }, { verdict: "once" }, { verdict: "once", shape }] }))
    expect(readCasebook(file)).toHaveLength(1)
  })
})

describe("cmux decision log", () => {
  it("appends redacted records privately, rotates once, and reads both files", () => {
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

  it("counts only live once replies inside the window", () => {
    const now = Date.parse("2026-10-10T20:00:00.000Z")
    const records = [
      record({ outcome: "replied_once", at: "2026-10-10T19:30:00.000Z" }),
      record({ outcome: "replied_once", at: "2026-10-10T18:00:00.000Z" }),
      record({ outcome: "shadow", at: "2026-10-10T19:59:00.000Z" }),
    ]
    expect(repliesInWindow(records, 3_600_000, now)).toBe(1)
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
