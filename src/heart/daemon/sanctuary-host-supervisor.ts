import { emitNervesEvent } from "../../nerves/runtime"
import type {
  HostExecutionPermitPayloadV1,
  HostSupervisor,
  HostSupervisorAttempt,
} from "./sanctuary-host-executor"

export interface SanctuaryHostSupervisorChild {
  pid: number
  bootId: string
  processStartTime: string
  ready: Promise<void>
  completion: Promise<{
    exitCode: number | null
    signal: string | null
    stdout: string
    stderr: string
    outputOverflow: boolean
    migrationSuspected: boolean
    deadlineExpired?: boolean
  }>
  drained: Promise<{
    stdout: string
    stderr: string
    stdoutDigest: string
    stderrDigest: string
    stdoutBytes: number
    stderrBytes: number
  }>
  signalGroup(signal: "SIGTERM"): void | Promise<void>
}

export interface SanctuaryHostSupervisorKernel {
  prepareCgroup(permitId: string, limits: {
    cpuMax: "50000 100000"
    memoryMax: "1073741824"
    pidsMax: "256"
  }): Promise<string>
  launch(input: {
    permit: HostExecutionPermitPayloadV1
    executable: string
    arguments: string[]
    cwd: "/"
    environment: Readonly<Record<string, string>>
    timeoutMs: number
    cgroupPath: string
  }): Promise<SanctuaryHostSupervisorChild>
  waitForCgroupEmpty(cgroupPath: string, timeoutMs: number): Promise<boolean>
  killCgroup(cgroupPath: string): Promise<void>
  removeCgroup(cgroupPath: string): Promise<void>
  sleep(milliseconds: number): Promise<void>
  now(): string
  verify(
    request: NonNullable<HostExecutionPermitPayloadV1["verification"]>,
    phase: "before" | "after",
    permit: HostExecutionPermitPayloadV1,
  ): Promise<{ digest: string } | { matches: boolean | null; digest: string } | null>
}

export class KernelSanctuaryHostSupervisor implements HostSupervisor {
  readonly #kernel: SanctuaryHostSupervisorKernel
  #active = false

  constructor(kernel: SanctuaryHostSupervisorKernel) {
    this.#kernel = kernel
  }

  async execute(input: {
    permit: HostExecutionPermitPayloadV1
    permitArtifact: Parameters<HostSupervisor["execute"]>[0]["permitArtifact"]
    executable: string
    arguments: string[]
    cwd: "/"
    environment: Readonly<Record<string, string>>
    timeoutMs: number
  }): Promise<HostSupervisorAttempt> {
    if (this.#active) throw new Error("Sanctuary host supervisor is already active")
    this.#active = true
    const startedAt = this.#kernel.now()
    const deadline = Date.parse(startedAt) + input.timeoutMs
    let cgroupPath: string | null = null
    try {
      const verificationBefore = input.permit.verification
        ? await this.#kernel.verify(input.permit.verification, "before", input.permit) as HostSupervisorAttempt["verificationBefore"]
        : null
      cgroupPath = await this.#kernel.prepareCgroup(input.permit.permitId, {
        cpuMax: "50000 100000",
        memoryMax: "1073741824",
        pidsMax: "256",
      })
      const child = await this.#kernel.launch({ permit: input.permit, executable: input.executable, arguments: input.arguments, cwd: input.cwd, environment: input.environment, timeoutMs: input.timeoutMs, cgroupPath })
      await child.ready
      const completion = await child.completion
      let timedOut = completion.deadlineExpired === true
      const remainingMs = Math.max(0, deadline - Date.parse(this.#kernel.now()))
      let cleanupEmpty = !timedOut && await this.#kernel.waitForCgroupEmpty(cgroupPath, remainingMs)
      if (!cleanupEmpty || completion.outputOverflow) {
        timedOut = timedOut || !completion.outputOverflow
        await child.signalGroup("SIGTERM")
        await this.#kernel.sleep(10_000)
        await this.#kernel.killCgroup(cgroupPath)
        cleanupEmpty = await this.#kernel.waitForCgroupEmpty(cgroupPath, 10_000)
      }
      if (cleanupEmpty) await this.#kernel.removeCgroup(cgroupPath)
      if (!cleanupEmpty) throw new Error("Sanctuary host output drain cannot be proven")
      const output = await Promise.race([
        child.drained,
        this.#kernel.sleep(10_000).then(() => {
          throw new Error("Sanctuary host output drain timed out")
        }),
      ])
      const verificationAfter = input.permit.verification
        ? await this.#kernel.verify(input.permit.verification, "after", input.permit) as HostSupervisorAttempt["verificationAfter"]
        : null
      emitNervesEvent({ component: "daemon", event: "daemon.sanctuary_host_cleanup_observed", message: "Sanctuary host cgroup cleanup and output drain observed", meta: { timedOut, outputOverflow: completion.outputOverflow } })
      return {
        startedAt,
        completedAt: this.#kernel.now(),
        exitCode: completion.exitCode,
        signal: completion.signal,
        timedOut,
        cancelled: false,
        outputOverflow: completion.outputOverflow,
        stdout: output.stdout,
        stderr: output.stderr,
        stdoutDigest: output.stdoutDigest,
        stderrDigest: output.stderrDigest,
        stdoutBytes: output.stdoutBytes,
        stderrBytes: output.stderrBytes,
        cleanup: "cgroup_empty",
        containment: completion.migrationSuspected
          ? "unprovable_after_approved_root_migration"
          : "approved_root_may_escape",
        verificationBefore,
        verificationAfter,
      }
    } catch (error) {
      if (cgroupPath) {
        try {
          await this.#kernel.killCgroup(cgroupPath)
          if (await this.#kernel.waitForCgroupEmpty(cgroupPath, 10_000)) {
            await this.#kernel.removeCgroup(cgroupPath)
          }
        } catch {
          // The caller records the failed dependency while startup reconciliation owns uncertain cgroup state.
        }
      }
      throw error
    } finally {
      this.#active = false
    }
  }
}
