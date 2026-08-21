import { pathToFileURL } from "node:url"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

interface BrokerDependencies {
  readBootId(): string
  containerSnapshot(): unknown | Promise<unknown>
  containerOwnerSnapshot?(): unknown | Promise<unknown>
  startHealthProbe?(input: Record<string, string>): unknown
  healthProbeStatus?(input: Record<string, string>): unknown
  recoverHealthProbe?(input: Record<string, string>): unknown
  healthProbeCoordinator?: {
    start<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
    recover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>
  }
}

interface BrokerModule {
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
  queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch): Promise<boolean>
  healthProbeDockerArgs(mode: "run" | "stop" | "recover", input: Record<string, string>): string[]
  healthProbeArtifactDisposition(artifacts: { receipt: unknown; workspace: unknown; pending: unknown }): "complete" | "recovery_required" | "absent"
  healthProbeOperationBudgets(): { startMaxMs: number; completeStatusMaxMs: number; recoveryMaxMs: number; composedCaptureMaxMs: number }
  requireHealthProbeCompleteAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>): void
  requireStableHealthProbeOwner(before: Record<string, string>, after: Record<string, string>): void
  terminateHealthProbeChild(record: HealthProbeRecord, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<void>
  recoverAfterHealthProbeTermination<T>(record: HealthProbeRecord, recovery: () => T | Promise<T>, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<T>
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
    createHealthProbeOperationCoordinator(): { start<T>(scenario: string, operation: () => T | Promise<T>): Promise<T>; recover<T>(scenario: string, operation: () => T | Promise<T>): Promise<T> }
    completeHealthProbeFromReceipt(request: Record<string, string>, snapshot: Record<string, unknown>, readReceipt: () => Record<string, unknown>): { state: "complete"; containerSnapshot: Record<string, unknown> }
    attestHealthProbeProcessAbsent(input: Record<string, string>, dependencies?: {
      run(executable: string, args: string[], options: unknown): { error?: Error; status: number | null }
      markerPresent(): boolean
    }): void
    createDispatchDrain(): { run<T>(operation: () => T | Promise<T>): Promise<T>; stopAndDrain(): Promise<void> }
    dispatch(request: unknown, dependencies?: BrokerDependencies): Promise<unknown>
    parseVaultStatus(output: string, succeeded: boolean): { vaultUnlocked: boolean; manualAuthRequired: boolean }
    queryGraphqlAutostart(records: unknown[], fetchImpl: typeof fetch): Promise<boolean>
    healthProbeDockerArgs(mode: "run" | "stop" | "recover", input: Record<string, string>): string[]
    healthProbeArtifactDisposition(artifacts: { receipt: unknown; workspace: unknown; pending: unknown }): "complete" | "recovery_required" | "absent"
    healthProbeOperationBudgets(): { startMaxMs: number; completeStatusMaxMs: number; recoveryMaxMs: number; composedCaptureMaxMs: number }
    requireHealthProbeCompleteAttestation(receipt: Record<string, unknown>, snapshot: Record<string, unknown>, request: Record<string, string>): void
    requireStableHealthProbeOwner(before: Record<string, string>, after: Record<string, string>): void
    terminateHealthProbeChild(record: HealthProbeRecord, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<void>
    recoverAfterHealthProbeTermination<T>(record: HealthProbeRecord, recovery: () => T | Promise<T>, options?: { termGraceMs?: number; killGraceMs?: number }): Promise<T>
  }>
}

describe("Sanctuary Unit 16 host broker", () => {
  it("stages a bounded host reboot attestation without executing reboot", async () => {
    const { dispatch } = await broker()
    const result = await dispatch({
      operation: "request_reboot",
      targetId: "sanctuary",
      idempotencyKey: "0123456789abcdef0123456789abcdef",
    }, {
      readBootId: () => "11111111-2222-3333-4444-555555555555\n",
      containerSnapshot: () => { throw new Error("unexpected container snapshot") },
    }) as Record<string, unknown>

    expect(result).toMatchObject({ accepted: true, targetId: "sanctuary", staged: true })
    expect(result.requestId).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.prebootId).toMatch(/^[A-Za-z0-9-]{4,128}$/u)
  })

  it("refreshes only the exact production container snapshot operation", async () => {
    const { dispatch } = await broker()
    const snapshot = {
      schemaVersion: 1, containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`,
      running: true, health: "healthy", user: "10001:10001", readOnlyRoot: true,
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
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true,
    }
    const snapshot = { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy", ...mutation }
    expect(() => requireHealthProbeCompleteAttestation(receipt, snapshot, request)).toThrow(/complete attestation/u)
    expect(() => requireHealthProbeCompleteAttestation(receipt, { imageId: `sha256:${"b".repeat(64)}`, containerId: "c".repeat(64), running: true, health: "healthy" }, request)).not.toThrow()
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
      workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true, ...mutation,
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
      "exec", "ouro-butler", "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe.js", "run",
      "--label", "unit-16h-daily-digest", "--scenario", "a".repeat(64), "--owner-image", "b".repeat(64), "--owner-container", "c".repeat(64),
    ])
    expect(healthProbeDockerArgs("stop", {
      label: "unit-16h-daily-digest", scenarioHandleDigest: "a".repeat(64), ownerImageDigest: "b".repeat(64), ownerContainerDigest: "c".repeat(64),
    })).toEqual([
      "exec", "ouro-butler", "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe.js", "stop",
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
      "exec", "ouro-butler", "/usr/local/bin/node", "/opt/ouro/dist/senses/sanctuary-health-acceptance-probe.js", "stop",
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
    const calls: Array<{ input: string; init?: RequestInit }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      return new Response(JSON.stringify({ data: { docker: { containers: [{ id: "Docker:one", names: ["/ouro-butler"], autoStart: true }] } } }), {
        status: 200, headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const permissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    await expect(queryGraphqlAutostart([{ id: "ro-id", name: "Butler RO", permissions, roles: [], key: "private-descriptor" }], fetchImpl)).resolves.toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe("http://127.0.0.1/graphql")
    expect(calls[0]?.init?.method).toBe("POST")
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json", "x-api-key": "private-descriptor" })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      query: "query AcceptanceContainerTopology { docker { containers(skipCache: true) { id names autoStart } } }",
      variables: {},
    })
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
    })).rejects.toThrow(/target host is invalid/u)
  })

  it("keeps host authority fixed and emits only redacted broker failures", () => {
    const source = fs.readFileSync("deploy/unraid/sanctuary-unit16-host-broker.mjs", "utf8")
    expect(source).toContain('const KEY_ROOT = "/boot/config/plugins/dynamix.my.servers/keys"')
    expect(source).toContain('const UNRAID_API = "/usr/local/sbin/unraid-api"')
    expect(source).toContain('const DOCKER = "/usr/bin/docker"')
    expect(source).toContain('const TAILSCALE = "/usr/local/sbin/tailscale"')
    expect(source).toContain('const PRODUCTION_CONTAINER = "ouro-butler"')
    expect(source).toContain('const AUTOSTART_FILE = "/var/lib/docker/unraid-autostart"')
    expect(source).toContain('const RUNTIME_POLICY_FILE = "/opt/ouro/container-runtime.json"')
    expect(source).toContain('const PRODUCTION_RUNTIME_SOURCE = "/mnt/user/appdata/ouro-butler/runtime/.ouro-cli"')
    expect(source).toContain('const PRODUCTION_BUNDLE_SOURCE = "/mnt/user/appdata/ouro-butler/agent/sanctuary.ouro"')
    expect(source).toContain("mount.source === expected.source")
    expect(source).toContain('"vault", "status", "--agent", "sanctuary"')
    expect(source.match(/spawnSync\(DOCKER, \["inspect"/gu)).toHaveLength(2)
    expect(source).toContain('const GRAPHQL_ENDPOINT = "http://127.0.0.1/graphql"')
    expect(source).toContain('chownSync(socket, 0, 10001)')
    expect(source).toContain('chmodSync(socket, 0o660)')
    expect(source).toContain('{ ok: false, error: "host operation failed" }')
    expect(source).not.toMatch(/console\.(?:log|error|warn)/u)
    expect(source).not.toContain("/var/run/docker.sock")
    expect(source).not.toContain("return { recovered: false }")
  })
})
