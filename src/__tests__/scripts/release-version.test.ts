import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const {
  applyRelease,
  compareVersions,
  npmRegistry,
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
  write(root, "changes/README.md", "How change notes work.\n")
  commit(root, "base release (#2)")
  return root
}

function head(root: string): string {
  return git(root, "rev-parse", "HEAD").trim()
}

type Published = Record<string, { commit?: string; changelog?: Array<{ version: string; changes: string[] }> }>

// What npm has published: each version's commit (gitHead) and the changelog.json its tarball carries.
function registry(published: Published, unreadable: string[] = []) {
  const asked: string[] = []
  return {
    asked,
    versions: () => Object.keys(published),
    gitHeads: () => new Map(Object.entries(published).flatMap(([version, release]) => (release.commit ? [[version, release.commit]] : []))),
    gitHead: (version: string) => published[version]?.commit,
    changelog: (version: string) => {
      asked.push(version)
      if (unreadable.includes(version)) throw new Error(`could not download @ouro.bot/cli@${version} from npm: ETARGET`)
      return published[version]?.changelog ?? []
    },
  }
}

function entryPairs(plan: { entries: Array<{ version: string; changes: string[] }> }): Array<[string, string[]]> {
  return plan.entries.map((entry) => [entry.version, entry.changes])
}

function historyPairs(plan: { history: Array<{ version: string; changes: string[] }> }): Array<[string, string[]]> {
  return plan.history.map((entry) => [entry.version, entry.changes])
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
    // Nothing is on npm, so every numbered commit is unpublished, and its notes fold into the one entry.
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.13", ["First fix.", "And a detail.", "Third."]]])
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

  it("counts only notes a commit adds, not edits to a note npm already released", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    write(root, "changes/first.md", "First, reworded.\n")
    write(root, "src/a.ts", "export const a = 3\n")
    commit(root, "second (#4)")
    const plan = planRelease({ root, registry: published })
    expect(plan.entries[0]).toMatchObject({ version: "0.1.0-alpha.12", changes: ["second (#4)"] })
    // npm's 11 is rebuilt from git, with its note as 11's own commit left it.
    expect(historyPairs(plan)).toEqual([["0.1.0-alpha.11", ["First."]]])
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
    // npm never had 0.2.0-alpha.0, so the line's own entry goes into the version that publishes.
    expect(entryPairs(plan)).toEqual([["0.2.0-alpha.1", ["new line", "First.", "Next."]]])
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

  it("does not take a moved or reformatted version line for a version change", () => {
    const root = makeRepo()
    const anchor = head(root)
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const { version, ...rest } = readJson(root, "package.json")
    json(root, "package.json", { ...rest, version })
    commit(root, "move package.json's version line (#4)")
    write(root, "changes/next.md", "Next.\n")
    commit(root, "next (#5)")
    const plan = planRelease({ root })
    expect(plan).toMatchObject({ anchor, baseVersion: BASE, version: "0.1.0-alpha.13" })
    expect(entryPairs(plan).map(([v]) => v)).toEqual(["0.1.0-alpha.13"])
  })

  it("reads a change note in a push as the push left it", () => {
    const root = makeRepo()
    const before = head(root)
    write(root, "changes/first.md", "First.\n")
    commit(root, "first commit of a rebase merge")
    write(root, "changes/first.md", "First, reworded.\n\nMore.\n")
    commit(root, "second commit of a rebase merge")
    write(root, "changes/gone.md", "Gone.\n")
    commit(root, "third commit of a rebase merge")
    fs.renameSync(path.join(root, "changes/gone.md"), path.join(root, "gone.md.aside"))
    commit(root, "fourth commit of a rebase merge")
    expect(entryPairs(planRelease({ root, before }))).toEqual([["0.1.0-alpha.13", ["First, reworded.", "More.", "Gone."]]])
  })

  it("releases nothing for a commit that only removes change notes", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const before = head(root)
    fs.renameSync(path.join(root, "changes/first.md"), path.join(root, "first.md.aside"))
    commit(root, "tidy old notes (#4)")
    expect(planRelease({ root, before })).toMatchObject({ release: false, version: "0.1.0-alpha.11" })
  })

  it("reads notes whose names are not ASCII", () => {
    const root = makeRepo()
    write(root, "changes/caf\u00e9.md", "Caf\u00e9.\n")
    commit(root, "cafe (#3)")
    expect(entryPairs(planRelease({ root }))).toEqual([["0.1.0-alpha.11", ["Caf\u00e9."]]])
  })

  it("plans from the commit, not from release files a previous apply already wrote", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    applyRelease({ root, plan: planRelease({ root }) })
    expect(planRelease({ root }).version).toBe("0.1.0-alpha.11")
  })

  it("publishes one version for a push of several commits, with every note in it, even when its last commit releases nothing", () => {
    const root = makeRepo()
    const before = head(root)
    write(root, "src/a.ts", "export const a = 2\n")
    write(root, "changes/first.md", "First.\n")
    commit(root, "first commit of a rebase merge")
    write(root, "changes/second.md", "Second.\n")
    commit(root, "second commit of a rebase merge")
    write(root, "docs/readme.md", "docs only\n")
    commit(root, "last commit of a rebase merge, docs only")

    const plan = planRelease({ root, before })
    expect(plan.release).toBe(true)
    expect(plan.version).toBe("0.1.0-alpha.12")
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.12", ["First.", "Second."]]])
  })

  it("publishes nothing for a push whose commits release nothing", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const before = head(root)
    write(root, "docs/readme.md", "docs only\n")
    commit(root, "docs (#4)")
    write(root, "src/__tests__/a.test.ts", "test\n")
    commit(root, "tests (#5)")
    const plan = planRelease({ root, before })
    expect(plan.release).toBe(false)
    expect(plan.version).toBe("0.1.0-alpha.11")
  })

  it("treats a missing or unknown push start as a push of HEAD alone", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    write(root, "changes/second.md", "Second.\n")
    commit(root, "second (#4)")
    for (const before of [undefined, "0000000000000000000000000000000000000000", "not-a-commit"]) {
      const plan = planRelease({ root, before })
      expect(plan.release).toBe(true)
      expect(entryPairs(plan)).toEqual([["0.1.0-alpha.12", ["First.", "Second."]]])
    }
  })

  it("folds the notes of every commit npm never released into this push's entry, whatever tags exist", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    write(root, "changes/b.md", "B.\n")
    commit(root, "b, whose push failed to publish (#4)")
    const before = head(root)
    write(root, "changes/c.md", "C.\n")
    commit(root, "c (#5)")

    const untagged = planRelease({ root, before, registry: published })
    git(root, "tag", "v0.1.0-alpha.12", "HEAD~1")
    expect(planRelease({ root, before, registry: published })).toEqual(untagged)
    expect(untagged.version).toBe("0.1.0-alpha.13")
    expect(entryPairs(untagged)).toEqual([["0.1.0-alpha.13", ["B.", "C."]]])
  })

  it("keeps npm's published history once a new release line starts", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const published = registry({
      [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim() },
      "0.1.0-alpha.11": { commit: head(root) },
    })
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#4)")
    write(root, "changes/next.md", "Next.\n")
    commit(root, "next (#5)")

    const plan = planRelease({ root, registry: published })
    expect(plan.version).toBe("0.2.0-alpha.1")
    // This push publishes 0.2.0-alpha.1, never 0.2.0-alpha.0, so the line's own entry goes into it.
    expect(entryPairs(plan)).toEqual([["0.2.0-alpha.1", ["new line", "Next."]]])
    applyRelease({ root, plan, registry: published })
    const versions = readJson(root, "changelog.json").versions
    expect(versions.map((entry: { version: string }) => entry.version)).toEqual(["0.2.0-alpha.1", "0.1.0-alpha.11", BASE, "0.1.0-alpha.9"])
    expect(versions[1].changes).toEqual(["First."])
    expect(published.asked).toEqual([])
  })

  it("releases a new line's own version when the push lands it", () => {
    const root = makeRepo()
    const before = head(root)
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#3)")
    const plan = planRelease({ root, before })
    expect(plan).toMatchObject({ release: true, version: lineStart })
    expect(entryPairs(plan)).toEqual([[lineStart, ["new line"]]])
  })

  it("refuses a shallow clone, which cannot see the anchor", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const shallow = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-shallow-"))
    git(shallow, "clone", "-q", "--depth", "1", `file://${root}`, "clone")
    expect(() => planRelease({ root: path.join(shallow, "clone") })).toThrow("fetch-depth: 0")
  })

  it("refuses a HEAD without changes/README.md instead of releasing nothing", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    fs.renameSync(path.join(root, "changes/README.md"), path.join(root, "README-moved.md"))
    commit(root, "lose the notes README (#3)")
    expect(() => planRelease({ root })).toThrow("changes/README.md is missing at HEAD")
  })

  it("numbers from npm's last release, whatever today's rules make of the commits before it", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    write(root, "docs/x.md", "docs\n")
    commit(root, "docs that an older rule released (#4)")
    const published = registry({
      "0.1.0-alpha.11": { commit: git(root, "rev-parse", "HEAD~1").trim() },
      "0.1.0-alpha.12": { commit: head(root), changelog: [{ version: "0.1.0-alpha.12", changes: ["Docs."] }, { version: "0.1.0-alpha.11", changes: ["A."] }] },
    })
    const before = head(root)
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#5)")
    const plan = planRelease({ root, before, registry: published })
    expect(plan).toMatchObject({ release: true, version: "0.1.0-alpha.13", baseVersion: "0.1.0-alpha.12", published: "0.1.0-alpha.12" })
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.13", ["B."]]])
    expect(published.asked).toEqual([])
  })

  it("counts from a release published before this push, even when npm already has this push's own version", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const before = head(root)
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#4)")
    const published = registry({
      "0.1.0-alpha.11": { commit: before },
      "0.1.0-alpha.12": { commit: head(root) },
      "0.3.0": { commit: "f".repeat(40) },
      "not-a-version": { commit: before },
    })
    expect(planRelease({ root, before, registry: published })).toMatchObject({ release: true, version: "0.1.0-alpha.12", published: "0.1.0-alpha.11" })
  })

  it("falls back to a release's v<version> tag when npm has no gitHead for it", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    git(root, "tag", "-a", "-m", "release", "v0.1.0-alpha.11")
    const before = head(root)
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#4)")
    expect(planRelease({ root, before, registry: registry({ "0.1.0-alpha.11": {} }) })).toMatchObject({ version: "0.1.0-alpha.12", published: "0.1.0-alpha.11" })
  })

  it("stops when none of npm's releases came from this history", () => {
    const root = makeRepo()
    expect(() => planRelease({ root, registry: registry({ "0.1.0-alpha.11": { commit: "e".repeat(40) } }) }))
      .toThrow("none of npm's published versions came from a commit in this history")
  })

  it("counts a version change within a release line onto or below the count, or back to an older one, as an ordinary commit", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    for (const stale of ["0.1.0-alpha.11", "0.1.0-alpha.3", "0.1.0-alpha.12", "0.0.9"]) {
      const branch = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-clone-"))
      git(branch, "clone", "-q", root, ".")
      git(branch, "config", "user.email", "t@example.com")
      git(branch, "config", "user.name", "t")
      writeReleaseFiles(branch, stale, readJson(branch, "changelog.json").versions)
      commit(branch, `an old-style bump to ${stale} (#4)`)
      expect(planRelease({ root: branch, registry: published })).toMatchObject({ release: true, version: "0.1.0-alpha.12" })
    }
    const fallback = makeRepo()
    write(fallback, "changes/a.md", "A.\n")
    commit(fallback, "a (#3)")
    writeReleaseFiles(fallback, "0.1.0-alpha.3", readJson(fallback, "changelog.json").versions)
    commit(fallback, "an old-style bump back to 3 (#4)")
    expect(planRelease({ root: fallback }).version).toBe("0.1.0-alpha.12")
  })

  it("keeps counting across a stale bump onto a counted number, and only a move to a higher release line restarts", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    write(root, "changes/b.md", "B.\n")
    commit(root, "b, counted 12 but never published (#4)")
    writeReleaseFiles(root, "0.1.0-alpha.12", readJson(root, "changelog.json").versions)
    commit(root, "an old-style bump to 12 that landed late (#5)")
    write(root, "changes/c.md", "C.\n")
    commit(root, "c (#6)")
    const plan = planRelease({ root, registry: published })
    expect(plan.version).toBe("0.1.0-alpha.14")
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.14", ["B.", "C."]]])
    writeReleaseFiles(root, "0.2.0-alpha.0", readJson(root, "changelog.json").versions)
    commit(root, "start 0.2 (#7)")
    writeReleaseFiles(root, "0.1.0-alpha.20", readJson(root, "changelog.json").versions)
    commit(root, "a stale bump back onto the old line (#8)")
    expect(planRelease({ root, registry: published }).version).toBe("0.2.0-alpha.1")
  })

  it("keeps releasing after a rebase merge of a bump and its drop-bump, on that push and every later one", () => {
    const root = makeRepo()
    const base = head(root)
    write(root, "changes/a.md", "A.\n")
    commit(root, "feature a (#3)")
    const published = registry({ [BASE]: { commit: base }, "0.1.0-alpha.11": { commit: head(root) } })
    const before = head(root)
    write(root, "src/b.ts", "export const b = 1\n")
    writeReleaseFiles(root, "0.1.0-alpha.11", readJson(root, "changelog.json").versions)
    commit(root, "feature b and an old-style bump to 11")
    writeReleaseFiles(root, BASE, readJson(root, "changelog.json").versions)
    write(root, "changes/b.md", "B.\n")
    commit(root, "drop the bump")
    expect(planRelease({ root, before, registry: published })).toMatchObject({ release: true, version: "0.1.0-alpha.13" })
    const after = head(root)
    write(root, "changes/c.md", "C.\n")
    commit(root, "a later fix (#5)")
    expect(planRelease({ root, before: after, registry: published })).toMatchObject({ release: true, version: "0.1.0-alpha.14" })
  })

  it("labels the notes of a push npm never published with the new release line that follows, not the skipped number", () => {
    const root = makeRepo()
    const published = registry({ [BASE]: { commit: head(root) } })
    write(root, "src/a.ts", "export const a = 2\n")
    write(root, "changes/a.md", "A note.\n")
    commit(root, "feature a, whose publish failed (#3)")
    const before = head(root)
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#4)")
    const plan = planRelease({ root, before, registry: published })
    expect(plan.version).toBe(lineStart)
    expect(entryPairs(plan)).toEqual([[lineStart, ["new line", "A note."]]])
    expect(plan.history).toEqual([])
  })

  it("gives the same version whether or not npm lists the last push's release yet, and heals the entries once it does", () => {
    const root = makeRepo()
    const base = head(root)
    write(root, "changes/a.md", "A note.\n")
    commit(root, "feature a (#3)")
    const before = head(root)
    write(root, "changes/b.md", "B note.\n")
    commit(root, "feature b (#4)")
    const fresh = planRelease({ root, before, registry: registry({ [BASE]: { commit: base }, "0.1.0-alpha.11": { commit: before } }) })
    const stale = planRelease({ root, before, registry: registry({ [BASE]: { commit: base } }) })
    expect(fresh.version).toBe("0.1.0-alpha.12")
    expect(stale.version).toBe("0.1.0-alpha.12")
    expect(entryPairs(fresh)).toEqual([["0.1.0-alpha.12", ["B note."]]])
    expect(historyPairs(fresh)).toEqual([["0.1.0-alpha.11", ["A note."]]])
    expect(entryPairs(stale)).toEqual([["0.1.0-alpha.12", ["A note.", "B note."]]])
    expect(stale.history).toEqual([])
  })

  it("rebuilds every release since the switch from git, folding a version npm never had into the next one", () => {
    const root = makeRepo()
    const base = head(root)
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const eleven = head(root)
    write(root, "changes/b.md", "B.\n")
    commit(root, "b, whose publish failed (#4)")
    write(root, "changes/c.md", "C.\n")
    commit(root, "c (#5)")
    const thirteen = head(root)
    write(root, "docs/x.md", "docs\n")
    commit(root, "docs (#6)")
    const before = head(root)
    write(root, "changes/d.md", "D.\n")
    commit(root, "d (#7)")
    const published = registry({ "0.1.0-alpha.9": { commit: git(root, "rev-parse", `${base}~1`).trim() }, [BASE]: { commit: base }, "0.1.0-alpha.11": { commit: eleven }, "0.1.0-alpha.13": { commit: thirteen } })
    const plan = planRelease({ root, before, registry: published })
    expect(plan.version).toBe("0.1.0-alpha.14")
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.14", ["D."]]])
    expect(historyPairs(plan)).toEqual([["0.1.0-alpha.13", ["B.", "C."]], ["0.1.0-alpha.11", ["A."]]])
    expect(published.asked).toEqual([])
  })

  it("rebuilds a published new release line's entry from its own changelog entry and the notes npm skipped before it", () => {
    const root = makeRepo()
    const base = head(root)
    write(root, "changes/a.md", "A.\n")
    commit(root, "a, whose publish failed (#3)")
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#4)")
    const published = registry({ [BASE]: { commit: base }, [lineStart]: { commit: head(root) } })
    const before = head(root)
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#5)")
    const plan = planRelease({ root, before, registry: published })
    expect(plan.version).toBe("0.2.0-alpha.1")
    expect(historyPairs(plan)).toEqual([[lineStart, ["new line", "A."]]])
  })

  it("jumps to an old-style bump above the count, so a handover never reuses the number that commit published", () => {
    const root = makeRepo()
    const base = head(root)
    write(root, "src/a.ts", "export const a = 2\n")
    writeReleaseFiles(root, "0.1.0-alpha.13", [{ version: "0.1.0-alpha.13", changes: ["The old-style entry."] }, ...readJson(root, "changelog.json").versions])
    commit(root, "an old-style bump that skipped 11 and 12 (#3)")
    const bumped = head(root)
    expect(planRelease({ root, before: base, registry: registry({ [BASE]: { commit: base } }) })).toMatchObject({ release: true, version: "0.1.0-alpha.13" })
    expect(entryPairs(planRelease({ root, before: base, registry: registry({ [BASE]: { commit: base } }) }))).toEqual([["0.1.0-alpha.13", ["The old-style entry."]]])
    write(root, "changes/switch.md", "The switch.\n")
    commit(root, "the switch (#4)")

    // npm lists 13: count from it.
    const listed = planRelease({ root, before: bumped, registry: registry({ [BASE]: { commit: base }, "0.1.0-alpha.13": { commit: bumped } }) })
    expect(listed.version).toBe("0.1.0-alpha.14")
    expect(entryPairs(listed)).toEqual([["0.1.0-alpha.14", ["The switch."]]])
    expect(listed.history).toEqual([])
    // npm hasn't listed 13 yet, or its publish failed: still 14, never 13, and 13's own entry is kept, under 14.
    const unlisted = planRelease({ root, before: bumped, registry: registry({ [BASE]: { commit: base } }) })
    expect(unlisted.version).toBe("0.1.0-alpha.14")
    expect(entryPairs(unlisted)).toEqual([["0.1.0-alpha.14", ["The old-style entry.", "The switch."]]])
    expect(unlisted.folded).toEqual(["0.1.0-alpha.13"])
  })

  it("folds a new line's own entry into the version npm published when npm never had the line's first version", () => {
    const root = makeRepo()
    const base = head(root)
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["The 0.2 line."] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2")
    write(root, "src/a.ts", "export const a = 2\n")
    write(root, "changes/follow-up.md", "A follow-up.\n")
    commit(root, "a follow-up, landed with it in one rebase merge")
    const plan = planRelease({ root, before: base, registry: registry({ [BASE]: { commit: base } }) })
    expect(plan.version).toBe("0.2.0-alpha.1")
    expect(entryPairs(plan)).toEqual([["0.2.0-alpha.1", ["The 0.2 line.", "A follow-up."]]])
    expect(plan.folded).toEqual([lineStart])
    applyRelease({ root, plan })
    expect(readJson(root, "changelog.json").versions.map((entry: { version: string }) => entry.version)).toEqual(["0.2.0-alpha.1", BASE, "0.1.0-alpha.9"])

    // Every later release rebuilds it the same way, and still names no version npm never had.
    git(root, "checkout", "-q", "--", ".")
    const published = registry({ [BASE]: { commit: base }, "0.2.0-alpha.1": { commit: head(root) } })
    const before = head(root)
    write(root, "changes/later.md", "Later.\n")
    commit(root, "later (#5)")
    const later = planRelease({ root, before, registry: published })
    expect(later.version).toBe("0.2.0-alpha.2")
    expect(historyPairs(later)).toEqual([["0.2.0-alpha.1", ["The 0.2 line.", "A follow-up."]]])
    expect(later.folded).toEqual([lineStart])
    applyRelease({ root, plan: later })
    expect(readJson(root, "changelog.json").versions.map((entry: { version: string }) => entry.version)).toEqual(["0.2.0-alpha.2", "0.2.0-alpha.1", BASE, "0.1.0-alpha.9"])
  })

  it("counts a note once when a later commit renames it within changes/", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    const before = head(root)
    git(root, "mv", "changes/a.md", "changes/renamed-a.md")
    commit(root, "tidy a note's name (#4)")
    expect(planRelease({ root, before, registry: published })).toMatchObject({ release: false, version: "0.1.0-alpha.11" })
    git(root, "mv", "changes/renamed-a.md", "changes/a-again.md")
    write(root, "src/b.ts", "export const b = 1\n")
    write(root, "changes/b.md", "B.\n")
    commit(root, "b, and another rename (#5)")
    const plan = planRelease({ root, before, registry: published })
    expect(plan.version).toBe("0.1.0-alpha.12")
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.12", ["B."]]])
  })

  it("refuses a history with no version anywhere in package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-none-"))
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.email", "t@example.com")
    git(root, "config", "user.name", "t")
    json(root, "package.json", { name: "x" })
    write(root, "changes/README.md", "notes\n")
    commit(root, "no version")
    expect(() => planRelease({ root })).toThrow("no commit sets package.json's version")
  })
})

describe("compareVersions", () => {
  it("orders versions by semver precedence", () => {
    const sorted = ["0.1.0-alpha.10", "0.1.0", "0.1.0-alpha.9", "0.2.0-alpha.0", "0.1.0-alpha.beta", "0.1.0-alpha", "1.0.0", "0.1.0-alpha.10"]
      .sort(compareVersions)
    expect(sorted).toEqual(["0.1.0-alpha", "0.1.0-alpha.9", "0.1.0-alpha.10", "0.1.0-alpha.10", "0.1.0-alpha.beta", "0.1.0", "0.2.0-alpha.0", "1.0.0"])
    expect(compareVersions("0.1.0-beta", "0.1.0-alpha.3")).toBe(1)
    expect(() => compareVersions("next", "0.1.0")).toThrow("next is not valid semver")
  })
})

describe("npmRegistry", { timeout: 30_000 }, () => {
  function failure(stderr: string): Error {
    return Object.assign(new Error("npm failed"), { status: 1, stderr })
  }

  it("reads npm's versions and every version's gitHead in one call each, asking once", () => {
    const calls: string[] = []
    const exec = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (args.includes("versions")) return '["0.0.1","0.1.0-alpha.10","0.1.0-alpha.11","0.2.0"]'
      if (args[1] === "@ouro.bot/cli@0.1.0-alpha.12") return `${"c".repeat(40)}\n`
      if (args[1] === "@ouro.bot/cli@0.1.0-alpha.13") return "\n"
      return `@ouro.bot/cli@0.1.0-alpha.10 '${"a".repeat(40)}'\n@ouro.bot/cli@0.1.0-alpha.11 '${"b".repeat(40)}'\nnoise\n`
    }
    const npm = npmRegistry(exec)
    expect(npm.versions()).toEqual(["0.0.1", "0.1.0-alpha.10", "0.1.0-alpha.11", "0.2.0"])
    expect(npm.versions()).toHaveLength(4)
    expect(npm.gitHeads()).toEqual(new Map([["0.1.0-alpha.10", "a".repeat(40)], ["0.1.0-alpha.11", "b".repeat(40)]]))
    expect(npm.gitHead("0.1.0-alpha.11")).toBe("b".repeat(40))
    expect(npm.gitHead("0.1.0-alpha.12")).toBe("c".repeat(40))
    expect(npm.gitHead("0.1.0-alpha.13")).toBeUndefined()
    expect(calls.filter((call) => call.includes("gitHead")).slice(0, 1)).toEqual(["npm view @ouro.bot/cli@>=0.0.1-0 || >=0.1.0-0 || >=0.2.0-0 gitHead"])
    expect(calls.filter((call) => call.includes("versions"))).toHaveLength(1)
    expect(npmRegistry((command: string, args: string[]) => (args.includes("versions") ? '"0.1.0-alpha.1"' : "")).versions()).toEqual(["0.1.0-alpha.1"])
  })

  it("reads a version's changelog from its tarball, waiting out a tarball npm cannot serve yet", () => {
    const calls: string[] = []
    let packs = 0
    const exec = (command: string, args: string[]) => {
      calls.push(`${command} ${args.join(" ")}`)
      if (command === "npm" && args[0] === "pack") {
        packs += 1
        if (packs === 1) throw failure("npm error code ETARGET")
        return JSON.stringify([{ filename: "ouro.bot-cli-0.1.0-alpha.12.tgz" }])
      }
      if (command === "tar") return JSON.stringify({ versions: [{ version: "0.1.0-alpha.12", changes: ["X."] }] })
      return ""
    }
    const slept: number[] = []
    expect(npmRegistry(exec, { sleep: (ms: number) => slept.push(ms) }).changelog("0.1.0-alpha.12")).toEqual([{ version: "0.1.0-alpha.12", changes: ["X."] }])
    expect(slept).toEqual([30_000])
    expect(calls.find((call) => call.startsWith("tar"))).toContain("package/changelog.json")
    const broken = (command: string, args: string[]) => {
      if (command === "npm") return JSON.stringify([{ filename: "x.tgz" }])
      return JSON.stringify({ nothing: true })
    }
    expect(() => npmRegistry(broken, { sleep: () => {} }).changelog("0.1.0-alpha.12")).toThrow("has no versions array")
    const never = (command: string) => { if (command === "npm") throw failure("npm error code ETARGET"); return "" }
    expect(() => npmRegistry(never, { sleep: () => {}, attempts: 2 }).changelog("0.1.0-alpha.12")).toThrow("after 2 attempts")
    const tarball404 = (version: string) => `npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/@ouro.bot/cli/-/cli-${version}.tgz`
    let served404 = 0
    const lagged404 = (command: string) => {
      if (command === "npm") {
        served404 += 1
        if (served404 === 1) throw failure(tarball404("0.1.0-alpha.12"))
        return JSON.stringify([{ filename: "x.tgz" }])
      }
      return JSON.stringify({ versions: [] })
    }
    const slept404: number[] = []
    expect(npmRegistry(lagged404, { sleep: (ms: number) => slept404.push(ms) }).changelog("0.1.0-alpha.12")).toEqual([])
    expect(slept404).toEqual([30_000])
    const packs404: string[] = []
    const never404 = (command: string) => { if (command === "npm") { packs404.push("pack"); throw failure(tarball404("0.1.0-alpha.12")) } return "" }
    const slept404b: number[] = []
    expect(() => npmRegistry(never404, { sleep: (ms: number) => slept404b.push(ms), attempts: 3 }).changelog("0.1.0-alpha.12")).toThrow("after 3 attempts")
    expect(packs404).toHaveLength(3)
    expect(slept404b).toEqual([30_000, 30_000])
    const otherTarball = () => { throw failure(tarball404("0.1.0-alpha.99")) }
    expect(() => npmRegistry(otherTarball, { sleep: () => { throw new Error("must not wait") } }).changelog("0.1.0-alpha.12")).toThrow("after 1 attempt")
    const gone = () => { throw failure("npm error code E404") }
    expect(() => npmRegistry(gone, { sleep: () => {} }).changelog("0.1.0-alpha.12")).toThrow("could not download @ouro.bot/cli@0.1.0-alpha.12")
  })

  it("reads a version npm does not have yet as no gitHead, so a wait can poll it, and stops on any other failure", () => {
    const missing = (command: string, args: string[]) => {
      if (args.includes("versions")) return '["0.1.0-alpha.10"]'
      if (args[1] === "@ouro.bot/cli@0.1.0-alpha.11") throw failure("npm error code E404\nnpm error 404 No match found for version 0.1.0-alpha.11")
      if (args[1] === "@ouro.bot/cli@0.1.0-alpha.12") throw failure("npm error code ENOTFOUND")
      return ""
    }
    expect(npmRegistry(missing).gitHead("0.1.0-alpha.11")).toBeUndefined()
    expect(() => npmRegistry(missing).gitHead("0.1.0-alpha.12")).toThrow("ENOTFOUND")
  })
})

describe("applyRelease", { timeout: 30_000 }, () => {
  it("writes every entry since the switch from git, never reading a tarball from npm", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#4)")
    const published = registry({ [BASE]: { commit: git(root, "rev-parse", "HEAD~2").trim() }, "0.1.0-alpha.11": { commit: git(root, "rev-parse", "HEAD~1").trim() } }, ["0.1.0-alpha.11", BASE])
    const plan = planRelease({ root, before: git(root, "rev-parse", "HEAD~1").trim(), registry: published })
    applyRelease({ root, plan })
    expect(published.asked).toEqual([])
    expect(readJson(root, "changelog.json").versions).toEqual([
      { version: "0.1.0-alpha.12", changes: ["B."] },
      { version: "0.1.0-alpha.11", changes: ["A."] },
      { version: BASE, changes: ["base release"] },
      { version: "0.1.0-alpha.9", changes: ["older"] },
    ])
  })

  it("keeps main's changelog.json for entries before the switch, fixes included, and git's for every later one", () => {
    const root = makeRepo()
    const fixed = readJson(root, "changelog.json")
    fixed.versions[0].changes = ["base release, typo fixed"]
    json(root, "changelog.json", { versions: [{ version: "0.1.0-alpha.11", changes: ["a stray entry"] }, ...fixed.versions] })
    write(root, "changes/a.md", "A.\n")
    commit(root, "a, with a fix to the base entry (#3)")
    const published = registry({ [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim() }, "0.1.0-alpha.11": { commit: head(root) } })
    const plan = planRelease({ root, before: head(root), registry: published })
    expect(plan.release).toBe(false)
    applyRelease({ root, plan })
    expect(readJson(root, "changelog.json").versions).toEqual([
      { version: "0.1.0-alpha.11", changes: ["A."] },
      { version: BASE, changes: ["base release, typo fixed"] },
      { version: "0.1.0-alpha.9", changes: ["older"] },
    ])
  })

  it("writes the version npm published from this commit when it differs from the plan, so the image matches the package", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const warnings: string[] = []
    applyRelease({ root, plan: planRelease({ root }), version: "0.1.0-alpha.12", warn: (line: string) => warnings.push(line) })
    expect(readJson(root, "package.json").version).toBe("0.1.0-alpha.12")
    expect(readJson(root, "changelog.json").versions[0]).toEqual({ version: "0.1.0-alpha.12", changes: ["A."] })
    expect(warnings.join("\n")).toContain("npm published 0.1.0-alpha.12 from this commit, not the planned 0.1.0-alpha.11")
  })

  it("writes the planned version into every release file and puts one entry, for every unpublished commit, on top of the changelog", () => {
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
      { version: next, changes: ["First.", "Second."] },
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
  function capture(root: string, argv: string[], published = registry({})) {
    const out: string[] = []
    const err: string[] = []
    const code = runReleaseVersionCli(argv, { root, registry: published, log: (line: string) => out.push(line), error: (line: string) => err.push(line) })
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

  it("says whether a push releases, as lines for GITHUB_OUTPUT", () => {
    const root = makeRepo()
    const before = head(root)
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    expect(capture(root, ["push", before])).toMatchObject({ code: 0, out: ["version=0.1.0-alpha.11\nrelease=true"] })
    const released = head(root)
    write(root, "docs/x.md", "docs\n")
    commit(root, "docs (#4)")
    const quiet = capture(root, ["push", released])
    expect(quiet).toMatchObject({ code: 0, out: ["version=0.1.0-alpha.11\nrelease=false"] })
    expect(quiet.err.join("\n")).toContain("releases nothing")
    expect(capture(root, ["push"])).toMatchObject({ code: 2 })
  })

  it("applies a push's release with every note since its start", () => {
    const root = makeRepo()
    const before = head(root)
    write(root, "changes/first.md", "First.\n")
    commit(root, "first")
    write(root, "changes/second.md", "Second.\n")
    commit(root, "second")
    expect(capture(root, ["apply", before])).toMatchObject({ code: 0, out: ["0.1.0-alpha.12"] })
    expect(readJson(root, "changelog.json").versions[0]).toEqual({ version: "0.1.0-alpha.12", changes: ["First.", "Second."] })
  })

  it("lets a manual run rebuild only the commit npm published HEAD's version from", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const released = head(root)
    const published: Published = { [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim() } }
    const unpublished = capture(root, ["dispatch"], registry(published))
    expect(unpublished.code).toBe(1)
    expect(unpublished.err.join("\n")).toContain("npm has no 0.1.0-alpha.11")
    published["0.1.0-alpha.11"] = { commit: released }
    expect(capture(root, ["dispatch"], registry(published))).toMatchObject({ code: 0, out: ["version=0.1.0-alpha.11\nrelease=true"] })
    write(root, "docs/x.md", "docs\n")
    commit(root, "docs (#4)")
    const moved = capture(root, ["dispatch"], registry(published))
    expect(moved.code).toBe(1)
    expect(moved.err.join("\n")).toContain(`0.1.0-alpha.11 was published from ${released.slice(0, 12)}`)
  })

  it("refuses to publish a version at or below npm's highest, unless this commit already published it", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const published: Published = { [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim() } }
    expect(capture(root, ["assert-new", "0.1.0-alpha.11"], registry(published))).toMatchObject({ code: 0 })
    published["0.1.0-alpha.11"] = { commit: head(root) }
    expect(capture(root, ["assert-new", "0.1.0-alpha.11"], registry(published))).toMatchObject({ code: 0 })
    published["0.1.0-alpha.12"] = { commit: "d".repeat(40) }
    const behind = capture(root, ["assert-new", "0.1.0-alpha.11"], registry(published))
    expect(behind.code).toBe(1)
    expect(behind.err.join("\n")).toContain("npm's highest version is 0.1.0-alpha.12")
    expect(capture(root, ["assert-new"], registry(published))).toMatchObject({ code: 2 })
  })

  it("waits for npm to publish any version from this commit, and prints that version", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const published: Published = { [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim() } }
    let clock = 0
    const timing = { now: () => clock, sleep: (ms: number) => { clock += ms; if (clock >= 60_000) published["0.1.0-alpha.12"] = { commit: head(root) } } }
    const run = (releases: Published, deadline = 600) => {
      const out: string[] = []
      const err: string[] = []
      const code = runReleaseVersionCli(["wait-published"], { root, registry: registry(releases), ...timing, waitSeconds: deadline, log: (line: string) => out.push(line), error: (line: string) => err.push(line) })
      return { code, out, err }
    }
    expect(run(published)).toMatchObject({ code: 0, out: ["version=0.1.0-alpha.12"] })
    expect(clock).toBe(60_000)
    clock = 0
    const late = run({ "0.1.0-alpha.11": { commit: "e".repeat(40) } }, 30)
    expect(late.code).toBe(1)
    expect(late.err.join("\n")).toContain(`npm has published no version from ${head(root).slice(0, 12)} after 30s`)
  })

  it("keeps waiting through npm errors until the deadline, and names the last one if it gives up", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    let clock = 0
    let calls = 0
    const flaky = {
      versions: () => [],
      gitHead: () => undefined,
      gitHeads: () => {
        calls += 1
        if (calls <= 2) throw new Error("npm error code ECONNRESET")
        return new Map([["0.1.0-alpha.11", head(root)]])
      },
    }
    const timing = { now: () => clock, sleep: (ms: number) => { clock += ms } }
    const out: string[] = []
    const err: string[] = []
    expect(runReleaseVersionCli(["wait-published"], { root, registry: flaky, ...timing, waitSeconds: 600, log: (line: string) => out.push(line), error: (line: string) => err.push(line) })).toBe(0)
    expect(out).toEqual(["version=0.1.0-alpha.11"])
    expect(err.join("\n")).toContain("ECONNRESET")
    expect(clock).toBe(60_000)

    clock = 0
    const down = { ...flaky, gitHeads: () => { throw new Error("npm error code ETIMEDOUT") } }
    const gaveUp: string[] = []
    expect(runReleaseVersionCli(["wait-published"], { root, registry: down, ...timing, waitSeconds: 90, log: () => {}, error: (line: string) => gaveUp.push(line) })).toBe(1)
    expect(gaveUp.join("\n")).toContain("after 90s")
    expect(gaveUp.join("\n")).toContain("ETIMEDOUT")
  })

  it("writes the changelog npm published for that version with --npm-changelog, so the image and the package carry the same one", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const tarball = [{ version: "0.1.0-alpha.12", changes: ["As npm has it."] }, { version: BASE, changes: ["base release"] }]
    const published = registry({ "0.1.0-alpha.12": { commit: head(root), changelog: tarball } })
    const result = capture(root, ["apply", head(root) + "^", "--version", "0.1.0-alpha.12", "--npm-changelog"], published)
    expect(result).toMatchObject({ code: 0, out: ["0.1.0-alpha.12"] })
    expect(published.asked).toEqual(["0.1.0-alpha.12"])
    expect(readJson(root, "changelog.json").versions).toEqual(tarball)
    expect(readJson(root, "package.json").version).toBe("0.1.0-alpha.12")
    expect(readJson(root, "deploy/unraid/sanctuary.ouro/bundle-meta.json").runtimeVersion).toBe("0.1.0-alpha.12")
    expect(capture(root, ["apply", "--npm-changelog"])).toMatchObject({ code: 2 })
    expect(capture(root, ["version", "--npm-changelog"])).toMatchObject({ code: 2 })
  })

  it("applies with the version npm published from this commit", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    expect(capture(root, ["apply", head(root) + "^", "--version", "0.1.0-alpha.12"])).toMatchObject({ code: 0, out: ["0.1.0-alpha.12"] })
    expect(readJson(root, "changelog.json").versions[0]).toEqual({ version: "0.1.0-alpha.12", changes: ["First."] })
    expect(capture(root, ["apply", "--version"])).toMatchObject({ code: 2 })
    expect(capture(root, ["version", "--version", "0.1.0-alpha.12"])).toMatchObject({ code: 2 })
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
