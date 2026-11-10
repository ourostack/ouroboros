import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { emitNervesEvent } from "../../../nerves/runtime"
import {
  gentleUpdaterCommand,
  hostSelfUpdatePath,
  memAvailableBytes,
  readHostSelfUpdateConfig,
  renderHostSelfUpdateConfig,
  writeHostSelfUpdateConfig,
  type HostSelfUpdateConfig,
} from "../../../heart/versioning/host-self-update"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const roots: string[] = []
function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-self-update-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const ON: HostSelfUpdateConfig = { schemaVersion: 1, enabled: true, lean: true, minMemAvailableMb: 250, reserveMb: 0 }

describe("host self-update config", () => {
  it("is off when there is no file, or the file is not a valid config", () => {
    const home = tempHome()
    expect(readHostSelfUpdateConfig(home)).toBeNull()
    for (const content of ["not json", "null", JSON.stringify({ ...ON, schemaVersion: 2 }), JSON.stringify({ ...ON, enabled: "yes" }), JSON.stringify({ ...ON, lean: 1 }),
      JSON.stringify({ ...ON, minMemAvailableMb: -1 }), JSON.stringify({ ...ON, reserveMb: 1.5 }), JSON.stringify({ ...ON, keepVersions: 1 }), JSON.stringify({ ...ON, keepVersions: "2" })]) {
      fs.writeFileSync(hostSelfUpdatePath(home), content)
      expect(readHostSelfUpdateConfig(home), content).toBeNull()
    }
  })

  it("writes atomically with mode 0600 and reads it back", () => {
    const home = path.join(tempHome(), "cli-home")
    writeHostSelfUpdateConfig(home, ON)
    expect(readHostSelfUpdateConfig(home)).toEqual(ON)
    expect(fs.statSync(hostSelfUpdatePath(home)).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(home)).toEqual(["self-update.json"])
    writeHostSelfUpdateConfig(home, { ...ON, keepVersions: 2 })
    expect(readHostSelfUpdateConfig(home)?.keepVersions).toBe(2)
    writeHostSelfUpdateConfig(home, { ...ON, enabled: false })
    expect(readHostSelfUpdateConfig(home)?.enabled).toBe(false)
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.host_self_update_configured", message: "unattended updates turned off for this machine" }))
  })

  it("renders on and off", () => {
    expect(renderHostSelfUpdateConfig(null)).toBe("unattended updates on this machine: off (turn on with `ouro self-update enable`)")
    expect(renderHostSelfUpdateConfig({ ...ON, enabled: false })).toContain(": off")
    expect(renderHostSelfUpdateConfig(ON)).toBe([
      "unattended updates on this machine: on",
      "  install: lean (no optional dependencies), at the lowest CPU and I/O priority",
      "  waits while MemAvailable is below 250 MB",
      "  keeps 0 MB free beyond the new version and its 64 MiB headroom",
      "  keeps the newest 5 versions (current and previous always); when an install would not fit, first removes all but current and previous",
    ].join("\n"))
    expect(renderHostSelfUpdateConfig({ ...ON, keepVersions: 2 })).toContain("keeps the newest 2 versions")
    expect(renderHostSelfUpdateConfig({ ...ON, lean: false })).toContain("install: full,")
  })

  it("reads MemAvailable from /proc/meminfo", () => {
    expect(memAvailableBytes("MemTotal:        1010688 kB\nMemFree:          302000 kB\nMemAvailable:     512000 kB\n")).toBe(512000 * 1024)
    expect(memAvailableBytes("MemTotal: 1 kB\n")).toBeNull()
  })

  it("runs the updater under ionice and nice when the host has them", () => {
    const args = ["/h/.ouro-cli/bin/ouro-launcher.js", "self-update", "--unattended"]
    expect(gentleUpdaterCommand("/usr/bin/node", args, (c) => `/bin/${c}`)).toEqual({
      file: "/bin/ionice", args: ["-c", "3", "/bin/nice", "-n", "19", "/usr/bin/node", ...args],
    })
    expect(gentleUpdaterCommand("/usr/bin/node", args, (c) => c === "nice" ? "/bin/nice" : null)).toEqual({
      file: "/bin/nice", args: ["-n", "19", "/usr/bin/node", ...args],
    })
    expect(gentleUpdaterCommand("/usr/bin/node", args, () => null)).toEqual({ file: "/usr/bin/node", args })
  })
})

const USAGE = "Usage: ouro self-update [--unattended] | ouro self-update enable [--full] [--min-mem-available-mb <mb>] [--reserve-mb <mb>] [--keep-versions <n>] | ouro self-update disable | ouro self-update status"

describe("ouro self-update enable | disable | status", () => {
  it("parses", () => {
    expect(parseOuroCommand(["self-update", "enable"])).toEqual({ kind: "self-update.enable" })
    expect(parseOuroCommand(["self-update", "enable", "--full", "--min-mem-available-mb", "300", "--reserve-mb", "128"])).toEqual({
      kind: "self-update.enable", full: true, minMemAvailableMb: 300, reserveMb: 128,
    })
    expect(parseOuroCommand(["self-update", "enable", "--keep-versions", "2"])).toEqual({ kind: "self-update.enable", keepVersions: 2 })
    expect(parseOuroCommand(["self-update", "disable"])).toEqual({ kind: "self-update.disable" })
    expect(parseOuroCommand(["self-update", "status"])).toEqual({ kind: "self-update.status" })
    expect(parseOuroCommand(["self-update", "--unattended"])).toEqual({ kind: "self-update", unattended: true })
    for (const args of [
      ["self-update", "now"],
      ["self-update", "disable", "--full"],
      ["self-update", "status", "x"],
      ["self-update", "enable", "--full", "--full"],
      ["self-update", "enable", "--reserve-mb"],
      ["self-update", "enable", "--reserve-mb", "-1"],
      ["self-update", "enable", "--reserve-mb", "2000000"],
      ["self-update", "enable", "--reserve-mb", "1", "--reserve-mb", "2"],
      ["self-update", "enable", "--min-mem-available-mb", "250MB"],
      ["self-update", "enable", "--min-mem-available-mb", "250", "--min-mem-available-mb", "300"],
      ["self-update", "enable", "--keep-versions", "1"],
      ["self-update", "enable", "--keep-versions", "101"],
      ["self-update", "enable", "--keep-versions", "2", "--keep-versions", "3"],
    ]) {
      expect(() => parseOuroCommand(args), args.join(" ")).toThrow(USAGE)
    }
  })

  function deps(initial: HostSelfUpdateConfig | null) {
    let saved = initial
    const write = vi.fn((config: HostSelfUpdateConfig) => { saved = config })
    return {
      write,
      deps: { writeStdout: vi.fn(), setExitCode: vi.fn(), hostSelfUpdate: { read: () => saved, write } } as unknown as OuroCliDeps,
    }
  }

  it("enable turns it on with lean, 250 MB floor and no extra reserve by default", async () => {
    const d = deps(null)
    const text = await runOuroCli(["self-update", "enable"], d.deps)
    expect(d.write).toHaveBeenCalledWith(ON)
    expect(text).toContain("unattended updates on this machine: on")
  })

  it("enable takes a full install, a floor and a reserve", async () => {
    const d = deps(null)
    await runOuroCli(["self-update", "enable", "--full", "--min-mem-available-mb", "300", "--reserve-mb", "128"], d.deps)
    expect(d.write).toHaveBeenCalledWith({ schemaVersion: 1, enabled: true, lean: false, minMemAvailableMb: 300, reserveMb: 128 })
  })

  it("enable keeps a given number of versions", async () => {
    const d = deps(null)
    await runOuroCli(["self-update", "enable", "--keep-versions", "2"], d.deps)
    expect(d.write).toHaveBeenCalledWith({ ...ON, keepVersions: 2 })
  })

  it("disable keeps the other settings, or the defaults when there were none", async () => {
    const d = deps({ ...ON, lean: false, minMemAvailableMb: 400, reserveMb: 64, keepVersions: 2 })
    expect(await runOuroCli(["self-update", "disable"], d.deps)).toContain(": off")
    expect(d.write).toHaveBeenCalledWith({ schemaVersion: 1, enabled: false, lean: false, minMemAvailableMb: 400, reserveMb: 64, keepVersions: 2 })
    const fresh = deps(null)
    await runOuroCli(["self-update", "disable"], fresh.deps)
    expect(fresh.write).toHaveBeenCalledWith({ ...ON, enabled: false })
  })

  it("status reads without writing", async () => {
    const d = deps(ON)
    expect(await runOuroCli(["self-update", "status"], d.deps)).toContain("waits while MemAvailable is below 250 MB")
    expect(d.write).not.toHaveBeenCalled()
  })

  it("notes that macOS uses its launchd updater", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!
    Object.defineProperty(process, "platform", { value: "darwin" })
    try {
      expect(await runOuroCli(["self-update", "status"], deps(null).deps)).toContain("(on macOS the launchd updater runs updates; this setting is for hosts without it)")
      Object.defineProperty(process, "platform", { value: "linux" })
      expect(await runOuroCli(["self-update", "status"], deps(null).deps)).not.toContain("macOS")
    } finally {
      Object.defineProperty(process, "platform", platform)
    }
  })

  it("fails when the settings are not wired", async () => {
    const setExitCode = vi.fn()
    const text = await runOuroCli(["self-update", "status"], { writeStdout: vi.fn(), setExitCode } as unknown as OuroCliDeps)
    expect(text).toContain("self-update settings are not available in this runtime")
    expect(setExitCode).toHaveBeenCalledWith(1)
  })
})
