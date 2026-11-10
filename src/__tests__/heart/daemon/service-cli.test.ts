import { describe, expect, it, vi } from "vitest"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"
import { runOuroCli } from "../../../heart/daemon/cli-exec"
import type { OuroCliDeps } from "../../../heart/daemon/cli-types"

const USAGE = "Usage: ouro service install --init <sysv|systemd> [--path <file>] [--print] | ouro service uninstall"

describe("ouro service", () => {
  it("parses install and uninstall", () => {
    expect(parseOuroCommand(["service", "install", "--init", "sysv"])).toEqual({ kind: "service.install", init: "sysv", print: false })
    expect(parseOuroCommand(["service", "install", "--print", "--init", "systemd", "--path", "/etc/systemd/system/a.service"])).toEqual({
      kind: "service.install", init: "systemd", print: true, path: "/etc/systemd/system/a.service",
    })
    expect(parseOuroCommand(["service", "uninstall"])).toEqual({ kind: "service.uninstall" })
    for (const args of [
      ["service"],
      ["service", "start"],
      ["service", "uninstall", "--now"],
      ["service", "install"],
      ["service", "install", "--init", "runit"],
      ["service", "install", "--init"],
      ["service", "install", "--init", "sysv", "--init", "systemd"],
      ["service", "install", "--init", "sysv", "--path"],
      ["service", "install", "--init", "sysv", "--path", "--print"],
      ["service", "install", "--init", "sysv", "--path", "/a", "--path", "/b"],
      ["service", "install", "--init", "sysv", "--print", "--print"],
      ["service", "install", "--init", "sysv", "extra"],
    ]) {
      expect(() => parseOuroCommand(args), args.join(" ")).toThrow(USAGE)
    }
  })

  it("installs through the wired service and says what it did", async () => {
    const writeStdout = vi.fn()
    const install = vi.fn(() => ({ path: "/etc/init.d/S99ouro", content: "#!/bin/sh\n", written: true }))
    const deps = { writeStdout, linuxService: { install, uninstall: vi.fn() } } as unknown as OuroCliDeps
    const text = await runOuroCli(["service", "install", "--init", "sysv"], deps)
    expect(install).toHaveBeenCalledWith({ init: "sysv", print: false })
    expect(text).toContain("installed the Ouro sysv service at /etc/init.d/S99ouro")
    expect(text).toContain("`ouro up` now starts the daemon through it")
    expect(text).toContain("/etc/init.d/S*")

    install.mockReturnValueOnce({ path: "/x.service", content: "[Unit]\n", written: true })
    const unit = await runOuroCli(["service", "install", "--init", "systemd", "--path", "/x.service"], deps)
    expect(install).toHaveBeenLastCalledWith({ init: "systemd", print: false, path: "/x.service" })
    expect(unit).not.toContain("/etc/init.d/S*")
  })

  it("prints the file without installing it when asked", async () => {
    const writeStdout = vi.fn()
    const install = vi.fn(() => ({ path: "/etc/init.d/S99ouro", content: "#!/bin/sh\necho hi\n", written: false }))
    const text = await runOuroCli(["service", "install", "--init", "sysv", "--print"], { writeStdout, linuxService: { install, uninstall: vi.fn() } } as unknown as OuroCliDeps)
    expect(text).toBe("#!/bin/sh\necho hi\n")
    expect(writeStdout).toHaveBeenCalledWith("#!/bin/sh\necho hi\n")
  })

  it("uninstalls, or says nothing is installed", async () => {
    const writeStdout = vi.fn()
    const uninstall = vi.fn(() => ({ path: "/etc/init.d/S99ouro" }))
    const deps = { writeStdout, linuxService: { install: vi.fn(), uninstall } } as unknown as OuroCliDeps
    expect(await runOuroCli(["service", "uninstall"], deps)).toBe("removed the Ouro service at /etc/init.d/S99ouro")
    uninstall.mockReturnValueOnce(null as never)
    expect(await runOuroCli(["service", "uninstall"], deps)).toBe("no Ouro service is installed")
  })

  it("reports when the service dependency isn't wired", async () => {
    const writeStdout = vi.fn()
    expect(await runOuroCli(["service", "uninstall"], { writeStdout } as unknown as OuroCliDeps)).toBe("ouro service is unavailable here (dep not wired)")
  })
})
