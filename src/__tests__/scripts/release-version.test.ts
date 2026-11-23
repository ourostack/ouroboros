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
    expect(entryPairs(plan)).toEqual([["0.2.0-alpha.1", ["First.", "Next."]]])
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
      "0.1.0-alpha.11": { commit: head(root), changelog: [{ version: "0.1.0-alpha.11", changes: ["First, as published."] }, { version: BASE, changes: ["base release"] }] },
    })
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#4)")
    write(root, "changes/next.md", "Next.\n")
    commit(root, "next (#5)")

    const plan = planRelease({ root, registry: published })
    expect(plan.version).toBe("0.2.0-alpha.1")
    expect(entryPairs(plan)).toEqual([["0.2.0-alpha.1", ["Next."]]])
    applyRelease({ root, plan, registry: published })
    const versions = readJson(root, "changelog.json").versions
    expect(versions.map((entry: { version: string }) => entry.version)).toEqual(["0.2.0-alpha.1", lineStart, "0.1.0-alpha.11", BASE, "0.1.0-alpha.9"])
    expect(versions[2].changes).toEqual(["First, as published."])
  })

  it("releases a new line's own version when the push lands it", () => {
    const root = makeRepo()
    const before = head(root)
    const lineStart = "0.2.0-alpha.0"
    writeReleaseFiles(root, lineStart, [{ version: lineStart, changes: ["new line"] }, ...readJson(root, "changelog.json").versions])
    commit(root, "start 0.2 (#3)")
    const plan = planRelease({ root, before })
    expect(plan).toMatchObject({ release: true, version: lineStart, entries: [] })
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

  it("stops loudly when a version change does not move the version forward, instead of reusing a number", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const published = registry({ "0.1.0-alpha.11": { commit: head(root) } })
    for (const stale of ["0.1.0-alpha.11", "0.1.0-alpha.3"]) {
      const branch = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-version-clone-"))
      git(branch, "clone", "-q", root, ".")
      git(branch, "config", "user.email", "t@example.com")
      git(branch, "config", "user.name", "t")
      writeReleaseFiles(branch, stale, readJson(branch, "changelog.json").versions)
      commit(branch, `an old-style bump to ${stale} (#4)`)
      expect(() => planRelease({ root: branch, registry: published })).toThrow(`sets package.json's version to ${stale}, which is not above 0.1.0-alpha.11`)
    }
    const fallback = makeRepo()
    write(fallback, "changes/a.md", "A.\n")
    commit(fallback, "a (#3)")
    writeReleaseFiles(fallback, "0.1.0-alpha.3", readJson(fallback, "changelog.json").versions)
    commit(fallback, "an old-style bump back to 3 (#4)")
    expect(() => planRelease({ root: fallback })).toThrow(`which is not above ${BASE}`)
  })

  it("accepts a version change above npm's release even when a number counted since then reaches it, so main never wedges", () => {
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
    expect(plan.version).toBe("0.1.0-alpha.13")
    expect(entryPairs(plan)).toEqual([["0.1.0-alpha.13", ["B.", "C."]]])
    writeReleaseFiles(root, "0.2.0-alpha.0", readJson(root, "changelog.json").versions)
    commit(root, "start 0.2 (#7)")
    writeReleaseFiles(root, "0.1.0-alpha.20", readJson(root, "changelog.json").versions)
    commit(root, "a stale bump back onto the old line (#8)")
    expect(() => planRelease({ root, registry: published })).toThrow("which is not above 0.2.0-alpha.0")
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
  function tarball(work: string, changelog: unknown): string {
    json(work, "package/changelog.json", changelog)
    execFileSync("tar", ["-czf", path.join(work, "cli.tgz"), "-C", work, "package"])
    return path.join(work, "cli.tgz")
  }
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

  it("reads the changelog a version's tarball carries, waiting out ETARGET while npm cannot serve it yet", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-release-registry-"))
    const file = tarball(work, { versions: [{ version: "0.1.0-alpha.11", changes: ["A."] }] })
    let refusals = 2
    const slept: number[] = []
    const exec = (command: string, args: string[], options: object) => {
      if (command !== "npm") return execFileSync(command, args, options)
      if (refusals > 0) {
        refusals -= 1
        throw failure("npm error code ETARGET\nnpm error notarget No matching version found")
      }
      fs.copyFileSync(file, path.join(args[args.indexOf("--pack-destination") + 1], "cli.tgz"))
      return JSON.stringify([{ filename: "cli.tgz" }])
    }
    const npm = npmRegistry(exec, { attempts: 3, intervalMs: 5, sleep: (ms: number) => slept.push(ms) })
    expect(npm.changelog("0.1.0-alpha.11")).toEqual([{ version: "0.1.0-alpha.11", changes: ["A."] }])
    expect(slept).toEqual([5, 5])

    refusals = 5
    expect(() => npmRegistry(exec, { attempts: 3, intervalMs: 0, sleep: () => undefined }).changelog("0.1.0-alpha.11")).toThrow("ETARGET")
    const offline = npmRegistry(() => { throw failure("npm error code ENOTFOUND") }, { attempts: 3, sleep: () => { throw new Error("must not wait") } })
    expect(() => offline.changelog("0.1.0-alpha.11")).toThrow("ENOTFOUND")
    tarball(work, { notVersions: true })
    refusals = 0
    expect(() => npmRegistry(exec).changelog("0.1.0-alpha.11")).toThrow("changelog.json has no versions array")
  })
})

describe("applyRelease", { timeout: 30_000 }, () => {
  it("reads npm's changelog only when writing the release, falling back to an older release npm cannot serve yet", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    write(root, "changes/b.md", "B.\n")
    commit(root, "b (#4)")
    const releases: Published = {
      [BASE]: { commit: git(root, "rev-parse", "HEAD~2").trim(), changelog: [{ version: BASE, changes: ["base, as published"] }] },
      "0.1.0-alpha.11": { commit: git(root, "rev-parse", "HEAD~1").trim() },
    }
    const published = registry(releases, ["0.1.0-alpha.11"])
    const plan = planRelease({ root, registry: published })
    expect(published.asked).toEqual([])
    const warnings: string[] = []
    applyRelease({ root, plan, registry: published, warn: (line: string) => warnings.push(line) })
    expect(published.asked).toEqual(["0.1.0-alpha.11", BASE])
    expect(warnings.join("\n")).toContain("could not read 0.1.0-alpha.11's changelog from npm")
    expect(readJson(root, "changelog.json").versions[0]).toEqual({ version: "0.1.0-alpha.12", changes: ["B."] })
    expect(() => applyRelease({ root, plan, registry: registry(releases, ["0.1.0-alpha.11", BASE]) }))
      .toThrow("could not read the changelog of any release npm has before this push")
  })

  it("lets main's changelog.json win over npm's copy, so a fix to an older entry lands", () => {
    const root = makeRepo()
    const fixed = readJson(root, "changelog.json")
    fixed.versions[0].changes = ["base release, typo fixed"]
    json(root, "changelog.json", fixed)
    write(root, "changes/a.md", "A.\n")
    commit(root, "a, with a fix to the base entry (#3)")
    const published = registry({ [BASE]: { commit: git(root, "rev-parse", "HEAD~1").trim(), changelog: [{ version: BASE, changes: ["base release"] }, { version: "0.1.0-alpha.8", changes: ["only on npm"] }] } })
    const plan = planRelease({ root, registry: published })
    applyRelease({ root, plan, registry: published })
    expect(readJson(root, "changelog.json").versions).toEqual([
      { version: "0.1.0-alpha.11", changes: ["A."] },
      { version: BASE, changes: ["base release, typo fixed"] },
      { version: "0.1.0-alpha.9", changes: ["older"] },
      { version: "0.1.0-alpha.8", changes: ["only on npm"] },
    ])
  })

  it("writes a given changelog as it is, for an image that must match npm's package", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const npmCopy = [{ version: "0.1.0-alpha.11", changes: ["A, as npm has it."] }]
    applyRelease({ root, plan: planRelease({ root }), changelog: npmCopy })
    expect(readJson(root, "changelog.json").versions).toEqual(npmCopy)
    expect(readJson(root, "package.json").version).toBe("0.1.0-alpha.11")
  })

  it("rebuilds exactly what npm published when nothing is new since that release", () => {
    const root = makeRepo()
    write(root, "changes/a.md", "A.\n")
    commit(root, "a (#3)")
    const changelog = [{ version: "0.1.0-alpha.11", changes: ["A, as published."] }, { version: BASE, changes: ["base release"] }, { version: "0.1.0-alpha.9", changes: ["older"] }]
    const published = registry({ "0.1.0-alpha.11": { commit: head(root), changelog } })
    const plan = planRelease({ root, before: head(root), registry: published })
    expect(plan).toMatchObject({ version: "0.1.0-alpha.11", release: false, entries: [] })
    applyRelease({ root, plan, registry: published })
    expect(readJson(root, "changelog.json").versions).toEqual(changelog)
    expect(readJson(root, "package.json").version).toBe("0.1.0-alpha.11")
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

  it("waits for npm to publish this commit's version, then writes the changelog its tarball carries", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const out = path.join(root, "npm-changelog.json")
    const npmCopy = [{ version: "0.1.0-alpha.11", changes: ["First, as npm has it."] }]
    const published: Published = {}
    let clock = 0
    const timing = { now: () => clock, sleep: (ms: number) => { clock += ms; if (clock >= 60_000) published["0.1.0-alpha.11"] = { commit: head(root), changelog: npmCopy } } }
    const run = (releases: Published, deadline = 600) => {
      const err: string[] = []
      const code = runReleaseVersionCli(["published-changelog", "0.1.0-alpha.11", out], { root, registry: registry(releases), ...timing, waitSeconds: deadline, log: () => undefined, error: (line: string) => err.push(line) })
      return { code, err }
    }
    expect(run(published)).toMatchObject({ code: 0 })
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual({ versions: npmCopy })
    expect(clock).toBe(60_000)

    const elsewhere = run({ "0.1.0-alpha.11": { commit: "e".repeat(40) } })
    expect(elsewhere.code).toBe(1)
    expect(elsewhere.err.join("\n")).toContain("npm published 0.1.0-alpha.11 from eeeeeeeeeeee")
    clock = 0
    const late = run({}, 30)
    expect(late.code).toBe(1)
    expect(late.err.join("\n")).toContain("npm has not published 0.1.0-alpha.11 from")
  })

  it("applies with a given changelog file", () => {
    const root = makeRepo()
    write(root, "changes/first.md", "First.\n")
    commit(root, "first (#3)")
    const file = path.join(os.tmpdir(), `npm-changelog-${process.pid}.json`)
    fs.writeFileSync(file, JSON.stringify({ versions: [{ version: "0.1.0-alpha.11", changes: ["npm's"] }] }))
    expect(capture(root, ["apply", head(root) + "^", "--changelog", file])).toMatchObject({ code: 0, out: ["0.1.0-alpha.11"] })
    expect(readJson(root, "changelog.json").versions).toEqual([{ version: "0.1.0-alpha.11", changes: ["npm's"] }])
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
