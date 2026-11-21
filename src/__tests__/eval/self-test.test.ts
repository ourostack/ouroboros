import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { evaluate } from "../../eval/assertions"
import type { Case } from "../../eval/domain/case"
import { loadCases, selfTest } from "../../eval/self-test"

const CASES_DIR = path.resolve(__dirname, "../../eval/cases/sanctuary-books")
const cases = () => loadCases(CASES_DIR)
const byId = (id: string) => cases().find(entry => entry.id === id)!

// Patterns committed cases must never match: real addresses, long numbers (ids, phone numbers, chat ids) and the
// real book the failures were about. The title is assembled from parts so it never appears in a committed file.
const REAL_TITLE = new RegExp(["How", "to", "Win"].join("\\s+"), "i")
const LEAK_PATTERNS: Array<[string, RegExp]> = [
  ["an email outside example.invalid", /[A-Za-z0-9._%+-]+@(?!example\.invalid\b)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/],
  ["a number of nine or more digits", /\d{9,}/],
  ["the real title", REAL_TITLE],
]
/** Leak findings in a case file's text; SHA-256 hashes are stripped first, since hex can hold long digit runs. */
const leaks = (text: string) => {
  const scrubbed = text.replace(/\b[0-9a-f]{64}\b/g, "")
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(scrubbed)).map(([name]) => name)
}

const tempDirs: string[] = []
afterEach(() => { for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-cases-"))
  tempDirs.push(dir)
  return dir
}

describe("the Butler book cases", () => {
  it("both load and validate, in file order", () => {
    expect(cases().map(entry => entry.id)).toEqual(["remove-bad-copy", "unreadable-edition"])
  })

  it.each(["unreadable-edition", "remove-bad-copy"])("%s passes its self-test", id => {
    expect(selfTest(byId(id))).toEqual({ ok: true, problems: [] })
  })

  it("carries the planned fail fixtures", () => {
    expect(Object.keys(byId("unreadable-edition").fixtures.fail)).toEqual(
      ["sent-scan", "sent-nothing", "sent-wrong-work", "sent-unchecked", "accepted-check-failure", "sent-elsewhere", "removed-other-book"])
    expect(Object.keys(byId("remove-bad-copy").fixtures.fail)).toEqual(
      ["said-cant", "wiped-library", "deleted-without-backup", "backup-was-seeded-file", "mailed-again"])
  })

  it("fails sent-unchecked only on the read-before-send rule, so that rule is not vacuous", () => {
    const c = byId("unreadable-edition")
    const failed = evaluate(c, c.fixtures.fail["sent-unchecked"]!).checks.filter(check => !check.ok).map(check => check.name)
    expect(failed).toEqual(["trace.readBeforeSend"])
  })

  it("holds none of the committed leak patterns", () => {
    for (const file of fs.readdirSync(CASES_DIR)) {
      expect(leaks(fs.readFileSync(path.join(CASES_DIR, file), "utf8")), file).toEqual([])
    }
  })

  it("leak patterns catch what they are for", () => {
    expect(leaks("mail a.person@gmail.com")).toEqual(["an email outside example.invalid"])
    expect(leaks("pocketbook@example.invalid")).toEqual([])
    expect(leaks("chat 123456789")).toEqual(["a number of nine or more digits"])
    expect(leaks(`hash ${"1".repeat(64)}`)).toEqual([])
    expect(leaks(["how", "to", "win"].join("  "))).toEqual(["the real title"])
  })
})

describe("selfTest", () => {
  it("rejects a case whose fail fixture passes every assertion, naming the fixture", () => {
    const c: Case = structuredClone(byId("remove-bad-copy"))
    c.fixtures.fail["said-cant"] = c.fixtures.pass
    const result = selfTest(c)
    expect(result.ok).toBe(false)
    expect(result.problems).toEqual([expect.stringContaining("said-cant")])
  })

  it("rejects a case whose pass fixture fails, naming the failed checks", () => {
    const c: Case = structuredClone(byId("remove-bad-copy"))
    c.fixtures.pass = c.fixtures.fail["mailed-again"]!
    const result = selfTest(c)
    expect(result.ok).toBe(false)
    expect(result.problems.join("\n")).toContain("pass fixture fails mail.none")
  })

  it("rejects a case with an assertion no fail fixture fails", () => {
    const c: Case = structuredClone(byId("unreadable-edition"))
    delete c.fixtures.fail["sent-elsewhere"]
    expect(selfTest(c)).toEqual({ ok: false, problems: ["no fail fixture fails mail.onlyTo"] })
  })

  it("rejects an assertion name not in the vocabulary without grading anything", () => {
    const c: Case = structuredClone(byId("unreadable-edition"))
    c.assertions.push({ name: "mail.maybe" })
    expect(selfTest(c)).toEqual({ ok: false, problems: ["unknown assertion mail.maybe"] })
  })

  it("reports an assertion whose arguments it cannot use", () => {
    const c: Case = structuredClone(byId("unreadable-edition"))
    c.assertions.push({ name: "mail.onlyTo", args: {} })
    const result = selfTest(c)
    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain("mail.onlyTo needs args.address")
  })
})

describe("loadCases", () => {
  it("reads only .json files, sorted, and names the file that fails validation", () => {
    const dir = tempDir()
    const valid = fs.readFileSync(path.join(CASES_DIR, "remove-bad-copy.json"), "utf8")
    fs.writeFileSync(path.join(dir, "b.json"), valid)
    fs.writeFileSync(path.join(dir, "notes.txt"), "not a case")
    expect(loadCases(dir).map(entry => entry.id)).toEqual(["remove-bad-copy"])
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ schemaVersion: 2 }))
    expect(() => loadCases(dir)).toThrow(/a\.json: Invalid case: schemaVersion/)
  })

  it("names a file that is not JSON, and refuses a folder with no cases", () => {
    const dir = tempDir()
    expect(() => loadCases(dir)).toThrow("no case files")
    fs.writeFileSync(path.join(dir, "broken.json"), "{")
    expect(() => loadCases(dir)).toThrow(/broken\.json: /)
  })

  it("refuses two cases with the same id", () => {
    const dir = tempDir()
    const valid = fs.readFileSync(path.join(CASES_DIR, "remove-bad-copy.json"), "utf8")
    fs.writeFileSync(path.join(dir, "a.json"), valid)
    fs.writeFileSync(path.join(dir, "b.json"), valid)
    expect(() => loadCases(dir)).toThrow("duplicate case id remove-bad-copy")
  })
})
