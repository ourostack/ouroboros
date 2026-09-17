import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { PassThrough } from "node:stream"

import { describe, expect, it, vi } from "vitest"

const programMetadata = vi.hoisted(() => ({ fault: "" }))
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>()
  return {
    ...original,
    lstatSync: (name: import("node:fs").PathLike, options?: unknown) => name === "/program" && programMetadata.fault ? {
      uid: programMetadata.fault === "owner" ? 10001 : 0,
      mode: programMetadata.fault === "writable" ? 0o777 : programMetadata.fault === "non-executable" ? 0o644 : 0o755,
      isFile: () => programMetadata.fault !== "directory",
      isDirectory: () => programMetadata.fault === "directory",
      isSymbolicLink: () => programMetadata.fault === "cycle",
    } : original.lstatSync(name, options as never),
    readlinkSync: (name: import("node:fs").PathLike, options?: unknown) => name === "/program" ? "/program" : original.readlinkSync(name, options as never),
  }
})

import { LinuxSanctuaryHostSupervisorKernel } from "../../../heart/daemon/sanctuary-host-linux-kernel"

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    stdout: PassThrough
    stderr: PassThrough
    stdio: Array<null | PassThrough>
  }
  child.pid = 321
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.stdio = [null, child.stdout, child.stderr, new PassThrough()]
  return child
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-linux-kernel-"))
  const cgroupRoot = path.join(root, "cgroup")
  fs.mkdirSync(cgroupRoot)
  const child = fakeChild()
  const spawn = vi.fn(() => child as never)
  const kill = vi.fn()
  const options = {
    cgroupRoot,
    shellPath: "/bin/sh",
    launcherPath: "/package/launcher.sh",
    prlimitPath: "/usr/bin/prlimit",
    setsidPath: "/usr/bin/setsid",
    spawn,
    kill,
    bootId: () => "boot-1",
    processStartTime: () => "456",
    processCgroup: () => "0::/ouro/permit-a\n",
    now: () => "2026-09-16T20:00:00.000Z",
    sleep: vi.fn(async () => undefined),
    pollIntervalMs: 25,
  }
  return { child, kill, options, root, spawn }
}

const launchInput = {
  permit: { permitId: `permit-${"a".repeat(43)}` },
  executable: "/usr/bin/id",
  arguments: ["-u"],
  cwd: "/" as const,
  environment: { PATH: "/usr/bin" },
  timeoutMs: 1_000,
  cgroupPath: "/sys/fs/cgroup/ouro/permit-a",
}

describe("Linux Sanctuary host supervisor kernel", () => {
  it.each(["owner", "cycle", "writable", "non-directory", "directory", "non-executable"])("refuses a root-owned program with %s metadata", async (fault) => {
    const f = fixture()
    programMetadata.fault = fault
    try {
      const executable = fault === "non-directory" ? "/program/child" : "/program"
      await expect(new LinuxSanctuaryHostSupervisorKernel(f.options).launch({ ...launchInput, executable } as never)).rejects.toThrow(/program/u)
      expect(f.spawn).not.toHaveBeenCalled()
    } finally { programMetadata.fault = "" }
  })

  it("refuses resident-writable program paths before starting the launcher", async () => {
    const f = fixture()
    const executable = path.join(f.root, "resident-program")
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o777 })
    fs.chmodSync(executable, 0o777)
    const kernel = new LinuxSanctuaryHostSupervisorKernel(f.options)
    await expect(kernel.launch({ ...launchInput, executable } as never)).rejects.toThrow(/root-owned/u)
    expect(f.spawn).not.toHaveBeenCalled()
  })

  it("continues cgroup cleanup after a missing process group without hiding other signal failures", async () => {
    const f = fixture()
    const kernel = new LinuxSanctuaryHostSupervisorKernel(f.options)
    const launched = await kernel.launch(launchInput as never)
    f.kill.mockImplementation(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }) })
    expect(() => launched.signalGroup("SIGTERM")).not.toThrow()
    f.kill.mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }) })
    expect(() => launched.signalGroup("SIGTERM")).toThrow("denied")
    f.child.emit("close", 0, null)
  })

  it("creates fixed cgroup limits and drives the one-use launcher handshake", async () => {
    const f = fixture()
    const kernel = new LinuxSanctuaryHostSupervisorKernel(f.options)
    const cgroupPath = await kernel.prepareCgroup(launchInput.permit.permitId, {
      cpuMax: "50000 100000",
      memoryMax: "1073741824",
      pidsMax: "256",
    })
    expect(fs.readFileSync(path.join(cgroupPath, "cpu.max"), "utf8")).toBe("50000 100000")
    expect(fs.readFileSync(path.join(cgroupPath, "memory.max"), "utf8")).toBe("1073741824")
    expect(fs.readFileSync(path.join(cgroupPath, "pids.max"), "utf8")).toBe("256")

    const launched = await kernel.launch(launchInput as never)
    expect(f.spawn).toHaveBeenCalledWith("/bin/sh", [
      "/package/launcher.sh",
      "/sys/fs/cgroup/ouro/permit-a/cgroup.procs",
      "/usr/bin/prlimit",
      "/usr/bin/setsid",
      "/usr/bin/id",
      "-u",
    ], {
      cwd: "/",
      env: { PATH: "/usr/bin" },
      detached: false,
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    })
    f.child.stdio[3]!.end("ready\n")
    await expect(launched.ready).resolves.toBeUndefined()
    f.child.stdout.end("ok\n")
    f.child.stderr.end("warn\n")
    f.child.emit("close", 0, null)
    await expect(launched.completion).resolves.toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
      stderr: "warn\n",
      deadlineExpired: false,
    })
    await expect(launched.drained).resolves.toEqual({
      stdout: "ok\n",
      stderr: "warn\n",
      stdoutDigest: `sha256:${createHash("sha256").update("ok\n").digest("hex")}`,
      stderrDigest: `sha256:${createHash("sha256").update("warn\n").digest("hex")}`,
      stdoutBytes: 3,
      stderrBytes: 5,
    })
    launched.signalGroup("SIGTERM")
    expect(f.kill).toHaveBeenCalledWith(-321, "SIGTERM")
    expect(launched).toMatchObject({ bootId: "boot-1", processStartTime: "456" })
  })

  it("owns deadline, output overflow, handshake refusal, and cgroup cleanup primitives", async () => {
    vi.useFakeTimers()
    try {
      const deadlineFixture = fixture()
      const deadlineKernel = new LinuxSanctuaryHostSupervisorKernel(deadlineFixture.options)
      const deadlineChild = await deadlineKernel.launch(launchInput as never)
      deadlineFixture.child.stdio[3]!.end("wrong\n")
      await expect(deadlineChild.ready).rejects.toThrow(/handshake/u)
      await vi.advanceTimersByTimeAsync(1_000)
      await expect(deadlineChild.completion).resolves.toMatchObject({ deadlineExpired: true })

      const overflowFixture = fixture()
      const overflowKernel = new LinuxSanctuaryHostSupervisorKernel(overflowFixture.options)
      const overflowChild = await overflowKernel.launch(launchInput as never)
      overflowFixture.child.stdio[3]!.end("ready\n")
      overflowFixture.child.stderr.write(Buffer.alloc(65 * 1024, 120))
      await expect(overflowChild.completion).resolves.toMatchObject({
        outputOverflow: true,
        stderr: expect.stringMatching(/^x/u),
      })
      overflowFixture.child.stderr.write(Buffer.alloc(10, 120))
      overflowFixture.child.stdout.write(Buffer.alloc(65 * 1024, 121))
      overflowFixture.child.emit("close", 0, null)
      await expect(overflowChild.drained).resolves.toEqual({
        stdout: "y".repeat(64 * 1024),
        stderr: "x".repeat(64 * 1024),
        stdoutDigest: `sha256:${createHash("sha256").update(Buffer.alloc(65 * 1024, 121)).digest("hex")}`,
        stderrDigest: `sha256:${createHash("sha256").update(Buffer.alloc((65 * 1024) + 10, 120)).digest("hex")}`,
        stdoutBytes: 65 * 1024,
        stderrBytes: (65 * 1024) + 10,
      })
      overflowFixture.child.emit("error", new Error("late"))

      const failedFixture = fixture()
      const failedKernel = new LinuxSanctuaryHostSupervisorKernel(failedFixture.options)
      const failedChild = await failedKernel.launch(launchInput as never)
      const failed = expect(failedChild.completion).rejects.toThrow("spawn failed")
      const failedDrain = expect(failedChild.drained).rejects.toThrow("spawn failed")
      failedFixture.child.emit("error", new Error("spawn failed"))
      await failed
      await failedDrain
    } finally {
      vi.useRealTimers()
    }

    const f = fixture()
    const cgroupPath = path.join(f.options.cgroupRoot, "cleanup")
    fs.mkdirSync(cgroupPath)
    fs.writeFileSync(path.join(cgroupPath, "cgroup.events"), "populated 1\n")
    const kernel = new LinuxSanctuaryHostSupervisorKernel({
      ...f.options,
      sleep: vi.fn(async () => { fs.writeFileSync(path.join(cgroupPath, "cgroup.events"), "populated 0\n") }),
    })

    await expect(kernel.waitForCgroupEmpty(cgroupPath, 50)).resolves.toBe(true)
    await kernel.sleep(1)
    fs.writeFileSync(path.join(cgroupPath, "cgroup.kill"), "")
    await kernel.killCgroup(cgroupPath)
    expect(fs.readFileSync(path.join(cgroupPath, "cgroup.kill"), "utf8")).toBe("1")
    fs.rmSync(path.join(cgroupPath, "cgroup.events"))
    fs.rmSync(path.join(cgroupPath, "cgroup.kill"))
    await kernel.removeCgroup(cgroupPath)
    expect(fs.existsSync(cgroupPath)).toBe(false)
    expect(kernel.now()).toBe("2026-09-16T20:00:00.000Z")
    const verificationTarget = path.join(f.root, "verification-target")
    fs.writeFileSync(verificationTarget, "expected", "utf8")
    const expectedDigest = `sha256:${createHash("sha256").update("expected").digest("hex")}`
    const permit = { targetResource: verificationTarget } as never
    await expect(kernel.verify({ profile: "file.digest.v1", expectedStateDigest: expectedDigest }, "before", permit))
      .resolves.toEqual({ digest: expectedDigest })
    await expect(kernel.verify({ profile: "file.digest.v1", expectedStateDigest: expectedDigest }, "after", permit))
      .resolves.toEqual({ matches: true, digest: expectedDigest })

    const neverEmpty = fixture()
    const neverEmptyPath = path.join(neverEmpty.options.cgroupRoot, "never-empty")
    fs.mkdirSync(neverEmptyPath)
    fs.writeFileSync(path.join(neverEmptyPath, "cgroup.events"), "populated 1\n")
    await expect(new LinuxSanctuaryHostSupervisorKernel(neverEmpty.options).waitForCgroupEmpty(neverEmptyPath, 25)).resolves.toBe(false)
  })

  it("digests exact invalid UTF-8 bytes independently from bounded display excerpts", async () => {
    const f = fixture()
    const child = await new LinuxSanctuaryHostSupervisorKernel(f.options).launch(launchInput as never)
    const raw = Buffer.from([0xff, 0xfe, 0x61])
    f.child.stdout.write(raw)
    f.child.emit("close", 0, null)
    await expect(child.drained).resolves.toEqual({
      stdout: "��a",
      stderr: "",
      stdoutDigest: `sha256:${createHash("sha256").update(raw).digest("hex")}`,
      stderrDigest: `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("hex")}`,
      stdoutBytes: 3,
      stderrBytes: 0,
    })
  })

  it("refuses relative paths and unavailable cgroup populated state", async () => {
    const f = fixture()
    expect(() => new LinuxSanctuaryHostSupervisorKernel({ ...f.options, launcherPath: "relative" })).toThrow(/absolute/u)
    const kernel = new LinuxSanctuaryHostSupervisorKernel(f.options)
    const cgroupPath = path.join(f.options.cgroupRoot, "missing-state")
    fs.mkdirSync(cgroupPath)
    fs.writeFileSync(path.join(cgroupPath, "cgroup.events"), "frozen 0\n")
    await expect(kernel.waitForCgroupEmpty(cgroupPath, 25)).rejects.toThrow(/populated/u)

    const noPid = fixture()
    noPid.options.spawn = vi.fn(() => ({ ...noPid.child, pid: 0 }) as never)
    await expect(new LinuxSanctuaryHostSupervisorKernel(noPid.options).launch(launchInput as never)).rejects.toThrow(/failed to start/u)

    const noHandshake = fixture()
    noHandshake.child.stdio[3] = null
    await expect(new LinuxSanctuaryHostSupervisorKernel(noHandshake.options).launch(launchInput as never)).rejects.toThrow(/failed to start/u)

    const migrated = fixture()
    migrated.options.processCgroup = () => "0::/moved\n"
    const migratedChild = await new LinuxSanctuaryHostSupervisorKernel(migrated.options).launch(launchInput as never)
    migrated.child.emit("close", 0, null)
    await expect(migratedChild.completion).resolves.toMatchObject({ migrationSuspected: true })

    const nonStandardRoot = fixture()
    nonStandardRoot.options.processCgroup = () => "0::/custom/permit-a\n"
    const nonStandardChild = await new LinuxSanctuaryHostSupervisorKernel(nonStandardRoot.options).launch({
      ...launchInput,
      cgroupPath: "/custom/permit-a",
    } as never)
    nonStandardRoot.child.emit("close", 0, null)
    await expect(nonStandardChild.completion).resolves.toMatchObject({ migrationSuspected: false })

    const unreadable = fixture()
    unreadable.options.processCgroup = () => { throw new Error("unreadable") }
    const unreadableChild = await new LinuxSanctuaryHostSupervisorKernel(unreadable.options).launch(launchInput as never)
    unreadable.child.emit("close", 0, null)
    await expect(unreadableChild.completion).resolves.toMatchObject({ migrationSuspected: true })

    const verification = fixture()
    const verificationKernel = new LinuxSanctuaryHostSupervisorKernel(verification.options)
    const target = path.join(verification.root, "target")
    fs.writeFileSync(target, "actual")
    const permit = { targetResource: target } as never
    await expect(verificationKernel.verify({
      profile: "file.digest.v1",
      expectedStateDigest: `sha256:${"0".repeat(64)}`,
    }, "after", permit)).resolves.toMatchObject({ matches: false })
    await expect(verificationKernel.verify({
      profile: "unsupported",
      expectedStateDigest: `sha256:${"0".repeat(64)}`,
    } as never, "before", permit)).rejects.toThrow(/unsupported/u)
    await expect(verificationKernel.verify({
      profile: "file.digest.v1",
      expectedStateDigest: `sha256:${"0".repeat(64)}`,
    }, "before", { targetResource: verification.root } as never)).rejects.toThrow(/regular file/u)
  })
})
