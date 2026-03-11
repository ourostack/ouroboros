import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { installSubagentsForAvailableCli } from "../../../heart/daemon/subagent-installer"

function writeSubagents(repoRoot: string): void {
  const dir = path.join(repoRoot, "subagents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "work-planner.md"), "# planner\n", "utf-8")
  fs.writeFileSync(path.join(dir, "work-doer.md"), "# doer\n", "utf-8")
  fs.writeFileSync(path.join(dir, "work-merger.md"), "# merger\n", "utf-8")
  fs.writeFileSync(path.join(dir, "README.md"), "# docs\n", "utf-8")
}

function expectHardLink(target: string, source: string): void {
  expect(fs.lstatSync(target).isSymbolicLink()).toBe(false)
  const targetStats = fs.statSync(target)
  const sourceStats = fs.statSync(source)
  expect(targetStats.dev).toBe(sourceStats.dev)
  expect(targetStats.ino).toBe(sourceStats.ino)
}

describe("subagent installer", () => {
  let tmpRoot = ""

  afterEach(() => {
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = ""
  })

  it("installs subagent symlinks for detected claude and codex CLIs", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: (binary) => (binary === "claude" || binary === "codex" ? `/usr/bin/${binary}` : null),
    })

    expect(result.claudeInstalled).toBe(3)
    expect(result.codexInstalled).toBe(3)

    const claudeLink = path.join(homeDir, ".claude", "agents", "work-planner.md")
    expect(fs.lstatSync(claudeLink).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(claudeLink)).toBe(path.join(repoRoot, "subagents", "work-planner.md"))

    const agentsLink = path.join(homeDir, ".agents", "skills", "work-merger", "SKILL.md")
    expectHardLink(agentsLink, path.join(repoRoot, "subagents", "work-merger.md"))

    expect(fs.existsSync(path.join(homeDir, ".codex", "skills", "work-doer", "SKILL.md"))).toBe(false)
  })

  it("is idempotent when matching symlinks already exist", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: () => "/usr/bin/claude",
    })
    const second = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: () => "/usr/bin/claude",
    })

    expect(second.claudeInstalled).toBe(0)
    expect(second.codexInstalled).toBe(0)
  })

  it("skips installation for CLIs that are not present", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: () => null,
    })

    expect(result.claudeInstalled).toBe(0)
    expect(result.codexInstalled).toBe(0)
    expect(result.notes).toEqual(expect.arrayContaining([
      "claude CLI not found; skipping subagent install",
      "codex CLI/config not found; skipping subagent install",
    ]))
  })

  it("installs codex-family skill links when local codex config exists without the CLI binary", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true })
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "", "utf-8")

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: (binary) => (binary === "claude" ? "/usr/bin/claude" : null),
    })

    expect(result.claudeInstalled).toBe(3)
    expect(result.codexInstalled).toBe(3)

    const agentsLink = path.join(homeDir, ".agents", "skills", "work-planner", "SKILL.md")
    expectHardLink(agentsLink, path.join(repoRoot, "subagents", "work-planner.md"))
    expect(fs.existsSync(path.join(homeDir, ".codex", "skills", "work-planner", "SKILL.md"))).toBe(false)
  })

  it("returns early when the repo has no subagent files", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    fs.mkdirSync(repoRoot, { recursive: true })

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: () => "/usr/bin/claude",
    })

    expect(result).toEqual({
      claudeInstalled: 0,
      codexInstalled: 0,
      notes: [expect.stringContaining("no subagent files found")],
    })
  })

  it("uses default `which` detection and replaces non-symlink targets", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const existingClaudeTarget = path.join(homeDir, ".claude", "agents", "work-planner.md")
    fs.mkdirSync(path.dirname(existingClaudeTarget), { recursive: true })
    fs.writeFileSync(existingClaudeTarget, "stale copy", "utf-8")

    const binDir = path.join(tmpRoot, "bin")
    fs.mkdirSync(binDir, { recursive: true })
    const fakeClaudePath = path.join(binDir, "claude")
    fs.writeFileSync(fakeClaudePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    fs.chmodSync(fakeClaudePath, 0o755)

    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}:${originalPath ?? ""}`

    try {
      const result = await installSubagentsForAvailableCli({
        repoRoot,
        homeDir,
      })

      expect(result.claudeInstalled).toBe(3)
      expect([0, 3]).toContain(result.codexInstalled)
      expect(fs.lstatSync(existingClaudeTarget).isSymbolicLink()).toBe(true)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it("replaces stale symlink targets with canonical source links", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const claudeTarget = path.join(homeDir, ".claude", "agents", "work-planner.md")
    const staleSource = path.join(tmpRoot, "stale", "work-planner.md")
    fs.mkdirSync(path.dirname(staleSource), { recursive: true })
    fs.writeFileSync(staleSource, "# stale\n", "utf-8")
    fs.mkdirSync(path.dirname(claudeTarget), { recursive: true })
    fs.symlinkSync(staleSource, claudeTarget)

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: (binary) => (binary === "claude" ? "/usr/bin/claude" : null),
    })

    expect(result.claudeInstalled).toBe(3)
    expect(result.codexInstalled).toBe(0)
    expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(claudeTarget)).toBe(path.join(repoRoot, "subagents", "work-planner.md"))
  })

  it("replaces broken symlink targets instead of throwing EEXIST", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const claudeTarget = path.join(homeDir, ".claude", "agents", "work-merger.md")
    const missingSource = path.join(tmpRoot, "missing", "work-merger.md")
    fs.mkdirSync(path.dirname(claudeTarget), { recursive: true })
    fs.symlinkSync(missingSource, claudeTarget)

    await expect(installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: (binary) => (binary === "claude" ? "/usr/bin/claude" : null),
    })).resolves.toMatchObject({
      claudeInstalled: 3,
      codexInstalled: 0,
    })

    expect(fs.lstatSync(claudeTarget).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(claudeTarget)).toBe(path.join(repoRoot, "subagents", "work-merger.md"))
  })

  it("replaces symlinked agents skill targets with hard links", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const agentsTarget = path.join(homeDir, ".agents", "skills", "work-planner", "SKILL.md")
    fs.mkdirSync(path.dirname(agentsTarget), { recursive: true })
    fs.symlinkSync(path.join(repoRoot, "subagents", "work-planner.md"), agentsTarget)

    const result = await installSubagentsForAvailableCli({
      repoRoot,
      homeDir,
      which: (binary) => (binary === "codex" ? "/usr/bin/codex" : null),
    })

    expect(result.codexInstalled).toBe(3)
    expectHardLink(agentsTarget, path.join(repoRoot, "subagents", "work-planner.md"))
  })

  it("uses default repo/home resolution when options omit those paths", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-"))

    const result = await installSubagentsForAvailableCli({
      which: () => null,
    })

    expect(result.notes).toContain("claude CLI not found; skipping subagent install")
  })
})
