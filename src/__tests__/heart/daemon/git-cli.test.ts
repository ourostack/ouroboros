import { describe, expect, it, vi } from "vitest"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"
import type { PortableGitInstallResult } from "../../../heart/daemon/portable-git-install"

const USAGE = "Usage: ouro git install [--force] | ouro git status"

const installed = (status: PortableGitInstallResult["status"]): PortableGitInstallResult => ({
  status,
  root: "/h/.ouro-cli/tools/git",
  marker: { release: "v2.56.0-2", asset: "a.tar.gz", sha256: "0".repeat(64), gitVersion: "git version 2.56.0", installedAt: "2026-11-10T08:00:00.000Z" },
})

describe("ouro git", () => {
  it("parses install, install --force and status", () => {
    expect(parseOuroCommand(["git", "install"])).toEqual({ kind: "git.install", force: false })
    expect(parseOuroCommand(["git", "install", "--force"])).toEqual({ kind: "git.install", force: true })
    expect(parseOuroCommand(["git", "status"])).toEqual({ kind: "git.status" })
    for (const args of [["git"], ["git", "pull"], ["git", "status", "--json"], ["git", "install", "--force", "--force"], ["git", "install", "--now"]]) {
      expect(() => parseOuroCommand(args), args.join(" ")).toThrow(USAGE)
    }
  })

  it("installs and says where", async () => {
    const writeStdout = vi.fn()
    const installPortableGit = vi.fn(async () => installed("installed"))
    const text = await runOuroCli(["git", "install", "--force"], { writeStdout, installPortableGit } as unknown as OuroCliDeps)
    expect(installPortableGit).toHaveBeenCalledWith({ force: true })
    expect(text).toBe("installed git version 2.56.0 at /h/.ouro-cli/tools/git\nOuro uses it whenever this host has no git of its own.")
    expect(writeStdout).toHaveBeenCalledWith(text)
  })

  it("says when it is already installed", async () => {
    const text = await runOuroCli(["git", "install"], { writeStdout: vi.fn(), installPortableGit: async () => installed("already-installed") } as unknown as OuroCliDeps)
    expect(text).toBe("portable git is already installed: git version 2.56.0 at /h/.ouro-cli/tools/git")
  })

  it("fails with the reason, and on a platform without a portable git", async () => {
    const setExitCode = vi.fn()
    const failing = { writeStdout: vi.fn(), setExitCode, installPortableGit: async () => { throw new Error("disk full") } } as unknown as OuroCliDeps
    expect(await runOuroCli(["git", "install"], failing)).toBe("disk full")
    expect(setExitCode).toHaveBeenCalledWith(1)
    const odd = { writeStdout: vi.fn(), installPortableGit: async () => { throw "offline" } } as unknown as OuroCliDeps
    expect(await runOuroCli(["git", "install"], odd)).toBe("offline")
    const none = { writeStdout: vi.fn(), setExitCode: vi.fn() } as unknown as OuroCliDeps
    expect(await runOuroCli(["git", "install"], none)).toBe(`no portable git for ${process.platform}-${process.arch}; install git with the host's package manager`)
  })

  it("reports which git is in use", async () => {
    const describeGit = vi.fn(async () => ({ systemGit: null, portable: null, portableSupported: true }))
    expect(await runOuroCli(["git", "status"], { writeStdout: vi.fn(), describeGit } as unknown as OuroCliDeps)).toBe(
      "system git: none\nin use: none; run `ouro git install`",
    )
    expect(await runOuroCli(["git", "status"], { writeStdout: vi.fn() } as unknown as OuroCliDeps)).toBe("ouro git status is unavailable here (dep not wired)")
  })
})
