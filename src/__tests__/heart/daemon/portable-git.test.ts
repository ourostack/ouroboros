import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { emitNervesEvent } from "../../../nerves/runtime"
import {
  PORTABLE_GIT_ASSETS,
  activatePortableGit,
  findGitOnPath,
  pinGitHelperPath,
  portableGitAsset,
  portableGitAssetUrl,
  portableGitBinary,
  portableGitEnv,
  portableGitRoot,
  portableGitToolsDir,
} from "../../../heart/daemon/portable-git"

const roots: string[] = []
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "portable-git-"))
  roots.push(dir)
  return dir
}

function executable(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, "#!/bin/sh\n", { mode: 0o755 })
}

afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  vi.mocked(emitNervesEvent).mockClear()
})

describe("portable git assets", () => {
  it("covers Linux arm64, x64 and arm, and nothing else", () => {
    expect(Object.keys(PORTABLE_GIT_ASSETS).sort()).toEqual(["linux-arm", "linux-arm64", "linux-x64"])
    expect(portableGitAsset("linux", "arm64")?.name).toBe("dugite-native-v2.56.0-a44aeca-ubuntu-arm64.tar.gz")
    expect(portableGitAsset("darwin", "arm64")).toBeNull()
    expect(portableGitAsset("linux", "ia32")).toBeNull()
    for (const asset of Object.values(PORTABLE_GIT_ASSETS)) expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it("downloads from the pinned dugite-native release", () => {
    expect(portableGitAssetUrl(PORTABLE_GIT_ASSETS["linux-arm64"])).toBe(
      "https://github.com/desktop/dugite-native/releases/download/v2.56.0-2/dugite-native-v2.56.0-a44aeca-ubuntu-arm64.tar.gz",
    )
  })

  it("lives under ~/.ouro-cli/tools/git", () => {
    expect(portableGitToolsDir("/h")).toBe("/h/.ouro-cli/tools")
    expect(portableGitRoot("/h")).toBe("/h/.ouro-cli/tools/git")
    expect(portableGitBinary("/h")).toBe("/h/.ouro-cli/tools/git/bin/git")
    // With no argument, the home directory is the user's own.
    expect(portableGitRoot()).toBe(portableGitRoot(os.homedir()))
    expect(portableGitToolsDir()).toBe(portableGitToolsDir(os.homedir()))
    expect(portableGitBinary()).toBe(portableGitBinary(os.homedir()))
  })
})

describe("portableGitEnv", () => {
  it("points git at its helpers and templates, and at its CA bundle when present", () => {
    expect(portableGitEnv("/r", () => false)).toEqual({ GIT_EXEC_PATH: "/r/libexec/git-core", GIT_TEMPLATE_DIR: "/r/share/git-core/templates" })
    expect(portableGitEnv("/r", (p) => p === "/r/ssl/cacert.pem")).toEqual({
      GIT_EXEC_PATH: "/r/libexec/git-core", GIT_TEMPLATE_DIR: "/r/share/git-core/templates", GIT_SSL_CAINFO: "/r/ssl/cacert.pem",
    })
    const dir = tempHome()
    fs.mkdirSync(path.join(dir, "ssl"))
    fs.writeFileSync(path.join(dir, "ssl", "cacert.pem"), "")
    expect(portableGitEnv(dir).GIT_SSL_CAINFO).toBe(path.join(dir, "ssl", "cacert.pem"))
  })
})

describe("findGitOnPath", () => {
  it("returns the first executable git and skips empty entries", () => {
    const home = tempHome()
    const a = path.join(home, "a")
    const b = path.join(home, "b")
    fs.mkdirSync(a)
    executable(path.join(b, "git"))
    expect(findGitOnPath(["", a, b].join(path.delimiter))).toBe(path.join(b, "git"))
    expect(findGitOnPath(a)).toBeNull()
    expect(findGitOnPath(undefined)).toBeNull()
  })

  it("ignores a directory or a non-executable file named git", () => {
    const home = tempHome()
    fs.mkdirSync(path.join(home, "d", "git"), { recursive: true })
    fs.mkdirSync(path.join(home, "f"))
    fs.writeFileSync(path.join(home, "f", "git"), "", { mode: 0o644 })
    expect(findGitOnPath([path.join(home, "d"), path.join(home, "f")].join(path.delimiter))).toBeNull()
  })
})

describe("activatePortableGit", () => {
  it("does nothing when no portable git is installed", () => {
    const home = tempHome()
    const env: NodeJS.ProcessEnv = { PATH: "/nowhere" }
    expect(activatePortableGit({ env, homeDir: home })).toEqual({ status: "absent" })
    expect(env.PATH).toBe("/nowhere")
  })

  it("leaves PATH alone when the host has its own git", () => {
    const home = tempHome()
    executable(portableGitBinary(home))
    const hostBin = path.join(home, "usr-bin")
    executable(path.join(hostBin, "git"))
    const env: NodeJS.ProcessEnv = { PATH: hostBin }
    expect(activatePortableGit({ env, homeDir: home })).toEqual({ status: "system", git: path.join(hostBin, "git") })
    expect(env.PATH).toBe(hostBin)
  })

  it("puts the portable git first on PATH when the host has none, once", () => {
    const home = tempHome()
    executable(portableGitBinary(home))
    const binDir = path.dirname(portableGitBinary(home))
    const env: NodeJS.ProcessEnv = { PATH: "/nowhere" }
    expect(activatePortableGit({ env, homeDir: home })).toEqual({ status: "activated", binDir })
    expect(env.PATH).toBe(`${binDir}${path.delimiter}/nowhere`)
    const root = portableGitRoot(home)
    expect(env.GIT_EXEC_PATH).toBe(path.join(root, "libexec", "git-core"))
    expect(env.GIT_TEMPLATE_DIR).toBe(path.join(root, "share", "git-core", "templates"))
    expect(env.GIT_SSL_CAINFO).toBeUndefined()
    expect(activatePortableGit({ env, homeDir: home })).toEqual({ status: "activated", binDir })
    expect(env.PATH).toBe(`${binDir}${path.delimiter}/nowhere`)
    expect(emitNervesEvent).toHaveBeenCalledTimes(1)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.portable_git_activated" }))
  })

  it("keeps git settings the host already has", () => {
    const home = tempHome()
    executable(portableGitBinary(home))
    const env: NodeJS.ProcessEnv = { PATH: "/nowhere", GIT_SSL_CAINFO: "/etc/ca.pem", GIT_EXEC_PATH: "/custom" }
    activatePortableGit({ env, homeDir: home })
    expect(env.GIT_EXEC_PATH).toBe("/custom")
    expect(env.GIT_SSL_CAINFO).toBe("/etc/ca.pem")
    expect(env.GIT_TEMPLATE_DIR).toBe(path.join(portableGitRoot(home), "share", "git-core", "templates"))
  })

  it("sets PATH when it was empty", () => {
    const home = tempHome()
    executable(portableGitBinary(home))
    const env: NodeJS.ProcessEnv = {}
    activatePortableGit({ env, homeDir: home })
    expect(env.PATH).toBe(path.dirname(portableGitBinary(home)))
  })

  it("defaults to process.env and an injected check", () => {
    const isExecutable = vi.fn(() => false)
    const before = process.env.PATH
    expect(activatePortableGit({ isExecutable })).toEqual({ status: "absent" })
    expect(isExecutable).toHaveBeenCalledWith(portableGitBinary())
    expect(process.env.PATH).toBe(before)
  })
})

describe("pinGitHelperPath", () => {
  const gitBinary = "/cache/github-copilot-git/bin/git"
  const libexec = "/cache/github-copilot-git/libexec/git-core"
  const helper = path.join(libexec, "git-remote-https")

  it("points GIT_EXEC_PATH at the libexec beside git when git cannot find its https helper", () => {
    const env: NodeJS.ProcessEnv = {}
    const exists = (filePath: string) => filePath === helper
    expect(pinGitHelperPath(gitBinary, env, { exists, execPath: () => "//libexec/git-core" })).toBe(true)
    expect(env.GIT_EXEC_PATH).toBe(libexec)
  })

  it("leaves the environment alone when git already finds its helper", () => {
    const env: NodeJS.ProcessEnv = {}
    const exists = (filePath: string) => filePath === helper
    expect(pinGitHelperPath(gitBinary, env, { exists, execPath: () => libexec })).toBe(false)
    expect(env.GIT_EXEC_PATH).toBeUndefined()
  })

  it("keeps a GIT_EXEC_PATH the host already set", () => {
    const env: NodeJS.ProcessEnv = { GIT_EXEC_PATH: "/elsewhere" }
    expect(pinGitHelperPath(gitBinary, env, { exists: () => true, execPath: () => null })).toBe(false)
    expect(env.GIT_EXEC_PATH).toBe("/elsewhere")
  })

  it("does nothing when there is no helper beside git to point at", () => {
    const env: NodeJS.ProcessEnv = {}
    expect(pinGitHelperPath(gitBinary, env, { exists: () => false, execPath: () => null })).toBe(false)
    expect(env.GIT_EXEC_PATH).toBeUndefined()
  })

  it("asks git for its own exec path, and points at the helper beside it when that path has none", () => {
    const home = tempHome()
    const git = path.join(home, "bin", "git")
    executable(git)
    fs.writeFileSync(git, "#!/bin/sh\necho //libexec/git-core\n", { mode: 0o755 })
    const beside = path.join(home, "libexec", "git-core")
    fs.mkdirSync(beside, { recursive: true })
    fs.writeFileSync(path.join(beside, "git-remote-https"), "")
    const env: NodeJS.ProcessEnv = {}
    expect(pinGitHelperPath(git, env)).toBe(true)
    expect(env.GIT_EXEC_PATH).toBe(beside)
  })

  it("treats a git that cannot report its exec path as lacking the helper", () => {
    const home = tempHome()
    const git = path.join(home, "bin", "git")
    executable(git)
    fs.writeFileSync(git, "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const beside = path.join(home, "libexec", "git-core")
    fs.mkdirSync(beside, { recursive: true })
    fs.writeFileSync(path.join(beside, "git-remote-https"), "")
    const env: NodeJS.ProcessEnv = {}
    expect(pinGitHelperPath(git, env)).toBe(true)
    expect(env.GIT_EXEC_PATH).toBe(beside)
  })

  it("pins the helper path for the host's git when no portable git is installed", () => {
    const home = tempHome()
    const hostBin = path.join(home, "host", "bin")
    executable(path.join(hostBin, "git"))
    fs.writeFileSync(path.join(hostBin, "git"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    const beside = path.join(home, "host", "libexec", "git-core")
    fs.mkdirSync(beside, { recursive: true })
    fs.writeFileSync(path.join(beside, "git-remote-https"), "")
    const env: NodeJS.ProcessEnv = { PATH: hostBin }
    expect(activatePortableGit({ env, homeDir: path.join(home, "nobody") })).toEqual({ status: "absent" })
    expect(env.GIT_EXEC_PATH).toBe(beside)
  })

  it("leaves the environment alone when git reports an exec path with its helper", () => {
    const home = tempHome()
    const git = path.join(home, "bin", "git")
    const ownExecPath = path.join(home, "own-git-core")
    executable(git)
    fs.writeFileSync(git, `#!/bin/sh\necho ${ownExecPath}\n`, { mode: 0o755 })
    fs.mkdirSync(ownExecPath, { recursive: true })
    fs.writeFileSync(path.join(ownExecPath, "git-remote-https"), "")
    fs.mkdirSync(path.join(home, "libexec", "git-core"), { recursive: true })
    fs.writeFileSync(path.join(home, "libexec", "git-core", "git-remote-https"), "")
    const env: NodeJS.ProcessEnv = {}
    expect(pinGitHelperPath(git, env)).toBe(false)
    expect(env.GIT_EXEC_PATH).toBeUndefined()
  })
})
