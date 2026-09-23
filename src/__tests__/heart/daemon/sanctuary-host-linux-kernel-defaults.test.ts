import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const controls = vi.hoisted(() => ({ shortStat: false, cgroupError: false, cgroupMissing: false }))

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  const { EventEmitter } = await import("node:events")
  const { PassThrough } = await import("node:stream")
  return {
    ...original,
    spawn: vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        pid: number
        stdout: InstanceType<typeof PassThrough>
        stderr: InstanceType<typeof PassThrough>
        stdio: Array<null | InstanceType<typeof PassThrough>>
      }
      child.pid = 321
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()]
      return child as never
    }),
  }
})

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    readFileSync: (filePath: import("node:fs").PathOrFileDescriptor, options?: unknown) => {
      if (filePath === "/proc/sys/kernel/random/boot_id") return "boot-default"
      if (filePath === "/proc/321/stat") {
        return controls.shortStat ? "short" : `${Array.from({ length: 21 }, () => "0").join(" ")} 789`
      }
      if (filePath === "/proc/321/cgroup" && controls.cgroupError) {
        throw Object.assign(new Error("denied"), { code: "EACCES" })
      }
      if (filePath === "/proc/321/cgroup" && controls.cgroupMissing) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" })
      }
      return original.readFileSync(filePath, options as never)
    },
  }
})

import * as fs from "node:fs"
import { LinuxSanctuaryHostSupervisorKernel } from "../../../heart/daemon/sanctuary-host-linux-kernel"

describe("Linux supervisor kernel production defaults", () => {
  it("uses default spawn, identity, process-group signal, polling, sleep, and clock", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-linux-defaults-"))
    const cgroupRoot = path.join(root, "cgroup")
    fs.mkdirSync(cgroupRoot)
    const kernel = new LinuxSanctuaryHostSupervisorKernel({
      cgroupRoot,
      shellPath: "/bin/sh",
      launcherPath: "/launcher",
      prlimitPath: "/prlimit",
      setsidPath: "/setsid",
    })
    const launched = await kernel.launch({
      permit: { permitId: `permit-${"a".repeat(43)}` },
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/",
      environment: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      cgroupPath: "/cgroup/permit",
    } as never)
    expect(launched).toMatchObject({ bootId: "boot-default", processStartTime: "789" })
    const originalKill = process.kill
    const kill = vi.fn()
    process.kill = kill as typeof process.kill
    try {
      launched.signalGroup("SIGTERM")
      expect(kill).toHaveBeenCalledWith(-321, "SIGTERM")
    } finally {
      process.kill = originalKill
    }

    const eventsRoot = path.join(cgroupRoot, "events")
    fs.mkdirSync(eventsRoot)
    fs.writeFileSync(path.join(eventsRoot, "cgroup.events"), "populated 0\n")
    await expect(kernel.waitForCgroupEmpty(eventsRoot, 25)).resolves.toBe(true)
    expect(kernel.now()).toMatch(/Z$/u)

    vi.useFakeTimers()
    try {
      fs.writeFileSync(path.join(eventsRoot, "cgroup.events"), "populated 1\n")
      const waiting = kernel.waitForCgroupEmpty(eventsRoot, 25)
      const empty = expect(waiting).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(25)
      await empty
      const sleeping = kernel.sleep(25)
      await vi.advanceTimersByTimeAsync(25)
      await sleeping
    } finally {
      vi.useRealTimers()
    }

    controls.shortStat = true
    const missingStart = await kernel.launch({
      permit: { permitId: `permit-${"b".repeat(43)}` },
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/",
      environment: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      cgroupPath: "/cgroup/permit-b",
    } as never)
    expect(missingStart.processStartTime).toBe("")
    controls.shortStat = false

    controls.cgroupError = true
    await kernel.launch({
      permit: { permitId: `permit-${"c".repeat(43)}` },
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/",
      environment: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      cgroupPath: "/cgroup/permit-c",
    } as never)
    controls.cgroupError = false

    // A cgroup read that ENOENTs (the spawned child already exited) must be
    // handled by defaultProcessCgroup returning null, deterministically -- not
    // left to a filesystem race, which is what made the coverage gate flaky.
    controls.cgroupMissing = true
    await kernel.launch({
      permit: { permitId: `permit-${"d".repeat(43)}` },
      executable: "/usr/bin/id",
      arguments: [],
      cwd: "/",
      environment: { PATH: "/usr/bin" },
      timeoutMs: 1_000,
      cgroupPath: "/cgroup/permit-d",
    } as never)
    controls.cgroupMissing = false
  })
})
