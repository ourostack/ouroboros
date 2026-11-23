import * as childProcess from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

const scriptPath = path.resolve(__dirname, "../../../scripts/desk-vendor.cjs")
const { STAMP, ensureVendored, readLock, runCli, updateLock, vendorDir } = require(scriptPath)

const temps: string[] = []

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
}

/** A synthetic Desk repository with a `release` branch holding plugins/desk. */
function fakeDesk(version = "9.9.1") {
  const repo = temp("fake-desk-")
  git(repo, "init", "-q", "-b", "release")
  git(repo, "config", "user.email", "t@example.com")
  git(repo, "config", "user.name", "t")
  fs.mkdirSync(path.join(repo, "plugins", "desk", "mcp"), { recursive: true })
  fs.writeFileSync(path.join(repo, "plugins", "desk", "plugin.json"), JSON.stringify({ name: "desk", version }))
  fs.writeFileSync(path.join(repo, "plugins", "desk", "mcp", "bootstrap.cjs"), "// bootstrap\n")
  fs.writeFileSync(path.join(repo, "README.md"), "not part of the plugin\n")
  git(repo, "add", "-A")
  git(repo, "commit", "-qm", "release")
  const commit = git(repo, "rev-parse", "HEAD")
  return { repo, commit, tree: git(repo, "rev-parse", "HEAD:plugins/desk") }
}

function checkout(lock: Record<string, string>) {
  const root = temp("ouro-checkout-")
  fs.writeFileSync(path.join(root, "desk.lock.json"), JSON.stringify(lock))
  return root
}

function deps(home: string, repo: string, out: string[] = []) {
  return {
    cpSync: fs.cpSync,
    homedir: () => home,
    mkdirSync: fs.mkdirSync,
    mkdtempSync: fs.mkdtempSync,
    readFileSync: fs.readFileSync,
    remoteUrl: () => repo,
    renameSync: fs.renameSync,
    rmSync: fs.rmSync,
    spawnSync: childProcess.spawnSync,
    tmpdir: () => temp("scratch-"),
    writeFileSync: fs.writeFileSync,
    writeStderr: (text: string) => out.push(text),
    writeStdout: (text: string) => out.push(text),
  }
}

const base = { repository: "ourostack/desk", branch: "release", path: "plugins/desk", version: "9.9.1" }

describe("desk-vendor", () => {
  it("fetches the locked tree into vendor/desk, then reuses it and the per-user cache", () => {
    const desk = fakeDesk()
    const root = checkout({ ...base, commit: desk.commit, tree: desk.tree })
    const home = temp("home-")
    const d = deps(home, desk.repo)

    expect(ensureVendored(root, d)).toEqual({ source: "fetched", version: "9.9.1" })
    expect(fs.existsSync(path.join(vendorDir(root), "mcp", "bootstrap.cjs"))).toBe(true)
    expect(fs.existsSync(path.join(vendorDir(root), "README.md"))).toBe(false)
    expect(JSON.parse(fs.readFileSync(path.join(vendorDir(root), STAMP), "utf8")).tree).toBe(desk.tree)
    expect(ensureVendored(root, d).source).toBe("current")

    const other = checkout({ ...base, commit: desk.commit, tree: desk.tree })
    expect(ensureVendored(other, { ...d, remoteUrl: () => "/nowhere" }).source).toBe("cache")
    expect(fs.existsSync(path.join(vendorDir(other), "plugin.json"))).toBe(true)
  })

  it("refuses a commit whose plugin tree is not the locked one, leaving nothing behind", () => {
    const desk = fakeDesk()
    const root = checkout({ ...base, commit: desk.commit, tree: "0".repeat(40) })
    expect(() => ensureVendored(root, deps(temp("home-"), desk.repo))).toThrow(/pins 0{40}/)
    expect(fs.existsSync(vendorDir(root))).toBe(false)
  })

  it("still vendors when the per-user cache cannot be written", () => {
    const desk = fakeDesk()
    const root = checkout({ ...base, commit: desk.commit, tree: desk.tree })
    const d = deps(temp("home-"), desk.repo)
    const cpSync = (from: string, to: string, options: fs.CopySyncOptions) => {
      if (to.includes(".cache")) throw new Error("read-only home")
      fs.cpSync(from, to, options)
    }
    expect(ensureVendored(root, { ...d, cpSync }).source).toBe("fetched")
  })

  it("says what is wrong with a malformed lock", () => {
    expect(() => readLock(checkout({ ...base, repository: "" }), deps("", ""))).toThrow(/repository must be/)
    expect(() => readLock(checkout({ ...base, commit: "abc", tree: "def" }), deps("", ""))).toThrow(/full 40-character/)
  })

  it("pins the newest release commit and its version with --update", () => {
    const desk = fakeDesk("9.9.2")
    const root = checkout({ ...base, commit: "1".repeat(40), tree: "2".repeat(40) })
    const result = updateLock(root, deps(temp("home-"), desk.repo))
    expect(result).toMatchObject({ previous: "9.9.1", version: "9.9.2", vendored: { source: "fetched" } })
    expect(JSON.parse(fs.readFileSync(path.join(root, "desk.lock.json"), "utf8"))).toMatchObject({ commit: desk.commit, tree: desk.tree, version: "9.9.2" })
  })

  it("refuses to pin when the repository has no release branch", () => {
    const repo = temp("empty-")
    git(repo, "init", "-q")
    const root = checkout({ ...base, commit: "1".repeat(40), tree: "2".repeat(40) })
    expect(() => updateLock(root, deps(temp("home-"), repo))).toThrow(/no release branch/)
  })

  it("reports success and failure from the command line", () => {
    const out: string[] = []
    const failing = { ...deps("", ""), readFileSync: () => "{" }
    expect(runCli([], { ...failing, writeStderr: (text: string) => out.push(text) })).toBe(1)
    expect(out.join("")).toMatch(/^desk-vendor: /)
    const passing = { ...deps("", ""), readFileSync: (file: string) => file.endsWith(STAMP) ? JSON.stringify({ tree: "2".repeat(40) }) : JSON.stringify({ ...base, commit: "1".repeat(40), tree: "2".repeat(40) }) }
    const lines: string[] = []
    expect(runCli([], { ...passing, writeStdout: (text: string) => lines.push(text) })).toBe(0)
    expect(lines.join("")).toContain("Desk 9.9.1 at vendor/desk (current)")
  })
})
