import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => {
    nervesEvents.push(event)
  }),
}))

const mockExecFile = vi.fn()
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}))

import { ensureBwCli, findExecutableOnPath, findExecutableViaNpmPrefix } from "../../repertoire/bw-installer"

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-bw-installer-"))
}

function writeExecutable(targetPath: string): string {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  fs.writeFileSync(targetPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  return targetPath
}

describe("ensureBwCli", () => {
  const originalPath = process.env.PATH
  const originalPathExt = process.env.PATHEXT
  const tempDirs: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    nervesEvents.length = 0
    process.env.PATH = ""
    delete process.env.PATHEXT
  })

  afterEach(() => {
    process.env.PATH = originalPath
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT
    } else {
      process.env.PATHEXT = originalPathExt
    }

    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = makeTempDir()
    tempDirs.push(dir)
    return dir
  }

  it("returns an existing bw binary from PATH without shelling out to which", async () => {
    const binDir = tempDir()
    const bwPath = writeExecutable(path.join(binDir, "bw"))
    process.env.PATH = binDir

    const result = await ensureBwCli()

    expect(result).toBe(bwPath)
    expect(mockExecFile).not.toHaveBeenCalled()
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_install_start")).toBe(false)
  })

  it("finds quoted PATH entries and absolute executable paths", () => {
    const binDir = tempDir()
    const bwPath = writeExecutable(path.join(binDir, "bw"))
    process.env.PATH = binDir

    expect(findExecutableOnPath("bw")).toBe(bwPath)
    expect(findExecutableOnPath("bw", `"${binDir}"`)).toBe(bwPath)
    expect(findExecutableOnPath(bwPath, "")).toBe(bwPath)
    expect(findExecutableOnPath(path.join(binDir, "missing-bw"), "")).toBeNull()
  })

  it("falls back to an empty PATH string when PATH is unset", () => {
    delete process.env.PATH
    expect(findExecutableOnPath("bw")).toBeNull()
  })

  it("supports windows-style PATHEXT lookup without relying on the host shell", () => {
    const binDir = tempDir()
    const bareBwPath = writeExecutable(path.join(binDir, "bw"))
    const bwCmdPath = writeExecutable(path.join(binDir, "bw.CMD"))

    expect(findExecutableOnPath("bw", binDir, "win32", ".CMD;.EXE")).toBe(bwCmdPath)
    expect(findExecutableOnPath("bw.CMD", binDir, "win32", ".CMD;.EXE")).toBe(bwCmdPath)
    expect(findExecutableOnPath("bw", binDir, "win32", "CMD")).toBe(bwCmdPath)
    expect(findExecutableOnPath("bw", binDir, "win32", "")).toBe(bareBwPath)
  })

  it("returns null when npm prefix lookup is empty and finds windows executables in the prefix root", async () => {
    const prefixDir = tempDir()
    const absoluteBwPath = writeExecutable(path.join(prefixDir, "absolute-bw"))
    const bwCmdPath = writeExecutable(path.join(prefixDir, "bw.CMD"))
    let prefixCallCount = 0

    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "npm" && args[0] === "prefix" && args[1] === "-g") {
        prefixCallCount += 1
        cb(null, prefixCallCount === 1 ? "\n" : `${prefixDir}\n`, "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    await expect(findExecutableViaNpmPrefix("bw")).resolves.toBeNull()
    await expect(findExecutableViaNpmPrefix("bw", "win32", ".CMD;.EXE")).resolves.toBe(bwCmdPath)
    await expect(findExecutableViaNpmPrefix(absoluteBwPath)).resolves.toBe(absoluteBwPath)
  })

  it("installs via npm and falls back to npm's global prefix when PATH is unchanged", async () => {
    const prefixDir = tempDir()
    const bwPath = writeExecutable(path.join(prefixDir, "bin", "bw"))

    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "npm" && args[0] === "install") {
        cb(null, "added 1 package\n", "")
        return
      }
      if (cmd === "npm" && args[0] === "prefix" && args[1] === "-g") {
        cb(null, `${prefixDir}\n`, "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    const result = await ensureBwCli()

    expect(result).toBe(bwPath)
    expect(mockExecFile).toHaveBeenCalledTimes(2)
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_install_start")).toBe(true)
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_install_end")).toBe(true)
  })

  it("throws when npm install fails", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "npm" && args[0] === "install") {
        cb(new Error("EACCES: permission denied"), "", "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("failed to install bw CLI via npm")
    await expect(ensureBwCli()).rejects.toThrow("EACCES")
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_install_start")).toBe(true)
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_install_fail")).toBe(true)
  })

  it("throws when npm install succeeds but bw is still not discoverable", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "npm" && args[0] === "install") {
        cb(null, "added 1 package\n", "")
        return
      }
      if (cmd === "npm" && args[0] === "prefix" && args[1] === "-g") {
        cb(null, `${tempDir()}\n`, "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("binary not found in PATH or npm global bin")
  })

  it("tolerates npm prefix lookup failing after a successful install", async () => {
    mockExecFile.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: Function) => {
      if (cmd === "npm" && args[0] === "install") {
        cb(null, "added 1 package\n", "")
        return
      }
      if (cmd === "npm" && args[0] === "prefix" && args[1] === "-g") {
        cb(new Error("npm prefix unavailable"), "", "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    await expect(ensureBwCli()).rejects.toThrow("binary not found in PATH or npm global bin")
  })
})
