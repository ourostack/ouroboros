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

import { bwCommand, ensureBwCli, findBundledBwCli, findExecutableOnPath, findExecutableViaNpmPrefix, PINNED_BW_CLI_VERSION } from "../../repertoire/bw-installer"

const NO_BUNDLED = (): null => null

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
    delete process.env.OURO_BW_BINARY
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

    const result = await ensureBwCli(NO_BUNDLED)

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
        expect(args).toEqual(["install", "-g", `@bitwarden/cli@${PINNED_BW_CLI_VERSION}`])
        cb(null, "added 1 package\n", "")
        return
      }
      if (cmd === "npm" && args[0] === "prefix" && args[1] === "-g") {
        cb(null, `${prefixDir}\n`, "")
        return
      }
      cb(new Error(`unexpected call: ${cmd} ${args.join(" ")}`), "", "")
    })

    const result = await ensureBwCli(NO_BUNDLED)

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

    await expect(ensureBwCli(NO_BUNDLED)).rejects.toThrow("failed to install bw CLI via npm")
    await expect(ensureBwCli(NO_BUNDLED)).rejects.toThrow("EACCES")
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

    await expect(ensureBwCli(NO_BUNDLED)).rejects.toThrow("binary not found in PATH or npm global bin")
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

    await expect(ensureBwCli(NO_BUNDLED)).rejects.toThrow("binary not found in PATH or npm global bin")
  })

  it("uses OURO_BW_BINARY before anything else, and refuses one that is not executable", async () => {
    const override = writeExecutable(path.join(tempDir(), "custom-bw"))
    process.env.OURO_BW_BINARY = ` ${override} `
    await expect(ensureBwCli(() => "/should/not/be/used/bw.js")).resolves.toBe(override)
    process.env.OURO_BW_BINARY = path.join(tempDir(), "absent-bw")
    await expect(ensureBwCli(NO_BUNDLED)).rejects.toThrow(/OURO_BW_BINARY is set to .*absent-bw, which is not an executable file/)
    process.env.OURO_BW_BINARY = "  "
    await expect(ensureBwCli(() => override)).resolves.toBe(override)
  })

  it("prefers the bw that ships with ouro over one on PATH", async () => {
    const binDir = tempDir()
    writeExecutable(path.join(binDir, "bw"))
    process.env.PATH = binDir
    const bundled = writeExecutable(path.join(tempDir(), "bundled-bw"))

    await expect(ensureBwCli(() => bundled)).resolves.toBe(bundled)
    expect(mockExecFile).not.toHaveBeenCalled()
  })

  it("finds the bundled bw entry point from the @bitwarden/cli package, and says when it is missing", () => {
    const pkgDir = tempDir()
    const entry = path.join(pkgDir, "build", "bw.js")
    fs.mkdirSync(path.dirname(entry), { recursive: true })
    fs.writeFileSync(entry, "// not executable on purpose\n", { mode: 0o644 })
    const pkgJson = path.join(pkgDir, "package.json")
    const resolveTo = (target: string) => (id: string): string => {
      expect(id).toBe("@bitwarden/cli/package.json")
      return target
    }

    fs.writeFileSync(pkgJson, JSON.stringify({ bin: { bw: "build/bw.js" } }))
    expect(findBundledBwCli(resolveTo(pkgJson))).toBe(entry)
    fs.writeFileSync(pkgJson, JSON.stringify({ bin: "build/bw.js" }))
    expect(findBundledBwCli(resolveTo(pkgJson))).toBe(entry)
    expect(nervesEvents.some((event) => event.event === "repertoire.bw_cli_bundled_missing")).toBe(false)

    fs.writeFileSync(pkgJson, JSON.stringify({ bin: { other: "x.js" } }))
    expect(findBundledBwCli(resolveTo(pkgJson))).toBeNull()
    fs.writeFileSync(pkgJson, JSON.stringify({}))
    expect(findBundledBwCli(resolveTo(pkgJson))).toBeNull()
    fs.writeFileSync(pkgJson, JSON.stringify({ bin: "missing.js" }))
    expect(findBundledBwCli(resolveTo(pkgJson))).toBeNull()
    expect(findBundledBwCli(() => { throw new Error("Cannot find module") })).toBeNull()
    expect(findBundledBwCli(() => { throw "not an error" })).toBeNull()
    const missing = nervesEvents.filter((event) => event.event === "repertoire.bw_cli_bundled_missing")
    expect(missing).toHaveLength(5)
    expect(missing.map((event) => (event.meta as { reason: string }).reason)).toEqual([
      "@bitwarden/cli package.json names no bw entry point",
      "@bitwarden/cli package.json names no bw entry point",
      `bundled bw entry point is missing: ${path.join(pkgDir, "missing.js")}`,
      "Cannot find module",
      "not an error",
    ])
  })

  it("runs a .js bw entry point under ouro's own node, and anything else directly", () => {
    expect(bwCommand("/x/build/bw.js", ["status"], "/opt/node")).toEqual({ file: "/opt/node", args: ["/x/build/bw.js", "status"] })
    expect(bwCommand("/usr/local/bin/bw", ["status"], "/opt/node")).toEqual({ file: "/usr/local/bin/bw", args: ["status"] })
    expect(bwCommand("/x/build/bw.js", ["status"]).file).toBe(process.execPath)
  })

  it("finds the real bundled bw at the pinned version", () => {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf8")) as { dependencies: Record<string, string> }
    expect(rootPkg.dependencies["@bitwarden/cli"]).toBe(PINNED_BW_CLI_VERSION)
    const found = findBundledBwCli()
    expect(found).not.toBeNull()
    const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(found!), "..", "package.json"), "utf8")) as { name: string; version: string }
    expect(pkg).toMatchObject({ name: "@bitwarden/cli", version: PINNED_BW_CLI_VERSION })
  })

  it("starts the real bundled bw with no node on PATH and reports the pinned version", async () => {
    const { execFileSync } = await vi.importActual<typeof import("node:child_process")>("node:child_process")
    const command = bwCommand(findBundledBwCli()!, ["--version"])
    const version = execFileSync(command.file, command.args, { env: { PATH: "", HOME: tempDir() }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
    expect(version).toBe(PINNED_BW_CLI_VERSION)
  }, 60_000)
})
