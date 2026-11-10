import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawnSync } from "child_process"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { emitNervesEvent } from "../../../nerves/runtime"
import { portableGitBinary, portableGitRoot, portableGitToolsDir } from "../../../heart/daemon/portable-git"
import {
  PORTABLE_GIT_MIN_FREE_BYTES,
  describeGitAvailability,
  installPortableGit,
  readPortableGitMarker,
  removeTree,
  renderGitAvailability,
  type PortableGitInstallDeps,
  type ProcessRun,
} from "../../../heart/daemon/portable-git-install"

const roots: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-git-install-"))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.mocked(emitNervesEvent).mockClear()
})

/** A tarball laid out like dugite-native: bin/git and libexec/git-core/git-remote-https. */
function fakeArchive(): Buffer {
  const src = tempDir()
  fs.mkdirSync(path.join(src, "bin"))
  fs.mkdirSync(path.join(src, "libexec", "git-core"), { recursive: true })
  fs.writeFileSync(path.join(src, "bin", "git"), "#!/bin/sh\necho 'git version 2.56.0'\n", { mode: 0o755 })
  fs.writeFileSync(path.join(src, "libexec", "git-core", "git-remote-https"), "#!/bin/sh\nexit 129\n", { mode: 0o755 })
  const archive = path.join(tempDir(), "git.tar.gz")
  const tar = spawnSync("tar", ["-czf", archive, "-C", src, "bin", "libexec"])
  expect(tar.status).toBe(0)
  return fs.readFileSync(archive)
}

const ARCHIVE = fakeArchive()
const SHA = crypto.createHash("sha256").update(ARCHIVE).digest("hex")

const okRun = (_file: string, args: string[]): ProcessRun => args[0] === "--version"
  ? { status: 0, stdout: "git version 2.56.0\n", stderr: "" }
  : { status: 129, stdout: "", stderr: "error: remote-curl: usage: git remote-curl <remote> [<url>]\n" }

function deps(homeDir: string, overrides: Partial<PortableGitInstallDeps> = {}): PortableGitInstallDeps {
  return {
    platform: "linux",
    arch: "arm64",
    homeDir,
    fetch: vi.fn(async () => new Response(ARCHIVE)) as unknown as typeof fetch,
    freeBytes: () => PORTABLE_GIT_MIN_FREE_BYTES,
    extract: (archive, dest) => {
      const run = spawnSync("tar", ["-xzf", archive, "-C", dest])
      if (run.status !== 0) throw new Error(run.stderr.toString())
    },
    run: vi.fn(okRun),
    now: () => new Date("2026-11-10T08:00:00Z"),
    resolveAsset: () => ({ name: "fake.tar.gz", sha256: SHA }),
    assetUrl: () => "https://example.test/fake.tar.gz",
    ...overrides,
  }
}

describe("installPortableGit", () => {
  it("downloads, verifies, installs and links the portable git", async () => {
    const home = tempDir()
    const d = deps(home)
    const result = await installPortableGit(d)
    expect(result.status).toBe("installed")
    expect(result.root).toBe(portableGitRoot(home))
    expect(result.marker).toEqual({
      release: "v2.56.0-2", asset: "fake.tar.gz", sha256: SHA, gitVersion: "git version 2.56.0", installedAt: "2026-11-10T08:00:00.000Z",
    })
    expect(fs.readlinkSync(portableGitRoot(home))).toBe("git-v2.56.0-2")
    expect(fs.existsSync(portableGitBinary(home))).toBe(true)
    expect(readPortableGitMarker(portableGitRoot(home))).toEqual(result.marker)
    expect(fs.readdirSync(portableGitToolsDir(home)).sort()).toEqual(["git", "git-v2.56.0-2"])
    expect(d.fetch).toHaveBeenCalledWith("https://example.test/fake.tar.gz", expect.objectContaining({ redirect: "follow" }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.portable_git_installed" }))
  })

  it("is a no-op when the same release is already installed and linked", async () => {
    const home = tempDir()
    await installPortableGit(deps(home))
    const again = deps(home)
    const result = await installPortableGit(again)
    expect(result.status).toBe("already-installed")
    expect(again.fetch).not.toHaveBeenCalled()
  })

  it("reinstalls with force, and prunes older releases and leftovers", async () => {
    const home = tempDir()
    await installPortableGit(deps(home))
    const tools = portableGitToolsDir(home)
    fs.mkdirSync(path.join(tools, "git-v2.50.0-1"))
    fs.writeFileSync(path.join(tools, ".git-v2.50.0-1.tar.gz"), "")
    fs.mkdirSync(path.join(tools, ".git-v2.50.0-1.partial"))
    fs.writeFileSync(path.join(tools, "unrelated"), "keep")
    const again = deps(home)
    expect((await installPortableGit(again, { force: true })).status).toBe("installed")
    expect(again.fetch).toHaveBeenCalledTimes(1)
    expect(fs.readdirSync(tools).sort()).toEqual(["git", "git-v2.56.0-2", "unrelated"])
  })

  it("refuses a platform with no portable git", async () => {
    const home = tempDir()
    await expect(installPortableGit(deps(home, { platform: "darwin", resolveAsset: undefined }))).rejects.toThrow(
      "no portable git for darwin-arm64; it covers Linux arm64, x64 and arm. Install git with the host's package manager.",
    )
  })

  it("uses the pinned asset and URL by default", async () => {
    const home = tempDir()
    const d = deps(home, { resolveAsset: undefined, assetUrl: undefined })
    await expect(installPortableGit(d)).rejects.toThrow(/failed its checksum: expected d5ce1205/)
    expect(d.fetch).toHaveBeenCalledWith(
      "https://github.com/desktop/dugite-native/releases/download/v2.56.0-2/dugite-native-v2.56.0-a44aeca-ubuntu-arm64.tar.gz",
      expect.anything(),
    )
    expect(fs.readdirSync(portableGitToolsDir(home))).toEqual([])
  })

  it("refuses when the disk is too full", async () => {
    const home = tempDir()
    const d = deps(home, { freeBytes: () => 50 * 1048576 })
    await expect(installPortableGit(d)).rejects.toThrow(/needs 128 MiB free under .*; 50 MiB is free/)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it("fails on an HTTP error and leaves nothing behind", async () => {
    const home = tempDir()
    const d = deps(home, { fetch: vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch })
    await expect(installPortableGit(d)).rejects.toThrow("portable git download failed: HTTP 404 from https://example.test/fake.tar.gz")
    expect(fs.readdirSync(portableGitToolsDir(home))).toEqual([])
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.portable_git_install_error" }))
  })

  it("reports a non-Error failure", async () => {
    const home = tempDir()
    const d = deps(home, { fetch: vi.fn(async () => { throw "offline" }) as unknown as typeof fetch })
    await expect(installPortableGit(d)).rejects.toBe("offline")
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ meta: { error: "offline" } }))
  })

  it("refuses a git that does not run here, keeping the old link", async () => {
    const home = tempDir()
    const d = deps(home, { run: vi.fn(() => ({ status: null, stdout: "", stderr: "spawn ENOEXEC" })) })
    await expect(installPortableGit(d)).rejects.toThrow("portable git does not run on this host: spawn ENOEXEC")
    expect(fs.existsSync(portableGitRoot(home))).toBe(false)
    const quiet = deps(home, { run: vi.fn(() => ({ status: 1, stdout: "bad", stderr: "" })) })
    await expect(installPortableGit(quiet)).rejects.toThrow("portable git does not run on this host: bad")
  })

  it("refuses when the HTTPS helper cannot load libcurl", async () => {
    const home = tempDir()
    const missing = "/x/git-remote-https: error while loading shared libraries: libcurl.so.4: cannot open shared object file"
    const d = deps(home, {
      run: vi.fn((file: string, args: string[]) => args[0] === "remote-https" ? { status: 127, stdout: "", stderr: `${missing}\n` } : okRun(file, args)),
    })
    await expect(installPortableGit(d)).rejects.toThrow(
      `portable git's HTTPS helper cannot load on this host (${missing}); install libcurl (libcurl.so.4) or a system git`,
    )
    const odd = deps(home, {
      run: vi.fn((file: string, args: string[]) => args[0] === "remote-https" ? { status: 127, stdout: "", stderr: "not found" } : okRun(file, args)),
    })
    await expect(installPortableGit(odd)).rejects.toThrow("(not found)")
  })

  it("refuses a git that cannot find its helpers, and checks them with the env activation sets", async () => {
    const home = tempDir()
    const run = vi.fn((file: string, args: string[]) => args[0] === "remote-https"
      ? { status: 1, stdout: "", stderr: "git: 'remote-https' is not a git command. See 'git --help'.\n" }
      : okRun(file, args))
    await expect(installPortableGit(deps(home, { run }))).rejects.toThrow(/portable git cannot find its helpers under .*\.partial: git: 'remote-https' is not a git command/)
    const staging = path.join(portableGitToolsDir(home), ".git-v2.56.0-2.partial")
    expect(run).toHaveBeenCalledWith(path.join(staging, "bin", "git"), ["remote-https"], {
      GIT_EXEC_PATH: path.join(staging, "libexec", "git-core"),
      GIT_TEMPLATE_DIR: path.join(staging, "share", "git-core", "templates"),
    })
  })

  it("will not replace a git directory it did not make", async () => {
    const home = tempDir()
    fs.mkdirSync(portableGitRoot(home), { recursive: true })
    await expect(installPortableGit(deps(home))).rejects.toThrow(/is not the portable git link; move it aside/)
  })

  it.skipIf(process.getuid?.() === 0)("surfaces an unexpected error reading the link", async () => {
    const home = tempDir()
    const tools = portableGitToolsDir(home)
    fs.mkdirSync(tools, { recursive: true })
    fs.chmodSync(tools, 0o000)
    try {
      await expect(installPortableGit(deps(home))).rejects.toThrow(/EACCES/)
    } finally {
      fs.chmodSync(tools, 0o700)
    }
  })
})

describe("readPortableGitMarker", () => {
  it("returns null for a missing or malformed marker", () => {
    const dir = tempDir()
    expect(readPortableGitMarker(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, "ouro-portable-git.json"), JSON.stringify({ release: 1 }))
    expect(readPortableGitMarker(dir)).toBeNull()
  })
})

describe("git availability", () => {
  it("prefers the host's git and does not count the portable one as the host's", async () => {
    const home = tempDir()
    await installPortableGit(deps(home))
    const portableBin = path.dirname(portableGitBinary(home))
    const hostBin = path.join(home, "usr-bin")
    fs.mkdirSync(hostBin)
    fs.writeFileSync(path.join(hostBin, "git"), "#!/bin/sh\n", { mode: 0o755 })

    const both = describeGitAvailability({ env: { PATH: `${portableBin}${path.delimiter}${hostBin}` }, homeDir: home, platform: "linux", arch: "arm64" })
    expect(both.systemGit).toBe(path.join(hostBin, "git"))
    expect(both.portable?.marker?.gitVersion).toBe("git version 2.56.0")
    expect(renderGitAvailability(both)).toBe([
      `system git: ${path.join(hostBin, "git")}`,
      `portable git: ${portableGitRoot(home)} (git version 2.56.0, v2.56.0-2)`,
      "in use: system git",
    ].join("\n"))

    const portableOnly = describeGitAvailability({ env: { PATH: portableBin }, homeDir: home, platform: "linux", arch: "arm64" })
    expect(portableOnly.systemGit).toBeNull()
    expect(renderGitAvailability(portableOnly)).toBe(["system git: none", `portable git: ${portableGitRoot(home)} (git version 2.56.0, v2.56.0-2)`, "in use: portable git"].join("\n"))

    fs.rmSync(path.join(portableGitRoot(home), "ouro-portable-git.json"))
    expect(renderGitAvailability(describeGitAvailability({ env: {}, homeDir: home }))).toContain(`portable git: ${portableGitRoot(home)}\n`)
  })

  it("says what to do when there is no git at all", () => {
    const home = tempDir()
    const hostBin = path.join(home, "usr-bin")
    fs.mkdirSync(hostBin)
    fs.writeFileSync(path.join(hostBin, "git"), "#!/bin/sh\n", { mode: 0o755 })
    expect(renderGitAvailability(describeGitAvailability({ env: { PATH: hostBin }, homeDir: home }))).toBe(`system git: ${path.join(hostBin, "git")}\nin use: system git`)
    expect(renderGitAvailability(describeGitAvailability({ env: {}, homeDir: home, platform: "linux", arch: "x64" }))).toBe("system git: none\nin use: none; run `ouro git install`")
    expect(renderGitAvailability(describeGitAvailability({ env: {}, homeDir: home, platform: "darwin", arch: "arm64" }))).toBe(
      "system git: none\nin use: none; install git with the host's package manager",
    )
    expect(typeof describeGitAvailability().portableSupported).toBe("boolean")
  })
})

describe("removeTree", () => {
  it("removes a nested tree without following links out of it, and ignores a missing path", () => {
    const base = tempDir()
    const outside = path.join(base, "outside")
    fs.mkdirSync(outside)
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep")
    const tree = path.join(base, "tree")
    fs.mkdirSync(path.join(tree, "libexec", "git-core"), { recursive: true })
    fs.writeFileSync(path.join(tree, "libexec", "git-core", "git"), "bin")
    fs.writeFileSync(path.join(tree, "top.txt"), "x")
    fs.symlinkSync(outside, path.join(tree, "link-to-outside"))
    removeTree(tree)
    expect(fs.existsSync(tree)).toBe(false)
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf-8")).toBe("keep")
    removeTree(path.join(base, "never-existed"))
    const file = path.join(base, "file.txt")
    fs.writeFileSync(file, "x")
    removeTree(file)
    expect(fs.existsSync(file)).toBe(false)
  })
})
