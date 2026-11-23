import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  applyRelease,
  isReleasableCommit,
  parseChangeNote,
  planRelease,
  runReleaseVersionCli,
  versionAfter,
} = require(path.resolve(__dirname, "../../../scripts/release-version.cjs"))

const BASE = "0.1.0-alpha.10"

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

function json(root: string, file: string, value: unknown): void {
  write(root, file, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(root: string, file: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"))
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function commit(cwd: string, subject: string): void {
  git(cwd, "add", "-A")
  git(cwd, "commit", "-q", "-m", subject)
}

function writeReleaseFiles(root: string, version: string, changelog: unknown[]): void {
  const lock = { name: "@ouro.bot/cli", version, lockfileVersion: 3, packages: { "": { name: "@ouro.bot/cli", version } } }
  json(root, "package.json", { name: "@ouro.bot/cli", version, dependencies: { semver: "^7.0.0" } })
  json(root, "package-lock.json", lock)
  json(root, "npm-shrinkwrap.json", lock)
  json(root, "packages/ouro.bot/package.json", { name: "ouro.bot", version })
  json(root, "changelog.json", { versions: changelog })
  write(root, "deploy/unraid/sanctuary.xml", `<Container><Name>ouro-butler</Name><Repository>ghcr.io/ourostack/ouroboros-butler:${version}</Repository></Container>\n`)
  json(root, "deploy/unraid/sanctuary.ouro/bundle-meta.json", { runtimeVersion: version, bundleSchemaVersion: 3 })
}

// A repository whose last version change (the anchor) set BASE, as main looks once releases stop bumping in PRs.
function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-"))
  git(root, "init", "-q", "-b", "main")
  git(root, "config", "user.email", "t@example.com")
  git(root, "config", "user.name", "t")
  writeReleaseFiles(root, "0.1.0-alpha.9", [{ version: "0.1.0-alpha.9", changes: ["older"] }])
  write(root, "src/a.ts", "export const a = 1\n")
  commit(root, "older release (#1)")
  writeReleaseFiles(root, BASE, [{ version: BASE, changes: ["base release"] }, { version: "0.1.0-alpha.9", changes: ["older"] }])
  commit(root, "base release (#2)")
  return root
}

describe("versionAfter", () => {
  it("counts a prerelease forward by its last number", () => {
    expect(versionAfter("0.1.0-alpha.1378", 0)).toBe("0.1.0-alpha.1378")
    expect(versionAfter("0.1.0-alpha.1378", 3)).toBe("0.1.0-alpha.1381")
  })

  it("counts a release without a prerelease number forward by its patch", () => {
    expect(versionAfter("1.2.3", 2)).toBe("1.2.5")
    expect(versionAfter("0.2.0-beta", 1)).toBe("0.2.1")
  })

  it("rejects a version that is not semver", () => {
    expect(() => versionAfter("nope", 1)).toThrow("not valid semver")
    expect(() => versionAfter("1.2", 1)).toThrow("not valid semver")
  })

  it("drops build metadata", () => {
    expect(versionAfter("0.1.0-alpha.4+abc", 1)).toBe("0.1.0-alpha.5")
  })
})

describe("parseChangeNote", () => {
  it("turns each paragraph and each bullet into one changelog line", () => {
    expect(parseChangeNote([
      "# Heading lines are ignored",
      "",
      "The first change, written",
      "across two lines.",
      "",
      "- A bullet.",
      "* Another bullet",
      "  that wraps.",
      "",
    ].join("\n"))).toEqual([
      "The first change, written across two lines.",
      "A bullet.",
      "Another bullet that wraps.",
    ])
  })

  it("gives nothing for an empty note", () => {
    expect(parseChangeNote("\n  \n# only a heading\n")).toEqual([])
  })
})

describe("isReleasableCommit", () => {
  it("releases a change to shipped source, the wrapper, package.json or a change note", () => {
    expect(isReleasableCommit(["src/heart/x.ts"])).toBe(true)
    expect(isReleasableCommit(["packages/ouro.bot/index.js"])).toBe(true)
    expect(isReleasableCommit(["package.json"])).toBe(true)
    expect(isReleasableCommit(["changes/fix-thing.md"])).toBe(true)
  })

  it("does not release tests, docs or workflow-only changes", () => {
    expect(isReleasableCommit(["src/__tests__/x.test.ts", "docs/a.md", ".github/workflows/coverage.yml", "changes/README.md", "changes/sub/x.txt"])).toBe(false)
  })
})

describe("planRelease", { timeout: 30_000 }, () => {
  it("releases the anchor's own version when nothing has landed after it", () => {
    const root = makeRepo()
    const plan = planRelease({ root })
    expect(plan.baseVersion).toBe(BASE)
    expect(plan.version).toBe(BASE)
    expect(plan.entries).toEqual([])
    expect(plan.anchor).toBe(git(root, "rev-parse", "HEAD").trim())
  })

  it("gives each releasable commit after the anchor the next number, with its change notes as its changelog entry", () => {
    const root = makeRepo()
    write(root, "src/a.ts", "export const a = 2\n")
    write(root, "changes/first.md", "First fix.\n\n- And a detail.\n")
    commit(root, "first (#3)")
    write(root, "docs/readme.md", "docs only\n")
    commit(root, "docs only (#4)")
    write(root, "src/b.ts", "export const b = 1\n")
    commit(root, "second without a note (#5)")
    write(root, "changes/third.md", "Third.\n")
    commit(root, "third, a note on its own (#6)")

    const plan = planRelease({ root })
    expect(plan.version).toBe("0.1.0-alpha.13")
    expect(plan.entries.map((entry: { version: string; changes: string[] }) => [entry.version, entry.changes])).toEqual([
      ["0.1.0-alpha.13", ["Third."]],
      ["0.1.0-alpha.12", ["second without a note (#5)"]],
      ["0.1.0-alpha.11", ["First fix.", "And a detail."]],
    ])
  })

  it("keeps the version of the last release for a commit that releases nothing", () => {
    const root = makeRepo()
    write(root, "src/a.ts", "export const a = 2\n")
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    write(root, "docs/readme.md", "docs only\n")
    commit(root, "docs only (#4)")
    expect(planRelease({ root }).version).toBe("0.1.0-alpha.11")
  })

  it("counts only notes a commit adds, not edits to an earlier note", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    write(root, "changes/first.md", "First, reworded.\n")
    write(root, "src/a.ts", "export const a = 3\n")
    commit(root, "second (#4)")
    const plan = planRelease({ root })
    expect(plan.entries[0]).toMatchObject({ version: "0.1.0-alpha.12", changes: ["second (#4)"] })
  })

  it("restarts the count at a deliberate version change, such as a new release line", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const lineStart = "0.2.0-alpha.0"
    const changelog = readJson(root, "changelog.json").versions
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...changelog])
    commit(root, "start 0.2 (#4)")
    write(root, "changes/next.md", "Next.\n")
    commit(root, "next (#5)")
    const plan = planRelease({ root })
    expect(plan.baseVersion).toBe(lineStart)
    expect(plan.version).toBe("0.2.0-alpha.1")
    expect(plan.entries).toHaveLength(1)
  })

  it("ignores dependency-only edits to package.json when finding the anchor", () => {
    const root = makeRepo()
    const pkg = readJson(root, "package.json")
    json(root, "package.json", { ...pkg, dependencies: { semver: "^7.6.0" } })
    commit(root, "bump a dependency (#3)")
    const plan = planRelease({ root })
    expect(plan.baseVersion).toBe(BASE)
    expect(plan.version).toBe("0.1.0-alpha.11")
    expect(plan.entries[0].changes).toEqual(["bump a dependency (#3)"])
  })

  it("plans from the commit, not from release files a previous apply already wrote", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    applyRelease({ root, plan: planRelease({ root }) })
    expect(planRelease({ root }).version).toBe("0.1.0-alpha.11")
  })

  it("refuses a shallow clone, which cannot see the anchor", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-shallow-"))
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, "clone")
    expect(() => planRelease({ root: path.join(shallow, "clone") })).toThrow("fetch-depth: 0")
  })

  it("refuses a history with no version anywhere in package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-none-"))
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    json(root, "package.json", { name: "x" })
    commit(root, "no version")
    expect(() => planRelease({ root })).toThrow("no commit sets package.json's version")
  })
})

describe("applyRelease", { timeout: 30_000 }, () => {
  it("writes the planned version into every release file and puts the new entries on top of the changelog", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    write(root, "changes/second.md", "Second.\n")
    commit(root, "second (#4)")
    const plan = planRelease({ root })
    applyRelease({ root, plan })
    applyRelease({ root, plan })

    const next = "0.1.0-alpha.12"
    expect(readJson(root, "package.json").version).toBe(next)
    expect(readJson(root, "package.json").dependencies).toEqual({ semver: "^7.0.0" })
    expect(readJson(root, "packages/ouro.bot/package.json").version).toBe(next)
    for (const lock of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const parsed = readJson(root, lock)
      expect([parsed.version, parsed.packages[""].version]).toEqual([next, next])
    }
    expect(fs.readFileSync(path.join(root, "deploy/unraid/sanctuary.xml"), "utf8")).toContain(`ouroboros-butler:${next}</Repository>`)
    expect(readJson(root, "deploy/unraid/sanctuary.ouro/bundle-meta.json").runtimeVersion).toBe(next)
    expect(readJson(root, "changelog.json").versions).toEqual([
      { version: next, changes: ["Second."] },
      { version: "0.1.0-alpha.11", changes: ["First."] },
      { version: BASE, changes: ["base release"] },
      { version: "0.1.0-alpha.9", changes: ["older"] },
    ])
  })

  it("keeps the changelog's other keys", () => {
    const root = makeRepo()
    json(root, "changelog.json", { _note: "keep me", versions: readJson(root, "changelog.json").versions })
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    applyRelease({ root, plan: planRelease({ root }) })
    expect(readJson(root, "changelog.json")._note).toBe("keep me")
  })
})

describe("runReleaseVersionCli", { timeout: 30_000 }, () => {
  function capture(root: string, argv: string[]) {
    const out: string[] = []
    const err: string[] = []
    const code = runReleaseVersionCli(argv, { root, log: (line: string) => out.push(line), error: (line: string) => err.push(line) })
    return { code, out, err }
  }

  it("prints the version for HEAD without writing anything", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    expect(capture(root, ["version"])).toMatchObject({ code: 0, out: ["0.1.0-alpha.11"] })
    expect(readJson(root, "package.json").version).toBe(BASE)
  })

  it("applies the release and prints only the version on stdout", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const result = capture(root, ["apply"])
    expect(result.code).toBe(0)
    expect(result.out).toEqual(["0.1.0-alpha.11"])
    expect(result.err.join("\n")).toContain("release files written for 0.1.0-alpha.11")
    expect(readJson(root, "package.json").version).toBe("0.1.0-alpha.11")
  })

  it("prints the release notes for HEAD's version", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n\nSecond line.\n")
    commit(root, "first (#3)")
    expect(capture(root, ["notes"])).toMatchObject({ code: 0, out: ["First.\n\nSecond line."] })
  })

  it("prints the anchor's committed notes when HEAD is the anchor", () => {
    const root = makeRepo()
    expect(capture(root, ["notes"])).toMatchObject({ code: 0, out: ["base release"] })
  })

  it("prints the commit that released HEAD's version, which is HEAD only when HEAD releases", () => {
    const root = makeRepo()
    const anchor = git(root, "rev-parse", "HEAD").trim()
    expect(capture(root, ["commit"]).out).toEqual([anchor])
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const first = git(root, "rev-parse", "HEAD").trim()
    expect(capture(root, ["commit"]).out).toEqual([first])
    write(root, "docs/x.md", "docs\n")
    commit(root, "docs (#4)")
    expect(capture(root, ["commit"]).out).toEqual([first])
  })

  it("fails with usage for an unknown command and with the reason for a planning error", () => {
    const root = makeRepo()
    expect(capture(root, ["bogus"])).toMatchObject({ code: 2 })
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-nogit-"))
    const failed = capture(empty, ["version"])
    expect(failed.code).toBe(1)
    expect(failed.err[0]).toBe("release version: FAIL")
  })
})
