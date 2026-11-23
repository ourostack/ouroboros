import { describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const repoRoot = path.resolve(__dirname, "../../..")
const BASE = "0.1.0-alpha.10"

function write(root: string, file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  fs.writeFileSync(path.join(root, file), content)
}

function json(root: string, file: string, value: unknown): void {
  write(root, file, `${JSON.stringify(value, null, 2)}\n`)
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), "utf8")
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function bump(cwd: string, version: string, change: string): void {
  execFileSync("node", ["scripts/release-bump.cjs", "--version", version, "--change", change], { cwd, stdio: "pipe" })
}

function run(cwd: string, command: string[], expectFailure = false): { status: number; output: string } {
  try {
    const output = execFileSync(command[0], command.slice(1), { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
    if (expectFailure) throw new Error(`expected ${command.join(" ")} to fail:\n${output}`)
    return { status: 0, output }
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string }
    if (!expectFailure || failure.status === undefined) throw error
    return { status: failure.status, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` }
  }
}

function makeRepos(): { work: string; origin: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-drop-bump-"))
  const work = path.join(base, "work")
  const origin = path.join(base, "origin.git")
  fs.mkdirSync(work)
  const lock = { name: "@ouro.bot/cli", version: BASE, lockfileVersion: 3, packages: { "": { name: "@ouro.bot/cli", version: BASE } } }
  json(work, "package.json", { name: "@ouro.bot/cli", version: BASE, dependencies: { semver: "^7.0.0" } })
  json(work, "package-lock.json", lock)
  json(work, "npm-shrinkwrap.json", lock)
  json(work, "packages/ouro.bot/package.json", { name: "ouro.bot", version: BASE })
  json(work, "changelog.json", { versions: [{ version: BASE, changes: ["base"] }] })
  write(work, "deploy/unraid/sanctuary.xml", `<Container><Name>ouro-butler</Name><Repository>ghcr.io/ourostack/ouroboros-butler:${BASE}</Repository></Container>\n`)
  json(work, "deploy/unraid/sanctuary.ouro/bundle-meta.json", { runtimeVersion: BASE, bundleSchemaVersion: 3 })
  for (const script of ["rebase-and-rebump.sh", "release-bump.cjs", "release-drop-bump.cjs"]) {
    fs.mkdirSync(path.join(work, "scripts"), { recursive: true })
    fs.copyFileSync(path.join(repoRoot, "scripts", script), path.join(work, "scripts", script))
  }
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(work, "node_modules"))
  write(work, ".gitignore", "node_modules\n")
  git(work, "init", "-q", "-b", "main")
  git(work, "config", "user.email", "t@example.com")
  git(work, "config", "user.name", "t")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "base")
  git(base, "init", "-q", "--bare", origin)
  git(work, "remote", "add", "origin", origin)
  git(work, "push", "-q", "origin", "main")
  return { work, origin }
}

// A branch made before releases moved to main: it bumped the version and added a changelog entry, and main moved on.
function branchWithOldStyleBump(work: string): void {
  git(work, "checkout", "-q", "-b", "feature/thing")
  write(work, "src/thing.ts", "export const thing = 1\n")
  const pkg = JSON.parse(read(work, "package.json"))
  json(work, "package.json", { ...pkg, dependencies: { semver: "^7.6.0" } })
  bump(work, "0.1.0-alpha.11", "Mine, the first line.")
  bump(work, "0.1.0-alpha.11", "Mine, the second line.")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "mine")
  git(work, "checkout", "-q", "main")
  bump(work, "0.1.0-alpha.11", "theirs")
  git(work, "commit", "-q", "-am", "theirs")
  git(work, "push", "-q", "origin", "main")
  git(work, "checkout", "-q", "feature/thing")
}

function expectReleaseFilesMatchMain(work: string): void {
  for (const file of ["package-lock.json", "npm-shrinkwrap.json", "packages/ouro.bot/package.json", "changelog.json", "deploy/unraid/sanctuary.xml", "deploy/unraid/sanctuary.ouro/bundle-meta.json"]) {
    expect(read(work, file), file).toBe(git(work, "show", `origin/main:${file}`))
  }
  expect(JSON.parse(read(work, "package.json")).version).toBe("0.1.0-alpha.11")
}

describe("scripts/release-drop-bump.cjs", { timeout: 30_000 }, () => {
  it("moves the branch's changelog lines into a change note, restores the release files and merges main cleanly", () => {
    const { work } = makeRepos()
    branchWithOldStyleBump(work)

    const result = run(work, ["node", "scripts/release-drop-bump.cjs"])

    expect(read(work, "changes/feature-thing.md")).toBe("Mine, the first line.\n\nMine, the second line.\n")
    expectReleaseFilesMatchMain(work)
    // The branch's own package.json change (a dependency) survives; only the version went back.
    expect(JSON.parse(read(work, "package.json")).dependencies).toEqual({ semver: "^7.6.0" })
    expect(read(work, "src/thing.ts")).toBe("export const thing = 1\n")
    expect(git(work, "status", "--porcelain")).toBe("")
    expect(git(work, "diff", "--name-only", "origin/main...HEAD").split("\n").filter(Boolean).sort()).toEqual([
      "changes/feature-thing.md",
      "package.json",
      "src/thing.ts",
    ])
    expect(result.output).toContain("changes/feature-thing.md")
    expect(result.output).toContain("git push")
  })

  it("is what scripts/rebase-and-rebump.sh now runs", () => {
    const { work } = makeRepos()
    branchWithOldStyleBump(work)

    run(work, ["bash", "scripts/rebase-and-rebump.sh"])

    expect(read(work, "changes/feature-thing.md")).toContain("Mine, the first line.")
    expectReleaseFilesMatchMain(work)
  })

  it("picks a free note name when the branch's name is taken", () => {
    const { work } = makeRepos()
    branchWithOldStyleBump(work)
    write(work, "changes/feature-thing.md", "Someone else's note.\n")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "a note with the same name")

    run(work, ["node", "scripts/release-drop-bump.cjs", "--no-merge"])

    expect(read(work, "changes/feature-thing.md")).toBe("Someone else's note.\n")
    expect(read(work, "changes/feature-thing-2.md")).toContain("Mine, the second line.")
    expect(JSON.parse(read(work, "package.json")).version).toBe(BASE)
  })

  it("keeps the branch's fix to an older changelog entry and moves only its new entry into the note", () => {
    const { work } = makeRepos()
    git(work, "checkout", "-q", "-b", "fix/typo")
    bump(work, "0.1.0-alpha.11", "Mine.")
    const changelog = JSON.parse(read(work, "changelog.json"))
    json(work, "changelog.json", { ...changelog, versions: changelog.versions.map((entry: { version: string; changes: string[] }) => (entry.version === BASE ? { ...entry, changes: ["base, with its typo fixed"] } : entry)) })
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "mine, and a typo fix")

    run(work, ["node", "scripts/release-drop-bump.cjs", "--no-merge"])

    expect(read(work, "changes/fix-typo.md")).toBe("Mine.\n")
    expect(JSON.parse(read(work, "changelog.json")).versions).toEqual([{ version: BASE, changes: ["base, with its typo fixed"] }])
    expect(JSON.parse(read(work, "package.json")).version).toBe(BASE)
  })

  it("does nothing on a branch that never bumped", () => {
    const { work } = makeRepos()
    git(work, "checkout", "-q", "-b", "clean")
    write(work, "src/x.ts", "x\n")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "x")
    const head = git(work, "rev-parse", "HEAD")

    const result = run(work, ["node", "scripts/release-drop-bump.cjs"])

    expect(result.output).toContain("no version bump to drop")
    expect(git(work, "rev-parse", "HEAD")).toBe(head)
  })

  it("refuses main and a dirty working tree", () => {
    const { work } = makeRepos()
    expect(run(work, ["node", "scripts/release-drop-bump.cjs"], true).output).toContain("refusing to run on main")
    git(work, "checkout", "-q", "-b", "dirty")
    write(work, "src/x.ts", "x\n")
    expect(run(work, ["node", "scripts/release-drop-bump.cjs"], true).output).toContain("commit or stash")
  })

  it("stops with the conflicted files when main conflicts somewhere else", () => {
    const { work } = makeRepos()
    branchWithOldStyleBump(work)
    git(work, "checkout", "-q", "main")
    write(work, "src/thing.ts", "export const thing = 2\n")
    git(work, "add", "-A")
    git(work, "commit", "-q", "-m", "main touches the same file")
    git(work, "push", "-q", "origin", "main")
    git(work, "checkout", "-q", "feature/thing")

    const result = run(work, ["node", "scripts/release-drop-bump.cjs"], true)

    expect(result.status).toBe(1)
    expect(result.output).toContain("src/thing.ts")
    expect(read(work, "changes/feature-thing.md")).toContain("Mine, the first line.")
  })

  it("rejects an unknown argument", () => {
    const { work } = makeRepos()
    expect(run(work, ["node", "scripts/release-drop-bump.cjs", "--bogus"], true).output).toContain("unknown argument: --bogus")
  })

  // From #1713, for the old rebump: main and the branch bumped to different versions, so every release file conflicts.
  // drop-bump puts the branch's release files back first, so merging main takes main's version with no conflict.
  it("takes main's version when main and the branch bumped to different versions", () => {
    const { work } = makeRepos()
    git(work, "checkout", "-q", "-b", "feature")
    bump(work, "0.1.0-alpha.11", "mine")
    git(work, "commit", "-q", "-am", "mine")
    git(work, "checkout", "-q", "main")
    bump(work, "0.1.0-alpha.12", "theirs")
    git(work, "commit", "-q", "-am", "theirs")
    git(work, "push", "-q", "origin", "main")
    git(work, "checkout", "-q", "feature")

    execFileSync("bash", ["scripts/rebase-and-rebump.sh"], { cwd: work, stdio: "pipe" })

    expect(JSON.parse(read(work, "package.json")).version).toBe("0.1.0-alpha.12")
    expect(JSON.parse(read(work, "npm-shrinkwrap.json")).version).toBe("0.1.0-alpha.12")
    expect(read(work, "changes/feature.md")).toBe("mine\n")
    expect(git(work, "status", "--porcelain")).toBe("")
  })
})
