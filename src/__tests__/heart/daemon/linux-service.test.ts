import { beforeEach, describe, expect, it, vi } from "vitest"

const nerves = vi.hoisted(() => ({ emit: vi.fn() }))
vi.mock("../../../nerves/runtime", () => ({ emitNervesEvent: nerves.emit }))

import {
  defaultServicePath,
  generateSysvInitScript,
  generateSystemdUnit,
  installLinuxService,
  readServiceRecord,
  serviceRecordPath,
  shellQuote,
  startLinuxService,
  uninstallLinuxService,
  type LinuxServiceDeps,
} from "../../../heart/daemon/linux-service"

const OPTIONS = {
  nodePath: "/opt/node/bin/node",
  entryPath: "/root/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js",
  socketPath: "/tmp/ouroboros-daemon.sock",
  homeDir: "/userdata/ouro",
  ouroCliHome: "/userdata/ouro/.ouro-cli",
  envPath: "/opt/node/bin:/usr/bin:/bin",
}

function fakeDeps(isRoot: boolean) {
  const files = new Map<string, { content: string; mode: number }>()
  const runs: Array<[string, string[]]> = []
  const deps: LinuxServiceDeps & { files: typeof files; runs: typeof runs } = {
    files,
    runs,
    writeFile: (filePath, content, mode) => { files.set(filePath, { content, mode }) },
    readFile: (filePath) => {
      const file = files.get(filePath)
      if (!file) throw new Error(`ENOENT ${filePath}`)
      return file.content
    },
    removeFile: (filePath) => { files.delete(filePath) },
    existsFile: (filePath) => files.has(filePath),
    mkdirp: () => undefined,
    run: (file, args) => { runs.push([file, args]) },
    isRoot,
  }
  return deps
}

describe("linux service", () => {
  beforeEach(() => nerves.emit.mockClear())

  it("quotes for POSIX sh, including single quotes", () => {
    expect(shellQuote("/a b/c")).toBe("'/a b/c'")
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`)
  })

  it("picks the conventional path per init system and user", () => {
    expect(defaultServicePath("sysv", "/home/a", true)).toBe("/etc/init.d/S99ouro")
    expect(defaultServicePath("systemd", "/home/a", true)).toBe("/etc/systemd/system/ouro.service")
    expect(defaultServicePath("systemd", "/home/a", false)).toBe("/home/a/.config/systemd/user/ouro.service")
  })

  it("writes an init script that runs the daemon in the foreground and respawns it only after a failure", () => {
    const script = generateSysvInitScript(OPTIONS)
    expect(script.startsWith("#!/bin/sh\n")).toBe(true)
    expect(script).toContain(`NODE='/opt/node/bin/node'`)
    expect(script).toContain(`SOCKET='/tmp/ouroboros-daemon.sock'`)
    expect(script).toContain(`OURO_HOME='/userdata/ouro'`)
    expect(script).toContain(`PATH='/opt/node/bin:/usr/bin:/bin'`)
    expect(script).toContain(`PIDFILE='/userdata/ouro/.ouro-cli/service.pid'`)
    expect(script).toContain(`HOME="$OURO_HOME" "$NODE" "$ENTRY" --socket "$SOCKET"`)
    expect(script).toContain(`[ "$code" -eq 0 ] && break`)
    expect(script).toContain("sleep 10 &")
    for (const verb of ["start)", "stop)", "restart)", "status)"]) expect(script).toContain(verb)
    expect(generateSysvInitScript({ ...OPTIONS, envPath: undefined })).not.toContain("export PATH")
  })

  it("writes a systemd unit that restarts on failure only", () => {
    const unit = generateSystemdUnit(OPTIONS, false)
    expect(unit).toContain(`ExecStart="/opt/node/bin/node" "${OPTIONS.entryPath}" --socket "/tmp/ouroboros-daemon.sock"`)
    expect(unit).toContain(`Environment="HOME=/userdata/ouro"`)
    expect(unit).toContain(`Environment="PATH=/opt/node/bin:/usr/bin:/bin"`)
    expect(unit).toContain("Restart=on-failure")
    expect(unit).toContain("WantedBy=multi-user.target")
    expect(generateSystemdUnit({ ...OPTIONS, envPath: undefined, nodePath: `/odd "dir"\\node` }, true)).toMatchInlineSnapshot(`
      "# Ouro daemon, written by \`ouro service install --init systemd\`.
      [Unit]
      Description=Ouro daemon
      After=network-online.target
      Wants=network-online.target

      [Service]
      Type=simple
      ExecStart="/odd \\"dir\\"\\\\node" "/root/.ouro-cli/CurrentVersion/node_modules/@ouro.bot/cli/dist/heart/daemon/daemon-entry.js" --socket "/tmp/ouroboros-daemon.sock"
      Environment="HOME=/userdata/ouro"
      Restart=on-failure
      RestartSec=10

      [Install]
      WantedBy=default.target
      "
    `)
  })

  it("installs a SysV script, records it, and starts and removes it through the script", () => {
    const deps = fakeDeps(true)
    const result = installLinuxService(deps, OPTIONS, { init: "sysv" })
    expect(result.record).toEqual({ schemaVersion: 1, init: "sysv", path: "/etc/init.d/S99ouro" })
    expect(deps.files.get("/etc/init.d/S99ouro")).toEqual({ content: generateSysvInitScript(OPTIONS), mode: 0o755 })
    expect(readServiceRecord(deps, OPTIONS.ouroCliHome)).toEqual(result.record)
    expect(deps.runs).toEqual([])
    expect(nerves.emit).toHaveBeenCalledWith(expect.objectContaining({ event: "daemon.service_installed" }))

    expect(startLinuxService(deps, OPTIONS.ouroCliHome)).toBe(true)
    expect(deps.runs).toEqual([["/etc/init.d/S99ouro", ["start"]]])

    expect(uninstallLinuxService(deps, OPTIONS.ouroCliHome)).toEqual(result.record)
    expect(deps.runs.at(-1)).toEqual(["/etc/init.d/S99ouro", ["stop"]])
    expect(deps.existsFile("/etc/init.d/S99ouro")).toBe(false)
    expect(deps.existsFile(serviceRecordPath(OPTIONS.ouroCliHome))).toBe(false)
    expect(startLinuxService(deps, OPTIONS.ouroCliHome)).toBe(false)
    expect(uninstallLinuxService(deps, OPTIONS.ouroCliHome)).toBeNull()
  })

  it("installs a systemd user unit for a non-root user and drives it with systemctl --user", () => {
    const deps = fakeDeps(false)
    const result = installLinuxService(deps, OPTIONS, { init: "systemd" })
    expect(result.record).toEqual({ schemaVersion: 1, init: "systemd", path: "/userdata/ouro/.config/systemd/user/ouro.service", user: true })
    expect(deps.files.get(result.record.path)?.mode).toBe(0o644)
    expect(deps.runs).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "ouro.service"]],
    ])
    expect(startLinuxService(deps, OPTIONS.ouroCliHome)).toBe(true)
    expect(deps.runs.at(-1)).toEqual(["systemctl", ["--user", "start", "ouro.service"]])
    uninstallLinuxService(deps, OPTIONS.ouroCliHome)
    expect(deps.runs.slice(-2)).toEqual([
      ["systemctl", ["--user", "disable", "--now", "ouro.service"]],
      ["systemctl", ["--user", "daemon-reload"]],
    ])
  })

  it("installs a system unit as root at a chosen path", () => {
    const deps = fakeDeps(true)
    const result = installLinuxService(deps, OPTIONS, { init: "systemd", path: "/lib/systemd/system/ouro-agent.service" })
    expect(result.record).toEqual({ schemaVersion: 1, init: "systemd", path: "/lib/systemd/system/ouro-agent.service" })
    expect(deps.runs).toEqual([
      ["systemctl", ["daemon-reload"]],
      ["systemctl", ["enable", "ouro-agent.service"]],
    ])
  })

  it("uninstalls even when the service is already stopped, disabled or deleted", () => {
    const sysv = fakeDeps(true)
    installLinuxService(sysv, OPTIONS, { init: "sysv" })
    sysv.run = () => { throw new Error("not running") }
    expect(uninstallLinuxService(sysv, OPTIONS.ouroCliHome)?.init).toBe("sysv")

    const gone = fakeDeps(true)
    installLinuxService(gone, OPTIONS, { init: "sysv" })
    gone.removeFile("/etc/init.d/S99ouro")
    expect(uninstallLinuxService(gone, OPTIONS.ouroCliHome)?.init).toBe("sysv")
    expect(gone.runs).toEqual([])

    const unit = fakeDeps(true)
    installLinuxService(unit, OPTIONS, { init: "systemd" })
    const runs: string[][] = []
    unit.run = (_file, args) => {
      runs.push(args)
      if (args[0] === "disable") throw new Error("not enabled")
    }
    expect(uninstallLinuxService(unit, OPTIONS.ouroCliHome)?.init).toBe("systemd")
    expect(runs.at(-1)).toEqual(["daemon-reload"])
  })

  it("ignores a missing, unreadable or foreign service record", () => {
    const deps = fakeDeps(true)
    const recordPath = serviceRecordPath(OPTIONS.ouroCliHome)
    expect(readServiceRecord(deps, OPTIONS.ouroCliHome)).toBeNull()
    for (const content of ["not json", JSON.stringify({ schemaVersion: 2, init: "sysv", path: "/x" }), JSON.stringify({ schemaVersion: 1, init: "runit", path: "/x" }), JSON.stringify({ schemaVersion: 1, init: "sysv" })]) {
      deps.writeFile(recordPath, content, 0o644)
      expect(readServiceRecord(deps, OPTIONS.ouroCliHome)).toBeNull()
    }
  })
})
