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

function makeRepos(): { work: string; origin: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-rebump-"))
  const work = path.join(base, "work")
  const origin = path.join(base, "origin.git")
  fs.mkdirSync(work)
  const lock = { name: "@ouro.bot/cli", version: BASE, lockfileVersion: 3, packages: { "": { name: "@ouro.bot/cli", version: BASE } } }
  json(work, "package.json", { name: "@ouro.bot/cli", version: BASE })
  json(work, "package-lock.json", lock)
  json(work, "npm-shrinkwrap.json", lock)
  json(work, "packages/ouro.bot/package.json", { name: "ouro.bot", version: BASE })
  json(work, "changelog.json", { versions: [{ version: BASE, changes: ["base"] }] })
  write(work, "deploy/unraid/sanctuary.xml", `<Container><Name>ouro-butler</Name><Repository>ghcr.io/ourostack/ouroboros-butler:${BASE}</Repository></Container>\n`)
  json(work, "deploy/unraid/sanctuary.ouro/bundle-meta.json", { runtimeVersion: BASE, bundleSchemaVersion: 3 })
  fs.mkdirSync(path.join(work, "scripts"))
  for (const script of ["rebase-and-rebump.sh", "release-bump.cjs"]) {
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

describe("scripts/rebase-and-rebump.sh", () => {
  it("writes the new version into every file a version bump touches", () => {
    const { work } = makeRepos()
    git(work, "checkout", "-q", "-b", "feature")
    bump(work, "0.1.0-alpha.11", "mine")
    git(work, "commit", "-q", "-am", "mine")
    git(work, "checkout", "-q", "main")
    bump(work, "0.1.0-alpha.11", "theirs")
    git(work, "commit", "-q", "-am", "theirs")
    git(work, "push", "-q", "origin", "main")
    git(work, "checkout", "-q", "feature")

    execFileSync("bash", ["scripts/rebase-and-rebump.sh"], { cwd: work, stdio: "pipe" })

    const next = "0.1.0-alpha.12"
    expect(JSON.parse(read(work, "package.json")).version).toBe(next)
    expect(JSON.parse(read(work, "packages/ouro.bot/package.json")).version).toBe(next)
    for (const lock of ["package-lock.json", "npm-shrinkwrap.json"]) {
      const parsed = JSON.parse(read(work, lock))
      expect([parsed.version, parsed.packages[""].version]).toEqual([next, next])
    }
    expect(read(work, "deploy/unraid/sanctuary.xml")).toContain(`ouroboros-butler:${next}</Repository>`)
    expect(JSON.parse(read(work, "deploy/unraid/sanctuary.ouro/bundle-meta.json")).runtimeVersion).toBe(next)
    const changelog = JSON.parse(read(work, "changelog.json"))
    expect(changelog.versions.map((entry: { version: string }) => entry.version)).toEqual([next, "0.1.0-alpha.11", BASE])
    expect(changelog.versions[0].changes).toEqual(["mine"])
    expect(git(work, "status", "--porcelain")).toBe("")
  })

  it("takes main's side of conflicted version files before node reads them", () => {
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

    expect(JSON.parse(read(work, "package.json")).version).toBe("0.1.0-alpha.13")
    expect(JSON.parse(read(work, "npm-shrinkwrap.json")).version).toBe("0.1.0-alpha.13")
    expect(git(work, "status", "--porcelain")).toBe("")
  })
})
