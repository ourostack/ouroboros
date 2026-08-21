import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createSanctuaryAcceptanceHarnessDependencies,
  executeSanctuaryAcceptanceHarness as executeHarness,
  resolveSanctuaryAdapterTimeoutMs,
  sanctuaryScenarioTimeoutBudget,
  validateSanctuaryUnit16EvidenceAssertions,
  type AcceptanceHarnessDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-harness"
import {
  createSanctuaryAcceptanceAdapterDependencies,
  executeSanctuaryAcceptanceAdapter,
  executeSanctuaryAcceptanceVaultProbe,
  type SanctuaryAcceptanceAdapterDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function root(): string {
  const created = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-acceptance-")))
  roots.push(created)
  return created
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
}

function dependencies(input: {
  secret?: string
  adapter?: (executable: string, payload: unknown, timeoutMs?: number) => Promise<unknown>
  fetch?: typeof fetch
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
} = {}): AcceptanceHarnessDependencies {
  const emptyIntegrity = { schemaVersion: "sanctuary-postboot-integrity-v1", telegramOffsetDigest: "1".repeat(64), approvalStateDigest: "2".repeat(64), approvalExecutionCount: 0, fingerprintDigest: "3".repeat(64), sweeps: [], deliveries: [], audits: [] }
  return {
    readSecret: () => input.secret ?? "",
    runAdapter: async (executable, payload, timeoutMs) => {
      const operation = (payload as Record<string, unknown>).operation
      if (operation === "reboot_preflight_snapshot") return { arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "e".repeat(64), processBindingDigest: "f".repeat(64) }
      if (operation === "postboot_integrity_snapshot") return emptyIntegrity
      return input.adapter ? input.adapter(executable, payload, timeoutMs) : { ok: true }
    },
    fetch: input.fetch ?? (async () => jsonResponse({ ok: true, result: [] })),
    now: input.now ?? (() => 1_800_000_000_000),
    randomBytes: () => Buffer.from("0123456789abcdef0123456789abcdef", "hex"),
    sleep: input.sleep ?? (async () => {}),
  }
}

function evidence(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function executeSanctuaryAcceptanceHarness(command: string, rawConfig: unknown, deps?: AcceptanceHarnessDependencies): Promise<void> {
  if (rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)) {
    const config = rawConfig as Record<string, unknown>
    if (typeof config.evidencePath === "string" && config.evidencePath.trim() && config.allowedRoot === undefined) {
      return executeHarness(command, { allowedRoot: fs.realpathSync(path.dirname(config.evidencePath)), ...config }, deps)
    }
  }
  return executeHarness(command, rawConfig, deps)
}

describe("Sanctuary acceptance harness", () => {
  const fixedAdapter = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"
  const telegramBootstrapFields = (dir: string, name = "bootstrap") => ({
    noncePath: path.join(dir, `${name}-nonce.txt`),
    pollerAdapter: fixedAdapter,
    vaultAdapter: fixedAdapter,
    deadlineMs: 300_000,
    pollTimeoutSeconds: 20,
  })
  const completeEvidenceLabels = [
    "unit-12c-1-opaque-identity",
    "unit-14b-3-opaque-identity-live",
    "unit-15c-1-no-callback-terminalization",
    "unit-16a-pre-reboot-checkpoint",
    "unit-16a-reboot-request",
    "unit-16a-boot-recovery-milestones",
    "unit-16b-runtime-vault-containment",
    "unit-16c-provider-readiness",
    "unit-16d-whats-up",
    "unit-16d-1-space",
    "unit-16d-2-unauthorized",
    "unit-16e-containment-audit",
    "unit-16e-1-stop-denial",
    "unit-16e-2-restart-denial",
    "unit-16f-cron-fingerprint",
    "unit-16g-health-transition",
    "unit-16h-daily-digest",
    "unit-16i-delayed-approval",
    "unit-16j-denial",
    "unit-16k-timeout-stale",
    "unit-16l-duplicate-callback",
    "unit-16m-restart-continuation",
  ]

  const evidenceProvenance = {
    imageDigest: "a".repeat(64),
    containerDigest: "b".repeat(64),
    cursorDigest: "c".repeat(64),
  }

  const liveProvenanceDependencies = (
    capture: Record<string, unknown> = evidenceProvenance,
    calls: Array<{ executable: string; payload: unknown }> = [],
  ) => dependencies({ adapter: async (executable, payload) => {
    calls.push({ executable, payload })
    return capture
  } })

  const validAssertions = (label: string): Record<string, unknown> => {
    switch (label) {
      case "unit-12c-1-opaque-identity": case "unit-14b-3-opaque-identity-live": return { identityBound: true, opaqueSubject: true, rawIdentityAbsent: true }
      case "unit-15c-1-no-callback-terminalization": return { buttonsRemoved: true, elapsedMs: 60_000, mutationCount: 0, noInboundUpdate: true, replayMutationCount: 0, terminalExpired: true, ttlMs: 60_000 }
      case "unit-16a-pre-reboot-checkpoint": return { approvalDigest: "d".repeat(64), auditDigest: "d".repeat(64), containerDigest: "d".repeat(64), fingerprintDigest: "d".repeat(64), offsetDigest: "d".repeat(64), processBindingDigest: "d".repeat(64), ready: true, unrelatedHostOperations: 0 }
      case "unit-16a-reboot-request": return { exactlyOnce: true, processBindingDigest: "d".repeat(64), requestCheckpointPersisted: true, requestDigest: "d".repeat(64) }
      case "unit-16a-boot-recovery-milestones": return { arrayReady: true, bootIdentityChanged: true, butlerReady: true, dockerReady: true, hostReady: true, postbootIntegrityPreserved: true, processBindingDigest: "d".repeat(64), sshReady: true, tailscaleReady: true }
      case "unit-16b-runtime-vault-containment": return { autostartExact: true, exactImage: true, manualAuthRequired: false, mountCount: 2, nonRootUid: 10001, publishedPortCount: 0, readOnlyRoot: true, updaterDisabled: true, vaultUnlocked: true }
      case "unit-16c-provider-readiness": return { baseUrlsExact: true, credentialIdentitiesDistinct: true, geminiCandidateReady: true, innerReady: true, modelsExact: true, outwardReady: true, providersDistinct: true, silentFallback: false, vaultCoordinatesExact: true }
      case "unit-16d-whats-up": return { accurate: true, authorized: true, grounded: true, liveFactsMatched: true, responseCount: 1, responseWithinLimit: true, telegramDelivered: true }
      case "unit-16d-1-space": return { accurate: true, authorized: true, grounded: true, liveFactsMatched: true, mutationCount: 0, responseCount: 1, responseWithinLimit: true, telegramDelivered: true }
      case "unit-16d-2-unauthorized": return { auditRejected: true, distinctAccount: true, mutationCount: 0, providerInvocationCount: 0, responseCount: 0, workItemCount: 0 }
      case "unit-16e-containment-audit": return {
        schemaVersion: "sanctuary-containment-audit-v1", keyCount: 2, keyInventoryDigest: "d".repeat(64), readScopeDigest: "9914469afdcb574937d1020a03faa82e3c02d767169d3eccae4b81863dafa06e", writeScopeDigest: "1de873b2bc3c7769010c32c69fcc8ea55343a5647cfdb0294769e831142945ec", keyRoleAssignmentCount: 0,
        telegramToolCount: 10, telegramProfileDigest: "a7f26934c5e60737582b9d13c78944b8bcbb941366899d82d58c01ca296e14e2", telegramSchemaDigest: "3c66299a5f70ec82f8795cae47659284e6dbc691ef49002c2fb22edba76c59b6", privateToolCount: 2, privateProfileDigest: "a100ffcaf436842bf9fceaf3d2fd1a1b766c04238300487474d6e9fcb7946369", privateSchemaDigest: "61b137b2467acbcf22ca7443ee01e71ed970a62728c42aabffbdcb562f4a6a70", resolvedHandlerCount: 12,
        excludedToolCount: 7, excludedSchemaIntersectionCount: 0, fabricatedHandlerInvocationCount: 0, excludedToolAttemptCount: 7, excludedToolRejectedCount: 7, excludedToolInvokedCount: 0, excludedToolSideEffectCount: 0, globallyResolvableExcludedToolCount: 4,
        auditPathDigest: "1cb8f1a00c544a5d10b0577090dbf070a07a5b6a99de13ccd27c11a257f84b75", auditLedgerDigest: "d".repeat(64), auditRecordCount: 2, auditLifecyclePairCount: 1,
        containerUser: "10001:10001", liveProcessUser: "10001:10001", mountCount: 2, publishedPortCount: 0, networkMode: "host", readOnlyRoot: true, mountsExact: true, securityExact: true, updaterDisabled: true, writableKeyExposure: false,
        rawWriteMaterialFieldCount: 0, typedWriteExecutorCount: 1, writeApprovalPolicyDigest: "24b1726edf1a2bbd524e9be63d3f0f726d996a8a009425462e01a5c4916ef42b", sensitiveMaterialObserved: false, mutationCount: 0,
      }
      case "unit-16e-1-stop-denial": case "unit-16e-2-restart-denial": return { attemptCount: 1, cursorBoundaryCount: 7, denied: true, mutationCount: 0, restartCountUnchanged: true, resumed: true }
      case "unit-16f-cron-fingerprint": return { fingerprintUnchanged: true, messageCount: 0, providerInvocationCount: 0, receiptUnchanged: true, scheduleRegistered: true, sweepObserved: true }
      case "unit-16g-health-transition": return { alertCount: 3, productionRestored: true, transitionObserved: true }
      case "unit-16h-daily-digest": return { firedWithinMs: 900_000, messageCount: 1, productionRestored: true, scheduleObserved: true }
      case "unit-16i-delayed-approval": return { elapsedMs: 120_000, mutationCount: 1, promptTerminal: true, replayMutationCount: 0, resumed: true, state: "succeeded" }
      case "unit-16j-denial": return { mutationCount: 0, promptTerminal: true, replayMutationCount: 0, resumed: true, state: "denied" }
      case "unit-16k-timeout-stale": return { buttonsRemoved: true, mutationCount: 0, promptTerminal: true, staleAcknowledged: true, staleReplayMutationCount: 0, state: "expired" }
      case "unit-16l-duplicate-callback": return { callbackCount: 2, claimCount: 1, mutationCount: 1, promptTerminal: true, replayMutationCount: 0, settledCount: 2, staleReplaySettled: true, writeCredentialAbsent: true }
      case "unit-16m-restart-continuation": return { attemptedIndeterminateRetryCount: 0, butlerRestartObserved: true, checkpointEpochPreserved: true, continuationEpochAdvanced: true, mutationCount: 1, preAttemptResumed: true, restartObserved: true, state: "succeeded" }
      default: throw new Error(`unknown label ${label}`)
    }
  }

  const completeEvidence = (label: string, harnessSha256: string, extra: Record<string, unknown> = {}) => {
    const assertions = validAssertions(label)
    return ({
    schemaVersion: 1,
    operation: label,
    phase: "complete",
    provenance: { ...evidenceProvenance, harnessSha256 },
    producer: { command: "evidence-snapshot", adapterOperation: "capture_acceptance_scenario", checkpointDigest: "e".repeat(64), sourceDigest: "f".repeat(64), captureDigest: sha(assertions) },
    assertions,
    ...extra,
    })
  }

  const seedRebootPhaseEvidence = (dir: string, harnessSha256: string): void => {
    for (const label of ["unit-16a-pre-reboot-checkpoint", "unit-16a-reboot-request", "unit-16a-boot-recovery-milestones"]) {
      fs.writeFileSync(path.join(dir, `${label}.json`), `${JSON.stringify(completeEvidence(label, harnessSha256))}\n`, { mode: 0o600 })
    }
  }

  it("builds and verifies one complete redacted Unit 16 evidence bundle", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const entries = completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `${index}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const bundlePath = path.join(dir, "unit-16-evidence-bundle.json")
    const provenanceCalls: Array<{ executable: string; payload: unknown }> = []

    await executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      entries,
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies(evidenceProvenance, provenanceCalls))
    await executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies(evidenceProvenance, provenanceCalls))

    expect(provenanceCalls).toEqual([
      { executable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh", payload: { operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" } },
      { executable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh", payload: { operation: "capture_evidence_provenance", schema: "sanctuary-unit-16-provenance-v1" } },
    ])

    const bundle = evidence(bundlePath)
    expect(bundle).toMatchObject({
      schemaVersion: 1,
      operation: "sanctuary-unit-16-evidence-bundle",
      phase: "complete",
      imageDigest: "a".repeat(64),
      containerDigest: "b".repeat(64),
      cursorDigest: "c".repeat(64),
      harnessSha256,
      bundleDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    })
    expect((bundle.entries as Array<{ label: string }>).map((entry) => entry.label)).toEqual(completeEvidenceLabels)
    expect(fs.statSync(bundlePath).mode & 0o777).toBe(0o600)
  })

  it("runs the fixed live scenario matrix and authors all 22 typed evidence files", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.sh")
    fs.writeFileSync(harnessPath, "fixed harness bytes\n", { mode: 0o700 })
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex"))
    const calls: Array<Record<string, unknown>> = []
    let firstWaiting = true
    let provenanceCapture = 0
    await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir,
      schema: "sanctuary-unit-16-matrix-v1",
      adapter: fixedAdapter,
      provenanceAdapter: fixedAdapter,
      harnessPath,
      timeoutMs: 300_000,
      intervalMs: 1,
    }, dependencies({
      adapter: async (_executable, rawPayload) => {
        const payload = rawPayload as Record<string, unknown>
        calls.push(payload)
        if (payload.operation === "capture_evidence_provenance") return {
          ...evidenceProvenance,
          cursorDigest: (++provenanceCapture).toString(16).padStart(64, "0"),
        }
        if (payload.operation === "finalize_acceptance_scenarios") return { finalized: true }
        const label = String(payload.label)
        if (label === completeEvidenceLabels[0] && payload.phase === "begin" && firstWaiting) {
          firstWaiting = false
          return { state: "waiting", checkpointDigest: "d".repeat(64) }
        }
        return {
          state: "complete",
          checkpointDigest: label.startsWith("unit-16a-") ? "e".repeat(64) : "d".repeat(64),
          sourceDigests: Object.fromEntries((payload.sources as string[]).map((source) => [source, "f".repeat(64)])),
          assertions: validAssertions(label),
        }
      },
    }))

    for (const label of completeEvidenceLabels) {
      const captured = evidence(path.join(dir, `${label}.json`))
      expect(captured).toMatchObject({
        operation: label,
        phase: "complete",
        assertions: validAssertions(label),
        producer: {
          command: "evidence-snapshot",
          adapterOperation: "capture_acceptance_scenario",
          checkpointDigest: label.startsWith("unit-16a-") ? "e".repeat(64) : "d".repeat(64),
          sourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
        },
      })
    }
    expect(calls).toContainEqual(expect.objectContaining({
      operation: "capture_acceptance_scenario",
      phase: "begin",
      label: "unit-16d-2-unauthorized",
      externalGate: "distinct-telegram-account-message",
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      operation: "capture_acceptance_scenario",
      phase: "begin",
      label: "unit-16i-delayed-approval",
      externalGate: "telegram-delayed-approve",
    }))
    expect(calls).toContainEqual(expect.objectContaining({ phase: "poll", checkpointDigest: "d".repeat(64) }))
    const livePhaseCursors = completeEvidenceLabels
      .filter((label) => !label.startsWith("unit-16a-"))
      .map((label) => (evidence(path.join(dir, `${label}.json`)).provenance as Record<string, unknown>).cursorDigest)
    expect(new Set(livePhaseCursors).size).toBe(livePhaseCursors.length)
  })

  it("rejects every material semantic failure instead of accepting self-attestation", () => {
    const reject = (label: string, patch: Record<string, unknown>, pattern: RegExp) => expect(() => validateSanctuaryUnit16EvidenceAssertions(
      label as Parameters<typeof validateSanctuaryUnit16EvidenceAssertions>[0],
      { ...validAssertions(label), ...patch },
    )).toThrow(pattern)
    reject("unit-12c-1-opaque-identity", { identityBound: false }, /must be true/u)
    reject("unit-15c-1-no-callback-terminalization", { elapsedMs: 59_999 }, /reach ttlMs/u)
    reject("unit-16b-runtime-vault-containment", { manualAuthRequired: true }, /must be false/u)
    reject("unit-16d-whats-up", { responseCount: 0 }, /must equal 1/u)
    reject("unit-16e-containment-audit", { fabricatedHandlerInvocationCount: 1 }, /must equal 0/u)
    reject("unit-16e-containment-audit", { excludedToolAttemptCount: 6 }, /must equal 7/u)
    reject("unit-16e-containment-audit", { excludedToolRejectedCount: 6 }, /must equal 7/u)
    reject("unit-16e-containment-audit", { excludedToolInvokedCount: 1 }, /must equal 0/u)
    reject("unit-16e-containment-audit", { excludedToolSideEffectCount: 1 }, /must equal 0/u)
    reject("unit-16e-containment-audit", { globallyResolvableExcludedToolCount: 0 }, /globallyResolvable/u)
    reject("unit-16e-containment-audit", { schemaVersion: "wrong" }, /schemaVersion/u)
    reject("unit-16e-containment-audit", { auditRecordCount: 1 }, /safe integer/u)
    reject("unit-16e-containment-audit", { auditLifecyclePairCount: 0 }, /safe integer/u)
    reject("unit-16e-containment-audit", { liveProcessUser: "0:0" }, /identity/u)
    reject("unit-16e-containment-audit", { writableKeyExposure: true }, /must be false/u)
    reject("unit-16e-containment-audit", { networkMode: "bridge" }, /network/u)
    reject("unit-16e-containment-audit", { telegramSchemaDigest: "e".repeat(64) }, /telegramSchemaDigest/u)
    reject("unit-16e-containment-audit", { readScopeDigest: "e".repeat(64) }, /readScopeDigest/u)
    reject("unit-16h-daily-digest", { firedWithinMs: 960_001 }, /16-minute/u)
    expect(() => validateSanctuaryUnit16EvidenceAssertions("unit-16h-daily-digest", {
      ...validAssertions("unit-16h-daily-digest"), firedWithinMs: 0,
    })).not.toThrow()
    reject("unit-16i-delayed-approval", { elapsedMs: 119_999 }, /120 seconds/u)
    reject("unit-16i-delayed-approval", { state: "failed" }, /succeeded/u)
    reject("unit-16j-denial", { state: "succeeded" }, /denied/u)
    reject("unit-16k-timeout-stale", { state: "denied" }, /expired/u)
    reject("unit-16m-restart-continuation", { state: "failed" }, /succeeded/u)
    reject("unit-16g-health-transition", { unexpected: true }, /fields/u)
    reject("unit-16g-health-transition", { alertCount: 1 }, /alertCount/u)
  })

  it("fails closed on scenario authority, timing, timeout, state, and checkpoint drift", async () => {
    expect(sanctuaryScenarioTimeoutBudget("unit-16k-timeout-stale")).toBe(875_000)
    expect(sanctuaryScenarioTimeoutBudget("unit-16f-cron-fingerprint")).toBe(1_025_000)

    const config = (dir: string, overrides: Record<string, unknown> = {}) => {
      const harnessPath = path.join(dir, "harness.sh")
      fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
      return {
        allowedRoot: dir,
        schema: "sanctuary-unit-16-matrix-v1",
        adapter: fixedAdapter,
        provenanceAdapter: fixedAdapter,
        harnessPath,
        timeoutMs: 300_000,
        intervalMs: 1,
        ...overrides,
      }
    }
    let dir = root()
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config(dir, { adapter: "/untrusted" }), dependencies())).rejects.toThrow(/fixed packaged/u)
    dir = root()
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config(dir, { timeoutMs: 7_200_001 }), dependencies())).rejects.toThrow(/timing bound/u)
    dir = root()
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(config(dir).harnessPath as string)).digest("hex"))
    let clock = 1_800_000_000_000
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config(dir), dependencies({
      now: () => clock,
      sleep: async () => { clock += 300_000 },
      adapter: async (_executable, rawPayload) => (rawPayload as Record<string, unknown>).operation === "finalize_acceptance_scenarios"
        ? { finalized: true }
        : { state: "waiting", checkpointDigest: "d".repeat(64) },
    }))).rejects.toThrow(/timed out/u)
    dir = root()
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(config(dir).harnessPath as string)).digest("hex"))
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config(dir), dependencies({
      adapter: async () => ({ state: "bogus", checkpointDigest: "d".repeat(64) }),
    }))).rejects.toThrow(/invalid state/u)
    dir = root()
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(config(dir).harnessPath as string)).digest("hex"))
    let call = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config(dir), dependencies({
      adapter: async () => (++call === 1
        ? { state: "waiting", checkpointDigest: "d".repeat(64) }
        : { state: "complete", checkpointDigest: "e".repeat(64), sourceDigests: {}, assertions: validAssertions(completeEvidenceLabels[0]!) }),
    }))).rejects.toThrow(/identity drifted/u)

    dir = root()
    const mismatchConfig = config(dir)
    seedRebootPhaseEvidence(dir, "9".repeat(64))
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", mismatchConfig, dependencies())).rejects.toThrow(/packaged harness/u)

    dir = root()
    const deadlineConfig = config(dir)
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(deadlineConfig.harnessPath as string)).digest("hex"))
    const times = [0, 0, 0, 400_000, 400_000]
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", deadlineConfig, dependencies({
      now: () => times.shift() ?? 400_000,
      adapter: async (_executable, rawPayload) => {
        const payload = rawPayload as Record<string, unknown>
        if (payload.operation === "capture_acceptance_scenario") return { state: "complete", checkpointDigest: "e".repeat(64), sourceDigests: Object.fromEntries((payload.sources as string[]).map((source) => [source, "f".repeat(64)])), assertions: validAssertions(String(payload.label)) }
        if (payload.operation === "finalize_acceptance_scenarios") return { finalized: true }
        return evidenceProvenance
      },
    }))).rejects.toThrow(/remaining deadline/u)

    dir = root()
    const pollTimeoutConfig = config(dir)
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(pollTimeoutConfig.harnessPath as string)).digest("hex"))
    let pollClock = 0
    let scenarioCalls = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", pollTimeoutConfig, dependencies({
      now: () => pollClock,
      adapter: async (_executable, rawPayload) => {
        const payload = rawPayload as Record<string, unknown>
        if (payload.operation === "finalize_acceptance_scenarios") return { finalized: true }
        if (payload.operation === "capture_acceptance_scenario") {
          scenarioCalls += 1
          if (scenarioCalls === 2) pollClock = 400_000
          return { state: "waiting", checkpointDigest: "e".repeat(64) }
        }
        return evidenceProvenance
      },
    }))).rejects.toThrow(/timed out while awaiting/u)
  })

  it("always invokes public scenario cleanup after timeout and adapter error", async () => {
    for (const failure of ["timeout", "adapter"] as const) {
      const dir = root()
      const harnessPath = path.join(dir, "harness.sh")
      fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
      const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
      seedRebootPhaseEvidence(dir, harnessSha256)
      const operations: string[] = []
      let clock = 1_800_000_000_000
      await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
        allowedRoot: dir,
        schema: "sanctuary-unit-16-matrix-v1",
        adapter: fixedAdapter,
        provenanceAdapter: fixedAdapter,
        harnessPath,
        timeoutMs: 300_000,
        intervalMs: 1,
      }, dependencies({
        now: () => clock,
        sleep: async () => { clock += 400_000 },
        adapter: async (_executable, rawPayload) => {
          const payload = rawPayload as Record<string, unknown>
          operations.push(String(payload.operation))
          if (payload.operation === "finalize_acceptance_scenarios") return { finalized: true }
          if (failure === "adapter") throw new Error("capture adapter failed")
          return { state: "waiting", checkpointDigest: "d".repeat(64) }
        },
      }))).rejects.toThrow(failure === "adapter" ? /adapter failed/u : /timed out/u)
      expect(operations.at(-1)).toBe("finalize_acceptance_scenarios")
      expect(fs.existsSync(path.join(dir, `${completeEvidenceLabels[0]}.json`))).toBe(false)
    }
  })

  it("preserves both operation and cleanup diagnostics under one bounded deadline", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "harness.sh")
    fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex"))
    const timeouts: number[] = []
    let thrown: unknown
    try {
      await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
        allowedRoot: dir, schema: "sanctuary-unit-16-matrix-v1", adapter: fixedAdapter,
        provenanceAdapter: fixedAdapter, harnessPath, timeoutMs: 300_000, intervalMs: 1,
      }, dependencies({
        adapter: async (_executable, rawPayload, timeoutMs) => {
          timeouts.push(timeoutMs as number)
          const payload = rawPayload as Record<string, unknown>
          if (payload.operation === "finalize_acceptance_scenarios") throw new Error("private cleanup failed")
          throw new Error("capture operation failed")
        },
      }))
    } catch (error) { thrown = error }
    expect(thrown).toBeInstanceOf(AggregateError)
    expect((thrown as AggregateError).errors).toHaveLength(2)
    expect((thrown as Error).message).toMatch(/capture operation failed.*private cleanup failed/u)
    expect(timeouts).toHaveLength(2)
    expect(timeouts.every((timeout) => Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 300_000)).toBe(true)
  })

  it("preserves unknown thrown diagnostics and rejects a false cleanup attestation", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "harness.sh")
    fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
    seedRebootPhaseEvidence(dir, createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex"))
    const config = { allowedRoot: dir, schema: "sanctuary-unit-16-matrix-v1", adapter: fixedAdapter, provenanceAdapter: fixedAdapter, harnessPath, timeoutMs: 300_000, intervalMs: 1 }
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", config, dependencies({ adapter: async () => Promise.reject("non-error") }))).rejects.toThrow(/unknown operation error.*unknown cleanup error/u)

    const dir0 = root()
    const harnessPath0 = path.join(dir0, "harness.sh")
    fs.writeFileSync(harnessPath0, "harness\n", { mode: 0o700 })
    seedRebootPhaseEvidence(dir0, createHash("sha256").update(fs.readFileSync(harnessPath0)).digest("hex"))
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", { ...config, allowedRoot: dir0, harnessPath: harnessPath0 }, dependencies({ adapter: async (_executable, payload) => {
      if ((payload as Record<string, unknown>).operation === "finalize_acceptance_scenarios") return { finalized: true }
      return Promise.reject(undefined)
    } }))).rejects.toThrow(/capture was not produced/u)

    const dir2 = root()
    const harnessPath2 = path.join(dir2, "harness.sh")
    fs.writeFileSync(harnessPath2, "harness\n", { mode: 0o700 })
    seedRebootPhaseEvidence(dir2, createHash("sha256").update(fs.readFileSync(harnessPath2)).digest("hex"))
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", { ...config, allowedRoot: dir2, harnessPath: harnessPath2 }, dependencies({ adapter: async (_executable, rawPayload) => {
      const payload = rawPayload as Record<string, unknown>
      if (payload.operation === "capture_acceptance_scenario") return { state: "complete", checkpointDigest: "e".repeat(64), sourceDigests: Object.fromEntries((payload.sources as string[]).map((source) => [source, "f".repeat(64)])), assertions: validAssertions(String(payload.label)) }
      if (payload.operation === "capture_evidence_provenance") return evidenceProvenance
      return { finalized: false }
    } }))).rejects.toThrow(/scenario finalization failed/u)
  })

  it("refuses incomplete, duplicate, unsafe, and tampered Unit 16 evidence bundles", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const createEntries = (labels: string[], unsafe = false) => labels.map((label, index) => {
      const file = path.join(dir, `refusal-${index}-${Math.random()}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256, unsafe && index === 0
        ? { neutral: "123456789" }
        : {}))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const config = (name: string, entries: Array<{ label: string; path: string }>) => ({
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries,
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("missing", createEntries(completeEvidenceLabels.slice(1))), dependencies())).rejects.toThrow(/complete Unit 16 evidence matrix/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("duplicate", createEntries([...completeEvidenceLabels, completeEvidenceLabels[0]!])), dependencies())).rejects.toThrow(/complete Unit 16 evidence matrix/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", config("unsafe", createEntries(completeEvidenceLabels, true)), liveProvenanceDependencies())).rejects.toThrow(/raw Telegram identity|sensitive/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", { ...config("nonarray", []), entries: null }, dependencies())).rejects.toThrow(/must be an array/u)

    const bundlePath = path.join(dir, "tampered.json")
    await executeSanctuaryAcceptanceHarness("evidence-bundle-index", { ...config("unused", createEntries(completeEvidenceLabels)), evidencePath: bundlePath }, liveProvenanceDependencies())
    const tampered = evidence(bundlePath)
    ;(tampered.entries as Array<Record<string, unknown>>)[0]!.sha256 = "f".repeat(64)
    fs.writeFileSync(bundlePath, `${JSON.stringify(tampered)}\n`, { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir,
      evidencePath: bundlePath,
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies())).rejects.toThrow(/bundle digest|entry hash/u)
  })

  it("requires exact complete per-label evidence contracts and matching live provenance", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const createEntries = (mutate: (value: Record<string, any>, index: number) => void) => completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `contract-${index}-${Math.random()}.json`)
      const value = completeEvidence(label, harnessSha256) as Record<string, any>
      mutate(value, index)
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const run = (name: string, entries: Array<{ label: string; path: string }>, packagedHarness = harnessPath) => executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries,
      harnessPath: packagedHarness,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      imageDigest: "d".repeat(64),
      containerDigest: "e".repeat(64),
      cursorDigest: "f".repeat(64),
    }, liveProvenanceDependencies())

    for (const [name, mutate] of [
      ["schema", (value: Record<string, any>, index: number) => { if (index === 0) value.schemaVersion = 2 }],
      ["operation", (value: Record<string, any>, index: number) => { if (index === 0) value.operation = completeEvidenceLabels[1] }],
      ["phase", (value: Record<string, any>, index: number) => { if (index === 0) value.phase = "requested" }],
      ["provenance-shape", (value: Record<string, any>, index: number) => { if (index === 0) delete value.provenance.imageDigest }],
      ["image-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.imageDigest = "d".repeat(64) }],
      ["container-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.containerDigest = "e".repeat(64) }],
      ["harness-attestation-drift", (value: Record<string, any>, index: number) => { if (index === 1) value.provenance.harnessSha256 = "f".repeat(64) }],
      ["producer-command", (value: Record<string, any>, index: number) => { if (index === 0) value.producer.command = "operator-authored" }],
      ["capture-digest", (value: Record<string, any>, index: number) => { if (index === 0) value.producer.captureDigest = "f".repeat(64) }],
    ] as const) {
      await expect(run(name, createEntries(mutate))).rejects.toThrow(/contract|fields|provenance|harness|produced|capture digest/u)
    }

    await expect(run("historical-cursor-variation", createEntries((value, index) => {
      if (index === 1) value.provenance.cursorDigest = "f".repeat(64)
    }))).resolves.toBeUndefined()

    await expect(run("fabricated-consensus", createEntries((value) => {
      value.provenance.imageDigest = "d".repeat(64)
      value.provenance.containerDigest = "e".repeat(64)
      value.provenance.cursorDigest = "f".repeat(64)
    }))).rejects.toThrow(/live provenance/u)

    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, "invalid-live-capture.json"),
      entries: createEntries(() => {}),
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies({ ...evidenceProvenance, unexpected: "field" }))).rejects.toThrow(/live provenance/u)
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, "untrusted-provenance-adapter.json"),
      entries: createEntries(() => {}),
      harnessPath,
      provenanceAdapter: "/tmp/untrusted-adapter",
    }, liveProvenanceDependencies())).rejects.toThrow(/packaged Sanctuary acceptance adapter/u)

    const changedHarness = path.join(dir, "changed-harness.js")
    fs.writeFileSync(changedHarness, "different packaged bytes\n", { mode: 0o700 })
    await expect(run("changed-harness", createEntries(() => {}), changedHarness)).rejects.toThrow(/harness/u)

    await expect(run("relative-harness", createEntries(() => {}), "relative-harness.js")).rejects.toThrow(/absolute/u)
    const writableHarness = path.join(dir, "writable-harness.js")
    fs.writeFileSync(writableHarness, "writable\n", { mode: 0o722 })
    fs.chmodSync(writableHarness, 0o722)
    await expect(run("writable-harness", createEntries(() => {}), writableHarness)).rejects.toThrow(/writable/u)
    const directoryHarness = path.join(dir, "directory-harness")
    fs.mkdirSync(directoryHarness, { mode: 0o700 })
    await expect(run("directory-harness", createEntries(() => {}), directoryHarness)).rejects.toThrow(/regular file/u)
    const harnessAlias = harnessPath.startsWith("/private/") ? harnessPath.slice("/private".length) : harnessPath
    if (harnessAlias !== harnessPath) {
      await expect(run("alias-harness", createEntries(() => {}), harnessAlias)).rejects.toThrow(/canonical/u)
    }
  })

  it("redacts neutral-key Telegram IDs without rejecting counters or timestamps", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const entries = (extra: Record<string, unknown>) => completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `redaction-${index}-${Math.random()}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256, index === 0 ? extra : {}))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const run = (name: string, extra: Record<string, unknown>) => executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir,
      evidencePath: path.join(dir, `${name}.json`),
      entries: entries(extra),
      harnessPath,
      provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies())

    await expect(run("numeric-string", { neutral: "8541786263" })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("numeric-value", { neutral: 8541786263 })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("sensitive-key", { nested: [{ telegramUserId: "opaque-looking" }] })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("token-shape", { nested: ["12345:abcdefghijklmnopqrstuvwxyz"] })).rejects.toThrow(/sensitive material/u)
    for (const [name, extra] of [
      ["status-smuggling", { status: 8541786263 }],
      ["code-smuggling", { resultCode: 8541786263 }],
      ["count-smuggling", { retryCount: 8541786263 }],
      ["false-timestamp", { capturedAt: 8541786263 }],
    ] as const) await expect(run(name, extra)).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("counter-string-smuggling", { evidenceCounters: { processed: "8541786263" } })).rejects.toThrow(/raw Telegram identity/u)
    await expect(run("extra-operational-fields", {
      capturedAt: 1_800_000_000_000,
      evidenceCounters: { arbitrary: 8541786263, retries: 123_456 },
      nested: { completedAt: "2026-08-20T12:34:56.789Z", events: [] },
    })).rejects.toThrow(/fields/u)
  })

  it("revalidates evidence contracts, continuity, and packaged bytes from the sealed bundle", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "packaged-harness.js")
    fs.writeFileSync(harnessPath, "packaged acceptance harness bytes\n", { mode: 0o700 })
    const harnessSha256 = createHash("sha256").update(fs.readFileSync(harnessPath)).digest("hex")
    const entries = completeEvidenceLabels.map((label, index) => {
      const file = path.join(dir, `verify-source-${index}.json`)
      fs.writeFileSync(file, `${JSON.stringify(completeEvidence(label, harnessSha256))}\n`, { mode: 0o600 })
      return { label, path: file }
    })
    const originalPath = path.join(dir, "original-bundle.json")
    await executeSanctuaryAcceptanceHarness("evidence-bundle-index", {
      allowedRoot: dir, evidencePath: originalPath, entries, harnessPath, provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies())
    const original = evidence(originalPath) as Record<string, any>
    const seal = (value: Record<string, any>) => {
      const core = {
        schemaVersion: value.schemaVersion,
        operation: value.operation,
        phase: value.phase,
        imageDigest: value.imageDigest,
        containerDigest: value.containerDigest,
        cursorDigest: value.cursorDigest,
        harnessSha256: value.harnessSha256,
        entries: value.entries,
      }
      value.bundleDigest = sha(core)
    }
    const verifyMutation = async (name: string, mutate: (value: Record<string, any>) => void, pattern: RegExp) => {
      const value = structuredClone(original) as Record<string, any>
      mutate(value)
      seal(value)
      const file = path.join(dir, `verify-${name}.json`)
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`, { mode: 0o600 })
      await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
        allowedRoot: dir, evidencePath: file, harnessPath, provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      }, liveProvenanceDependencies())).rejects.toThrow(pattern)
    }

    await verifyMutation("header", (value) => { value.phase = "requested" }, /header/u)
    await verifyMutation("entries-shape", (value) => { value.entries = null }, /entries/u)
    await verifyMutation("label-set", (value) => { value.entries = value.entries.slice(1) }, /complete Unit 16 evidence matrix/u)
    await verifyMutation("entry-contract", (value) => {
      value.entries[0].evidence.operation = "wrong-operation"
      value.entries[0].sha256 = sha(value.entries[0].evidence)
    }, /evidence contract/u)
    await verifyMutation("entry-provenance", (value) => {
      value.entries[1].evidence.provenance.imageDigest = "f".repeat(64)
      value.entries[1].sha256 = sha(value.entries[1].evidence)
    }, /provenance/u)
    await verifyMutation("continuity", (value) => { value.imageDigest = "f".repeat(64) }, /continuity coordinates/u)

    const digestMismatch = structuredClone(original) as Record<string, any>
    digestMismatch.bundleDigest = "0".repeat(64)
    const digestMismatchPath = path.join(dir, "verify-bundle-digest.json")
    fs.writeFileSync(digestMismatchPath, `${JSON.stringify(digestMismatch)}\n`, { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir, evidencePath: digestMismatchPath, harnessPath, provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies())).rejects.toThrow(/bundle digest/u)

    const changedHarness = path.join(dir, "verify-changed-harness.js")
    fs.writeFileSync(changedHarness, "changed packaged bytes\n", { mode: 0o700 })
    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir, evidencePath: originalPath, harnessPath: changedHarness, provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies())).rejects.toThrow(/harness/u)

    await expect(executeSanctuaryAcceptanceHarness("evidence-bundle-verify", {
      allowedRoot: dir, evidencePath: originalPath, harnessPath, provenanceAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
    }, liveProvenanceDependencies({ ...evidenceProvenance, cursorDigest: "f".repeat(64) }))).rejects.toThrow(/live provenance/u)
  })

  it("preserves a non-timeout Telegram transport failure category", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      allowedRoot: dir,
      evidencePath: path.join(dir, "network-error.json"),
      offsetPath: path.join(dir, "offset.json"),
      expectedBotId: "8541786263",
      expectedUsername: "MendelowCloudButlerBot",
      currentOffset: 0,
      ...telegramBootstrapFields(dir, "network-error"),
    }, dependencies({
      secret: "descriptor-secret",
      fetch: async () => { throw new Error("network unavailable") },
    }))).rejects.toThrow(/network unavailable/u)
  })

  it("packages an exact operator-only adapter contract and config-file invocation", () => {
    const contract = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary-acceptance-contract.json", "utf8")) as Record<string, any>
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-harness.sh", "utf8")
    const adapterWrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-adapter.sh", "utf8")
    expect(contract).toMatchObject({
      schemaVersion: 1,
      harnessExecutable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-harness.sh",
      adapterExecutable: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      adapterTimeoutMs: 240_000,
      telegramTimeoutMs: 10_000,
    })
    expect(Object.keys(contract.commands).sort()).toEqual([
      "callback-inject", "cursor-delta", "cursor-snapshot", "evidence-bundle-index", "evidence-bundle-verify",
      "evidence-snapshot", "reboot-request", "reboot-resume", "telegram-bootstrap", "unraid-key-rotate",
    ])
    expect(contract.adapters).toEqual(expect.objectContaining({
      "callback-inject": expect.objectContaining({ operation: "callback-inject" }),
      "reboot-request": expect.objectContaining({ operation: "reboot-request" }),
      "unraid-key-rotate": expect.objectContaining({ operation: "unraid-key-rotate" }),
      "scenario-capture": expect.objectContaining({ operation: "capture_acceptance_scenario", modelReachable: false }),
      "health-probe-start": expect.objectContaining({ operation: "start_health_probe", modelReachable: false }),
      "health-probe-status": expect.objectContaining({ operation: "health_probe_status", modelReachable: false }),
      "health-probe-recovery": expect.objectContaining({ operation: "recover_health_probe", modelReachable: false }),
    }))
    expect(contract.adapters["health-probe-start"].timeoutMs).toBe(170_000)
    expect(contract.adapters["health-probe-status"].timeoutMs).toBe(170_000)
    expect(contract.adapters["health-probe-recovery"].timeoutMs).toBe(90_000)
    expect(contract.adapters["health-probe-recovery"].timeoutMs).toBeLessThan(contract.adapterTimeoutMs)
    expect(contract.adapters["scenario-capture"].timeoutMs).toBe(210_000)
    expect(contract.scenarioSources).toEqual(expect.objectContaining({
      "telegram-audit": expect.objectContaining({ kind: "fixed-mac-chain", path: expect.stringContaining("telegram-audit-chain.ndjson"), headPath: expect.stringContaining("telegram-audit-chain.head.json") }),
      "container-inspect": expect.objectContaining({ kind: "fixed-host-snapshot", path: "/run/ouro-acceptance/container-inspect.json" }),
      "provider-live-check": expect.objectContaining({ kind: "fixed-runtime-api", operation: "sanctuary-provider-readiness" }),
      "health-probe-receipt": expect.objectContaining({ kind: "fixed-private-json", path: expect.stringContaining("health-probe-receipts") }),
    }))
    expect(contract.configTemplates["evidence-snapshot"]).toMatchObject({
      fixed: { timeoutMs: 5_610_000 },
      timing: {
        execution: "sequential",
        cleanupReservePerScenarioMs: 5_000,
        approvalReconciliationJitterMs: 1_000,
        approvalTerminalEditMaxMs: 30_000,
        timeoutStaleMs: 875_000,
        timeoutStaleBreakdown: {
          promptCreationAdapterMs: 210_000,
          approvalTtlMs: 300_000,
          staleCallbackInjectionMs: 120_000,
          pollIntervalReserveMs: 30_000,
          reconciliationPollAdapterMs: 210_000,
          cleanupReserveMs: 5_000,
        },
        cronLivenessMs: 1_025_000,
        scenarioSumMs: 5_585_000,
        totalMs: 5_610_000,
      },
    })
    expect(contract.configTemplates["reboot-request"].fixed).toMatchObject({
      scenarioTimeoutMs: 125_000,
      scenarioAdapter: contract.adapterExecutable,
      provenanceAdapter: contract.adapterExecutable,
    })
    const runner = fs.readFileSync("deploy/unraid/sanctuary-unit16-run.sh", "utf8")
    expect(runner).toContain("evidence-snapshot) TIME_LIMIT=4950; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;")
    expect(runner).toContain("reboot-resume) TIME_LIMIT=780; NETWORK=host; INPUT=no; BUNDLE_MODE=readonly; BROKER=yes ;;")
    expect(runner).toContain('test "$COMMAND" = evidence-snapshot || test "$COMMAND" = reboot-request || test "$COMMAND" = reboot-resume')
    expect(runner).toContain("assert_health_probe_cleanup")
    expect(runner).toContain('operation: "commit_reboot"')
    expect(runner).not.toMatch(/^\s*\/sbin\/reboot\s*$/mu)
    expect(wrapper).toContain("--config")
    expect(wrapper).toContain("--contract")
    expect(adapterWrapper).toContain("sanctuary-acceptance-adapter.js")
    expect(`${wrapper}\n${adapterWrapper}`).not.toMatch(/token|password|api[_-]?key/iu)

    const stringValues = (value: unknown): string[] => {
      if (typeof value === "string") return [value]
      if (Array.isArray(value)) return value.flatMap(stringValues)
      if (value && typeof value === "object") return Object.values(value).flatMap(stringValues)
      return []
    }
    const secretShapedValue = /(?:\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{12,}|\b\d{6,}:[A-Za-z0-9_-]{20,})/u
    expect(stringValues(contract)).not.toEqual(expect.arrayContaining([
      expect.stringMatching(secretShapedValue),
    ]))
    expect(stringValues({ telegramCredentialField: "8541786263:abcdefghijklmnopqrstuvwxyzABCDE" }))
      .toEqual(expect.arrayContaining([expect.stringMatching(secretShapedValue)]))
  })

  it("applies the raised outer adapter default while still clamping to the remaining deadline", () => {
    expect(resolveSanctuaryAdapterTimeoutMs(undefined, undefined)).toBe(240_000)
    expect(resolveSanctuaryAdapterTimeoutMs(undefined, 150_000)).toBe(150_000)
    expect(resolveSanctuaryAdapterTimeoutMs(210_000, 220_000)).toBe(210_000)
    expect(resolveSanctuaryAdapterTimeoutMs(210_000, 165_001)).toBe(165_001)
  })

  it("hard-times-out packaged adapters and Telegram network requests", async () => {
    const dir = root()
    const sleeper = path.join(dir, "sleeper.sh")
    fs.writeFileSync(sleeper, "#!/bin/sh\nsleep 2\nprintf '{}\\n'\n", { mode: 0o700 })
    const bounded = createSanctuaryAcceptanceHarnessDependencies(3, { adapterTimeoutMs: 25 })
    const started = Date.now()
    await expect(bounded.runAdapter(sleeper, {})).rejects.toThrow(/timed out/u)
    expect(Date.now() - started).toBeLessThan(1_000)

    vi.useFakeTimers()
    try {
      const evidencePath = path.join(dir, "telegram-timeout.json")
      const deps = dependencies({ secret: "descriptor-secret" }) as AcceptanceHarnessDependencies & { telegramTimeoutMs: number }
      deps.telegramTimeoutMs = 25
      deps.fetch = vi.fn(async (_input, init) => new Promise<Response>((_resolve, reject) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        init!.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })
      })) as typeof fetch
      const pending = executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
        allowedRoot: dir,
        evidencePath,
        offsetPath: path.join(dir, "offset.json"),
        expectedBotId: "8541786263",
        expectedUsername: "MendelowCloudButlerBot",
        currentOffset: 0,
        ...telegramBootstrapFields(dir, "timeout"),
      }, deps)
      const assertion = expect(pending).rejects.toThrow(/timed out/u)
      await vi.advanceTimersByTimeAsync(25)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it("uses fixed outgoing argv and requests for the four legacy-key lifecycle operations", async () => {
    const calls: Array<{ executable: string; args: string[] }> = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const keyFiles = [
      { id: "read-id", name: "Butler RO", permissions: readPermissions, roles: [] },
      { id: "write-id", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER" ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] } : permission), roles: [] },
      { id: "legacy-id", name: "Legacy Write", permissions: [{ resource: "API_KEY", actions: ["DELETE_ANY"] }], roles: [] },
      { id: "legacy-read-id", name: "Legacy Read", permissions: readPermissions, roles: [] },
    ]
    const adapterDeps: SanctuaryAcceptanceAdapterDependencies = {
      readKeyFiles: () => keyFiles,
      readDescriptor: () => JSON.stringify({ keyId: "legacy-id", descriptor: "revoked-secret" }),
      execFile: async (executable, args) => {
        calls.push({ executable, args })
        return args.includes("--delete")
          ? { status: 0, stdout: JSON.stringify({ deleted: 1, keys: [{ id: args.includes("Legacy Read") ? "legacy-read-id" : "legacy-id", name: args.at(-3) }] }) }
          : { status: 0, stdout: JSON.stringify({ valid: true, keyId: args.at(-2), capability: args.at(-1) }) }
      },
      fetch: async (input, init) => {
        requests.push({ url: String(input), init })
        return jsonResponse({ errors: [{ message: "Unauthorized" }] }, 401)
      },
    }
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "vault-backed-capability-verify", keyId: "read-id", capability: "read-only",
    }, adapterDeps)).resolves.toEqual({ verified: true, keyId: "read-id", capability: "read-only" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, adapterDeps)).resolves.toEqual({
      keys: [
        { id: "legacy-id", scope: "legacy-write", roles: "none" },
        { id: "legacy-read-id", scope: "read-only", roles: "none" },
        { id: "read-id", scope: "read-only", roles: "none" },
        { id: "write-id", scope: "bounded-write", roles: "none" },
      ],
    })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "legacy-id" }, adapterDeps)).resolves.toEqual({ revoked: true, id: "legacy-id" })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "legacy-read-id" }, adapterDeps)).resolves.toEqual({ revoked: true, id: "legacy-read-id" })
    await expect(executeSanctuaryAcceptanceAdapter({
      operation: "revoked-key-auth-rejection", keyId: "legacy-id", endpoint: "http://127.0.0.1:2378/graphql",
    }, adapterDeps)).resolves.toEqual({ rejected: true, id: "legacy-id", status: 401 })

    expect(calls).toContainEqual({
      executable: "/usr/bin/docker",
      args: ["exec", "-i", "ouro-butler-staging", "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh", "vault-probe", "read-id", "read-only"],
    })
    expect(calls).toContainEqual({
      executable: "/usr/local/sbin/unraid-api",
      args: ["apikey", "--name", "Legacy Write", "--delete", "--json"],
    })
    expect(calls).toContainEqual({
      executable: "/usr/local/sbin/unraid-api",
      args: ["apikey", "--name", "Legacy Read", "--delete", "--json"],
    })
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:2378/graphql",
      init: {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "revoked-secret" },
        body: JSON.stringify({ query: "query AcceptanceAuthProbe { info { os { hostname } } }", variables: {} }),
        signal: expect.any(AbortSignal),
      },
    })

    for (const permissions of [
      [{ resource: "DOCKER", actions: ["EXEC_ANY"] }],
      [{ resource: "DOCKER", actions: ["READ_ANY"], addedAuthority: true }],
    ]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, {
        ...adapterDeps,
        readKeyFiles: () => [{ id: "bad", name: "Bad", permissions, roles: [] }],
      })).rejects.toThrow(/permission/u)
    }

    const unsafeDirectory = path.join(root(), "keys")
    fs.mkdirSync(unsafeDirectory, { mode: 0o700 })
    fs.symlinkSync("missing.json", path.join(unsafeDirectory, "unexpected.json"))
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" },
      createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: unsafeDirectory }))).rejects.toThrow(/unexpected key directory entry/u)
  })

  it("runs the packaged inner vault probe through injected vault and network boundaries", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const refresh = vi.fn(async () => ({
      ok: true as const,
      itemPath: "vault:opaque",
      revision: "opaque",
      updatedAt: "2026-08-20T00:00:00.000Z",
      config: { unraidGraphqlUrl: "http://127.0.0.1:2378/graphql", unraidReadApiKey: "read-descriptor", unraidWriteApiKey: "write-descriptor" },
    }))
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init })
      const body = JSON.parse(String(init?.body)) as { query: string }
      if (body.query.startsWith("mutation") && (init?.headers as Record<string, string>)["x-api-key"] === "read-descriptor") {
        return jsonResponse({ errors: [{ extensions: { code: "FORBIDDEN" } }] })
      }
      if (body.query.startsWith("mutation")) return jsonResponse({ errors: [{ extensions: { code: "NOT_FOUND" } }] })
      return jsonResponse({ data: { info: { os: { hostname: "opaque" } } } })
    }) as typeof fetch
    const readKeyRecords = () => [
      { id: "read-id", name: "Butler RO", permissions: readPermissions, roles: [], key: "read-descriptor" },
      { id: "write-id", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER"
        ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
        : permission), roles: [], key: "write-descriptor" },
    ]
    await expect(executeSanctuaryAcceptanceVaultProbe("read-id", "read-only", { refresh, readKeyRecords, fetch: fetchImpl })).resolves.toEqual({
      valid: true, keyId: "read-id", capability: "read-only", proof: "read-authorized-write-denied",
    })
    await expect(executeSanctuaryAcceptanceVaultProbe("write-id", "bounded-write", { refresh, readKeyRecords, fetch: fetchImpl })).resolves.toEqual({
      valid: true, keyId: "write-id", capability: "bounded-write", proof: "read-authorized-write-reached-not-found",
    })
    expect(requests.map((request) => request.init?.headers)).toEqual([
      { "content-type": "application/json", "x-api-key": "read-descriptor" },
      { "content-type": "application/json", "x-api-key": "read-descriptor" },
      { "content-type": "application/json", "x-api-key": "write-descriptor" },
      { "content-type": "application/json", "x-api-key": "write-descriptor" },
    ])
    expect(requests[0]).toMatchObject({
      url: "http://127.0.0.1:2378/graphql",
      init: { method: "POST", body: JSON.stringify({ query: "query AcceptanceAuthProbe { info { os { hostname } } }", variables: {} }), signal: expect.any(AbortSignal) },
    })
  })

  it("fails closed across packaged adapter filesystem, subprocess, inventory, revoke, and probe errors", async () => {
    const dir = root()
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const valid = { id: "key-id", name: "Butler RO", permissions: readPermissions, roles: [] }
    const deps = (keys: any[] = [valid], overrides: Partial<SanctuaryAcceptanceAdapterDependencies> = {}): SanctuaryAcceptanceAdapterDependencies => ({
      readKeyFiles: () => keys,
      readDescriptor: () => JSON.stringify({ keyId: "key-id", descriptor: "descriptor" }),
      execFile: async () => ({ status: 0, stdout: JSON.stringify({ valid: true, keyId: "key-id", capability: "read-only" }) }),
      fetch: async () => jsonResponse({}, 401),
      ...overrides,
    })
    await expect(executeSanctuaryAcceptanceAdapter(null, deps())).rejects.toThrow(/object/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "" }, deps())).rejects.toThrow(/nonempty/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "unknown" }, deps())).rejects.toThrow(/unknown/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "bad id", capability: "read-only" }, deps())).rejects.toThrow(/keyId/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "key-id", capability: "admin" }, deps())).rejects.toThrow(/capability/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "vault-backed-capability-verify", keyId: "key-id", capability: "read-only" }, deps([], { execFile: async () => ({ status: 0, stdout: "{}" }) }))).rejects.toThrow(/verification failed/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([valid, { ...valid }]))).rejects.toThrow(/duplicate IDs/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([valid, { ...valid, id: "other" }]))).rejects.toThrow(/duplicate names/u)
    for (const permissions of [null, [{ resource: "UNKNOWN", actions: ["READ_ANY"] }], [{ resource: "DOCKER", actions: [] }]]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, permissions }]))).rejects.toThrow(/permission/u)
    }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, roles: [1] }]))).rejects.toThrow(/roles/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "absent" }, deps())).rejects.toThrow(/absent or ambiguous/u)
    for (const stdout of [JSON.stringify({ deleted: 0 }), JSON.stringify({ deleted: 1, keys: [{ id: "other", name: "Butler RO" }] })]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "exact-id-revoke", keyId: "key-id" }, deps([], {
        readKeyFiles: () => [valid], execFile: async () => ({ status: 0, stdout }),
      }))).rejects.toThrow(/revoke/u)
    }
    for (const endpoint of ["ftp://127.0.0.1/graphql", "http://example.com/graphql", "http://127.0.0.1/not-graphql", "http://user@127.0.0.1/graphql", "http://127.0.0.1/graphql?q=1"]) {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint }, deps())).rejects.toThrow(/loopback/u)
    }
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { readDescriptor: () => "{}" }))).rejects.toThrow(/shape/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { readDescriptor: () => JSON.stringify({ keyId: "other", descriptor: "x" }) }))).rejects.toThrow(/ID mismatch/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { fetch: async () => jsonResponse({}, 200) }))).rejects.toThrow(/authentication rejection/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "revoked-key-auth-rejection", keyId: "key-id", endpoint: "http://127.0.0.1/graphql" }, deps([], { fetch: async () => jsonResponse({}, 403) }))).resolves.toMatchObject({ rejected: true, status: 403 })

    const keyDirectory = path.join(dir, "valid-keys")
    fs.mkdirSync(keyDirectory, { mode: 0o700 })
    fs.writeFileSync(path.join(keyDirectory, "key.json"), JSON.stringify({ ...valid, key: "never-returned" }), { mode: 0o600 })
    const descriptorPath = path.join(dir, "descriptor.json")
    fs.writeFileSync(descriptorPath, JSON.stringify({ keyId: "key-id", descriptor: "descriptor" }), { mode: 0o600 })
    const descriptorFd = fs.openSync(descriptorPath, "r")
    const defaults = createSanctuaryAcceptanceAdapterDependencies(descriptorFd, { keyDirectory })
    const timeoutDefaults = createSanctuaryAcceptanceAdapterDependencies(descriptorFd, { keyDirectory, adapterTimeoutMs: 1 })
    createSanctuaryAcceptanceAdapterDependencies()
    try {
      await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, defaults)).resolves.toMatchObject({ keys: [{ id: "key-id" }] })
      expect(JSON.parse(defaults.readDescriptor())).toMatchObject({ keyId: "key-id" })
    } finally { fs.closeSync(descriptorFd) }
    const success = path.join(dir, "adapter-success.sh")
    const failed = path.join(dir, "adapter-failed.sh")
    const sleeping = path.join(dir, "adapter-sleeping.sh")
    fs.writeFileSync(success, "#!/bin/sh\nprintf '{}\\n'\n", { mode: 0o700 })
    fs.writeFileSync(failed, "#!/bin/sh\nexit 1\n", { mode: 0o700 })
    fs.writeFileSync(sleeping, "#!/bin/sh\nsleep 2\n", { mode: 0o700 })
    await expect(defaults.execFile(success, [])).resolves.toMatchObject({ status: 0, stdout: "{}\n" })
    await expect(defaults.execFile(failed, [])).rejects.toThrow(/failed/u)
    await expect(timeoutDefaults.execFile(sleeping, [])).rejects.toThrow(/timed out/u)
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([{ ...valid, roles: ["ADMIN"] }]))).resolves.toMatchObject({ keys: [{ roles: "present" }] })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" }, deps([], { readKeyFiles: () => { throw "opaque" } }))).rejects.toBe("opaque")

    const invalidRolesDirectory = path.join(dir, "invalid-roles")
    fs.mkdirSync(invalidRolesDirectory, { mode: 0o700 })
    fs.writeFileSync(path.join(invalidRolesDirectory, "key.json"), JSON.stringify({ ...valid, roles: [1] }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceAdapter({ operation: "closed-inventory" },
      createSanctuaryAcceptanceAdapterDependencies(3, { keyDirectory: invalidRolesDirectory }))).rejects.toThrow(/roles/u)
  })

  it("fails closed across inner vault-probe readiness and response branches", async () => {
    const ready = { ok: true as const, itemPath: "vault:opaque", revision: "opaque", updatedAt: "2026-08-20T00:00:00.000Z", config: { unraidGraphqlUrl: "http://127.0.0.1/graphql", unraidReadApiKey: "r", unraidWriteApiKey: "w" } }
    const readPermissions = ["ARRAY", "DASHBOARD", "DISK", "DOCKER", "INFO", "LOGS", "NOTIFICATIONS", "SHARE", "VARS"]
      .map((resource) => ({ resource, actions: ["READ_ANY"] }))
    const run = (capability: string, refreshResult: any = ready, response = jsonResponse({ data: {} })) => executeSanctuaryAcceptanceVaultProbe("key", capability, {
      refresh: async () => refreshResult,
      readKeyRecords: () => [
        { id: "key", name: "Butler RO", permissions: readPermissions, roles: [], key: "r" },
        { id: "key", name: "Butler RW", permissions: readPermissions.map((permission) => permission.resource === "DOCKER"
          ? { ...permission, actions: ["READ_ANY", "UPDATE_ANY"] }
          : permission), roles: [], key: "w" },
      ],
      fetch: async () => response,
    })
    await expect(executeSanctuaryAcceptanceVaultProbe("key", "invalid")).rejects.toThrow(/capability/u)
    await expect(run("read-only", { ok: false, reason: "missing", itemPath: "vault:opaque", error: "missing" })).rejects.toThrow(/unavailable/u)
    await expect(run("read-only", { ...ready, config: { ...ready.config, unraidGraphqlUrl: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("read-only", { ...ready, config: { ...ready.config, unraidReadApiKey: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("bounded-write", { ...ready, config: { ...ready.config, unraidWriteApiKey: "" } })).rejects.toThrow(/nonempty/u)
    await expect(run("read-only", ready, jsonResponse({}, 500))).rejects.toThrow(/probe failed/u)
    await expect(run("read-only", ready, jsonResponse({ errors: [{}] }))).rejects.toThrow(/rejected/u)
  })

  it("performs a Telegram identity/nonce/vault/offset transaction without persisting secrets", async () => {
    const dir = root()
    const evidencePath = path.join(dir, "telegram-evidence.json")
    const offsetPath = path.join(dir, "offset.json")
    const adapterCalls: Array<{ executable: string; payload: unknown }> = []
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const token = "123456:top-secret-token"
    const deps = dependencies({
      secret: `${token}\n`,
      adapter: async (executable, payload) => {
        adapterCalls.push({ executable, payload })
        if ((payload as any).operation === "quiesce_telegram_poller") return { activePollers: 0, quiesced: true }
        if ((payload as any).operation === "store_telegram_bootstrap") return { stored: true }
        throw new Error("unexpected adapter")
      },
      fetch: async (input, init) => {
        const url = String(input)
        requests.push({ url, init })
        if (url.endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        return jsonResponse({
          ok: true,
          result: [
            { update_id: 40, message: { message_id: 2, date: 1_800_000_000, from: { id: 111 }, chat: { id: 222, type: "private" }, text: "unrelated" } },
            { update_id: 41, message: { message_id: 3, date: 1_800_000_000, from: { id: 111 }, chat: { id: 222, type: "private" }, text: "0123456789abcdef0123456789abcdef" } },
          ],
        })
      },
    })

    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      evidencePath,
      offsetPath,
      expectedBotId: "8541786263",
      expectedUsername: "MendelowCloudButlerBot",
      currentOffset: 40,
      ...telegramBootstrapFields(dir, "success"),
    }, deps)

    expect(requests).toHaveLength(2)
    expect(requests[0]!.url).toBe(`https://api.telegram.org/bot${token}/getMe`)
    expect(requests[1]!.url).toBe(`https://api.telegram.org/bot${token}/getUpdates`)
    expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({ offset: 40, timeout: 20, allowed_updates: ["message"] })
    expect(adapterCalls).toEqual([
      { executable: fixedAdapter, payload: { operation: "quiesce_telegram_poller", expectedState: "stopped" } },
      { executable: fixedAdapter, payload: { operation: "store_telegram_bootstrap", botToken: token, authorizedUserId: "111", authorizedChatId: "222" } },
    ])
    expect(JSON.parse(fs.readFileSync(offsetPath, "utf8"))).toEqual({ nextUpdateId: 42 })
    expect(fs.statSync(offsetPath).mode & 0o777).toBe(0o600)
    expect(fs.statSync(evidencePath).mode & 0o777).toBe(0o600)
    const rawEvidence = fs.readFileSync(evidencePath, "utf8")
    expect(rawEvidence).not.toContain(token)
    expect(rawEvidence).not.toContain("111")
    expect(rawEvidence).not.toContain("222")
    expect(rawEvidence).not.toContain("0123456789abcdef0123456789abcdef")
    expect(fs.readFileSync(path.join(dir, "success-nonce.txt"), "utf8")).toBe("0123456789abcdef0123456789abcdef")
    expect(evidence(evidencePath)).toMatchObject({ operation: "telegram-bootstrap", phase: "complete", offsetDigest: sha(42) })
  })

  it("long-polls for a delayed nonce and times out without storing coordinates", async () => {
    const delayedRoot = root()
    let updatePolls = 0
    const operations: string[] = []
    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      allowedRoot: delayedRoot,
      evidencePath: path.join(delayedRoot, "evidence.json"),
      offsetPath: path.join(delayedRoot, "offset.json"),
      expectedBotId: "8541786263",
      expectedUsername: "MendelowCloudButlerBot",
      currentOffset: 5,
      ...telegramBootstrapFields(delayedRoot, "delayed"),
    }, dependencies({
      secret: "rotated-candidate-token",
      adapter: async (_executable, payload) => {
        operations.push((payload as any).operation)
        return (payload as any).operation === "quiesce_telegram_poller"
          ? { activePollers: 0, quiesced: true }
          : { stored: true }
      },
      fetch: async (request) => {
        if (String(request).endsWith("/getMe")) return jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        updatePolls += 1
        return jsonResponse({ ok: true, result: updatePolls === 1 ? [] : [{
          update_id: 8,
          message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 9 }, chat: { id: 10, type: "private" } },
        }] })
      },
    }))
    expect(updatePolls).toBe(2)
    expect(operations).toEqual(["quiesce_telegram_poller", "store_telegram_bootstrap"])

    const timeoutRoot = root()
    let clock = 1_800_000_000_000
    const timeoutOperations: string[] = []
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      allowedRoot: timeoutRoot,
      evidencePath: path.join(timeoutRoot, "evidence.json"),
      offsetPath: path.join(timeoutRoot, "offset.json"),
      expectedBotId: "8541786263",
      expectedUsername: "MendelowCloudButlerBot",
      currentOffset: 0,
      ...telegramBootstrapFields(timeoutRoot, "deadline"),
    }, dependencies({
      secret: "rotated-candidate-token",
      now: () => { clock += 100_000; return clock },
      adapter: async (_executable, payload) => {
        timeoutOperations.push((payload as any).operation)
        return { activePollers: 0, quiesced: true }
      },
      fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [] }),
    }))).rejects.toThrow(/confirmation timed out/u)
    expect(timeoutOperations).toEqual(["quiesce_telegram_poller"])
    expect(fs.existsSync(path.join(timeoutRoot, "offset.json"))).toBe(false)
  })

  it("fails Telegram bootstrap before mutation on identity, nonce, or checkpoint ambiguity", async () => {
    const cases = [
      { label: "identity", getMe: { id: 7, username: "wrong" }, updates: [] },
      { label: "nonce", getMe: { id: 8541786263, username: "MendelowCloudButlerBot" }, updates: [] },
      { label: "duplicate", getMe: { id: 8541786263, username: "MendelowCloudButlerBot" }, updates: [41, 42].map((update_id) => ({ update_id, message: { message_id: update_id, date: 1_800_000_000, from: { id: 1 }, chat: { id: 2, type: "private" }, text: "0123456789abcdef0123456789abcdef" } })) },
    ]
    for (const testCase of cases) {
      const dir = root()
      const mutations: string[] = []
      let clock = 1_800_000_000_000
      const deps = dependencies({
        secret: "token",
        adapter: async (_executable, payload) => {
          mutations.push((payload as any).operation)
          return { activePollers: 0, quiesced: true }
        },
        fetch: async (request) => String(request).endsWith("/getMe")
          ? jsonResponse({ ok: true, result: testCase.getMe })
          : jsonResponse({ ok: true, result: testCase.updates }),
        now: () => { clock += 60_000; return clock },
      })
      await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
        evidencePath: path.join(dir, "evidence.json"), offsetPath: path.join(dir, "offset.json"),
        expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
        ...telegramBootstrapFields(dir, testCase.label),
      }, deps), testCase.label).rejects.toThrow()
      expect(mutations).not.toContain("store_telegram_bootstrap")
      expect(fs.existsSync(path.join(dir, "offset.json"))).toBe(false)
    }

    const dir = root()
    fs.writeFileSync(path.join(dir, "evidence.json"), "{}\n", { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      evidencePath: path.join(dir, "evidence.json"), offsetPath: path.join(dir, "offset.json"),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
      ...telegramBootstrapFields(dir, "checkpoint"),
    }, dependencies({ secret: "token" }))).rejects.toThrow(/inspect-before-retry/u)
  })

  it("captures selected cursor snapshots and computes a redacted delta", async () => {
    const dir = root()
    const before = path.join(dir, "before.json")
    const after = path.join(dir, "after.json")
    const delta = path.join(dir, "delta.json")
    let offset = 10
    const deps = dependencies({ adapter: async (executable, payload) => {
      expect(executable).toBe("/safe/snapshot")
      expect(payload).toEqual({ operation: "snapshot", schema: "telegram-cursor-v1" })
      return { offsetDigest: createHash("sha256").update(String(offset)).digest("hex"), auditCursorDigest: createHash("sha256").update(String(offset + 5)).digest("hex"), ignoredToken: "must-not-persist" }
    } })
    const config = { adapters: [{ schema: "telegram-cursor-v1", executable: "/safe/snapshot" }] }
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: before, ...config }, deps)
    offset = 11
    await executeSanctuaryAcceptanceHarness("cursor-snapshot", { evidencePath: after, ...config }, deps)
    await executeSanctuaryAcceptanceHarness("cursor-delta", { evidencePath: delta, beforePath: before, afterPath: after }, deps)
    expect(evidence(before)).toMatchObject({ operation: "cursor-snapshot", values: { "telegram-cursor-v1.offsetDigest": createHash("sha256").update("10").digest("hex"), "telegram-cursor-v1.auditCursorDigest": createHash("sha256").update("15").digest("hex") } })
    expect(evidence(delta)).toMatchObject({ operation: "cursor-delta", changes: { "telegram-cursor-v1.offsetDigest": expect.any(Object), "telegram-cursor-v1.auditCursorDigest": expect.any(Object) } })
    expect(fs.readFileSync(before, "utf8")).not.toContain("must-not-persist")
  })

  it("injects one saved callback concurrently and proves one-shot mutation plus replay denial", async () => {
    const dir = root()
    const calls: unknown[] = []
    const update = { update_id: 99, callback_query: { id: "opaque", from: { id: 111 }, data: "a:opaque", message: { message_id: 4, chat: { id: 222 } } } }
    await executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "callback.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({
      secret: JSON.stringify(update),
      adapter: async (executable, payload) => {
        expect(executable).toBe("/safe/inject")
        calls.push(payload)
        return (payload as { operation: string }).operation === "inject_callbacks_concurrently"
          ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
          : { settled: true, claimed: false, mutated: false }
      },
    }))
    expect(calls).toEqual([
      { operation: "inject_callbacks_concurrently", update, concurrency: 2 },
      { operation: "inject_callback_replay", update },
    ])
    const raw = fs.readFileSync(path.join(dir, "callback.json"), "utf8")
    expect(raw).not.toContain("a:opaque")
    expect(evidence(path.join(dir, "callback.json"))).toMatchObject({ phase: "complete", claims: 1, mutations: 1, replayMutated: false })
  })

  it("rejects malformed callback material and unexpected callback totals before claiming success", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "bad.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({ secret: "{}" }))).rejects.toThrow(/callback_query/u)

    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "totals.json"), adapter: "/safe/inject", concurrency: 2,
    }, dependencies({
      secret: JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } }),
      adapter: async () => ({ results: [{ settled: true, claimed: true, mutated: false }, { settled: true, claimed: false, mutated: false }] }),
    }))).rejects.toThrow(/mutation total/u)
    expect(evidence(path.join(dir, "totals.json"))).toMatchObject({ phase: "failed" })
  })

  it("creates exact Unraid keys once, stores them through stdin adapters, and revokes/probes old secrets", async () => {
    const dir = root()
    const calls: Array<{ executable: string; payload: any }> = []
    const permissions = ["ARRAY:READ_ANY", "DOCKER:READ_ANY"]
    let inventoryCount = 0
    await executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "keys.json"), targetServerId: "sanctuary-unraid",
      inventoryAdapter: "/safe/inventory", createAdapter: "/safe/create", storeAdapter: "/safe/store",
      revokeAdapter: "/safe/revoke", probeAdapter: "/safe/probe",
      keys: [
        { name: "Butler RO", vaultField: "unraidReadApiKey", permissions },
        { name: "Butler RW", vaultField: "unraidWriteApiKey", permissions: [...permissions, "DOCKER:UPDATE_ANY"] },
      ],
      oldKeys: [{ id: "legacy-read", secretAdapter: "/safe/old-read" }],
    }, dependencies({ adapter: async (executable, payload: any) => {
      calls.push({ executable, payload })
      if (executable === "/safe/inventory") {
        inventoryCount += 1
        if (inventoryCount === 1) return { keys: [{ id: "legacy-read", name: "Legacy", permissions: permissions, roles: [] }] }
        if (inventoryCount === 2) return { keys: [
          { id: "legacy-read", name: "Legacy", permissions, roles: [] },
          { id: "ro-id", name: "Butler RO", permissions, roles: [] },
          { id: "rw-id", name: "Butler RW", permissions: [...permissions, "DOCKER:UPDATE_ANY"], roles: [] },
        ] }
        return {
          keys: [
            { id: "ro-id", name: "Butler RO", permissions, roles: [] },
            { id: "rw-id", name: "Butler RW", permissions: [...permissions, "DOCKER:UPDATE_ANY"], roles: [] },
          ],
        }
      }
      if (executable === "/safe/create") {
        const isRo = payload.name === "Butler RO"
        return { id: isRo ? "ro-id" : "rw-id", name: payload.name, permissions: payload.permissions, roles: [], key: isRo ? "raw-ro" : "raw-rw" }
      }
      if (executable === "/safe/store") return { stored: true, keyId: payload.keyId }
      if (executable === "/safe/probe") return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
      if (executable === "/safe/old-read") return { key: "raw-old" }
      if (executable === "/safe/revoke") return { revoked: true, id: payload.id }
      throw new Error("unexpected adapter")
    } }))

    expect(calls.find((call) => call.executable === "/safe/create")!.payload).toEqual({
      operation: "create_key", targetServerId: "sanctuary-unraid", name: "Butler RO", permissions,
    })
    expect(calls).toContainEqual({ executable: "/safe/store", payload: { operation: "store_key", targetServerId: "sanctuary-unraid", vaultField: "unraidReadApiKey", keyId: "ro-id", key: "raw-ro" } })
    expect(calls).toContainEqual({ executable: "/safe/revoke", payload: { operation: "revoke_key", targetServerId: "sanctuary-unraid", id: "legacy-read" } })
    expect(calls).toContainEqual({ executable: "/safe/probe", payload: { operation: "probe_revoked_key", targetServerId: "sanctuary-unraid", id: "legacy-read", key: "raw-old" } })
    const raw = fs.readFileSync(path.join(dir, "keys.json"), "utf8")
    for (const secret of ["raw-ro", "raw-rw", "raw-old"]) expect(raw).not.toContain(secret)
    expect(evidence(path.join(dir, "keys.json"))).toMatchObject({ phase: "complete", createdKeyIds: ["ro-id", "rw-id"], revokedKeyIds: ["legacy-read"] })
  })

  it("rotates occupied canonical Unraid names through exact temporary keys and ends with only the canonical pair", async () => {
    const dir = root()
    const readPermissions = ["ARRAY:READ_ANY", "DOCKER:READ_ANY"]
    const writePermissions = [...readPermissions, "DOCKER:UPDATE_ANY"]
    const state = new Map([
      ["old-ro", { id: "old-ro", name: "Butler RO", permissions: readPermissions, roles: [] as string[] }],
      ["old-rw", { id: "old-rw", name: "Butler RW", permissions: writePermissions, roles: [] as string[] }],
    ])
    const operations: Array<{ operation: string; id?: string; name?: string }> = []
    let created = 0
    await executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "canonical-rotation.json"), targetServerId: "sanctuary-unraid",
      inventoryAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      createAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      storeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      revokeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      probeAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh",
      keys: [
        { name: "Butler RO", vaultField: "unraidReadApiKey", permissions: readPermissions },
        { name: "Butler RW", vaultField: "unraidWriteApiKey", permissions: writePermissions },
      ],
      oldKeys: [
        { id: "old-ro", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" },
        { id: "old-rw", secretAdapter: "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh" },
      ],
    }, dependencies({ adapter: async (_executable, rawPayload: any) => {
      operations.push(rawPayload)
      if (rawPayload.operation === "inventory_keys") return { keys: [...state.values()] }
      if (rawPayload.operation === "create_key") {
        if ([...state.values()].some((key) => key.name === rawPayload.name)) throw new Error("name collision")
        const id = `created-${++created}`
        state.set(id, { id, name: rawPayload.name, permissions: rawPayload.permissions, roles: [] })
        return { id, name: rawPayload.name, permissions: rawPayload.permissions, roles: [], key: `unraid-key:${id}` }
      }
      if (rawPayload.operation === "store_key") return { stored: true, keyId: rawPayload.keyId }
      if (rawPayload.operation === "probe_new_key") return { valid: true }
      if (rawPayload.operation === "read_old_key") return { key: `unraid-key:${rawPayload.id}` }
      if (rawPayload.operation === "revoke_key") {
        state.delete(rawPayload.id)
        return { revoked: true, id: rawPayload.id }
      }
      if (rawPayload.operation === "probe_revoked_key") return { valid: false, status: 401 }
      throw new Error(`unexpected ${rawPayload.operation}`)
    } }))

    expect([...state.values()].map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "created-3", name: "Butler RO" },
      { id: "created-4", name: "Butler RW" },
    ])
    const creates = operations.filter((entry) => entry.operation === "create_key")
    expect(creates.slice(0, 2).every((entry) => entry.name?.startsWith("Butler ") && entry.name.includes(" Rotation "))).toBe(true)
    expect(creates.slice(2).map((entry) => entry.name)).toEqual(["Butler RO", "Butler RW"])
    const revokes = operations.filter((entry) => entry.operation === "revoke_key").map((entry) => entry.id)
    expect(revokes).toEqual(["old-ro", "old-rw", "created-1", "created-2"])
    expect(evidence(path.join(dir, "canonical-rotation.json"))).toMatchObject({
      phase: "complete",
      createdKeyIds: ["created-1", "created-2", "created-3", "created-4"],
      revokedKeyIds: ["old-ro", "old-rw", "created-1", "created-2"],
    })
  })

  it.each([
    "create", "store", "new-probe", "temporary-inventory", "revoke", "revoked-status", "old-revoke-inventory", "canonical-inventory", "final-inventory",
  ])("fails closed and checkpoints an occupied canonical rotation %s fault", async (fault) => {
    const dir = root()
    const fixed = "/opt/ouro/deploy/unraid/sanctuary-acceptance-adapter.sh"
    const readPermissions = ["ARRAY:READ_ANY", "DOCKER:READ_ANY"]
    const writePermissions = [...readPermissions, "DOCKER:UPDATE_ANY"]
    const state = new Map([
      ["old-ro", { id: "old-ro", name: "Butler RO", permissions: readPermissions, roles: [] as string[] }],
      ["old-rw", { id: "old-rw", name: "Butler RW", permissions: writePermissions, roles: [] as string[] }],
    ])
    let created = 0
    let inventoryCall = 0
    const evidencePath = path.join(dir, `${fault}.json`)
    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath, targetServerId: "sanctuary-unraid", inventoryAdapter: fixed, createAdapter: fixed, storeAdapter: fixed, revokeAdapter: fixed, probeAdapter: fixed,
      keys: [{ name: "Butler RO", vaultField: "unraidReadApiKey", permissions: readPermissions }, { name: "Butler RW", vaultField: "unraidWriteApiKey", permissions: writePermissions }],
      oldKeys: [{ id: "old-ro", secretAdapter: fixed }, { id: "old-rw", secretAdapter: fixed }],
    }, dependencies({ adapter: async (_executable, rawPayload: any) => {
      if (rawPayload.operation === "inventory_keys") {
        inventoryCall += 1
        if ((fault === "temporary-inventory" && inventoryCall === 2)
          || (fault === "old-revoke-inventory" && inventoryCall === 3)
          || (fault === "canonical-inventory" && inventoryCall === 4)
          || (fault === "final-inventory" && inventoryCall === 5)) return { keys: [] }
        return { keys: [...state.values()] }
      }
      if (rawPayload.operation === "create_key") {
        const id = `created-${++created}`
        if (fault === "create" && created === 1) return { id, name: "wrong", permissions: rawPayload.permissions, roles: [], key: "raw" }
        state.set(id, { id, name: rawPayload.name, permissions: rawPayload.permissions, roles: [] })
        return { id, name: rawPayload.name, permissions: rawPayload.permissions, roles: [], key: `raw-${id}` }
      }
      if (rawPayload.operation === "store_key") return fault === "store" ? { stored: false, keyId: rawPayload.keyId } : { stored: true, keyId: rawPayload.keyId }
      if (rawPayload.operation === "probe_new_key") return { valid: fault !== "new-probe" }
      if (rawPayload.operation === "read_old_key") return { key: `raw-${rawPayload.id}` }
      if (rawPayload.operation === "revoke_key") {
        if (fault === "revoke") return { revoked: false, id: rawPayload.id }
        state.delete(rawPayload.id)
        return { revoked: true, id: rawPayload.id }
      }
      if (rawPayload.operation === "probe_revoked_key") return fault === "revoked-status" ? { valid: false, status: 200 } : { valid: false, status: 403 }
      throw new Error(`unexpected ${rawPayload.operation}`)
    } }))).rejects.toThrow()
    expect(evidence(evidencePath)).toMatchObject({ phase: "failed" })
  })

  it("refuses Unraid mutation before checkpoint on existing labels and leaves a failed checkpoint after adapter error", async () => {
    const dir = root()
    const mutations: string[] = []
    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "exists.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    }, dependencies({ adapter: async (executable) => {
      if (executable !== "/inventory") mutations.push(executable)
      return { keys: [{ id: "already", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
    } }))).rejects.toThrow(/already exists/u)
    expect(mutations).toEqual([])
    expect(fs.existsSync(path.join(dir, "exists.json"))).toBe(false)

    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      evidencePath: path.join(dir, "failed.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return { keys: [] }
      throw new Error("adapter failed")
    } }))).rejects.toThrow(/adapter failed/u)
    expect(evidence(path.join(dir, "failed.json"))).toMatchObject({ phase: "failed" })
  })

  it("records generic health evidence by digest and only selected safe values", async () => {
    const dir = root()
    const file = path.join(dir, "health.json")
    await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      evidencePath: file, schema: "postboot-health-v1", adapter: "/safe/health",
    }, dependencies({ adapter: async (_executable, payload) => {
      expect(payload).toEqual({ operation: "evidence_snapshot", schema: "postboot-health-v1" })
      return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64), apiToken: "secret" }
    } }))
    const saved = evidence(file)
    expect(saved).toMatchObject({ operation: "evidence-snapshot", schema: "postboot-health-v1", values: { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } })
    expect(saved).not.toHaveProperty("payloadDigest")
    expect(fs.readFileSync(file, "utf8")).not.toContain('"secret"')
  })

  it("checkpoints one reboot request and resumes only that request until the exact target is ready", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    const calls: Array<{ executable: string; payload: unknown }> = []
    let poll = 0
    const deps = dependencies({
      adapter: async (executable, payload) => {
        calls.push({ executable, payload })
        if (executable === "/safe/reboot") return { accepted: true, targetId: "sanctuary", requestId: "request-1", reservationId: "a".repeat(64), prebootId: "boot-1" }
        poll += 1
        return poll === 1
          ? { state: "booting", targetId: "sanctuary", requestId: "request-1" }
          : { state: "ready", targetId: "sanctuary", requestId: "request-1", bootId: "boot-2" }
      },
      now: (() => { let value = 1000; return () => value += 10 })(),
    })
    await executeSanctuaryAcceptanceHarness("reboot-request", {
      evidencePath: file, targetId: "sanctuary", adapter: "/safe/reboot",
    }, deps)
    const requested = evidence(file)
    expect(requested).toMatchObject({ phase: "requested", targetId: "sanctuary", requestId: "request-1", processBindingDigest: "f".repeat(64), prebootDigest: sha("boot-1") })
    expect(calls.find((call) => call.executable === "/safe/reboot" && (call.payload as Record<string, unknown>).operation === "request_reboot")?.payload).toMatchObject({ processBindingDigest: "f".repeat(64) })
    await executeSanctuaryAcceptanceHarness("reboot-resume", {
      evidencePath: file, adapter: "/safe/poll", timeoutMs: 100, intervalMs: 1,
    }, deps)
    expect(calls.filter((call) => call.executable === "/safe/reboot")).toHaveLength(1)
    expect(calls.filter((call) => call.executable === "/safe/poll")[0]!.payload).toEqual({ operation: "poll_reboot", targetId: "sanctuary", requestId: "request-1" })
    expect(evidence(file)).toMatchObject({ phase: "complete", targetId: "sanctuary", requestId: "request-1", postbootDigest: sha("boot-2") })
  })

  it("captures truthful preflight, requested, and postboot phases in order with per-phase cleanup", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    const harnessPath = path.join(dir, "harness.sh")
    fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
    const order: string[] = []
    const requestId = "d".repeat(64)
    const scenarioConfig = {
      allowedRoot: dir,
      evidencePath: file,
      adapter: fixedAdapter,
      scenarioAdapter: fixedAdapter,
      provenanceAdapter: fixedAdapter,
      harnessPath,
      scenarioTimeoutMs: 30_000,
      scenarioIntervalMs: 1,
    }
    const deps = dependencies({
      adapter: async (_executable, rawPayload) => {
        const payload = rawPayload as Record<string, unknown>
        if (payload.operation === "capture_evidence_provenance") return evidenceProvenance
        if (payload.operation === "finalize_acceptance_scenarios") { order.push("cleanup"); return { finalized: true } }
        if (payload.operation === "capture_acceptance_scenario") {
          const label = String(payload.label)
          order.push(`capture:${label}:${String(evidence(file).phase)}`)
          return {
            state: "complete",
            checkpointDigest: "e".repeat(64),
            sourceDigests: Object.fromEntries((payload.sources as string[]).map((source) => [source, "f".repeat(64)])),
            assertions: validAssertions(label),
          }
        }
        if (payload.operation === "request_reboot") {
          order.push("request")
          return { accepted: true, targetId: "sanctuary", requestId, reservationId: "a".repeat(64), prebootId: "boot-before" }
        }
        if (payload.operation === "poll_reboot") {
          order.push("reconnect")
          return { state: "ready", targetId: "sanctuary", requestId, bootId: "boot-after" }
        }
        throw new Error("unexpected adapter operation")
      },
    })

    await executeSanctuaryAcceptanceHarness("reboot-request", { ...scenarioConfig, targetId: "sanctuary" }, deps)
    await executeSanctuaryAcceptanceHarness("reboot-resume", { ...scenarioConfig, timeoutMs: 100, intervalMs: 1 }, deps)

    expect(order).toEqual([
      "capture:unit-16a-pre-reboot-checkpoint:preflight", "cleanup",
      "request",
      "capture:unit-16a-reboot-request:requested", "cleanup",
      "reconnect",
      "capture:unit-16a-boot-recovery-milestones:complete", "cleanup",
    ])
    for (const label of ["unit-16a-pre-reboot-checkpoint", "unit-16a-reboot-request", "unit-16a-boot-recovery-milestones"]) {
      expect(evidence(path.join(dir, `${label}.json`))).toMatchObject({ operation: label, phase: "complete" })
    }
  })

  it("rejects reboot scenario adapter and timing drift before scenario dispatch", async () => {
    const dir = root()
    const harnessPath = path.join(dir, "harness.sh")
    fs.writeFileSync(harnessPath, "harness\n", { mode: 0o700 })
    const baseline = { targetId: "sanctuary", adapter: fixedAdapter, scenarioAdapter: fixedAdapter, provenanceAdapter: fixedAdapter, harnessPath, scenarioTimeoutMs: 30_000, scenarioIntervalMs: 1 }
    const attempts = [
      { name: "scenario-adapter", config: { ...baseline, scenarioAdapter: "/wrong" }, pattern: /fixed packaged/u },
      { name: "provenance-adapter", config: { ...baseline, provenanceAdapter: "/wrong" }, pattern: /fixed packaged/u },
      { name: "scenario-timeout", config: { ...baseline, scenarioTimeoutMs: sanctuaryScenarioTimeoutBudget("unit-16a-pre-reboot-checkpoint") + 1 }, pattern: /timing bound/u },
      { name: "scenario-interval", config: { ...baseline, scenarioIntervalMs: 60_001 }, pattern: /timing bound/u },
    ]
    for (const attempt of attempts) {
      await expect(executeSanctuaryAcceptanceHarness("reboot-request", { ...attempt.config, evidencePath: path.join(dir, `${attempt.name}.json`) }, dependencies())).rejects.toThrow(attempt.pattern)
    }
  })

  it("refuses duplicate reboot requests and fails resume on target drift or timeout", async () => {
    const dir = root()
    const file = path.join(dir, "reboot.json")
    fs.writeFileSync(file, JSON.stringify({ operation: "reboot", phase: "requested", targetId: "sanctuary", requestId: "r", prebootDigest: sha("before") }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-request", { evidencePath: file, targetId: "sanctuary", adapter: "/reboot" }, dependencies())).rejects.toThrow(/inspect-before-retry/u)
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: file, adapter: "/poll", timeoutMs: 10, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "ready", targetId: "other", requestId: "r", bootId: "b" }),
    }))).rejects.toThrow(/target drift/u)

    let now = 0
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: file, adapter: "/poll", timeoutMs: 5, intervalMs: 1 }, dependencies({
      now: () => now += 3,
      adapter: async () => ({ state: "booting", targetId: "sanctuary", requestId: "r" }),
    }))).rejects.toThrow(/timed out/u)
  })

  it("rejects unsupported snapshot schemas and unknown commands", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      evidencePath: path.join(dir, "bad.json"), schema: "unsupported", adapter: "/adapter",
    }, dependencies())).rejects.toThrow(/unsupported standalone evidence schema/u)
    await expect(executeSanctuaryAcceptanceHarness("nope", {}, dependencies())).rejects.toThrow(/unknown Sanctuary acceptance command/u)
  })

  it("ships an executable descriptor-only wrapper in deploy/unraid", () => {
    const wrapper = fs.readFileSync("deploy/unraid/sanctuary-acceptance-harness.sh", "utf8")
    expect(wrapper).toContain('import("/opt/ouro/dist/heart/daemon/sanctuary-acceptance-harness.js")')
    expect(wrapper).toContain("module.executeSanctuaryAcceptanceHarness")
    expect(wrapper).toContain('3<&3')
    expect(wrapper).not.toMatch(/token|password|api[_-]?key/iu)
  })

  it("runs descriptor-only adapter executables with a minimal environment and redacted failures", async () => {
    const dir = root()
    const success = path.join(dir, "success.sh")
    const invalid = path.join(dir, "invalid.sh")
    const failed = path.join(dir, "failed.sh")
    const oversized = path.join(dir, "oversized.sh")
    fs.writeFileSync(success, "#!/bin/sh\nread payload\nprintf '{\"payload\":%s}' \"$payload\"\n", { mode: 0o700 })
    fs.writeFileSync(invalid, "#!/bin/sh\nprintf nope\n", { mode: 0o700 })
    fs.writeFileSync(failed, "#!/bin/sh\nexit 7\n", { mode: 0o700 })
    fs.writeFileSync(oversized, "#!/bin/sh\nhead -c 1048577 /dev/zero\n", { mode: 0o700 })
    const secretFile = path.join(dir, "descriptor")
    fs.writeFileSync(secretFile, "descriptor-secret")
    const secretFd = fs.openSync(secretFile, "r")
    const deps = createSanctuaryAcceptanceHarnessDependencies(secretFd)
    expect(deps.readSecret()).toBe("descriptor-secret")
    fs.closeSync(secretFd)
    expect(await deps.runAdapter(success, { safe: true })).toEqual({ payload: { safe: true } })
    await expect(deps.runAdapter(invalid, {})).rejects.toThrow(/invalid JSON/u)
    await expect(deps.runAdapter(failed, {})).rejects.toThrow(/adapter failed/u)
    await expect(deps.runAdapter(oversized, {})).rejects.toThrow(/output exceeded/u)
    await expect(deps.runAdapter(path.join(dir, "absent"), {})).rejects.toThrow(/adapter failed/u)
    await expect(deps.runAdapter("relative", {})).rejects.toThrow(/absolute/u)
    expect(typeof deps.fetch).toBe("function")
    expect(Number.isFinite(deps.now())).toBe(true)
    expect(deps.randomBytes(2)).toHaveLength(2)
    await expect(deps.sleep(0)).resolves.toBeUndefined()
    const previousPath = process.env.PATH
    delete process.env.PATH
    try { expect(await createSanctuaryAcceptanceHarnessDependencies().runAdapter(success, { fallback: true })).toEqual({ payload: { fallback: true } }) }
    finally { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath }
  })

  it("fails closed across malformed configs, selectors, Telegram responses, and private checkpoint rules", async () => {
    const dir = root()
    const reject = async (command: string, config: unknown, deps = dependencies(), pattern?: RegExp) => {
      const promise = executeSanctuaryAcceptanceHarness(command, config, deps)
      if (pattern) await expect(promise).rejects.toThrow(pattern)
      else await expect(promise).rejects.toThrow()
    }
    await reject("cursor-snapshot", null, undefined, /object/u)
    await reject("cursor-snapshot", { allowedRoot: dir, evidencePath: "", adapters: [] }, undefined, /nonempty text/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "empty.json"), adapters: [] }, undefined, /nonempty/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "bad-adapter.json"), adapters: [{ schema: "telegram-cursor-v1", executable: "relative" }] }, undefined, /absolute/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "duplicate-schema.json"), adapters: [{ schema: "telegram-cursor-v1", executable: "/x" }, { schema: "telegram-cursor-v1", executable: "/y" }] }, dependencies({ adapter: async () => ({ offsetDigest: "a".repeat(64), auditCursorDigest: "b".repeat(64) }) }), /unique/u)
    await reject("cursor-snapshot", { evidencePath: path.join(dir, "bad-schema.json"), adapters: [{ schema: "postboot-health-v1", executable: "/x" }] }, undefined, /unsupported/u)
    const existingSnapshot = path.join(dir, "existing-snapshot.json")
    fs.writeFileSync(existingSnapshot, "{}\n", { mode: 0o600 })
    let existingEvidenceAdapterCalls = 0
    const existingEvidenceDeps = dependencies({ adapter: async () => { existingEvidenceAdapterCalls += 1; return { ok: true } } })
    await reject("cursor-snapshot", { evidencePath: existingSnapshot, adapters: [{ schema: "telegram-cursor-v1", executable: "/x" }] }, existingEvidenceDeps, /inspect-before-retry/u)
    await reject("evidence-snapshot", { evidencePath: existingSnapshot, schema: "postboot-health-v1", adapter: "/x" }, existingEvidenceDeps, /inspect-before-retry/u)
    expect(existingEvidenceAdapterCalls).toBe(0)
    await reject("evidence-snapshot", { evidencePath: path.join(dir, "invalid-digest.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "raw", telegramOffsetDigest: "b".repeat(64) }) }), /opaque sha256/u)
    await reject("evidence-snapshot", { evidencePath: path.join(dir, "invalid-health.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: "yes", containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }), /boolean/u)
    const publicDir = path.join(dir, "public")
    fs.mkdirSync(publicDir, { mode: 0o755 })
    await reject("evidence-snapshot", { allowedRoot: publicDir, evidencePath: path.join(publicDir, "evidence.json"), schema: "postboot-health-v1", adapter: "/x" }, dependencies(), /allowed root must be private/u)
    const privateFile = path.join(dir, "not-private.json")
    fs.writeFileSync(privateFile, JSON.stringify({ values: {} }), { mode: 0o644 })
    await reject("cursor-delta", { evidencePath: path.join(dir, "delta-private.json"), beforePath: privateFile, afterPath: privateFile }, undefined, /owned private file/u)
    const longPath = path.join(dir, "x".repeat(300))
    await reject("evidence-snapshot", { evidencePath: longPath, schema: "postboot-health-v1", adapter: "/x" }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }))

    const telegramConfig = (name: string) => ({
      evidencePath: path.join(dir, `${name}.json`), offsetPath: path.join(dir, `${name}-offset.json`),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 0,
      ...telegramBootstrapFields(dir, name),
    })
    await reject("telegram-bootstrap", { ...telegramConfig("wrong-poller"), pollerAdapter: "/wrong" }, dependencies(), /fixed packaged/u)
    await reject("telegram-bootstrap", { ...telegramConfig("wrong-vault"), vaultAdapter: "/wrong" }, dependencies(), /fixed packaged/u)
    await reject("telegram-bootstrap", { ...telegramConfig("long-deadline"), deadlineMs: 900_001 }, dependencies(), /15 minutes/u)
    await reject("telegram-bootstrap", { ...telegramConfig("long-poll"), pollTimeoutSeconds: 51 }, dependencies(), /50 seconds/u)
    await reject("telegram-bootstrap", telegramConfig("empty-token"), dependencies({ secret: "" }), /empty/u)
    await reject("telegram-bootstrap", telegramConfig("bad-json"), dependencies({ secret: "t", fetch: async () => new Response("nope") }), /invalid JSON/u)
    await reject("telegram-bootstrap", telegramConfig("api-fail"), dependencies({ secret: "t", fetch: async () => jsonResponse({ ok: false }, 401) }), /request failed/u)
    await reject("telegram-bootstrap", telegramConfig("poller-fail"), dependencies({
      secret: "t", fetch: async () => jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }),
      adapter: async () => ({ activePollers: 1, quiesced: false }),
    }), /competing poller/u)
    await reject("telegram-bootstrap", telegramConfig("updates-shape"), dependencies({
      secret: "t", fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: {} }),
      adapter: async () => ({ activePollers: 0, quiesced: true }),
    }), /must be an array/u)
    await reject("telegram-bootstrap", telegramConfig("ambiguous-update"), dependencies({
      secret: "t", fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [1, 2].map((update_id) => ({ update_id, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: update_id }, chat: { id: update_id, type: "private" } } })) }),
      adapter: async () => ({ activePollers: 0, quiesced: true }),
    }), /ambiguous/u)
    const nonceRace = telegramConfig("nonce-race")
    await reject("telegram-bootstrap", nonceRace, dependencies({
      secret: "t", fetch: async (request) => {
        if (String(request).endsWith("/getMe")) {
          fs.writeFileSync(nonceRace.noncePath, "racer", { flag: "wx" })
          return jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        }
        return jsonResponse({ ok: true, result: [] })
      },
      adapter: async () => ({ activePollers: 0, quiesced: true }),
    }), /private text claim failed/u)
    let invalidShapeClock = 1_800_000_000_000
    await reject("telegram-bootstrap", telegramConfig("invalid-update-shapes"), dependencies({
      secret: "t", fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [{ update_id: 1, message: null }, { update_id: 2, message: { chat: null } }] }),
      adapter: async () => ({ activePollers: 0, quiesced: true }),
      now: () => { invalidShapeClock += 100_000; return invalidShapeClock },
    }), /timed out/u)
    await reject("telegram-bootstrap", telegramConfig("vault-fail"), dependencies({
      secret: "t",
      fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: [{ update_id: 1, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 1 }, chat: { id: 2, type: "private" } } }] }),
      adapter: async (_executable, payload) => (payload as any).operation === "quiesce_telegram_poller"
        ? { activePollers: 0, quiesced: true }
        : { stored: false },
    }), /did not attest/u)
    const offsetDirectory = telegramConfig("offset-cleanup")
    await reject("telegram-bootstrap", offsetDirectory, dependencies({
      secret: "t",
      fetch: async (request) => String(request).endsWith("/getMe") ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } }) : jsonResponse({ ok: true, result: [{ update_id: 1, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 1 }, chat: { id: 2, type: "private" } } }] }),
      adapter: async (_executable, payload) => {
        if ((payload as any).operation === "quiesce_telegram_poller") return { activePollers: 0, quiesced: true }
        fs.mkdirSync(offsetDirectory.offsetPath)
        return { stored: true }
      },
    }))

    const beforeMissing = path.join(dir, "before-missing.json")
    const afterMissing = path.join(dir, "after-missing.json")
    fs.writeFileSync(beforeMissing, JSON.stringify({ values: { beforeOnly: 1, unchanged: null } }), { mode: 0o600 })
    fs.writeFileSync(afterMissing, JSON.stringify({ values: { afterOnly: 2, unchanged: null } }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("cursor-delta", {
      evidencePath: path.join(dir, "missing-delta.json"), beforePath: beforeMissing, afterPath: afterMissing,
    }, dependencies())).rejects.toThrow(/exact complete cursor snapshot/u)
  })

  it("covers callback refusal variants and preserves redacted failed checkpoints", async () => {
    const dir = root()
    const update = JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } })
    const run = async (name: string, response: unknown, overrides: Record<string, unknown> = {}) => executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, `${name}.json`), adapter: "/inject", concurrency: 2, ...overrides,
    }, dependencies({ secret: update, adapter: async (_executable, payload) => (payload as { operation: string }).operation === "inject_callbacks_concurrently"
      ? { results: [response, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: false, mutated: false } }))
    await expect(run("settled", { settled: false, claimed: false, mutated: false })).rejects.toThrow(/did not settle/u)
    await expect(run("claim", { settled: true, claimed: "no", mutated: false })).rejects.toThrow(/claim must be boolean/u)
    await expect(run("mutation", { settled: true, claimed: false, mutated: "no" })).rejects.toThrow(/mutation must be boolean/u)
    await expect(run("claim-total", { settled: true, claimed: false, mutated: false })).rejects.toThrow(/claim total/u)
    await expect(run("mutation-total", { settled: true, claimed: true, mutated: false })).rejects.toThrow(/mutation total/u)
    await expect(run("concurrency", { settled: true, claimed: false, mutated: false }, { concurrency: 17 })).rejects.toThrow(/exceeds/u)
    await expect(run("integer", { settled: true, claimed: false, mutated: false }, { concurrency: "one" })).rejects.toThrow(/safe integer/u)
    await expect(run("minimum", { settled: true, claimed: false, mutated: false }, { concurrency: 1 })).rejects.toThrow(/>= 2/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "json.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: "{" }))).rejects.toThrow(/valid JSON/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "replay-shape.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async (_executable, payload) => (payload as { operation: string }).operation === "inject_callbacks_concurrently"
      ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: false, mutated: undefined } }))).rejects.toThrow(/did not settle canonically/u)
    let call = 0
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "replay-mutated.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => (++call === 1 ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] } : { settled: true, claimed: false, mutated: true }) }))).rejects.toThrow(/replay was claimed or mutated/u)
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: path.join(dir, "batch-count.json"), adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => ({ results: [] }) }))).rejects.toThrow(/result count/u)
    const cleanupPath = path.join(dir, "cleanup.json")
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      evidencePath: cleanupPath, adapter: "/inject", concurrency: 2,
    }, dependencies({ secret: update, adapter: async () => {
      fs.unlinkSync(cleanupPath)
      fs.mkdirSync(cleanupPath)
      return { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
    } }))).rejects.toThrow()
  })

  it("fails every Unraid create/store/probe/revoke/final-inventory mismatch without leaking raw keys", async () => {
    const dir = root()
    const base = (name: string) => ({
      evidencePath: path.join(dir, `${name}.json`), targetServerId: "target", inventoryAdapter: "/inventory",
      createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["DOCKER:READ_ANY"] }], oldKeys: [],
    })
    const run = async (name: string, adapterImpl: (executable: string, payload: any) => Promise<unknown>, config: any = base(name)) => {
      await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", config, dependencies({ adapter: adapterImpl }))).rejects.toThrow()
      if (fs.existsSync(config.evidencePath)) expect(fs.readFileSync(config.evidencePath, "utf8")).not.toContain("raw-secret")
    }
    await run("inventory-shape", async () => ({}))
    await run("roles-shape", async () => ({ keys: [{ id: "x", name: "x", permissions: ["P"], roles: null }] }))
    await run("old-absent", async () => ({ keys: [] }), { ...base("old-absent"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })
    await run("create-scope", async (executable) => executable === "/inventory" ? { keys: [] } : { id: "new", name: "wrong", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" })
    await run("store", async (executable, payload) => executable === "/inventory" ? { keys: [] } : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: false, keyId: payload.keyId } : { valid: true })
    await run("new-probe", async (executable) => executable === "/inventory" ? { keys: [] } : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: true, keyId: "new" } : { valid: false })
    let inventoryCall = 0
    await run("final", async (executable) => executable === "/inventory" ? (++inventoryCall === 1 ? { keys: [] } : { keys: [] }) : executable === "/create" ? { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" } : executable === "/store" ? { stored: true, keyId: "new" } : { valid: true })
    await run("duplicates", async () => ({ keys: [] }), { ...base("duplicates"), keys: [{ name: "x", vaultField: "a", permissions: ["P", "P"] }] })
    await run("duplicate-names", async () => ({ keys: [] }), { ...base("duplicate-names"), keys: [{ name: "x", vaultField: "a", permissions: ["P"] }, { name: "x", vaultField: "b", permissions: ["Q"] }] })
    await run("keys-empty", async () => ({ keys: [] }), { ...base("keys-empty"), keys: [] })
    await run("old-shape", async () => ({ keys: [] }), { ...base("old-shape"), oldKeys: null })
    const existing = base("existing")
    fs.writeFileSync(existing.evidencePath, "{}\n", { mode: 0o600 })
    await run("existing", async () => ({ keys: [] }), existing)

    let phase = 0
    let revokeInventory = 0
    await run("revoke", async (executable, payload) => {
      if (executable === "/inventory") return ++revokeInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/probe") return { valid: true }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: false, id: payload.id }
      return {}
    }, { ...base("revoke"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })
    let probeInventory = 0
    await run("revoked-probe", async (executable) => {
      if (executable === "/inventory") return ++probeInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      phase += 1
      return phase === 1 ? { valid: true } : { valid: true, status: 200 }
    }, { ...base("revoked-probe"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })

    let finalInventory = 0
    await run("old-remains", async (executable, payload) => {
      if (executable === "/inventory") return ++finalInventory === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["P"], roles: [] }] }
        : { keys: [{ id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [] }, { id: "old", name: "Old", permissions: ["P"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["DOCKER:READ_ANY"], roles: [], key: "raw-secret" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "raw-old" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 403 }
    }, { ...base("old-remains"), oldKeys: [{ id: "old", secretAdapter: "/old" }] })

    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      ...base("non-error"), evidencePath: path.join(dir, "non-error.json"),
    }, dependencies({ adapter: async (executable) => executable === "/inventory" ? { keys: [] } : Promise.reject("non-error") }))).rejects.toBe("non-error")
    expect(evidence(path.join(dir, "non-error.json"))).toMatchObject({ errorCategory: "unknown" })
  })

  it("fails reboot request attestations and invalid resume states", async () => {
    const dir = root()
    await expect(executeSanctuaryAcceptanceHarness("reboot-request", {
      evidencePath: path.join(dir, "request.json"), targetId: "sanctuary", adapter: "/reboot",
    }, dependencies({ adapter: async () => ({ accepted: false, targetId: "sanctuary" }) }))).rejects.toThrow(/exact target/u)
    expect(evidence(path.join(dir, "request.json"))).toMatchObject({ phase: "failed" })
    const invalid = path.join(dir, "invalid.json")
    fs.writeFileSync(invalid, JSON.stringify({ operation: "other", phase: "requested" }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: invalid, adapter: "/poll", timeoutMs: 1, intervalMs: 1 }, dependencies())).rejects.toThrow(/not resumable/u)
    const state = path.join(dir, "state.json")
    fs.writeFileSync(state, JSON.stringify({ operation: "reboot", phase: "requested", targetId: "t", requestId: "r", prebootDigest: sha("boot-before") }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: state, adapter: "/poll", timeoutMs: 20, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "wrong", targetId: "t", requestId: "r" }),
    }))).rejects.toThrow(/invalid state/u)
    const complete = path.join(dir, "complete.json")
    fs.writeFileSync(complete, JSON.stringify({ operation: "reboot", phase: "complete", targetId: "t", requestId: "r", prebootDigest: sha("before"), postbootDigest: sha("after") }), { mode: 0o600 })
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { evidencePath: complete }, dependencies())).resolves.toBeUndefined()
  })

  it("persists only opaque Telegram identity and offset evidence", async () => {
    const dir = root()
    const file = path.join(dir, "telegram-opaque.json")
    await executeSanctuaryAcceptanceHarness("telegram-bootstrap", {
      allowedRoot: dir, evidencePath: file, offsetPath: path.join(dir, "offset.json"),
      expectedBotId: "8541786263", expectedUsername: "MendelowCloudButlerBot", currentOffset: 40,
      ...telegramBootstrapFields(dir, "opaque"),
    }, dependencies({
      secret: "token",
      adapter: async (_executable, payload) => (payload as any).operation === "quiesce_telegram_poller"
        ? { activePollers: 0, quiesced: true }
        : { stored: true },
      fetch: async (request) => String(request).endsWith("/getMe")
        ? jsonResponse({ ok: true, result: { id: 8541786263, username: "MendelowCloudButlerBot" } })
        : jsonResponse({ ok: true, result: [{ update_id: 41, message: { date: 1_800_000_000, text: "0123456789abcdef0123456789abcdef", from: { id: 111 }, chat: { id: 222, type: "private" } } }] }),
    }))
    const raw = fs.readFileSync(file, "utf8")
    for (const forbidden of ["8541786263", "MendelowCloudButlerBot", "111", "222", "41", "42", "0123456789abcdef0123456789abcdef"]) expect(raw).not.toContain(forbidden)
    expect(evidence(file)).toMatchObject({ phase: "complete", botIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), offsetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(JSON.parse(fs.readFileSync(path.join(dir, "offset.json"), "utf8"))).toEqual({ nextUpdateId: 42 })
  })

  it("locks callback totals and requires an unclaimed nonmutating replay", async () => {
    const dir = root()
    const update = JSON.stringify({ update_id: 1, callback_query: { id: "x", from: { id: 1 }, data: "x" } })
    let call = 0
    await expect(executeSanctuaryAcceptanceHarness("callback-inject", {
      allowedRoot: dir, evidencePath: path.join(dir, "callback.json"), adapter: "/inject", concurrency: 2,
      expectedClaims: 0, expectedMutations: 0, replay: false,
    }, dependencies({ secret: update, adapter: async () => (++call === 1
      ? { results: [{ settled: true, claimed: true, mutated: true }, { settled: true, claimed: false, mutated: false }] }
      : { settled: true, claimed: true, mutated: false }) }))).rejects.toThrow(/replay/u)
  })

  it("rejects ambiguous Unraid identities and reconciles immediately before exact revoke", async () => {
    const dir = root()
    const base = {
      allowedRoot: dir, evidencePath: path.join(dir, "keys.json"), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "same", permissions: ["READ"] }, { name: "Butler RW", vaultField: "same", permissions: ["READ", "WRITE"] }], oldKeys: [],
    }
    let calls = 0
    await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", base, dependencies({ adapter: async () => { calls += 1; return { keys: [] } } }))).rejects.toThrow(/vault fields.*unique/u)
    expect(calls).toBe(0)

    const operations: string[] = []
    let inventoryCall = 0
    await executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
      ...base, evidencePath: path.join(dir, "reconciled.json"), keys: [{ name: "Butler RO", vaultField: "read", permissions: ["READ"] }], oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable, payload: any) => {
      operations.push(payload.operation)
      if (executable === "/inventory") {
        inventoryCall += 1
        if (inventoryCall === 1) return { keys: [{ id: "old", name: "Legacy", permissions: ["READ"], roles: [] }] }
        if (inventoryCall === 2) return { keys: [{ id: "old", name: "Legacy", permissions: ["READ"], roles: [] }, { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] }] }
        return { keys: [{ id: "new", name: "Butler RO", permissions: ["READ"], roles: [] }] }
      }
      if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["READ"], roles: [], key: "raw" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      if (executable === "/old") return { key: "old-raw" }
      if (executable === "/revoke") return { revoked: true, id: "old" }
      return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
    } }))
    expect(operations.lastIndexOf("inventory_keys")).toBeGreaterThan(operations.indexOf("revoke_key"))
    expect(operations[operations.indexOf("revoke_key") - 2]).toBe("inventory_keys")
  })

  it("rejects any added or changed authority in the final Unraid inventory", async () => {
    const dir = root()
    const base = {
      allowedRoot: dir,
      targetServerId: "target",
      inventoryAdapter: "/inventory",
      createAdapter: "/create",
      storeAdapter: "/store",
      revokeAdapter: "/revoke",
      probeAdapter: "/probe",
      keys: [{ name: "Butler RO", vaultField: "read", permissions: ["READ"] }],
      oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }
    for (const scenario of ["added", "changed"] as const) {
      let inventoryCall = 0
      await expect(executeSanctuaryAcceptanceHarness("unraid-key-rotate", {
        ...base, evidencePath: path.join(dir, `${scenario}.json`),
      }, dependencies({ adapter: async (executable, payload: any) => {
        if (executable === "/inventory") {
          inventoryCall += 1
          if (inventoryCall === 1) return { keys: [
            { id: "old", name: "Legacy", permissions: ["READ"], roles: [] },
            { id: "retained", name: "Retained", permissions: ["READ"], roles: [] },
          ] }
          if (inventoryCall === 2) return { keys: [
            { id: "old", name: "Legacy", permissions: ["READ"], roles: [] },
            { id: "retained", name: "Retained", permissions: ["READ"], roles: [] },
            { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] },
          ] }
          return { keys: [
            { id: "new", name: "Butler RO", permissions: ["READ"], roles: [] },
            scenario === "added"
              ? { id: "rogue", name: "Rogue Admin", permissions: ["WRITE"], roles: ["ADMIN"] }
              : { id: "retained", name: "Retained", permissions: ["WRITE"], roles: [] },
            ...(scenario === "added" ? [{ id: "retained", name: "Retained", permissions: ["READ"], roles: [] }] : []),
          ] }
        }
        if (executable === "/create") return { id: "new", name: "Butler RO", permissions: ["READ"], roles: [], key: "raw" }
        if (executable === "/store") return { stored: true, keyId: "new" }
        if (executable === "/old") return { key: "old-raw" }
        if (executable === "/revoke") return { revoked: true, id: "old" }
        return payload.operation === "probe_new_key" ? { valid: true } : { valid: false, status: 401 }
      } }))).rejects.toThrow(/final Unraid key inventory mismatch/u)
      expect(evidence(path.join(dir, `${scenario}.json`))).toMatchObject({ phase: "failed" })
    }
  })

  it("uses fixed evidence schemas without hashing untrusted adapter responses", async () => {
    const dir = root()
    const file = path.join(dir, "health-fixed.json")
    await executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: file, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64), value: "raw-secret" }) }))
    expect(evidence(file)).toMatchObject({ schema: "postboot-health-v1", values: { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } })
    expect(fs.readFileSync(file, "utf8")).not.toContain("raw-secret")
    expect(evidence(file)).not.toHaveProperty("payloadDigest")
  })

  it("rejects cursor deltas unless both inputs are exact complete cursor snapshots", async () => {
    const dir = root()
    const valid = {
      schemaVersion: 1,
      operation: "cursor-snapshot",
      phase: "complete",
      schema: "telegram-cursor-v1",
      capturedAt: 1_800_000_000_000,
      values: {
        "telegram-cursor-v1.offsetDigest": "a".repeat(64),
        "telegram-cursor-v1.auditCursorDigest": "b".repeat(64),
      },
    }
    const cases: Array<[string, Record<string, unknown>]> = [
      ["raw", { ...valid, values: { token: "raw-secret" } }],
      ["version", { ...valid, schemaVersion: 2 }],
      ["operation", { ...valid, operation: "evidence-snapshot" }],
      ["phase", { ...valid, phase: "failed" }],
      ["schema", { ...valid, schema: "postboot-health-v1" }],
      ["values-shape", { ...valid, values: null }],
      ["extra-key", { ...valid, values: { ...valid.values, extra: "c".repeat(64) } }],
      ["invalid-digest", { ...valid, values: { ...valid.values, "telegram-cursor-v1.offsetDigest": "not-opaque" } }],
    ]
    for (const [name, malformed] of cases) {
      const before = path.join(dir, `${name}-before.json`)
      const after = path.join(dir, `${name}-after.json`)
      const delta = path.join(dir, `${name}-delta.json`)
      fs.writeFileSync(before, JSON.stringify(malformed), { mode: 0o600 })
      fs.writeFileSync(after, JSON.stringify(valid), { mode: 0o600 })
      await expect(executeSanctuaryAcceptanceHarness("cursor-delta", {
        allowedRoot: dir, evidencePath: delta, beforePath: before, afterPath: after,
      }, dependencies())).rejects.toThrow(/cursor snapshot/u)
      expect(fs.existsSync(delta)).toBe(false)
    }
    const exactBefore = path.join(dir, "exact-before.json")
    const exactAfter = path.join(dir, "exact-after.json")
    const exactDelta = path.join(dir, "exact-delta.json")
    fs.writeFileSync(exactBefore, JSON.stringify(valid), { mode: 0o600 })
    fs.writeFileSync(exactAfter, JSON.stringify({
      ...valid,
      values: { ...valid.values, "telegram-cursor-v1.offsetDigest": "c".repeat(64) },
    }), { mode: 0o600 })
    await executeSanctuaryAcceptanceHarness("cursor-delta", {
      allowedRoot: dir, evidencePath: exactDelta, beforePath: exactBefore, afterPath: exactAfter,
    }, dependencies())
    expect(evidence(exactDelta)).toMatchObject({
      changes: { "telegram-cursor-v1.offsetDigest": { before: "a".repeat(64), after: "c".repeat(64) } },
    })
    expect((evidence(exactDelta).changes as Record<string, unknown>)).not.toHaveProperty("telegram-cursor-v1.auditCursorDigest")
  })

  it("atomically grants only one concurrent process an initial checkpoint claim", async () => {
    const dir = root()
    const compiledRoot = path.join(dir, "compiled")
    const harnessPath = path.join(compiledRoot, "heart", "daemon", "sanctuary-acceptance-harness.cjs")
    const nervesPath = path.join(compiledRoot, "nerves", "runtime.js")
    fs.mkdirSync(path.dirname(harnessPath), { recursive: true })
    fs.mkdirSync(path.dirname(nervesPath), { recursive: true })
    const source = fs.readFileSync(path.join(process.cwd(), "src", "heart", "daemon", "sanctuary-acceptance-harness.ts"), "utf8")
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    fs.writeFileSync(harnessPath, compiled)
    fs.writeFileSync(nervesPath, "exports.emitNervesEvent = () => {};\n")
    const evidencePath = path.join(dir, "claim.json")
    const mutationPath = path.join(dir, "mutations.log")
    const runnerPath = path.join(dir, "runner.cjs")
    fs.writeFileSync(runnerPath, String.raw`
const fs = require("node:fs")
const [harnessPath, allowedRoot, evidencePath, mutationPath, marker] = process.argv.slice(2)
const originalExists = fs.existsSync
let exactCalls = 0
fs.existsSync = (candidate) => {
  if (candidate === evidencePath && ++exactCalls === 2) {
    fs.writeFileSync(marker, "ready")
    const peer = marker.endsWith("-a") ? marker.slice(0, -2) + "-b" : marker.slice(0, -2) + "-a"
    const deadline = Date.now() + 5000
    while (!originalExists(peer) && Date.now() < deadline) {}
    if (!originalExists(peer)) process.exit(19)
    return false
  }
  return originalExists(candidate)
}
const { executeSanctuaryAcceptanceHarness } = require(harnessPath)
executeSanctuaryAcceptanceHarness("reboot-request", {
  allowedRoot, evidencePath, targetId: "sanctuary", adapter: "/reboot",
}, {
  readSecret: () => "",
  runAdapter: async (_executable, payload) => {
    if (payload.operation === "reboot_preflight_snapshot") return { arrayReady: true, parityActive: false, moverActive: false, mutationActive: false, safe: true, digest: "e".repeat(64), processBindingDigest: "f".repeat(64) }
    if (payload.operation === "postboot_integrity_snapshot") return { schemaVersion: "sanctuary-postboot-integrity-v1", telegramOffsetDigest: "1".repeat(64), approvalStateDigest: "2".repeat(64), approvalExecutionCount: 0, fingerprintDigest: "3".repeat(64), sweeps: [], deliveries: [], audits: [] }
    fs.appendFileSync(mutationPath, process.pid + "\n")
    return { accepted: true, targetId: "sanctuary", requestId: String(process.pid), reservationId: "a".repeat(64), prebootId: "boot-before", preflightDigest: payload.preflightDigest }
  },
  fetch: globalThis.fetch,
  now: Date.now,
  randomBytes: require("node:crypto").randomBytes,
  sleep: async () => {},
}).then(() => process.exit(0), () => process.exit(17))
`)
    const markerBase = path.join(dir, "barrier")
    const run = (suffix: string) => new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath, harnessPath, dir, evidencePath, mutationPath, `${markerBase}-${suffix}`], { stdio: "ignore" })
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? -1))
    })
    const statuses = await Promise.all([run("a"), run("b")])
    expect(statuses.sort()).toEqual([0, 17])
    expect(fs.readFileSync(mutationPath, "utf8").trim().split("\n")).toHaveLength(1)
    expect(evidence(evidencePath)).toMatchObject({ operation: "reboot", phase: "requested" })
  })

  it("rejects a dangling checkpoint target before invoking an adapter", async () => {
    const dir = root()
    const evidencePath = path.join(dir, "dangling.json")
    fs.symlinkSync(path.join(dir, "missing.json"), evidencePath)
    let adapterCalls = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => { adapterCalls += 1; return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) } } }))).rejects.toThrow(/inspect-before-retry|nonsymlink/u)
    expect(adapterCalls).toBe(0)
    expect(fs.lstatSync(evidencePath).isSymbolicLink()).toBe(true)
  })

  it("confines atomic private checkpoints to an owned nonsymlink allowed root", async () => {
    const dir = root()
    const outside = root()
    let adapterCalls = 0
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: path.join(outside, "escape.json"), schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => { adapterCalls += 1; return { healthy: true, containerImageDigest: "x", telegramOffsetDigest: "y" } } }))).rejects.toThrow(/allowed root/u)
    expect(adapterCalls).toBe(0)
    const link = path.join(dir, "link")
    fs.symlinkSync(outside, link)
    await expect(executeSanctuaryAcceptanceHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: path.join(link, "evidence.json"), schema: "postboot-health-v1", adapter: "/health",
    }, dependencies())).rejects.toThrow(/symlink/u)
  })

  it("requires reboot resume to observe a different opaque boot identity", async () => {
    const dir = root()
    const file = path.join(dir, "reboot-identity.json")
    await executeSanctuaryAcceptanceHarness("reboot-request", { allowedRoot: dir, evidencePath: file, targetId: "sanctuary", adapter: "/reboot" }, dependencies({
      adapter: async () => ({ accepted: true, targetId: "sanctuary", requestId: "r", reservationId: "a".repeat(64), prebootId: "boot-a" }),
    }))
    await expect(executeSanctuaryAcceptanceHarness("reboot-resume", { allowedRoot: dir, evidencePath: file, adapter: "/poll", timeoutMs: 10, intervalMs: 1 }, dependencies({
      adapter: async () => ({ state: "ready", targetId: "sanctuary", requestId: "r", bootId: "boot-a" }),
    }))).rejects.toThrow(/boot identity did not change/u)
    expect(fs.readFileSync(file, "utf8")).not.toContain("boot-a")
  })

  it("covers every path confinement and identity uniqueness refusal branch", async () => {
    const dir = root()
    const snapshot = (evidencePath: string, allowedRoot: string = dir) => executeHarness("evidence-snapshot", {
      allowedRoot, evidencePath, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => ({ healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }) }))

    await expect(snapshot(path.join(dir, "relative-root.json"), "relative")).rejects.toThrow(/allowed root must be absolute/u)
    const getuid = process.getuid!()
    vi.spyOn(process, "getuid").mockReturnValue(getuid + 1)
    await expect(snapshot(path.join(dir, "wrong-owner.json"))).rejects.toThrow(/owned by the harness user/u)
    vi.restoreAllMocks()
    vi.spyOn(process, "getuid").mockReturnValue(undefined as never)
    await expect(snapshot(path.join(dir, "missing-identity.json"))).rejects.toThrow(/operating-system user identity/u)
    vi.restoreAllMocks()
    const rootFile = path.join(dir, "root-file")
    fs.writeFileSync(rootFile, "x", { mode: 0o600 })
    await expect(snapshot(path.join(dir, "root-file-evidence.json"), rootFile)).rejects.toThrow(/nonsymlink directory/u)
    await expect(executeHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: "relative.json", schema: "postboot-health-v1", adapter: "/health",
    }, dependencies())).rejects.toThrow(/evidencePath must be absolute/u)
    const publicAncestor = path.join(dir, "public-ancestor")
    fs.mkdirSync(publicAncestor, { mode: 0o755 })
    await expect(snapshot(path.join(publicAncestor, "evidence.json"))).rejects.toThrow(/owned private directory/u)
    const canonicalAlias = dir.startsWith("/private/") ? dir.slice("/private".length) : dir
    if (canonicalAlias !== dir) await expect(snapshot(path.join(dir, "canonical.json"), canonicalAlias)).rejects.toThrow(/canonical/u)
    if (process.platform === "linux") {
      const canonicalRoot = path.join(dir, "canonical-root")
      fs.mkdirSync(canonicalRoot, { mode: 0o700 })
      const directoryFd = fs.openSync(dir, "r")
      try {
        const procAlias = `/proc/self/fd/${directoryFd}/canonical-root`
        await expect(snapshot(path.join(procAlias, "evidence.json"), procAlias)).rejects.toThrow(/canonical/u)
      } finally {
        fs.closeSync(directoryFd)
      }
    }

    const raced = path.join(dir, "raced.json")
    await expect(executeHarness("evidence-snapshot", {
      allowedRoot: dir, evidencePath: raced, schema: "postboot-health-v1", adapter: "/health",
    }, dependencies({ adapter: async () => {
      fs.writeFileSync(raced, "{}\n", { mode: 0o600 })
      return { healthy: true, containerImageDigest: "a".repeat(64), telegramOffsetDigest: "b".repeat(64) }
    } }))).rejects.toThrow(/inspect-before-retry/u)

    const base = (name: string) => ({
      allowedRoot: dir, evidencePath: path.join(dir, `${name}.json`), targetServerId: "target",
      inventoryAdapter: "/inventory", createAdapter: "/create", storeAdapter: "/store", revokeAdapter: "/revoke", probeAdapter: "/probe",
      keys: [{ name: "New", vaultField: "new", permissions: ["READ"] }], oldKeys: [],
    })
    await expect(executeHarness("unraid-key-rotate", base("inventory-id"), dependencies({ adapter: async () => ({ keys: [
      { id: "same", name: "one", permissions: ["READ"], roles: [] }, { id: "same", name: "two", permissions: ["READ"], roles: [] },
    ] }) }))).rejects.toThrow(/IDs must be unique/u)
    await expect(executeHarness("unraid-key-rotate", base("inventory-name"), dependencies({ adapter: async () => ({ keys: [
      { id: "one", name: "same", permissions: ["READ"], roles: [] }, { id: "two", name: "same", permissions: ["READ"], roles: [] },
    ] }) }))).rejects.toThrow(/names must be unique/u)
    await expect(executeHarness("unraid-key-rotate", { ...base("old-id"), oldKeys: [{ id: "old", secretAdapter: "/old" }, { id: "old", secretAdapter: "/old" }] }, dependencies())).rejects.toThrow(/old key IDs must be unique/u)
    await expect(executeHarness("unraid-key-rotate", {
      ...base("created-reuse"), oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return { keys: [{ id: "old", name: "Old", permissions: ["READ"], roles: [] }] }
      return { id: "old", name: "New", permissions: ["READ"], roles: [], key: "raw" }
    } }))).rejects.toThrow(/preexisting or reused/u)
    let inventoryCalls = 0
    await expect(executeHarness("unraid-key-rotate", {
      ...base("reconcile-drift"), oldKeys: [{ id: "old", secretAdapter: "/old" }],
    }, dependencies({ adapter: async (executable) => {
      if (executable === "/inventory") return ++inventoryCalls === 1
        ? { keys: [{ id: "old", name: "Old", permissions: ["READ"], roles: [] }] }
        : { keys: [{ id: "old", name: "Changed", permissions: ["READ"], roles: [] }, { id: "new", name: "New", permissions: ["READ"], roles: [] }] }
      if (executable === "/create") return { id: "new", name: "New", permissions: ["READ"], roles: [], key: "raw" }
      if (executable === "/store") return { stored: true, keyId: "new" }
      return { valid: true }
    } }))).rejects.toThrow(/changed ambiguously/u)
    await expect(executeHarness("unraid-key-rotate", { ...base("bad-permissions"), keys: [{ name: "New", vaultField: "new", permissions: [1] }] }, dependencies())).rejects.toThrow(/nonempty strings/u)
  })
})
