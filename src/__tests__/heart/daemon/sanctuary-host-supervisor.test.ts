import { createHash } from "node:crypto"

import { describe, expect, it, vi } from "vitest"

import {
  KernelSanctuaryHostSupervisor,
  type SanctuaryHostSupervisorKernel,
} from "../../../heart/daemon/sanctuary-host-supervisor"

const digest = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`
const drained = (stdout = "", stderr = "") => Promise.resolve({
  stdout,
  stderr,
  stdoutDigest: digest(stdout),
  stderrDigest: digest(stderr),
  stdoutBytes: Buffer.byteLength(stdout),
  stderrBytes: Buffer.byteLength(stderr),
})

function kernel(overrides: Partial<SanctuaryHostSupervisorKernel> = {}): SanctuaryHostSupervisorKernel {
  return {
    prepareCgroup: vi.fn(async () => "/sys/fs/cgroup/ouro/permit-a"),
    launch: vi.fn(async () => ({
      pid: 123,
      bootId: "boot-1",
      processStartTime: "456",
      ready: Promise.resolve(),
      completion: Promise.resolve({ exitCode: 0, signal: null, stdout: "ok\n", stderr: "", outputOverflow: false, migrationSuspected: false }),
      drained: drained("ok\n"),
      signalGroup: vi.fn(),
    })),
    waitForCgroupEmpty: vi.fn(async () => true),
    killCgroup: vi.fn(async () => undefined),
    removeCgroup: vi.fn(async () => undefined),
    sleep: vi.fn(async () => undefined),
    now: vi.fn()
      .mockReturnValueOnce("2026-09-16T20:00:00.000Z")
      .mockReturnValue("2026-09-16T20:00:01.000Z"),
    verify: vi.fn(async () => null),
    ...overrides,
  }
}

const input = {
  permit: {
    permitId: `permit-${"a".repeat(43)}`,
    targetResource: "host",
    verification: null,
  },
  executable: "/usr/bin/id",
  arguments: ["-u"],
  cwd: "/" as const,
  environment: { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" },
  timeoutMs: 60_000,
}

describe("Sanctuary host supervisor", () => {
  it("binds the launched process, waits for cgroup emptiness, and removes only an empty cgroup", async () => {
    const dependencies = kernel()
    const supervisor = new KernelSanctuaryHostSupervisor(dependencies)
    await expect(supervisor.execute(input as never)).resolves.toMatchObject({
      exitCode: 0,
      timedOut: false,
      cleanup: "cgroup_empty",
      containment: "approved_root_may_escape",
      stdout: "ok\n",
    })
    expect(dependencies.prepareCgroup).toHaveBeenCalledWith(input.permit.permitId, {
      cpuMax: "50000 100000",
      memoryMax: "1073741824",
      pidsMax: "256",
    })
    expect(dependencies.waitForCgroupEmpty).toHaveBeenCalledWith("/sys/fs/cgroup/ouro/permit-a", 59_000)
    expect(dependencies.removeCgroup).toHaveBeenCalledWith("/sys/fs/cgroup/ouro/permit-a")
    expect(dependencies.killCgroup).not.toHaveBeenCalled()
  })

  it("survives leader exit by waiting for descendants and force-cleans deadline or output overflow", async () => {
    for (const completion of [
      { exitCode: 0, signal: null, stdout: "", stderr: "", outputOverflow: false, migrationSuspected: false },
      { exitCode: null, signal: "SIGTERM", stdout: "x", stderr: "", outputOverflow: true, migrationSuspected: false },
    ]) {
      const signalGroup = vi.fn()
      const dependencies = kernel({
        launch: vi.fn(async () => ({
          pid: 123,
          bootId: "boot-1",
          processStartTime: "456",
          ready: Promise.resolve(),
          completion: Promise.resolve(completion),
          drained: drained(completion.stdout, completion.stderr),
          signalGroup,
        })),
        waitForCgroupEmpty: vi.fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true),
      })
      const result = await new KernelSanctuaryHostSupervisor(dependencies).execute(input as never)
      expect(result.timedOut || result.outputOverflow).toBe(true)
      expect(signalGroup).toHaveBeenCalledWith("SIGTERM")
      expect(dependencies.sleep).toHaveBeenCalledWith(10_000)
      expect(dependencies.killCgroup).toHaveBeenCalledOnce()
      expect(dependencies.removeCgroup).toHaveBeenCalledOnce()
    }
  })

  it("does not claim containment after detected migration or cleanup when cgroup emptiness is unknown", async () => {
    const migrated = kernel({
      launch: vi.fn(async () => ({
        pid: 123,
        bootId: "boot-1",
        processStartTime: "456",
        ready: Promise.resolve(),
        completion: Promise.resolve({ exitCode: 0, signal: null, stdout: "", stderr: "", outputOverflow: false, migrationSuspected: true }),
        drained: drained(),
        signalGroup: vi.fn(),
      })),
    })
    await expect(new KernelSanctuaryHostSupervisor(migrated).execute(input as never)).resolves.toMatchObject({
      containment: "unprovable_after_approved_root_migration",
      cleanup: "cgroup_empty",
    })

    const unknown = kernel({
      waitForCgroupEmpty: vi.fn(async () => false),
    })
    await expect(new KernelSanctuaryHostSupervisor(unknown).execute(input as never)).rejects.toThrow(/output drain/u)
    expect(unknown.removeCgroup).not.toHaveBeenCalled()
  })

  it("fails closed on handshake or primitive failure and allows only one active attempt", async () => {
    const failed = kernel({
      launch: vi.fn(async () => ({
        pid: 123,
        bootId: "boot-1",
        processStartTime: "456",
        ready: Promise.reject(new Error("handshake failed")),
        completion: new Promise(() => undefined),
        drained: new Promise(() => undefined),
        signalGroup: vi.fn(),
      })),
    })
    await expect(new KernelSanctuaryHostSupervisor(failed).execute(input as never)).rejects.toThrow("handshake failed")

    let release!: () => void
    const blocked = new Promise<{ exitCode: number; signal: null; stdout: string; stderr: string; outputOverflow: false; migrationSuspected: false }>((resolve) => {
      release = () => resolve({ exitCode: 0, signal: null, stdout: "", stderr: "", outputOverflow: false, migrationSuspected: false })
    })
    const activeKernel = kernel({
      launch: vi.fn(async () => ({
        pid: 123,
        bootId: "boot-1",
        processStartTime: "456",
        ready: Promise.resolve(),
        completion: blocked,
        drained: drained(),
        signalGroup: vi.fn(),
      })),
    })
    const supervisor = new KernelSanctuaryHostSupervisor(activeKernel)
    const first = supervisor.execute(input as never)
    await expect(supervisor.execute(input as never)).rejects.toThrow(/active/u)
    release()
    await first
  })

  it("preserves uncertain cleanup evidence across every startup failure point", async () => {
    const beforeCgroup = kernel({
      prepareCgroup: vi.fn(async () => { throw new Error("cgroup failed") }),
    })
    await expect(new KernelSanctuaryHostSupervisor(beforeCgroup).execute(input as never)).rejects.toThrow("cgroup failed")
    expect(beforeCgroup.killCgroup).not.toHaveBeenCalled()

    const nonempty = kernel({
      launch: vi.fn(async () => { throw new Error("launch failed") }),
      waitForCgroupEmpty: vi.fn(async () => false),
    })
    await expect(new KernelSanctuaryHostSupervisor(nonempty).execute(input as never)).rejects.toThrow("launch failed")
    expect(nonempty.killCgroup).toHaveBeenCalledOnce()
    expect(nonempty.removeCgroup).not.toHaveBeenCalled()

    const cleanupFailure = kernel({
      launch: vi.fn(async () => { throw new Error("launch failed") }),
      killCgroup: vi.fn(async () => { throw new Error("cleanup failed") }),
    })
    await expect(new KernelSanctuaryHostSupervisor(cleanupFailure).execute(input as never)).rejects.toThrow("launch failed")
    expect(cleanupFailure.removeCgroup).not.toHaveBeenCalled()
  })

  it("binds optional before and after verification to the exact attempt", async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ digest: `sha256:${"a".repeat(64)}` })
      .mockResolvedValueOnce({ matches: true, digest: `sha256:${"b".repeat(64)}` })
    const dependencies = kernel({ verify })
    const withVerification = {
      ...input,
      permit: {
        ...input.permit,
        verification: { profile: "file.digest.v1", expectedStateDigest: `sha256:${"b".repeat(64)}` },
      },
    }
    await expect(new KernelSanctuaryHostSupervisor(dependencies).execute(withVerification as never)).resolves.toMatchObject({
      verificationBefore: { digest: `sha256:${"a".repeat(64)}` },
      verificationAfter: { matches: true, digest: `sha256:${"b".repeat(64)}` },
    })
    expect(verify).toHaveBeenNthCalledWith(1, withVerification.permit.verification, "before", withVerification.permit)
    expect(verify).toHaveBeenNthCalledWith(2, withVerification.permit.verification, "after", withVerification.permit)
  })
})
