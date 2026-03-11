import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

function writeSubagents(repoRoot: string): void {
  const dir = path.join(repoRoot, "subagents")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "work-planner.md"), "# planner\n", "utf-8")
}

describe("subagent installer detectCliBinary", () => {
  let tmpRoot = ""

  afterEach(() => {
    vi.resetModules()
    vi.unmock("fs")
    vi.unmock("child_process")
    if (tmpRoot && fs.existsSync(tmpRoot)) {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    }
    tmpRoot = ""
  })

  it("treats empty and missing `which` output as unavailable CLI binaries", async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-installer-detect-"))
    const repoRoot = path.join(tmpRoot, "repo")
    const homeDir = path.join(tmpRoot, "home")
    writeSubagents(repoRoot)

    const spawnSyncMock = vi
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: "\n" })
      .mockReturnValueOnce({ status: 1, stdout: "" })
    vi.doMock("child_process", () => ({ spawnSync: spawnSyncMock }))

    const { installSubagentsForAvailableCli } = await import("../../../heart/daemon/subagent-installer")
    const result = await installSubagentsForAvailableCli({ repoRoot, homeDir })

    expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    expect(result.claudeInstalled).toBe(0)
    expect(result.codexInstalled).toBe(0)
    expect(result.notes).toEqual(expect.arrayContaining([
      "claude CLI not found; skipping subagent install",
      "codex CLI/config not found; skipping subagent install",
    ]))
  })

  it("replaces agents skill targets when same-file detection falls back on stat failure", async () => {
    const mkdirSync = vi.fn()
    const unlinkSync = vi.fn()
    const linkSync = vi.fn()
    const lstatSync = vi.fn((filePath: string) => {
      if (filePath === "/home/.agents/skills/work-planner/SKILL.md") {
        return { isSymbolicLink: () => false }
      }
      throw new Error(`ENOENT: ${filePath}`)
    })
    const statSync = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("stat failed")
      })
      .mockImplementation(() => ({ dev: 1, ino: 1 }))

    vi.doMock("fs", () => ({
      existsSync: vi.fn((filePath: string) => filePath === "/repo/subagents"),
      readdirSync: vi.fn((filePath: string) => (
        filePath === "/repo/subagents" ? ["work-planner.md"] : []
      )),
      lstatSync,
      statSync,
      mkdirSync,
      unlinkSync,
      linkSync,
      symlinkSync: vi.fn(),
      readlinkSync: vi.fn(),
    }))

    const { installSubagentsForAvailableCli } = await import("../../../heart/daemon/subagent-installer")
    const result = await installSubagentsForAvailableCli({
      repoRoot: "/repo",
      homeDir: "/home",
      which: (binary) => (binary === "codex" ? "/usr/bin/codex" : null),
    })

    expect(result.codexInstalled).toBe(1)
    expect(unlinkSync).toHaveBeenCalledWith("/home/.agents/skills/work-planner/SKILL.md")
    expect(linkSync).toHaveBeenCalledWith(
      "/repo/subagents/work-planner.md",
      "/home/.agents/skills/work-planner/SKILL.md",
    )
  })
})
