import { pathToFileURL } from "node:url"
import { EventEmitter } from "node:events"
import { createHash, createHmac } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

const defaultTargetId = "0".repeat(64)

interface BrokerDependencies {
  readBootId(): string
  containerSnapshot(): unknown | Promise<unknown>
  denialTargetSnapshot?(): unknown | Promise<unknown>
  containerOwnerSnapshot?(): unknown | Promise<unknown>
  startHealthProbe?(input: Record<string, string>): unknown
  healthProbeStatus?(input: Record<string, string>): unknown
  recoverHealthProbe?(input: Record<string, string>): unknown
  restartButlerForAcceptance?(input: Record<string, unknown>): unknown
  driveDuplicateCallbacks?(input: Record<string, string>): unknown
  driveTimeoutStale?(input: Record<string, string>): unknown
  driveRestartContinuation?(input: Record<string, string>): unknown
  ownerMutationCoordinator?: ReturnType<BrokerModule["createOwnerMutationCoordinator"]>
  interactiveRestartDriver?: ReturnType<BrokerModule["createInteractiveRestartDriver"]>
  healthOwnerMutationActive?(): boolean
  rebootPreflightSnapshot?(): Record<string, unknown>
  stopExactRebootOwner?(processBindingDigest: string): unknown | Promise<unknown>
  verifyStoppedRebootOwner?(proof: Record<string, unknown>): unknown | Promise<unknown>
  commitHostReboot?(): unknown | Promise<unknown>
  healthProbeCoordinator?: {
    start<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    recover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
  }
}

interface BrokerModule {
  productionProcessBindingDigest(value: Record<string, unknown>): string
  assertStableContainerProcess(before: Record<string, unknown>, after: Record<string, unknown>): void
  readBoundedProcStatus(file: string): string
  liveContainerProcessUser(pid: number, dependencies?: { readFile(file: string): string }): string
  liveContainerProcessIdentity(pid: number, dependencies: { readFile(file: string): { content: string; inode: string } }): { user: string; processStartTime: string; processInode: string }
  parseProcStartTime(raw: string): string
  observeRebootPreflight(dependencies?: {
    readArrayStatus(): string
    readMoverStatus(): { status: number | null; error?: Error }
    mutationActive(): boolean
  }): Record<string, unknown>
  createOwnerMutationCoordinator(): {
    active(): boolean
    reserveReboot<T>(reservationId: string, processBindingDigest: string, operation: () => T | Promise<T>): Promise<T>
    stopRebootOwner<T>(reservationId: string, processBindingDigest: string, operation: () => T | Promise<T>): Promise<T>
    commitReboot<T>(reservationId: string, processBindingDigest: string, operation: (proof: Record<string, unknown>, markAttempted: () => void) => T | Promise<T>): Promise<T>
    healthStart<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    healthRecover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    healthOperation<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    interactive<T>(operation: () => T | Promise<T>): Promise<T>
  }
  createInteractiveRestartDriver(): {
    poll(input: Record<string, string>, operation: () => unknown | Promise<unknown>): Record<string, unknown>
    arm(scenarioHandleDigest: string): void
    stopAndDrain(): Promise<void>
  }
  armRestartAfterResponseClosed(connection: EventEmitter, scenarioHandleDigest: string, driver: { arm(scenarioHandleDigest: string): void }): () => void
  runInteractiveDriver(input: Record<string, string>, dependencies?: {
    run(executable: string, args: string[], options: Record<string, unknown>): { error?: Error; status: number | null; stdout?: string }
  }): Record<string, unknown>
  driveRestartContinuation(input: Record<string, string>, dependencies: {
    readReceipt(input: Record<string, string>): Record<string, unknown> | null
    persistReceipt(input: Record<string, string>, receipt: Record<string, unknown>): void
    runtime(operation: string, input: Record<string, string>): Record<string, unknown> | Promise<Record<string, unknown>>
    restart(input: Record<string, string>): Record<string, unknown> | Promise<Record<string, unknown>>
    snapshot(): Record<string, unknown> | Promise<Record<string, unknown>>
    sleep(milliseconds: number): Promise<void>
  }): Promise<Record<string, unknown>>
  driveDuplicateCallbacks(input: Record<string, string>, dependencies: {
    readReceipt(input: Record<string, string>): Record<string, unknown> | null
    persistReceipt(input: Record<string, string>, receipt: Record<string, unknown>): void
    runtime(input: Record<string, string>): Record<string, unknown> | Promise<Record<string, unknown>>
  }): Promise<Record<string, unknown>>
  driveTimeoutStale(input: Record<string, string>, dependencies: {
    readReceipt(input: Record<string, string>): Record<string, unknown> | null
    persistReceipt(input: Record<string, string>, receipt: Record<string, unknown>): void
    runtime(input: Record<string, string>): Record<string, unknown> | Promise<Record<string, unknown>>
  }): Promise<Record<string, unknown>>
  createHealthProbeOperationCoordinator(): {
    start<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    recover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
  }
  completeHealthProbeFromReceipt(request: Record<string, string>, snapshot: Record<string, unknown>, readReceipt: () => Record<string, unknown>): { state: "complete"; containerSnapshot: Record<string, unknown> }
  attestHealthProbeProcessAbsent(input: Record<string, string>, dependencies?: {
    run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null }
    markerPresent(): boolean
  }): void
  createDispatchDrain(): {
    run<T>(operation: () => T | Promise<T>): Promise<T>
    stopAndDrain(): Promise<void>
  }
  dispatch(request: unknown, dependencies?: BrokerDependencies): Promise<unknown>
  parseVaultStatus(output: string, succeeded: boolean): { vaultUnlocked: boolean; manualAuthRequired: boolean }
  queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch, expectedContainerId?: string, profile?: { containerName: string; requiredStopped: string[]; forbidden: string[] }): Promise<boolean>
  denialTargetSnapshot(dependencies?: {
    run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null; stdout?: string }
  }): Record<string, unknown>
  healthProbeDockerArgs(mode: "run" | "stop" | "recover", input: Record<string, string>): string[]
  healthProbeArtifactDisposition(artifacts: { receipt: unknown; workspace: unknown; pending: unknown }): "complete" | "recovery_required" | "absent"
  healthProbeOperationBudgets(): { startMaxMs: number; completeStatusMaxMs: number; recoveryMaxMs: number; composedCaptureMaxMs: number }
  requireHealthProbeCompleteAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>, readIdentityKey?: () => string): void
  finalizeHealthProbeAfterAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>, finalize: () => void, readIdentityKey?: () => string): void
  requireStableHealthProbeOwner(before: Record<string, string>, after: Record<string, string>): void
  terminateHealthProbeChild(record: HealthProbeRecord, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<void>
  recoverAfterHealthProbeTermination<T>(record: HealthProbeRecord, recovery: () => T | Promise<T>, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<T>
  restartButlerForAcceptance(input: Record<string, unknown>, dependencies?: {
    snapshot(): Record<string, unknown> | Promise<Record<string, unknown>>
    run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null }
    sleep(milliseconds: number): Promise<void>
  }): Promise<Record<string, unknown>>
}

interface HealthProbeChild extends EventEmitter {
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  kill(signal: NodeJS.Signals): boolean
}

interface HealthProbeRecord {
  child: HealthProbeChild
  state: string
  exitCode: number | null
  terminationPromise?: Promise<void>
}

async function broker(): Promise<BrokerModule> {
  return import(pathToFileURL(path.resolve("deploy/unraid/sanctuary-unit16-host-broker.mjs")).href) as Promise<{
    createOwnerMutationCoordinator(): ReturnType<BrokerModule["createOwnerMutationCoordinator"]>
    createInteractiveRestartDriver: BrokerModule["createInteractiveRestartDriver"]
    armRestartAfterResponseClosed: BrokerModule["armRestartAfterResponseClosed"]
    runInteractiveDriver(input: Record<string, string>, dependencies?: { run(executable: string, args: string[], options: Record<string, unknown>): { error?: Error; status: number | null; stdout?: string } }): Record<string, unknown>
    driveRestartContinuation: BrokerModule["driveRestartContinuation"]
    driveDuplicateCallbacks: BrokerModule["driveDuplicateCallbacks"]
    driveTimeoutStale: BrokerModule["driveTimeoutStale"]
    createHealthProbeOperationCoordinator(): { start<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>; recover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T> }
    completeHealthProbeFromReceipt(request: Record<string, string>, snapshot: Record<string, unknown>, readReceipt: () => Record<string, unknown>): { state: "complete"; containerSnapshot: Record<string, unknown> }
    attestHealthProbeProcessAbsent(input: Record<string, string>, dependencies?: {
      run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null }
      markerPresent(): boolean
    }): void
    createDispatchDrain(): { run<T>(operation: () => T | Promise<T>): Promise<T>; stopAndDrain(): Promise<void> }
    dispatch(request: unknown, dependencies?: BrokerDependencies): Promise<unknown>
    parseVaultStatus(output: string, succeeded: boolean): { vaultUnlocked: boolean; manualAuthRequired: boolean }
    queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch, expectedContainerId?: string, profile?: { containerName: string; requiredStopped: string[]; forbidden: string[] }): Promise<boolean>
    denialTargetSnapshot: BrokerModule["denialTargetSnapshot"]
    assertStableContainerProcess: BrokerModule["assertStableContainerProcess"]
    readBoundedProcStatus: BrokerModule["readBoundedProcStatus"]
    liveContainerProcessUser: BrokerModule["liveContainerProcessUser"]
    liveContainerProcessIdentity: BrokerModule["liveContainerProcessIdentity"]
    parseProcStartTime: BrokerModule["parseProcStartTime"]
    productionProcessBindingDigest: BrokerModule["productionProcessBindingDigest"]
    healthProbeDockerArgs(mode: "run" | "stop" | "recover", input: Record<string, string>): string[]
    healthProbeArtifactDisposition(artifacts: { receipt: unknown; workspace: unknown; pending: unknown }): "complete" | "recovery_required" | "absent"
    healthProbeOperationBudgets(): { startMaxMs: number; completeStatusMaxMs: number; recoveryMaxMs: number; composedCaptureMaxMs: number }
    requireHealthProbeCompleteAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>, readIdentityKey?: () => string): void
    finalizeHealthProbeAfterAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>, finalize: () => void, readIdentityKey?: () => string): void
    requireStableHealthProbeOwner(before: Record<string, string>, after: Record<string, string>): void
    terminateHealthProbeChild(record: HealthProbeRecord, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<void>
    recoverAfterHealthProbeTermination<T>(record: HealthProbeRecord, recovery: () => T | Promise<T>, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<T>
    restartButlerForAcceptance(input: Record<string, unknown>, dependencies?: {
      snapshot(): Record<string, unknown> | Promise<Record<string, unknown>>
      run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null }
      sleep(milliseconds: number): Promise<void>
    }): Promise<Record<string, unknown>>
  }>
}

describe("Sanctuary Unit 16 host broker", () => {
  it("binds effective PID1 UID and GID to the inspected live container process", async () => {
    const { assertStableContainerProcess, liveContainerProcessIdentity, liveContainerProcessUser, parseProcStartTime, productionProcessBindingDigest, readBoundedProcStatus } = await broker()
    const reads: string[] = []
    expect(liveContainerProcessUser(4321, { readFile: (file) => {
      reads.push(file)
      return "Name:\tnode\nUid:\t10000\t10001\t10002\t10003\nGid:\t10000\t10001\t10002\t10003\n"
    } })).toBe("10001:10001")
    expect(reads).toEqual(["/proc/4321/status"])
    for (const status of [
      "Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n",
      "Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t0\t10001\t10001\n",
      "Uid:\t10001\t10001\t10001\t10001\nUid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\n",
    ]) expect(() => liveContainerProcessUser(4321, { readFile: () => status })).toThrow()
    for (const pid of [0, -1, 1.5]) expect(() => liveContainerProcessUser(pid, { readFile: () => "" })).toThrow()
    const procStat = `4321 (node worker) S ${Array.from({ length: 18 }, (_, index) => index + 1).join(" ")} 987654 0 0`
    expect(parseProcStartTime(procStat)).toBe("987654")
    expect(() => parseProcStartTime("4321 malformed")).toThrow(/stat/u)
    expect(liveContainerProcessIdentity(4321, { readFile: (file) => file.endsWith("/status")
      ? { content: "Uid:\t10001\t10001\t10001\t10001\nGid:\t10001\t10001\t10001\t10001\n", inode: "11" }
      : { content: procStat, inode: "12" } })).toEqual({ user: "10001:10001", processStartTime: "987654", processInode: "11:12" })
    expect(() => liveContainerProcessIdentity(4321, { readFile: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }) } })).toThrow("gone")
    expect(() => assertStableContainerProcess({ containerId: "a", pid: 4321, running: true }, { containerId: "b", pid: 4321, running: true })).toThrow(/changed/u)
    expect(() => assertStableContainerProcess({ containerId: "a", pid: 4321, running: true }, { containerId: "a", pid: 4322, running: true })).toThrow(/changed/u)
    expect(() => assertStableContainerProcess({ containerId: "a", pid: 4321, running: true }, { containerId: "a", pid: 4321, running: false })).toThrow(/changed/u)
    const stable = { containerId: "a", imageId: "sha256:a", pid: 4321, running: true, restartCount: 4, startedAt: "2026-08-20T00:00:00.000Z", health: "healthy", processStartTime: "1234", processInode: "5678" }
    expect(() => assertStableContainerProcess(stable, { ...stable })).not.toThrow()
    for (const drift of [
      { restartCount: 5 },
      { startedAt: "2026-08-20T00:00:01.000Z" },
      { imageId: "sha256:b" },
      { health: "starting" },
      { processStartTime: "9999" },
      { processInode: "9999" },
    ]) expect(() => assertStableContainerProcess(stable, { ...stable, ...drift })).toThrow(/changed/u)
    const bindingInput = { containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, pid: 4321, restartCount: 4, startedAt: "2026-08-20T00:00:00.000Z", processStartTime: "1234", processInode: "5678:5679" }
    const binding = productionProcessBindingDigest(bindingInput)
    expect(binding).toMatch(/^[0-9a-f]{64}$/u)
    for (const drift of [{ pid: 4322 }, { restartCount: 5 }, { startedAt: "2026-08-20T00:00:01.000Z" }, { processStartTime: "9999" }, { processInode: "9999:9998" }]) {
      expect(productionProcessBindingDigest({ ...bindingInput, ...drift })).not.toBe(binding)
    }
    const oversized = path.join(fs.mkdtempSync("/tmp/sanctuary-proc-status-"), "status")
    fs.writeFileSync(oversized, "x".repeat(128 * 1024 + 1))
    expect(() => readBoundedProcStatus(oversized)).toThrow(/bound/u)
  })

  it("drains already queued owner work and rejects new work once reboot is reserved", async () => {
    const { createOwnerMutationCoordinator } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    let release!: () => void
    const first = coordinator.interactive(() => new Promise<void>((resolve) => { release = resolve }))
    const second = coordinator.interactive(async () => undefined)
    const reserved = coordinator.reserveReboot("a".repeat(64), "b".repeat(64), async () => "reserved")
    await expect(coordinator.interactive(async () => undefined)).rejects.toThrow(/reboot reservation/u)
    expect(coordinator.active()).toBe(true)
    release()
    await Promise.all([first, second])
    await expect(reserved).resolves.toBe("reserved")
    expect(coordinator.active()).toBe(false)
  })

  it("commits a reboot reservation once and never retries an ambiguous commit", async () => {
    const { createOwnerMutationCoordinator } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    const reservation = "a".repeat(64)
    const binding = "b".repeat(64)
    await coordinator.reserveReboot(reservation, binding, async () => undefined)
    await expect(coordinator.commitReboot(reservation, binding, async () => undefined)).rejects.toThrow(/not stopped/u)
    await coordinator.stopRebootOwner(reservation, binding, async () => ({ processBindingDigest: binding }))
    await expect(coordinator.commitReboot(reservation, binding, async () => { throw new Error("preflight") })).rejects.toThrow(/preflight/u)
    await expect(coordinator.commitReboot(reservation, binding, async (_proof, markAttempted) => { markAttempted(); throw new Error("ambiguous") })).rejects.toThrow(/ambiguous/u)
    await expect(coordinator.commitReboot(reservation, binding, async () => undefined)).rejects.toThrow(/already attempted/u)
  })

  it("observes an idle array/mover/mutation preflight and rejects active or unknown host operations", async () => {
    const { observeRebootPreflight } = await broker()
    const idle = observeRebootPreflight({
      readArrayStatus: () => "mdState=STARTED\nmdResync=0\n",
      readMoverStatus: () => ({ status: 1 }),
      mutationActive: () => false,
    })
    expect(idle).toMatchObject({ arrayReady: true, moverActive: false, mutationActive: false, safe: true })
    expect(idle.digest).toMatch(/^[0-9a-f]{64}$/u)
    expect(() => observeRebootPreflight({ readArrayStatus: () => "mdState=STARTED\nmdResync=42\n", readMoverStatus: () => ({ status: 1 }), mutationActive: () => false })).toThrow(/host operation/u)
    expect(() => observeRebootPreflight({ readArrayStatus: () => "mdState=STARTED\nmdResync=0\n", readMoverStatus: () => ({ status: 0 }), mutationActive: () => false })).toThrow(/host operation/u)
    expect(() => observeRebootPreflight({ readArrayStatus: () => "mdState=MYSTERY\n", readMoverStatus: () => ({ status: 1 }), mutationActive: () => false })).toThrow(/preflight/u)
    expect(() => observeRebootPreflight({ readArrayStatus: () => "mdState=STARTED\nmdResync=0\n", readMoverStatus: () => ({ status: 2 }), mutationActive: () => false })).toThrow(/preflight/u)
  })

  it("digest-binds request_reboot to a fresh unchanged broker preflight", async () => {
    const { createOwnerMutationCoordinator, dispatch } = await broker()
    const first = { arrayReady: true, moverActive: false, mutationActive: false, safe: true, digest: "a".repeat(64) }
    const changed = { ...first, moverActive: true, safe: false, digest: "b".repeat(64) }
    const binding = "c".repeat(64)
    const request = { operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "0123456789abcdef0123456789abcdef", preflightDigest: first.digest, processBindingDigest: binding }
    await expect(dispatch(request, { readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: createOwnerMutationCoordinator(), rebootPreflightSnapshot: () => first })).resolves.toMatchObject({ accepted: true, preflightDigest: first.digest, processBindingDigest: binding, reservationId: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    await expect(dispatch(request, { readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: createOwnerMutationCoordinator(), rebootPreflightSnapshot: () => changed })).rejects.toThrow(/preflight changed/u)
    await expect(dispatch(request, { readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: "d".repeat(64) }), ownerMutationCoordinator: createOwnerMutationCoordinator(), rebootPreflightSnapshot: () => first })).rejects.toThrow(/process generation changed/u)
  })

  it("rechecks preflight under the reservation and couples exactly one host reboot commit", async () => {
    const { createOwnerMutationCoordinator, dispatch } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    const safe = { arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "a".repeat(64) }
    const binding = "b".repeat(64)
    const staged = await dispatch({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "0123456789abcdef0123456789abcdef", preflightDigest: safe.digest, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: coordinator, rebootPreflightSnapshot: () => safe,
    }) as Record<string, unknown>
    await dispatch({ operation: "stop_reboot_owner", targetId: "sanctuary", requestId: staged.requestId, reservationId: staged.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: coordinator, rebootPreflightSnapshot: () => safe,
      stopExactRebootOwner: () => ({ processBindingDigest: binding, containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, restartCount: 0, startedAt: "2026-08-20T00:00:00.000Z" }),
    })
    const commits: string[] = []
    const order: string[] = []
    const committed = await dispatch({ operation: "commit_reboot", targetId: "sanctuary", requestId: staged.requestId, reservationId: staged.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: coordinator, rebootPreflightSnapshot: () => safe,
      verifyStoppedRebootOwner: () => { order.push("verify") },
      rebootPreflightSnapshot: () => { order.push("preflight"); return safe },
      commitHostReboot: () => { order.push("commit"); commits.push("reboot") },
    }) as Record<string, unknown>
    expect(committed).toMatchObject({ committed: true, requestId: staged.requestId })
    expect(commits).toEqual(["reboot"])
    expect(order).toEqual(["verify", "preflight", "verify", "commit"])
    await expect(dispatch({ operation: "commit_reboot", targetId: "sanctuary", requestId: staged.requestId, reservationId: staged.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({}), ownerMutationCoordinator: coordinator, rebootPreflightSnapshot: () => safe,
      verifyStoppedRebootOwner: () => undefined,
      commitHostReboot: () => { commits.push("retry") },
    })).rejects.toThrow(/already attempted/u)
    expect(commits).toEqual(["reboot"])
  })

  it("fails closed when the reserved production generation drifts before stop or after stop", async () => {
    const { createOwnerMutationCoordinator, dispatch } = await broker()
    const safe = { arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "a".repeat(64) }
    const binding = "b".repeat(64)
    const stage = async (coordinator: ReturnType<BrokerModule["createOwnerMutationCoordinator"]>) => dispatch({ operation: "request_reboot", targetId: "sanctuary", idempotencyKey: "0123456789abcdef0123456789abcdef", preflightDigest: safe.digest, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: coordinator, rebootPreflightSnapshot: () => safe,
    }) as Promise<Record<string, unknown>>
    const beforeStop = createOwnerMutationCoordinator()
    const stagedBefore = await stage(beforeStop)
    await expect(dispatch({ operation: "stop_reboot_owner", targetId: "sanctuary", requestId: stagedBefore.requestId, reservationId: stagedBefore.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: beforeStop, rebootPreflightSnapshot: () => safe,
      stopExactRebootOwner: () => { throw new Error("production process generation changed before exact stop") },
    })).rejects.toThrow(/generation changed/u)

    const afterStop = createOwnerMutationCoordinator()
    const stagedAfter = await stage(afterStop)
    await dispatch({ operation: "stop_reboot_owner", targetId: "sanctuary", requestId: stagedAfter.requestId, reservationId: stagedAfter.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: afterStop, rebootPreflightSnapshot: () => safe,
      stopExactRebootOwner: () => ({ processBindingDigest: binding }),
    })
    const commits: string[] = []
    await expect(dispatch({ operation: "commit_reboot", targetId: "sanctuary", requestId: stagedAfter.requestId, reservationId: stagedAfter.reservationId, processBindingDigest: binding }, {
      readBootId: () => "boot-id", containerSnapshot: () => ({ processBindingDigest: binding }), ownerMutationCoordinator: afterStop, rebootPreflightSnapshot: () => safe,
      verifyStoppedRebootOwner: () => { throw new Error("exact stopped production owner generation changed") },
      commitHostReboot: () => { commits.push("reboot") },
    })).rejects.toThrow(/generation changed/u)
    expect(commits).toEqual([])
  })
  it("reads the exact denial target lifecycle without returning raw owner identifiers", async () => {
    const { denialTargetSnapshot, dispatch } = await broker()
    const raw = {
      containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, running: true,
      status: "running", restartCount: 7, startedAt: "2026-08-20T01:02:03.000000000Z",
    }
    const calls: Array<{ executable: string; args: string[] }> = []
    const snapshot = denialTargetSnapshot({ run: (executable, args) => {
      calls.push({ executable, args }); return { status: 0, stdout: JSON.stringify(raw) }
    } })
    expect(snapshot).toEqual({
      containerIdDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), imageDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      running: true, status: "running", restartCount: 7, startedAtDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect(JSON.stringify(snapshot)).not.toContain(raw.containerId)
    expect(JSON.stringify(snapshot)).not.toContain(raw.imageId)
    expect(calls).toEqual([{ executable: "/usr/bin/docker", args: expect.arrayContaining(["inspect", "calibre-web"]) }])
    await expect(dispatch({ operation: "denial_target_snapshot", targetId: "sanctuary" }, {
      readBootId: () => "unused", containerSnapshot: () => ({}), denialTargetSnapshot: () => snapshot,
    })).resolves.toEqual(snapshot)
    await expect(dispatch({ operation: "denial_target_snapshot", targetId: "sanctuary", container: "other" }, {
      readBootId: () => "unused", containerSnapshot: () => ({}), denialTargetSnapshot: () => snapshot,
    })).rejects.toThrow(/shape/u)
  })

  it("captures then settles one stale timeout callback through the production runtime", async () => {
    const { dispatch } = await broker()
    const coordinates = { targetId: "sanctuary", label: "unit-16k-timeout-stale", scenarioHandleDigest: "a".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", phase: "complete", label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64), approvalEpochBefore: 0,
      callbackAttempts: 1, distinctQueryCount: 1, callbackDataDigest: "e".repeat(64), settledCount: 1, claimCount: 0, mutationCount: 0,
      staleAcknowledged: true, promptTerminal: true,
    }
    let calls = 0
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused", containerSnapshot: () => ({}),
      driveTimeoutStale: () => { calls += 1; return calls === 1 ? { state: "waiting" } : receipt },
    }
    await expect(dispatch({ operation: "drive_timeout_stale", ...coordinates }, dependencies)).resolves.toEqual({ state: "waiting" })
    await expect(dispatch({ operation: "drive_timeout_stale", ...coordinates }, dependencies)).resolves.toEqual(receipt)
    expect(calls).toBe(2)
  })

  it("persists timeout arming and refuses retry after an indeterminate stale callback", async () => {
    const { driveTimeoutStale } = await broker()
    const input = { label: "unit-16k-timeout-stale", scenarioHandleDigest: "a".repeat(64) }
    const writes: Record<string, unknown>[] = []
    const dependencies = {
      readReceipt: () => writes.at(-1) ?? null,
      persistReceipt: (_coordinates: Record<string, string>, receipt: Record<string, unknown>) => { writes.push(receipt) },
      runtime: () => writes.length === 1 ? { state: "waiting" } : (() => { throw new Error("runtime transport severed") })(),
    }
    await expect(driveTimeoutStale(input, dependencies)).resolves.toEqual({ state: "waiting" })
    await expect(driveTimeoutStale(input, dependencies)).rejects.toThrow(/transport severed/u)
    expect(writes.map(({ phase }) => phase)).toEqual(["preparing", "waiting", "attempting", "attempted_or_indeterminate"])
    await expect(driveTimeoutStale(input, { ...dependencies, runtime: () => { throw new Error("must not retry") } })).rejects.toThrow(/inspect-before-retry/u)
  })

  it("drives duplicate callbacks through one fixed runtime operation with distinct opaque queries and a stale replay", async () => {
    const { dispatch } = await broker()
    const calls: Record<string, string>[] = []
    const coordinates = { targetId: "sanctuary", label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }
    const result = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64),
      approvalEpochBefore: 0, callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "e".repeat(64), barrierObserved: true,
      settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true,
      staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false,
    }
    await expect(dispatch({ operation: "drive_duplicate_callbacks", ...coordinates }, {
      readBootId: () => "unused", containerSnapshot: () => ({}),
      driveDuplicateCallbacks: (input) => { calls.push(input); return result },
    })).resolves.toEqual(result)
    expect(calls).toEqual([{ label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest }])
    expect(JSON.stringify(calls)).not.toMatch(/approval-|query-|callback-/u)
  })

  it("drives a crash-safe restart continuation without raw approval coordinates crossing the broker", async () => {
    const { createInteractiveRestartDriver, dispatch } = await broker()
    const calls: Record<string, string>[] = []
    const coordinates = { targetId: "sanctuary", label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }
    const result = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64),
      approvalEpochBefore: 0, approvalEpochAfterRestart: 0, continuationEpochAfter: 1,
      ownerImageDigest: "e".repeat(64), ownerContainerDigest: "f".repeat(64), restartCountBefore: 4, restartCountAfter: 5,
      pendingDigestBefore: "1".repeat(64), pendingDigestAfter: "1".repeat(64), pendingRestored: true,
      callbackAttempts: 1, mutationCount: 1, indeterminateRecoveryObserved: true, attemptedRecoveryReopened: true,
      attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "8".repeat(64), indeterminateRetryCount: 0,
    }
    const asyncDriver = createInteractiveRestartDriver()
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused", containerSnapshot: () => ({}),
      driveRestartContinuation: (input) => { calls.push(input); return result },
      interactiveRestartDriver: asyncDriver,
    }
    await expect(dispatch({ operation: "drive_restart_continuation", ...coordinates }, dependencies)).resolves.toEqual({ state: "waiting" })
    expect(calls).toEqual([])
    asyncDriver.arm(coordinates.scenarioHandleDigest)
    await asyncDriver.stopAndDrain()
    await expect(dispatch({ operation: "drive_restart_continuation", ...coordinates }, dependencies)).resolves.toEqual({ state: "complete", receipt: result })
    expect(calls).toEqual([{ label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest }])
    expect(JSON.stringify(calls)).not.toMatch(/approval-|session-/u)
  })

  it("redacts async restart failures and never relaunches a failed host task", async () => {
    const { createInteractiveRestartDriver } = await broker()
    let calls = 0
    const driver = createInteractiveRestartDriver()
    const input = { label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }
    expect(driver.poll(input, () => { calls += 1; throw new Error("secret raw failure") })).toEqual({ state: "waiting" })
    driver.arm(input.scenarioHandleDigest)
    await driver.stopAndDrain()
    const failed = driver.poll(input, () => { calls += 1 })
    expect(failed).toEqual({ state: "failed", errorDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(calls).toBe(1)
    expect(JSON.stringify(driver.poll(input, () => {}))).not.toContain("secret raw failure")
    const restartDriver = createInteractiveRestartDriver()
    const restartInput = { ...input, scenarioHandleDigest: "b".repeat(64) }
    restartDriver.poll(restartInput, () => { throw new Error("production butler restart failed") })
    restartDriver.arm(restartInput.scenarioHandleDigest)
    await restartDriver.stopAndDrain()
    expect((restartDriver.poll(restartInput, () => {}) as { errorDigest: string }).errorDigest).not.toBe((failed as { errorDigest: string }).errorDigest)
  })

  it("arms a restart only after both response write completion and socket close", async () => {
    const { armRestartAfterResponseClosed } = await broker()
    const connection = new EventEmitter()
    const calls: string[] = []
    const written = armRestartAfterResponseClosed(connection, "a".repeat(64), { arm: (scenario) => { calls.push(scenario) } })
    written()
    expect(calls).toEqual([])
    connection.emit("close")
    expect(calls).toEqual(["a".repeat(64)])

    const reverse = new EventEmitter()
    const reverseCalls: string[] = []
    const reverseWritten = armRestartAfterResponseClosed(reverse, "b".repeat(64), { arm: (scenario) => { reverseCalls.push(scenario) } })
    reverse.emit("close")
    expect(reverseCalls).toEqual([])
    reverseWritten()
    reverseWritten()
    expect(reverseCalls).toEqual(["b".repeat(64)])
  })

  it("coordinates owner mutation across health and interactive operations in both orderings", async () => {
    const { createOwnerMutationCoordinator } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    await coordinator.healthStart("a".repeat(64), () => "started")
    await expect(coordinator.interactive(() => "restart")).rejects.toThrow(/health probe is active/u)
    await coordinator.healthRecover("a".repeat(64), () => "recovered")

    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const events: string[] = []
    const restarting = coordinator.interactive(async () => { events.push("restart-start"); await blocked; events.push("restart-end") })
    await Promise.resolve()
    const starting = coordinator.healthStart("b".repeat(64), () => { events.push("health-start") })
    await Promise.resolve()
    expect(events).toEqual(["restart-start"])
    release()
    await Promise.all([restarting, starting])
    expect(events).toEqual(["restart-start", "restart-end", "health-start"])
  })

  it("runs Unit-16l once in the production runtime and rejects vacuous callback evidence", async () => {
    const { runInteractiveDriver } = await broker()
    const calls: Array<{ executable: string; args: string[]; options: Record<string, unknown> }> = []
    const input = { label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", ...input,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64), approvalEpochBefore: 0,
      callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "e".repeat(64), barrierObserved: true,
      settledCount: 2, claimCount: 1, mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true,
      staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false,
    }
    const result = runInteractiveDriver(input, { run: (executable, args, options) => {
      calls.push({ executable, args, options }); return { status: 0, stdout: JSON.stringify(receipt) }
    } })
    expect(result).toEqual(receipt)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.executable).toBe("/usr/bin/docker")
    expect(calls[0]?.args).toEqual(["exec", "-i", defaultTargetId, "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"])
    expect(JSON.parse(String(calls[0]?.options.input))).toEqual({ operation: "drive_duplicate_callbacks", ...input })
    expect(String(calls[0]?.options.input)).not.toMatch(/approval-|query-|callback_data|credential/iu)
    for (const mutation of [{ distinctQueryCount: 1 }, { barrierObserved: false }, { staleReplayAttempts: 0 }, { writeCredentialObserved: true }]) {
      expect(() => runInteractiveDriver(input, { run: () => ({ status: 0, stdout: JSON.stringify({ ...receipt, ...mutation }) }) })).toThrow(/interactive driver receipt/u)
    }
  })

  it("persists duplicate-callback uncertainty and refuses an unsafe retry", async () => {
    const { driveDuplicateCallbacks } = await broker()
    const input = { label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }
    const writes: Record<string, unknown>[] = []
    await expect(driveDuplicateCallbacks(input, {
      readReceipt: () => null,
      persistReceipt: (_coordinates, receipt) => { writes.push(receipt) },
      runtime: () => { throw new Error("runtime transport severed") },
    })).rejects.toThrow(/transport severed/u)
    expect(writes.map((receipt) => receipt.phase)).toEqual(["attempting", "attempted_or_indeterminate"])
    await expect(driveDuplicateCallbacks(input, {
      readReceipt: () => writes.at(-1)!, persistReceipt: () => {}, runtime: () => { throw new Error("must not retry") },
    })).rejects.toThrow(/inspect-before-retry/u)
  })

  it("releases failed interactive ownership but preserves active health ownership until recovery", async () => {
    const { createOwnerMutationCoordinator } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    await expect(coordinator.interactive(() => { throw new Error("crash") })).rejects.toThrow("crash")
    await expect(coordinator.interactive(() => "retry")).resolves.toBe("retry")
    await expect(coordinator.healthStart("a".repeat(64), () => { throw new Error("start crash") })).rejects.toThrow("start crash")
    await expect(coordinator.interactive(() => "after failed start")).resolves.toBe("after failed start")
    await coordinator.healthStart("b".repeat(64), () => "started")
    await expect(coordinator.interactive(() => "unsafe")).rejects.toThrow(/health probe is active/u)
    await expect(coordinator.healthRecover("b".repeat(64), () => { throw new Error("recovery crash") })).rejects.toThrow("recovery crash")
    await expect(coordinator.interactive(() => "still unsafe")).rejects.toThrow(/health probe is active/u)
    await coordinator.healthRecover("b".repeat(64), () => "recovered")
    await expect(coordinator.interactive(() => "safe")).resolves.toBe("safe")
  })

  it("does not overlap interactive mutation with an asynchronous health start", async () => {
    const { createOwnerMutationCoordinator } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const events: string[] = []
    const starting = coordinator.healthStart("a".repeat(64), async () => { events.push("health-entered"); await barrier; events.push("health-started") })
    await Promise.resolve()
    const interactive = coordinator.interactive(() => { events.push("interactive") })
    await Promise.resolve()
    expect(events).toEqual(["health-entered"])
    release()
    await starting
    await expect(interactive).rejects.toThrow(/health probe is active/u)
    expect(events).toEqual(["health-entered", "health-started"])
  })

  it("wires the shared owner coordinator through live health and interactive dispatch", async () => {
    const { createOwnerMutationCoordinator, dispatch } = await broker()
    const coordinator = createOwnerMutationCoordinator()
    let release!: () => void
    const barrier = new Promise<void>((resolve) => { release = resolve })
    const health = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    const duplicate = { targetId: "sanctuary", label: "unit-16l-duplicate-callback", scenarioHandleDigest: "b".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "complete", label: duplicate.label, scenarioHandleDigest: duplicate.scenarioHandleDigest,
      approvalIdDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), suspendedSessionRevisionDigest: "e".repeat(64), approvalEpochBefore: 0,
      callbackAttempts: 2, distinctQueryCount: 2, callbackDataDigest: "f".repeat(64), barrierObserved: true, settledCount: 2, claimCount: 1,
      mutationCount: 1, staleReplayAttempts: 1, staleReplaySettled: true, staleReplayMutationCount: 0, promptTerminal: true, writeCredentialObserved: false,
    }
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused", ownerMutationCoordinator: coordinator,
      containerSnapshot: async () => { await barrier; return { imageId: `sha256:${"1".repeat(64)}`, containerId: "2".repeat(64), running: true, health: "healthy" } },
      startHealthProbe: () => ({ state: "started", operationDigest: "3".repeat(64) }),
      recoverHealthProbe: () => ({ recovered: true }), driveDuplicateCallbacks: () => receipt,
    }
    const starting = dispatch({ operation: "start_health_probe", ...health }, dependencies)
    await Promise.resolve()
    const driving = dispatch({ operation: "drive_duplicate_callbacks", ...duplicate }, dependencies)
    release()
    await expect(starting).resolves.toMatchObject({ state: "started" })
    await expect(driving).rejects.toThrow(/health probe is active/u)
    await expect(dispatch({ operation: "recover_health_probe", ...health }, { ...dependencies, containerOwnerSnapshot: () => ({ imageId: `sha256:${"1".repeat(64)}`, containerId: "2".repeat(64) }) })).resolves.toEqual({ recovered: true })
    await expect(dispatch({ operation: "drive_duplicate_callbacks", ...duplicate }, dependencies)).resolves.toEqual(receipt)
  })

  it("refuses interactive mutation when durable health artifacts survive broker memory", async () => {
    const { dispatch } = await broker()
    let drove = false
    await expect(dispatch({ operation: "drive_duplicate_callbacks", targetId: "sanctuary", label: "unit-16l-duplicate-callback", scenarioHandleDigest: "a".repeat(64) }, {
      readBootId: () => "unused", containerSnapshot: () => ({}), healthOwnerMutationActive: () => true,
      driveDuplicateCallbacks: () => { drove = true; return {} },
    })).rejects.toThrow(/durable health probe artifacts are active/u)
    expect(drove).toBe(false)
  })

  it("persists restart preparation, re-enters after the exact owner restart, and never retries the action", async () => {
    const { driveRestartContinuation } = await broker()
    const input = { label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }
    const writes: Record<string, unknown>[] = []
    const operations: string[] = []
    const prepared = {
      schemaVersion: "sanctuary-interactive-driver-receipt-v2", phase: "prepared", ...input,
      approvalIdDigest: "b".repeat(64), checkpointDigest: "c".repeat(64), suspendedSessionRevisionDigest: "d".repeat(64),
      approvalEpochBefore: 0, pendingDigestBefore: "1".repeat(64), indeterminateRecoveryObserved: true,
      attemptedRecoveryReopened: true, attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "8".repeat(64),
    }
    const reconciled = {
      approvalEpochAfterRestart: 0, continuationEpochAfter: 1, pendingDigestAfter: "1".repeat(64), pendingRestored: true,
      callbackAttempts: 1, mutationCount: 1, indeterminateRetryCount: 0,
    }
    let readinessChecks = 0
    const result = await driveRestartContinuation(input, {
      readReceipt: () => null,
      persistReceipt: (_coordinates, receipt) => { writes.push(receipt) },
      runtime: (operation) => {
        operations.push(operation)
        if (operation === "prepare_restart_continuation") return prepared
        if (operation === "interactive_runtime_ready") return { ready: ++readinessChecks >= 2 }
        return reconciled
      },
      snapshot: () => ({ imageId: `sha256:${"e".repeat(64)}`, containerId: "f".repeat(64), running: true, health: "healthy", restartCount: 4 }),
      restart: () => ({ restarted: true, restartInvocationCount: 1, ownerImageDigest: "e".repeat(64), ownerContainerDigest: "f".repeat(64), restartCountBefore: 4, restartCountAfter: 5 }),
      sleep: async () => {},
    })
    expect(operations).toEqual(["prepare_restart_continuation", "interactive_runtime_ready", "interactive_runtime_ready", "reconcile_restart_continuation"])
    expect(writes.map((receipt) => receipt.phase)).toEqual(["attempting", "prepared", "complete"])
    expect(result).toMatchObject({ phase: "complete", callbackAttempts: 1, mutationCount: 1, indeterminateRetryCount: 0, restartCountBefore: 4, restartCountAfter: 5 })

    await expect(driveRestartContinuation(input, {
      readReceipt: () => prepared, persistReceipt: () => {}, runtime: () => { throw new Error("must not retry") }, restart: () => { throw new Error("must not restart") }, snapshot: () => { throw new Error("must not inspect incomplete coordinates") }, sleep: async () => {},
    })).rejects.toThrow(/inspect-before-retry/u)

    const recoveredWrites: Record<string, unknown>[] = []
    await expect(driveRestartContinuation(input, {
      readReceipt: () => ({ ...prepared, ownerImageDigest: "e".repeat(64), ownerContainerDigest: "f".repeat(64), restartCountBefore: 4 }),
      persistReceipt: (_coordinates, receipt) => { recoveredWrites.push(receipt) },
      runtime: (operation) => { operations.push(operation); return operation === "interactive_runtime_ready" ? { ready: true } : reconciled },
      restart: () => { throw new Error("recovery must not restart") },
      snapshot: () => ({ imageId: `sha256:${"e".repeat(64)}`, containerId: "f".repeat(64), running: true, health: "healthy", restartCount: 5 }),
      sleep: async () => {},
    })).resolves.toMatchObject({ phase: "complete", restartCountBefore: 4, restartCountAfter: 5, indeterminateRetryCount: 0 })
    expect(recoveredWrites).toHaveLength(1)

    for (const corruption of [{ label: "unit-16l-duplicate-callback" }, { scenarioHandleDigest: "9".repeat(64) }, { rawApprovalId: "approval-raw" }]) {
      const calls: string[] = []
      await expect(driveRestartContinuation(input, {
        readReceipt: () => ({ ...prepared, ownerImageDigest: "e".repeat(64), ownerContainerDigest: "f".repeat(64), restartCountBefore: 4, ...corruption }),
        persistReceipt: () => { calls.push("persist") }, runtime: () => { calls.push("runtime"); return reconciled },
        restart: () => { calls.push("restart"); return {} }, snapshot: () => { calls.push("snapshot"); return {} }, sleep: async () => {},
      })).rejects.toThrow(/inspect-before-retry/u)
      expect(calls).toEqual([])
    }
  })
  it("stages a bounded host reboot attestation without executing reboot", async () => {
    const { createOwnerMutationCoordinator, dispatch } = await broker()
    const result = await dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
      preflightDigest: "a".repeat(64),
      processBindingDigest: "b".repeat(64),
    }, {
      readBootId: () => "11111111-2222-3333-4444-555555555555\n",
      containerSnapshot: () => ({ processBindingDigest: "b".repeat(64) }),
      ownerMutationCoordinator: createOwnerMutationCoordinator(),
      rebootPreflightSnapshot: () => ({ arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "a".repeat(64) }),
    }) as Record<string, unknown>

    expect(result).toMatchObject({ accepted: true, targetId: "sanctuary", staged: true })
    expect(result.requestId).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.prebootId).toMatch(/^[A-Za-z0-9-]{4,128}$/u)
  })

  it("refreshes only the exact production container snapshot operation", async () => {
    const { dispatch } = await broker()
    const snapshot = {
      schemaVersion: 1, containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`,
      running: true, health: "healthy", user: "10001:10001", liveProcessUser: "10001:10001", readOnlyRoot: true,
      mountCount: 2, mountsDigest: "c".repeat(64), publishedPortCount: 0,
      networkMode: "host", restartPolicy: "no", restartCount: 3,
      autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false,
      mountsExact: true, securityExact: true, writableKeyExposure: false,
      recoveryMilestones: { hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
    }
    await expect(dispatch({ operation: "container_snapshot", targetId: "sanctuary" }, {
      readBootId: () => { throw new Error("unexpected boot read") },
      containerSnapshot: () => snapshot,
    })).resolves.toEqual(snapshot)
    await expect(dispatch({ operation: "container_snapshot", targetId: "sanctuary", name: "another" }, {
      readBootId: () => "unused",
      containerSnapshot: () => snapshot,
    })).rejects.toThrow(/shape is invalid/u)
  })

  it("rejects raw approval coordinates at the broker boundary", async () => {
    const { dispatch } = await broker()
    const calls: Record<string, unknown>[] = []
    const request = {
      operation: "restart_butler_for_acceptance", targetId: "sanctuary", label: "unit-16m-restart-continuation",
      scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1", checkpointDigest: "b".repeat(64), approvalEpoch: 0,
    }
    const result = { restarted: true, beforeLifecycleDigest: "1".repeat(64), afterLifecycleDigest: "2".repeat(64), restartInvocationCount: 1 }
    await expect(dispatch(request, {
      readBootId: () => "unused", containerSnapshot: () => { throw new Error("unexpected snapshot") },
      restartButlerForAcceptance: (input) => { calls.push(input); return result },
    })).rejects.toThrow(/not whitelisted/u)
    expect(calls).toEqual([])
    await expect(dispatch({ ...request, label: "unit-16l-duplicate-callback" }, {
      readBootId: () => "unused", containerSnapshot: () => ({}), restartButlerForAcceptance: () => result,
    })).rejects.toThrow(/not whitelisted/u)
  })

  it("executes one exact docker restart argv and waits for a changed healthy owner", async () => {
    const { restartButlerForAcceptance } = await broker()
    const calls: Array<{ executable: string; args: string[] }> = []
    let snapshots = 0
    const result = await restartButlerForAcceptance({
      label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64),
    }, {
      snapshot: async () => {
        snapshots += 1
        return snapshots === 1
          ? { lifecycleDigest: "1".repeat(64), containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, restartCount: 4, running: true, health: "healthy" }
          : { lifecycleDigest: "2".repeat(64), containerId: "c".repeat(64), imageId: `sha256:${"d".repeat(64)}`, restartCount: 5, running: true, health: "healthy" }
      },
      run: (executable, args) => { calls.push({ executable, args }); return { status: 0 } },
      sleep: async () => {},
    })
    expect(calls).toEqual([{ executable: "/usr/bin/docker", args: ["restart", defaultTargetId] }])
    expect(result).toMatchObject({ restarted: true, restartInvocationCount: 1, ownerImageDigest: "d".repeat(64), ownerContainerDigest: "c".repeat(64), restartCountBefore: 4, restartCountAfter: 5 })
    expect(result.beforeLifecycleDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.afterLifecycleDigest).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.beforeLifecycleDigest).not.toBe(result.afterLifecycleDigest)
  })

  it("starts, polls, and recovers only the fixed owner-bound health probe", async () => {
    const { dispatch } = await broker()
    const calls: Array<{ operation: string; input: Record<string, string> }> = []
    const snapshot = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused",
      containerSnapshot: () => snapshot,
      startHealthProbe: (input) => { calls.push({ operation: "start", input }); return { state: "started", operationDigest: "d".repeat(64) } },
      healthProbeStatus: (input) => { calls.push({ operation: "status", input }); return { state: "running" } },
      recoverHealthProbe: (input) => { calls.push({ operation: "recover", input }); return { recovered: true } },
    }
    const coordinates = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    await expect(dispatch({ operation: "start_health_probe", ...coordinates }, dependencies)).resolves.toEqual({ state: "started", operationDigest: "d".repeat(64) })
    await expect(dispatch({ operation: "health_probe_status", ...coordinates }, dependencies)).resolves.toEqual({ state: "running" })
    await expect(dispatch({ operation: "recover_health_probe", ...coordinates }, dependencies)).resolves.toEqual({ recovered: true })
    expect(calls).toEqual([
      { operation: "start", input: { label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest, ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64) } },
      { operation: "status", input: { label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest } },
      { operation: "recover", input: { label: coordinates.label, scenarioHandleDigest: coordinates.scenarioHandleDigest, ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64) } },
    ])
  })

  it("keeps running status on the fast path and returns the exact independently attested complete snapshot", async () => {
    const { dispatch } = await broker()
    const coordinates = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    const snapshot = { schemaVersion: 1, imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }
    let state: "running" | "complete" = "running"
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused",
      containerSnapshot: () => { throw new Error("full snapshot must not run before completion") },
      healthProbeStatus: () => state === "running" ? { state } : { state, containerSnapshot: snapshot },
    }
    await expect(dispatch({ operation: "health_probe_status", ...coordinates }, dependencies)).resolves.toEqual({ state: "running" })
    state = "complete"
    await expect(dispatch({ operation: "health_probe_status", ...coordinates }, dependencies)).resolves.toEqual({ state: "complete", containerSnapshot: snapshot })
  })

  it("uses only the bounded owner identity path before health recovery", async () => {
    const { dispatch } = await broker()
    const calls: string[] = []
    const coordinates = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    await expect(dispatch({ operation: "recover_health_probe", ...coordinates }, {
      readBootId: () => "unused",
      containerSnapshot: () => { throw new Error("full snapshot is too slow for recovery") },
      containerOwnerSnapshot: () => { calls.push("owner"); return { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64) } },
      recoverHealthProbe: (input) => { calls.push(`recover:${input.ownerImageDigest}`); return { recovered: true } },
    })).resolves.toEqual({ recovered: true })
    expect(calls).toEqual(["owner", `recover:${"b".repeat(64)}`])
  })

  it("keeps declared socket deadlines above bounded blocked-operation maxima", async () => {
    const { healthProbeOperationBudgets } = await broker()
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as any
    const budgets = healthProbeOperationBudgets()
    expect(budgets).toEqual({ startMaxMs: 115_000, completeStatusMaxMs: 130_000, recoveryMaxMs: 85_000, composedCaptureMaxMs: 165_000 })
    expect(contract.adapters["health-probe-start"].timeoutMs).toBeGreaterThan(budgets.startMaxMs)
    expect(contract.adapters["health-probe-status"].timeoutMs).toBeGreaterThan(budgets.completeStatusMaxMs)
    expect(contract.adapters["health-probe-recovery"].timeoutMs).toBeGreaterThan(budgets.recoveryMaxMs)
    expect(contract.adapterTimeoutMs).toBeGreaterThan(contract.adapters["health-probe-status"].timeoutMs)
    expect(contract.adapters["scenario-capture"].timeoutMs).toBeGreaterThan(budgets.composedCaptureMaxMs)
    expect(contract.adapterTimeoutMs).toBeGreaterThan(contract.adapters["scenario-capture"].timeoutMs)
  })

  it.each([
    ["image drift", { imageId: `sha256:${"d".repeat(64)}` }],
    ["container drift", { containerId: "d".repeat(64) }],
    ["stopped owner", { running: false }],
    ["unhealthy owner", { health: "unhealthy" }],
  ])("rejects complete retry attestation with %s", async (_case, mutation) => {
    const { requireHealthProbeCompleteAttestation } = await broker()
    const request = { label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-health-probe-receipt-v1", label: request.label, scenarioHandleDigest: request.scenarioHandleDigest,
      ownerImageDigestBefore: "b".repeat(64), ownerImageDigestAfter: "b".repeat(64), ownerContainerDigestBefore: "c".repeat(64), ownerContainerDigestAfter: "c".repeat(64),
      beforeStateDigest: "d".repeat(64), restoredStateDigest: "d".repeat(64), cronFingerprintBefore: "e".repeat(64), cronFingerprintAfter: "e".repeat(64),
      cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: "f".repeat(64),
      clockMode: "ambient", effectiveNow: "2026-08-20T17:00:00.000Z", phases: [], providerInvocationCount: 0, privateTurnCount: 0, deliveryCount: 0,
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, schedulerReceipt: null,
    }
    const snapshot = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy", ...mutation }
    expect(() => requireHealthProbeCompleteAttestation(receipt, snapshot, request)).toThrow(/complete attestation/u)
    expect(() => requireHealthProbeCompleteAttestation(receipt, { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }, request)).not.toThrow()
  })

  it("verifies the scheduler receipt MAC before accepting complete Unit16f evidence", async () => {
    const { requireHealthProbeCompleteAttestation } = await broker()
    const key = "k".repeat(43)
    const request = { label: "unit-16f-cron-fingerprint", scenarioHandleDigest: "a".repeat(64) }
    const slot = "2026-08-20T17:00:00.000Z"
    const occurrenceId = `cron:${slot}`
    const command = "/usr/local/bin/node /opt/ouro/dist/heart/daemon/ouro-entry.js poke sanctuary --habit sanctuary-health --trigger cron"
    const unsignedScheduler = {
      schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", label: request.label, trigger: "cron", scenarioHandleDigest: request.scenarioHandleDigest,
      occurrenceId, runnerId: "11111111-1111-4111-8111-111111111111", recordedAt: "2026-08-20T17:00:01.000Z",
      before: { sweepCount: 10, deliveryCount: 4 }, after: { sweepCount: 11, deliveryCount: 4 }, sweepDelta: 1, deliveryDelta: 0,
      providerInvocationCount: 0, privateTurnCount: 0, nonReplay: true,
      sweep: { recordDigest: "d".repeat(64), opened: 0, recovered: 0, digestDue: false, deliveryId: null },
      supervisor: {
        schemaVersion: "supercronic-supervisor-snapshot-v1", daemonPid: 1, childCount: 1, childPid: 42, healthy: true,
        binaryPath: "/usr/local/bin/supercronic", args: ["-split-logs", "-inotify", "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab"],
        crontabPath: "/home/ouro/.ouro-cli/scheduler/sanctuary.crontab", namespace: "habit:sanctuary",
        manifest: [{ id: "sanctuary:sanctuary-health", agent: "sanctuary", taskId: "sanctuary-health", schedule: "*/15 * * * *", lastRun: null, command, taskPath: "/home/ouro/AgentBundles/sanctuary.ouro/habits/sanctuary-health.md" }],
        renderedCrontab: `# ouro:habit:sanctuary:sanctuary:sanctuary-health\n*/15 * * * * ${command}\n`,
      },
      schedulerOrigin: { slot, occurrenceId, schedulerRunId: "22222222-2222-4222-8222-222222222222", invocationPid: 43, parentPid: 42, parentStartTime: "8001", invocationStartTime: "9001", proofMac: "", scenarioHandleDigest: request.scenarioHandleDigest },
    }
    const { proofMac: _proofMac, ...originWithoutProof } = unsignedScheduler.schedulerOrigin
    const schedulerCommand = { kind: "habit.scheduler-fire", agent: "sanctuary", habitName: "sanctuary-health", trigger: "cron", ...originWithoutProof }
    unsignedScheduler.schedulerOrigin.proofMac = createHmac("sha256", key).update(JSON.stringify(schedulerCommand)).digest("hex")
    const receiptMac = createHmac("sha256", key).update(`sanctuary-scheduler-liveness-receipt-v2\0${JSON.stringify(unsignedScheduler)}`).digest("hex")
    const receipt = {
      schemaVersion: "sanctuary-health-probe-receipt-v1", label: request.label, scenarioHandleDigest: request.scenarioHandleDigest,
      ownerImageDigestBefore: "b".repeat(64), ownerImageDigestAfter: "b".repeat(64), ownerContainerDigestBefore: "c".repeat(64), ownerContainerDigestAfter: "c".repeat(64),
      beforeStateDigest: "d".repeat(64), restoredStateDigest: "d".repeat(64), cronFingerprintBefore: "e".repeat(64), cronFingerprintAfter: "e".repeat(64),
      cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: createHash("sha256").update(JSON.stringify([])).digest("hex"),
      clockMode: "ambient", effectiveNow: "2026-08-20T17:00:00.000Z",
      phases: [{ ordinal: 1, name: "cron-unchanged", trigger: "cron", fixtureStatus: null, opened: 0, recovered: 0, digestDue: false, deliveryKind: null, sweepReceiptDigest: "d".repeat(64), deliveryReceiptDigest: null }],
      providerInvocationCount: 0, privateTurnCount: 0, deliveryCount: 0,
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true,
      schedulerReceipt: { ...unsignedScheduler, receiptMac },
    }
    const snapshot = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }
    expect(() => requireHealthProbeCompleteAttestation(receipt, snapshot, request, () => key)).not.toThrow()
    ;(receipt.schedulerReceipt as Record<string, unknown>).runnerId = "33333333-3333-4333-8333-333333333333"
    expect(() => requireHealthProbeCompleteAttestation(receipt, snapshot, request, () => key)).toThrow(/complete attestation/u)
  })

  it("rejects signed sparse or semantically inconsistent scheduler evidence before finalization", async () => {
    const { finalizeHealthProbeAfterAttestation, requireHealthProbeCompleteAttestation } = await broker()
    const key = "k".repeat(43)
    const request = { label: "unit-16f-cron-fingerprint", scenarioHandleDigest: "a".repeat(64) }
    const slot = "2026-08-20T17:00:00.000Z"
    const occurrenceId = `cron:${slot}`
    const sparse = { schemaVersion: "sanctuary-scheduler-liveness-receipt-v1", trigger: "cron", scenarioHandleDigest: request.scenarioHandleDigest, occurrenceId, sweepDelta: 1, deliveryDelta: 0, nonReplay: true, runnerId: "11111111-1111-4111-8111-111111111111", schedulerOrigin: { slot, occurrenceId, schedulerRunId: "22222222-2222-4222-8222-222222222222", scenarioHandleDigest: request.scenarioHandleDigest } }
    const schedulerReceipt = { ...sparse, receiptMac: createHmac("sha256", key).update(`sanctuary-scheduler-liveness-receipt-v2\0${JSON.stringify(sparse)}`).digest("hex") }
    const receipt = {
      schemaVersion: "sanctuary-health-probe-receipt-v1", label: request.label, scenarioHandleDigest: request.scenarioHandleDigest,
      ownerImageDigestBefore: "b".repeat(64), ownerImageDigestAfter: "b".repeat(64), ownerContainerDigestBefore: "c".repeat(64), ownerContainerDigestAfter: "c".repeat(64),
      beforeStateDigest: "d".repeat(64), restoredStateDigest: "d".repeat(64), cronFingerprintBefore: "e".repeat(64), cronFingerprintAfter: "e".repeat(64),
      cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: "f".repeat(64),
      clockMode: "ambient", effectiveNow: "2026-08-20T17:00:00.000Z", phases: [], providerInvocationCount: 0, privateTurnCount: 0, deliveryCount: 0,
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, schedulerReceipt,
    }
    const snapshot = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }
    const finalize = vi.fn()
    expect(() => requireHealthProbeCompleteAttestation(receipt, snapshot, request, () => key)).toThrow(/complete attestation/u)
    expect(() => finalizeHealthProbeAfterAttestation(receipt, snapshot, request, finalize, () => key)).toThrow(/complete attestation/u)
    expect(finalize).not.toHaveBeenCalled()
  })

  it.each([
    ["before image drift", { ownerImageDigestBefore: "d".repeat(64) }],
    ["before container drift", { ownerContainerDigestBefore: "d".repeat(64) }],
  ])("rejects receipt-first complete retries with %s", async (_case, mutation) => {
    const { completeHealthProbeFromReceipt } = await broker()
    const request = { label: "unit-16f-cron-fingerprint", scenarioHandleDigest: "a".repeat(64) }
    const receipt = {
      schemaVersion: "sanctuary-health-probe-receipt-v1", label: request.label, scenarioHandleDigest: request.scenarioHandleDigest,
      ownerImageDigestBefore: "b".repeat(64), ownerImageDigestAfter: "b".repeat(64), ownerContainerDigestBefore: "c".repeat(64), ownerContainerDigestAfter: "c".repeat(64),
      beforeStateDigest: "d".repeat(64), restoredStateDigest: "d".repeat(64), cronFingerprintBefore: "e".repeat(64), cronFingerprintAfter: "e".repeat(64),
      cronRegisteredBefore: true, cronRegisteredAfter: true, cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: "f".repeat(64),
      clockMode: "ambient", effectiveNow: "2026-08-20T17:00:00.000Z", phases: [], providerInvocationCount: 0, privateTurnCount: 0, deliveryCount: 0,
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, schedulerReceipt: null, ...mutation,
    }
    expect(() => completeHealthProbeFromReceipt(request, {
      imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy",
    }, () => receipt)).toThrow(/complete attestation/u)
  })

  it("constructs an exact argv-only packaged probe invocation", async () => {
    const { healthProbeDockerArgs } = await broker()
    expect(healthProbeDockerArgs("run", {
      label: "unit-16h-daily-digest", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64),
    })).toEqual([
      "exec", defaultTargetId, "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe-entry.js", "run",
      "--label", "unit-16h-daily-digest", "--scenario", "a".repeat(64), "--owner-image", "b".repeat(64), "--owner-container", "c".repeat(64),
    ])
    expect(healthProbeDockerArgs("stop", {
      label: "unit-16h-daily-digest", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64),
    })).toEqual([
      "exec", defaultTargetId, "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe-entry.js", "stop",
      "--label", "unit-16h-daily-digest", "--scenario", "a".repeat(64), "--owner-image", "b".repeat(64), "--owner-container", "c".repeat(64),
    ])
  })

  it("drains an accepted delayed start before shutdown recovery can snapshot active probes", async () => {
    const { createDispatchDrain } = await broker()
    const drain = createDispatchDrain()
    let releaseSnapshot!: () => void
    const delayedSnapshot = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    const events: string[] = []
    const accepted = drain.run(async () => {
      events.push("snapshot-start")
      await delayedSnapshot
      events.push("probe-started")
    })
    const draining = drain.stopAndDrain().then(() => { events.push("recovery-snapshot") })
    await Promise.resolve()
    expect(events).toEqual(["snapshot-start"])
    await expect(drain.run(() => { events.push("late-start") })).rejects.toThrow(/shutting down/u)
    releaseSnapshot()
    await Promise.all([accepted, draining])
    expect(events).toEqual(["snapshot-start", "probe-started", "recovery-snapshot"])
  })

  it("serializes recovery behind an entered delayed start and tombstones later starts", async () => {
    const { createHealthProbeOperationCoordinator } = await broker()
    const coordinator = createHealthProbeOperationCoordinator()
    let releaseSnapshot!: () => void
    const delayedSnapshot = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    const events: string[] = []
    const started = coordinator.start("a".repeat(64), async () => {
      events.push("snapshot")
      await delayedSnapshot
      events.push("launch")
    })
    await Promise.resolve()
    const recovered = coordinator.recover("a".repeat(64), () => { events.push("recover") })
    await expect(coordinator.start("a".repeat(64), () => { events.push("orphan") })).rejects.toThrow(/recovered scenario/u)
    expect(events).toEqual(["snapshot"])
    releaseSnapshot()
    await Promise.all([started, recovered])
    expect(events).toEqual(["snapshot", "launch", "recover"])
  })

  it("wires same-scenario serialization around dispatch before the delayed owner snapshot", async () => {
    const { createHealthProbeOperationCoordinator, dispatch } = await broker()
    const coordinator = createHealthProbeOperationCoordinator()
    let releaseSnapshot!: () => void
    const snapshotReady = new Promise<void>((resolve) => { releaseSnapshot = resolve })
    const events: string[] = []
    const payload = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused",
      healthProbeCoordinator: coordinator,
      containerSnapshot: async () => {
        events.push("snapshot")
        await snapshotReady
        return { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }
      },
      containerOwnerSnapshot: () => ({ imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64) }),
      startHealthProbe: () => { events.push("launch"); return { state: "started", operationDigest: "d".repeat(64) } },
      recoverHealthProbe: () => { events.push("recover"); return { recovered: true } },
    }
    const starting = dispatch({ operation: "start_health_probe", ...payload }, dependencies)
    await Promise.resolve()
    await Promise.resolve()
    const recovering = dispatch({ operation: "recover_health_probe", ...payload }, dependencies)
    expect(events).toEqual(["snapshot"])
    releaseSnapshot()
    await Promise.all([starting, recovering])
    expect(events).toEqual(["snapshot", "launch", "recover"])
    await expect(dispatch({ operation: "start_health_probe", ...payload }, dependencies)).rejects.toThrow(/recovered scenario/u)
    expect(events).toEqual(["snapshot", "launch", "recover"])
  })

  it.each([
    ["wrong target", { targetId: "another-host", scenarioHandleDigest: "a".repeat(64) }],
    ["malformed handle", { targetId: "sanctuary", scenarioHandleDigest: "wrong" }],
  ])("validates %s before recovery can tombstone a scenario", async (_case, invalid) => {
    const { createHealthProbeOperationCoordinator, dispatch } = await broker()
    const coordinator = createHealthProbeOperationCoordinator()
    const valid = { targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused",
      healthProbeCoordinator: coordinator,
      containerSnapshot: () => ({ imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }),
      containerOwnerSnapshot: () => ({ imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64) }),
      startHealthProbe: () => ({ state: "started", operationDigest: "d".repeat(64) }),
      recoverHealthProbe: () => ({ recovered: true }),
    }
    await expect(dispatch({ operation: "recover_health_probe", label: valid.label, ...invalid }, dependencies)).rejects.toThrow(/target|digest/u)
    await expect(dispatch({ operation: "start_health_probe", ...valid }, dependencies)).resolves.toMatchObject({ state: "started" })
  })

  it("classifies a pending-only probe as recovery-required and fail-closed", async () => {
    const { healthProbeArtifactDisposition } = await broker()
    expect(healthProbeArtifactDisposition({ receipt: null, workspace: null, pending: { isFile: () => true } })).toBe("recovery_required")
    expect(healthProbeArtifactDisposition({ receipt: null, workspace: null, pending: null })).toBe("absent")
    expect(healthProbeArtifactDisposition({ receipt: { isFile: () => true }, workspace: null, pending: null })).toBe("complete")
  })

  it("always invokes the scenario-bound in-container absence attestation when the marker is missing", async () => {
    const { attestHealthProbeProcessAbsent } = await broker()
    const calls: Array<{ executable: string; args: string[] }> = []
    const input = {
      label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64),
    }
    expect(() => attestHealthProbeProcessAbsent(input, {
      run: (executable, args) => { calls.push({ executable, args }); return { status: 0 } },
      markerPresent: () => false,
    })).not.toThrow()
    expect(calls).toEqual([{ executable: "/usr/bin/docker", args: [
      "exec", defaultTargetId, "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe-entry.js", "stop",
      "--label", input.label, "--scenario", input.scenarioHandleDigest, "--owner-image", input.ownerImageDigest, "--owner-container", input.ownerContainerDigest,
    ] }])
  })

  it("rejects health probes for drifted owners and invalid labels before launch", async () => {
    const { dispatch } = await broker()
    const started: unknown[] = []
    const dependencies: BrokerDependencies = {
      readBootId: () => "unused",
      containerSnapshot: () => ({ imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: false, health: "unhealthy" }),
      startHealthProbe: (input) => { started.push(input); return {} },
    }
    await expect(dispatch({ operation: "start_health_probe", targetId: "sanctuary", label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64) }, dependencies)).rejects.toThrow(/healthy production owner/u)
    await expect(dispatch({ operation: "start_health_probe", targetId: "sanctuary", label: "unit-14f-real-cron", scenarioHandleDigest: "a".repeat(64) }, dependencies)).rejects.toThrow(/label is invalid/u)
    expect(started).toEqual([])
  })

  it("rejects independently re-observed image or container drift before final attestation", async () => {
    const { requireStableHealthProbeOwner } = await broker()
    const before = { label: "unit-16g-health-transition", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64) }
    expect(() => requireStableHealthProbeOwner(before, { ...before, ownerImageDigest: "d".repeat(64) })).toThrow(/owner binding drifted/u)
    expect(() => requireStableHealthProbeOwner(before, { ...before, ownerContainerDigest: "e".repeat(64) })).toThrow(/owner binding drifted/u)
    expect(() => requireStableHealthProbeOwner(before, before)).not.toThrow()
  })

  it("waits for a running health probe child to exit before recovery starts", async () => {
    const { recoverAfterHealthProbeTermination } = await broker()
    const child = new EventEmitter() as HealthProbeChild
    child.exitCode = null
    child.signalCode = null
    const signals: NodeJS.Signals[] = []
    child.kill = (signal) => { signals.push(signal); return true }
    const record: HealthProbeRecord = { child, state: "running", exitCode: null }
    let recoveryStarted = false

    const recovered = recoverAfterHealthProbeTermination(record, () => {
      recoveryStarted = true
      return "restored"
    }, { termGraceMs: 100, killGraceMs: 100 })
    await Promise.resolve()

    expect(signals).toEqual(["SIGTERM"])
    expect(record.state).toBe("terminating")
    expect(recoveryStarted).toBe(false)
    child.signalCode = "SIGTERM"
    child.emit("exit", null, "SIGTERM")
    await expect(recovered).resolves.toBe("restored")
    expect(record.state).toBe("terminated")
    expect(recoveryStarted).toBe(true)
  })

  it("uses an exact SIGKILL after the bounded graceful termination window", async () => {
    const { terminateHealthProbeChild } = await broker()
    const child = new EventEmitter() as HealthProbeChild
    child.exitCode = null
    child.signalCode = null
    const signals: NodeJS.Signals[] = []
    child.kill = (signal) => {
      signals.push(signal)
      if (signal === "SIGKILL") {
        child.signalCode = signal
        queueMicrotask(() => child.emit("exit", null, signal))
      }
      return true
    }
    const record: HealthProbeRecord = { child, state: "running", exitCode: null }

    await expect(terminateHealthProbeChild(record, { termGraceMs: 1, killGraceMs: 100 })).resolves.toBeUndefined()
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(record.state).toBe("terminated")
  })

  it("shares termination state safely across concurrent recovery attempts", async () => {
    const { terminateHealthProbeChild } = await broker()
    const child = new EventEmitter() as HealthProbeChild
    child.exitCode = null
    child.signalCode = null
    const signals: NodeJS.Signals[] = []
    child.kill = (signal) => { signals.push(signal); return true }
    const record: HealthProbeRecord = { child, state: "running", exitCode: null }

    const first = terminateHealthProbeChild(record, { termGraceMs: 100, killGraceMs: 100 })
    const second = terminateHealthProbeChild(record, { termGraceMs: 100, killGraceMs: 100 })
    expect(record.state).toBe("terminating")
    expect(record.terminationPromise).toBe(first)
    expect(second).toBe(first)
    expect(signals).toEqual(["SIGTERM"])

    child.signalCode = "SIGTERM"
    child.emit("exit", null, "SIGTERM")
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(record.state).toBe("terminated")
  })

  it("reads GraphQL autostart through the exact canonical RO credential and query", async () => {
    const { queryGraphqlAutostart } = await broker()
    const productionId = "b".repeat(64)
    const stagingId = "c".repeat(64)
    const rollbackId = "d".repeat(64)
    const serverId = "f".repeat(64)
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return new Response(JSON.stringify({ data: { vars: { id: `${serverId}:vars` }, docker: { containers: [
        { id: `${serverId}:${productionId}`, names: ["/ouro-butler"], autoStart: true },
        { id: `${serverId}:${rollbackId}`, names: ["/ouro-butler-rollback"], autoStart: false },
      ] } } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const permissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    await expect(queryGraphqlAutostart([{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }], fetchImpl, productionId)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe("http://127.0.0.1/graphql")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json", "x-api-key": "private-descriptor" })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "query AcceptanceContainerTopology { vars { id } docker { containers(skipCache: true) { id names autoStart } } }",
      variables: {},
    })
    const responseWith = (containers: unknown[]) => (async () => new Response(JSON.stringify({ data: { vars: { id: `${serverId}:vars` }, docker: { containers } } }), { status: 200 })) as typeof fetch
    const wrongSuffix = responseWith([
      { id: `${serverId}:${stagingId}`, names: ["/ouro-butler"], autoStart: true },
      { id: `${serverId}:${rollbackId}`, names: ["/ouro-butler-rollback"], autoStart: false },
    ])
    await expect(queryGraphqlAutostart([{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }], wrongSuffix, productionId)).resolves.toBe(false)
    for (const invalidTopology of [
      [{ id: `${serverId}:${productionId}`, names: ["/ouro-butler"], autoStart: true }],
      [
        { id: `${serverId}:${productionId}`, names: ["/ouro-butler"], autoStart: true },
        { id: `${serverId}:${rollbackId}`, names: ["/ouro-butler-rollback"], autoStart: true },
      ],
      [
        { id: `${serverId}:${productionId}`, names: ["/ouro-butler"], autoStart: true },
        { id: `${serverId}:${rollbackId}`, names: ["/ouro-butler-rollback"], autoStart: false },
        { id: `${serverId}:${stagingId}`, names: ["/ouro-butler-staging"], autoStart: false },
      ],
    ]) {
      await expect(queryGraphqlAutostart([{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }], responseWith(invalidTopology), productionId)).resolves.toBe(false)
    }
    const stagingProfile = { containerName: "ouro-butler-staging", requiredStopped: [], forbidden: ["ouro-butler", "ouro-butler-rollback"] }
    await expect(queryGraphqlAutostart(
      [{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }],
      responseWith([{ id: `${serverId}:${stagingId}`, names: ["/ouro-butler-staging"], autoStart: true }]),
      stagingId,
      stagingProfile,
    )).resolves.toBe(true)
    await expect(queryGraphqlAutostart(
      [{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }],
      responseWith([
        { id: `${serverId}:${stagingId}`, names: ["/ouro-butler-staging"], autoStart: true },
        { id: `${serverId}:${productionId}`, names: ["/ouro-butler"], autoStart: false },
      ]),
      stagingId,
      stagingProfile,
    )).resolves.toBe(false)
  })

  it("requires successful live runtime and both provider vault reads", async () => {
    const { parseVaultStatus } = await broker()
    expect(parseVaultStatus("local unlock: available\nruntime credentials: missing\nprovider credentials: unavailable (network)\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: available\nruntime credentials: telegramAuthorizedChatId, telegramAuthorizedUserId, telegramBotToken (runtime_revision)\nprovider credentials: \n  openai-compatible: credential fields apiKey, config fields baseUrl\n  openai-compatible-gemini: credential fields apiKey, config fields baseUrl\n", true))
      .toEqual({ vaultUnlocked: true, manualAuthRequired: false })
    expect(parseVaultStatus("local unlock: available\nruntime credentials: telegramAuthorizedChatId, telegramAuthorizedUserId, telegramBotToken (runtime_revision)\nprovider credentials: \n  openai-compatible: credential fields apiKey, config fields baseUrl\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: missing\n", true))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
    expect(parseVaultStatus("local unlock: available\n", false))
      .toEqual({ vaultUnlocked: false, manualAuthRequired: true })
  })

  it("rejects unknown operations, extra authority, and invalid target coordinates", async () => {
    const { dispatch } = await broker()
    await expect(dispatch({ operation: "run_command", executable: "/bin/sh" })).rejects.toThrow(/not whitelisted/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
      executable: "/sbin/reboot",
    })).rejects.toThrow(/shape is invalid/u)
    await expect(dispatch({
      operation: "request_reboot",
      targetId: "another-host",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
      preflightDigest: "a".repeat(64),
      processBindingDigest: "b".repeat(64),
    })).rejects.toThrow(/target host is invalid/u)
  })

  it("keeps host authority fixed and emits only redacted broker failures", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-host-broker.mjs", "utf8")
    expect(source).toContain('const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"')
    expect(source).toContain('const UNRAID_API = "/usr/local/sbin/unraid-api"')
    expect(source).toContain('const DOCKER = "/usr/bin/docker"')
    expect(source).toContain('const TAILSCALE = "/usr/local/sbin/tailscale"')
    expect(source).toContain('let activeContainer = "ouro-butler"')
    expect(source).toContain('let activeContainerId = "0".repeat(64)')
    expect(source).toContain('activeProfile = targetProfile(profileName)')
    expect(source).toContain('activeContainer = activeProfile.containerName')
    expect(source).toContain('activeContainerId = text(targetContainerId, "attested target container id", SHA256)')
    expect(source).toContain('["inspect", "--format", template, activeContainerId]')
    expect(source).toContain('["restart", activeContainerId]')
    expect(source).not.toContain('["restart", activeContainer]')
    expect(source).toContain('const AUTOSTART_FILE = "/var/lib/docker/unraid-autostart"')
    expect(source).toContain('const RUNTIME_POLICY_FILE = "/opt/ouro/container-runtime.json"')
    expect(source).toContain('const PRODUCTION_RUNTIME_SOURCE = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"')
    expect(source).toContain('const PRODUCTION_BUNDLE_SOURCE = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"')
    expect(source).toContain("mount.source === expected.source")
    expect(source).toContain("mount.mode === expected.mode")
    expect(source).toContain("mount.propagation === expected.propagation")
    expect(source).toContain('"capDrop":{{json .HostConfig.CapDrop}}')
    expect(source).toContain('JSON.stringify(value.capDrop) === JSON.stringify(["ALL"])')
    expect(source).toContain('JSON.stringify(value.securityOpt) === JSON.stringify(["no-new-privileges"])')
    expect(source).toContain('"vault", "status", "--agent", "sanctuary"')
    expect(source.match(/spawnSync\(DOCKER, \["inspect"/gu)).toHaveLength(5)
    expect(source).toContain('const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"')
    expect(source).toContain('chownSync(socket, 0, 10001)')
    expect(source).toContain('chmodSync(socket, 0o660)')
    expect(source).toContain('{ ok: false, error: "host operation failed" }')
    expect(source).not.toMatch(/console\.(?:log|error|warn)/u)
    expect(source).not.toContain("/var/run/docker.sock")
    expect(source).not.toContain("return { recovered: false }")
  })
})
