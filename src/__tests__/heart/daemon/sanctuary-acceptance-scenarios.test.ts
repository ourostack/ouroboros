import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-scenarios-"))
vi.mock("../../../heart/identity", () => ({ getAgentRoot: () => path.join(root, "sanctuary.ouro") }))

import {
  createSanctuaryScenarioCapture,
  deriveSanctuaryScenarioAssertions,
  finalizeSanctuaryScenarioCapture,
  type SanctuaryScenarioFacts,
} from "../../../heart/daemon/sanctuary-acceptance-scenarios"
import { SANCTUARY_UNIT_16_EVIDENCE_LABELS, validateSanctuaryUnit16EvidenceAssertions } from "../../../heart/daemon/sanctuary-acceptance-harness"
import { readSanctuaryAcceptanceMarker } from "../../../heart/daemon/sanctuary-acceptance-marker"

const event = (name: string) => ({ event: name, at: 1, meta: {} })
const turnReceipt = (toolResultDigests: string[] = []) => ({ status: "success" as const, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests, providerTurnCount: 1, toolInvocationCount: toolResultDigests.length, deliveryCount: 1, telegramMessageIdDigests: ["4".repeat(64)], completedAt: 10_000 })
const approval = (state: string) => ({ approvalId: "approval-1", state, toolName: "unraid_restart_container", createdAt: 1_000, expiresAt: 301_000, updatedAt: 302_000, attempted: state === "succeeded", continuationCompleted: true, buttonsRemoved: true, terminalPrompt: true, callbackCount: 0, settledCount: 0, claimCount: state === "succeeded" ? 1 : 0, replayMutationCount: 0, staleAcknowledged: true, argumentDigest: "d".repeat(64), target: "calibre-web" })
const successfulRestart = () => ([
  { state: "attempt_not_started" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 1_000, mutationAcknowledged: false, afterState: null },
  { state: "attempting" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 2_000, mutationAcknowledged: false, afterState: null },
  { state: "succeeded" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 3_000, mutationAcknowledged: true, afterState: "running" },
])
const probeDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const probePhase = (ordinal: number, name: string, trigger: "cron" | "acceptance", fixtureStatus: 200 | 503 | null, opened: number, recovered: number, digestDue: boolean, deliveryKind: "transition" | "digest" | null) => ({
  ordinal, name, trigger, fixtureStatus, opened, recovered, digestDue, deliveryKind,
  sweepReceiptDigest: probeDigest({ ordinal, name }), deliveryReceiptDigest: deliveryKind === null ? null : probeDigest({ ordinal, deliveryKind }),
})
const healthProbe = (label: "unit-16f-cron-fingerprint" | "unit-16g-health-transition" | "unit-16h-daily-digest") => {
  const phases = label === "unit-16f-cron-fingerprint"
    ? [probePhase(1, "cron-unchanged", "cron", null, 0, 0, false, null)]
    : label === "unit-16g-health-transition"
      ? [
          probePhase(1, "live-baseline", "acceptance", null, 0, 0, false, null), probePhase(2, "live-repeat", "acceptance", null, 0, 0, false, null),
          probePhase(3, "fixture-fail", "acceptance", 503, 1, 0, false, "transition"), probePhase(4, "fixture-repeat", "acceptance", 503, 0, 0, false, null),
          probePhase(5, "fixture-recover", "acceptance", 200, 0, 1, false, "transition"), probePhase(6, "fixture-refail", "acceptance", 503, 1, 0, false, "transition"),
        ]
      : [probePhase(1, "digest-first", "acceptance", 503, 0, 0, true, "digest"), probePhase(2, "digest-repeat", "acceptance", 503, 0, 0, false, null)]
  const fixtureSequence = phases.flatMap((phase) => phase.fixtureStatus === null ? [] : [phase.fixtureStatus])
  return {
    label, scenarioHandleDigest: "a".repeat(64), ownerImageDigestBefore: "1".repeat(64), ownerImageDigestAfter: "1".repeat(64), ownerContainerDigestBefore: "2".repeat(64), ownerContainerDigestAfter: "2".repeat(64),
    beforeStateDigest: "3".repeat(64), restoredStateDigest: "3".repeat(64), cronFingerprintBefore: "a".repeat(64), cronFingerprintAfter: "a".repeat(64), cronRegisteredBefore: true, cronRegisteredAfter: true,
    cronDegradedBefore: false, cronDegradedAfter: false, fixtureSequenceDigest: probeDigest(fixtureSequence), clockMode: label === "unit-16h-daily-digest" ? "local-daily-boundary" as const : "ambient" as const,
    effectiveNow: label === "unit-16h-daily-digest" ? "2026-08-20T16:00:00.000Z" : "2026-08-20T15:00:00.000Z", phases,
    privateTurnCount: label === "unit-16f-cron-fingerprint" ? 0 : label === "unit-16g-health-transition" ? 3 : 1,
    providerInvocationCount: label === "unit-16f-cron-fingerprint" ? 0 : label === "unit-16g-health-transition" ? 5 : 2, deliveryCount: phases.filter((phase) => phase.deliveryReceiptDigest !== null).length,
    workspaceAbsent: true, socketAbsent: true, snapshotAbsent: true, realCheckEquivalent: true, productionRestored: true,
  }
}
const base = (): SanctuaryScenarioFacts => ({
  capturedAt: 0,
  sourceValues: Object.fromEntries(["identity-key", "telegram-audit", "telegram-offset", "approval-journal", "approval-checkpoints", "container-inspect", "provider-live-check", "cron-runtime", "health-runtime", "digest-runtime", "health-probe-receipt", "reboot-checkpoint"].map((key) => [key, { key }])),
  events: [], approvals: [],
  restartAttempts: [],
  telegramTurns: [],
  identity: { keyPresent: true, subjectOpaque: true, rawIdentityAbsent: true, liveSubjectObserved: true, inspectedRecordCount: 1, opaqueSubjectCount: 1, mismatchCount: 0, rawLeakCount: 0, surfaceDigest: "a".repeat(64) },
  container: { exactImage: true, running: true, healthy: true, user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false },
  provider: { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false, credentialRevisionsPresent: true, requestSemanticsExact: true, fallbackAttemptCount: 0 },
  cron: { registered: true, fingerprint: "a".repeat(64), receiptDigest: "b".repeat(64), sweepCount: 0 },
  health: { transitionCount: 0, alertCount: 0, productionRestored: true },
  digest: { scheduleObserved: true, messageCount: 0, firedWithinMs: 1_000, productionRestored: true },
  reboot: { phase: "complete", requestDigest: "c".repeat(64), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0, bootIdentityChanged: true, hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
  containment: { auditComplete: true, readOnlyBoundaryHeld: true, sensitiveMaterialObserved: false, stopDenied: true, restartDenied: true, denialAuditCount: 1, denialStateUnchanged: true, denialProbeCompleted: true },
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("Sanctuary live scenario capture", () => {
  it("derives every Unit 16 assertion contract from event, journal, and runtime facts", () => {
    for (const label of SANCTUARY_UNIT_16_EVIDENCE_LABELS) {
      const before = base()
      const after = base()
      if (label === "unit-16a-pre-reboot-checkpoint") after.reboot = { ...after.reboot!, phase: "preflight", requestCount: 0, bootIdentityChanged: false }
      if (label === "unit-16a-reboot-request") after.reboot = { ...after.reboot!, phase: "requested", bootIdentityChanged: false }
      if (label.includes("opaque-identity-live")) after.telegramTurns.push(turnReceipt())
      if (label === "unit-15c-1-no-callback-terminalization") {
        after.approvals = [approval("expired")]
        before.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: createHash("sha256").update(JSON.stringify(after.sourceValues["telegram-offset"])).digest("hex"), inboundEventCount: 0 }
      }
      if (label === "unit-16d-whats-up" || label === "unit-16d-1-space") {
        const resultDigest = "5".repeat(64)
        after.telegramTurns.push(turnReceipt([resultDigest]))
        after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: label === "unit-16d-whats-up" ? "unraid_get_system" : "unraid_get_storage", success: true, resultDigest } })
      }
      if (label === "unit-16d-2-unauthorized") after.events.push({ ...event("telegram.update_dropped"), meta: { scenarioHandleDigest: "a".repeat(64), distinctAccount: true } })
      if (label === "unit-16j-denial") after.approvals = [approval("denied")]
      if (label === "unit-16f-cron-fingerprint" || label === "unit-16g-health-transition" || label === "unit-16h-daily-digest") after.healthProbe = healthProbe(label)
      if (label === "unit-16i-delayed-approval") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart() }
      if (label === "unit-16k-timeout-stale") { after.approvals = [approval("expired")]; after.events.push(event("telegram.update_dropped")) }
      if (label === "unit-16l-duplicate-callback") { after.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2, claimCount: 1 }]; after.restartAttempts = successfulRestart(); after.events.push(event("telegram.callback_settled"), event("telegram.callback_settled"), event("approval.acceptance_transition")) }
      if (label === "unit-16m-restart-continuation") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart(); after.events.push({ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } }) }
      const assertions = deriveSanctuaryScenarioAssertions(label, before, after, 400_000)
      expect(assertions, label).not.toBeNull()
      expect(validateSanctuaryUnit16EvidenceAssertions(label, assertions)).toEqual(assertions)
    }
  })

  it("keeps the opaque handle private while persisting and completing the bound receipt", async () => {
    const receipts = path.join(root, "receipts")
    const gate = path.join(root, "evidence", "current-scenario-gate.json")
    let facts = base()
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => facts })
    const begin = await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"] })
    expect(begin).toEqual({ state: "waiting", checkpointDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
    expect(fs.readFileSync(gate, "utf8")).not.toContain("scenarioHandleDigest")
    expect(await capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"], checkpointDigest: begin.checkpointDigest as string })).toEqual(begin)
    facts = base(); facts.telegramTurns.push(turnReceipt(["5".repeat(64)])); facts.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64) } })
    const complete = await capture({ phase: "poll", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"], checkpointDigest: begin.checkpointDigest as string })
    expect(complete).toMatchObject({ state: "complete", checkpointDigest: begin.checkpointDigest, assertions: { responseCount: 1 }, sourceDigests: { "telegram-audit": expect.stringMatching(/^[0-9a-f]{64}$/u), "telegram-offset": expect.stringMatching(/^[0-9a-f]{64}$/u) } })
    finalizeSanctuaryScenarioCapture(gate)
    expect(fs.existsSync(gate)).toBe(false)
  })

  it("finalizes the exact active private marker, receipt, and public gate", async () => {
    const receipts = path.join(root, "cleanup-receipts")
    const gate = path.join(root, "cleanup-evidence", "current-scenario-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"] })
    const marker = path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")
    expect(fs.readdirSync(receipts)).toHaveLength(1)
    expect(fs.existsSync(marker)).toBe(true)
    expect(fs.existsSync(gate)).toBe(true)

    finalizeSanctuaryScenarioCapture(gate, receipts)

    expect(fs.readdirSync(receipts)).toHaveLength(0)
    expect(fs.existsSync(marker)).toBe(false)
    expect(fs.existsSync(gate)).toBe(false)
  })

  it("quarantines corrupt marker and receipt state before surfacing cleanup failure", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const gate = path.join(root, "corrupt-evidence", "current-scenario-gate.json")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(acceptanceRoot, "active-scenario.json"), "{}\n", { mode: 0o600 })
    fs.writeFileSync(path.join(receipts, "not-a-receipt"), "untrusted\n", { mode: 0o600 })
    fs.mkdirSync(path.dirname(gate), { recursive: true })
    fs.writeFileSync(gate, "{}\n")

    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.readdirSync(receipts)).toEqual([])
    expect(fs.existsSync(gate)).toBe(false)
    const quarantine = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
    expect(quarantine.some((entry) => entry.startsWith("active-scenario-"))).toBe(true)
    expect(quarantine.some((entry) => entry.startsWith("receipts-"))).toBe(true)
  })

  it("atomically quarantines an ambiguous active receipt set without losing evidence", async () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const gate = path.join(root, "ambiguous-evidence", "current-scenario-gate.json")
    const capture = createSanctuaryScenarioCapture({ now: () => 400_000, receiptRoot: receipts, gateStatusPath: gate, readFacts: async () => base() })
    await capture({ phase: "begin", label: "unit-16d-whats-up", externalGate: "authorized-telegram-message", sources: ["telegram-audit", "telegram-offset"] })
    const original = fs.readdirSync(receipts)[0]!
    fs.copyFileSync(path.join(receipts, original), path.join(receipts, `${"f".repeat(64)}.json`))
    fs.chmodSync(path.join(receipts, `${"f".repeat(64)}.json`), 0o600)

    expect(() => finalizeSanctuaryScenarioCapture(gate, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.readdirSync(receipts)).toEqual([])
    const quarantinedReceiptRoot = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
      .find((entry) => entry.startsWith("receipts-"))
    expect(quarantinedReceiptRoot).toBeDefined()
    expect(fs.readdirSync(path.join(acceptanceRoot, "quarantine", quarantinedReceiptRoot!))).toHaveLength(2)
  })

  it("stops receipt inspection at the thirty-third entry and quarantines the complete set", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    for (let index = 0; index < 40; index += 1) fs.writeFileSync(path.join(receipts, `entry-${index}`), "evidence\n", { mode: 0o600 })

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(fs.readdirSync(receipts)).toEqual([])
    const quarantinedReceiptRoot = fs.readdirSync(path.join(acceptanceRoot, "quarantine"))
      .find((entry) => entry.startsWith("receipts-"))
    expect(fs.readdirSync(path.join(acceptanceRoot, "quarantine", quarantinedReceiptRoot!))).toHaveLength(40)
  })

  it("quarantines a symlink receipt root by inode without traversing its target", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const outside = path.join(root, "outside-receipts")
    fs.mkdirSync(acceptanceRoot, { recursive: true, mode: 0o700 })
    fs.mkdirSync(outside, { mode: 0o700 })
    fs.writeFileSync(path.join(outside, "preserved"), "evidence\n", { mode: 0o600 })
    fs.symlinkSync(outside, receipts)

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(fs.lstatSync(receipts).isDirectory()).toBe(true)
    expect(fs.statSync(receipts).mode & 0o777).toBe(0o700)
    expect(fs.readFileSync(path.join(outside, "preserved"), "utf8")).toBe("evidence\n")
    const quarantined = fs.readdirSync(path.join(acceptanceRoot, "quarantine")).find((entry) => entry.startsWith("receipts-"))
    expect(quarantined).toBeDefined()
    expect(fs.lstatSync(path.join(acceptanceRoot, "quarantine", quarantined!)).isSymbolicLink()).toBe(true)
    expect(fs.readlinkSync(path.join(acceptanceRoot, "quarantine", quarantined!))).toBe(outside)
  })

  it("moves a quarantine-root symlink aside without touching its external target", () => {
    const acceptanceRoot = path.join(root, "sanctuary.ouro", "state", "acceptance")
    const receipts = path.join(acceptanceRoot, "receipts")
    const quarantine = path.join(acceptanceRoot, "quarantine")
    const outside = path.join(root, "outside-quarantine")
    fs.mkdirSync(receipts, { recursive: true, mode: 0o700 })
    fs.mkdirSync(outside, { mode: 0o700 })
    fs.writeFileSync(path.join(outside, "preserved"), "external\n", { mode: 0o600 })
    fs.symlinkSync(outside, quarantine)
    fs.writeFileSync(path.join(acceptanceRoot, "active-scenario.json"), "{}\n", { mode: 0o600 })

    expect(() => finalizeSanctuaryScenarioCapture(undefined, receipts)).toThrow("Sanctuary scenario finalization failed")

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
    expect(fs.lstatSync(quarantine).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(outside, "preserved"), "utf8")).toBe("external\n")
    expect(fs.readdirSync(outside)).toEqual(["preserved"])
    const entries = fs.readdirSync(quarantine)
    expect(entries.some((entry) => entry.startsWith("quarantine-rejected-"))).toBe(true)
    expect(entries.some((entry) => entry.startsWith("active-scenario-"))).toBe(true)
  })

  it("keeps quarantine rename durability and inode checks structurally explicit", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/heart/daemon/sanctuary-acceptance-scenarios.ts"), "utf8")
    const helper = source.slice(source.indexOf("function durableQuarantineReceiptRoot"), source.indexOf("export function finalizeSanctuaryScenarioCapture"))
    expect(helper).toContain("fs.constants.O_NOFOLLOW")
    expect(helper).toContain("rootMetadata.ino !== reboundMetadata.ino")
    expect(helper.indexOf("fs.renameSync(receiptRoot, quarantinePath)")).toBeLessThan(helper.indexOf("fs.fsyncSync(rootHandle)"))
    expect(helper.match(/fs\.fsyncSync\(/gu)).toHaveLength(5)
  })

  it("keeps marker quarantine inode binding and durability structurally explicit", () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), "src/heart/daemon/sanctuary-acceptance-marker.ts"), "utf8")
    const helper = source.slice(source.indexOf("export function quarantineSanctuaryAcceptanceMarker"), source.indexOf("export function sanctuaryAcceptanceEventMeta"))
    expect(helper).toContain("fs.constants.O_NOFOLLOW")
    expect(helper).toContain("markerMetadata.ino !== markerPathMetadata.ino")
    expect(helper.indexOf("fs.renameSync(filePath, quarantinePath)")).toBeLessThan(helper.indexOf("fs.fsyncSync(markerHandle)"))
    expect(helper.match(/fs\.fsyncSync\(/gu)?.length).toBeGreaterThanOrEqual(3)
  })

  it("waits instead of self-attesting absent negative and containment facts", () => {
    const before = base()
    const containment = base(); containment.container!.updaterDisabled = false
    expect(deriveSanctuaryScenarioAssertions("unit-16b-runtime-vault-containment", before, containment, 400_000)).toBeNull()
    const unauthorized = base(); unauthorized.events.push(event("telegram.update_dropped"))
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, unauthorized, 400_000)).toBeNull()
    const denial = base(); denial.approvals = [{ ...approval("denied"), replayMutationCount: 1 }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, denial, 400_000)).toBeNull()
    const audit = base(); audit.containment!.sensitiveMaterialObserved = true
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", before, audit, 400_000)).toBeNull()
    const unlinkedMutation = base(); unlinkedMutation.restartAttempts = successfulRestart().map((attempt) => ({ ...attempt, approvalId: "unlinked" }))
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", before, unlinkedMutation, 400_000)).toBeNull()
    const wrongApproval = base(); wrongApproval.approvals = [{ ...approval("denied"), toolName: "ponder", target: null }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, wrongApproval, 400_000)).toBeNull()
    const unobservedProvider = base(); unobservedProvider.provider!.requestSemanticsExact = false
    expect(deriveSanctuaryScenarioAssertions("unit-16c-provider-readiness", before, unobservedProvider, 400_000)).toBeNull()
  })

  it("binds positive turns and approvals to one new scenario record", () => {
    const before = base()
    const decoy = turnReceipt(["6".repeat(64)])
    const after = base()
    after.telegramTurns.push(decoy, turnReceipt(["5".repeat(64)]))
    after.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64) } })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", before, after, 400_000)).toBeNull()

    const overbroad = base()
    overbroad.telegramTurns.push({ ...turnReceipt(["5".repeat(64), "6".repeat(64)]), toolInvocationCount: 2 })
    overbroad.events.push({ ...event("senses.sanctuary_read_receipt"), meta: { toolName: "unraid_get_system", success: true, resultDigest: "5".repeat(64) } })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-whats-up", before, overbroad, 400_000)).toBeNull()

    const ambiguous = base()
    ambiguous.approvals = [approval("denied"), { ...approval("denied"), approvalId: "approval-2" }]
    expect(deriveSanctuaryScenarioAssertions("unit-16j-denial", before, ambiguous, 400_000)).toBeNull()
  })

  it("requires unauthorized traffic to leave every scenario work ledger empty", () => {
    const before = base()
    const after = base()
    after.events.push({ ...event("telegram.update_dropped"), meta: { scenarioHandleDigest: "a".repeat(64), distinctAccount: true } })
    after.telegramTurns.push({ ...turnReceipt(), status: "error", deliveryCount: 0, telegramMessageIdDigests: [], providerTurnCount: 1 })
    expect(deriveSanctuaryScenarioAssertions("unit-16d-2-unauthorized", before, after, 400_000)).toBeNull()
  })

  it("treats lone indeterminate attempts as unsafe across negative approval and containment gates", () => {
    const unsafe = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, approvalId: "unlinked", attemptId: "unlinked-attempt" }
    const noCallbackBefore = base()
    const noCallback = base(); noCallback.approvals = [approval("expired")]; noCallback.restartAttempts = [unsafe]
    noCallbackBefore.sourceValues["no-callback-baseline"] = { approvalId: "approval-1", offsetDigest: probeDigest(noCallback.sourceValues["telegram-offset"]), inboundEventCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-15c-1-no-callback-terminalization", noCallbackBefore, noCallback, 400_000)).toBeNull()

    for (const [label, state] of [["unit-16j-denial", "denied"], ["unit-16k-timeout-stale", "expired"]] as const) {
      const after = base(); after.approvals = [approval(state)]; after.restartAttempts = [unsafe]
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
    const containment = base(); containment.restartAttempts = [unsafe]
    expect(deriveSanctuaryScenarioAssertions("unit-16e-containment-audit", base(), containment, 400_000)).toBeNull()
  })

  it("rejects extra unlinked attempts from every positive approval proof", () => {
    const unsafe = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, approvalId: "unlinked", attemptId: "unlinked-attempt" }
    for (const label of ["unit-16i-delayed-approval", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      const after = base()
      after.approvals = [{ ...approval("succeeded"), ...(label === "unit-16l-duplicate-callback" ? { callbackCount: 2, settledCount: 2, claimCount: 1 } : {}) }]
      after.restartAttempts = [...successfulRestart(), unsafe]
      if (label === "unit-16m-restart-continuation") after.events.push({ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
  })

  it("rejects a second linked indeterminate attempt from every positive exactly-once proof", () => {
    const extra = { ...successfulRestart()[0]!, state: "attempted_or_indeterminate" as const, attemptId: "attempt-2", observedAt: 4_000 }
    for (const label of ["unit-16i-delayed-approval", "unit-16l-duplicate-callback", "unit-16m-restart-continuation"] as const) {
      const after = base()
      after.approvals = [{ ...approval("succeeded"), ...(label === "unit-16l-duplicate-callback" ? { callbackCount: 2, settledCount: 2, claimCount: 1 } : {}) }]
      after.restartAttempts = [...successfulRestart(), extra]
      if (label === "unit-16m-restart-continuation") after.events.push({ ...event("senses.telegram_approved_restart_end"), meta: { approvalId: "approval-1" } })
      expect(deriveSanctuaryScenarioAssertions(label, base(), after, 400_000)).toBeNull()
    }
  })

  it("accepts a daily digest fired exactly at the local boundary", () => {
    const before = base()
    const after = base()
    after.healthProbe = healthProbe("unit-16h-daily-digest")
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, after, 400_000)).toMatchObject({ firedWithinMs: 0 })
  })

  it("derives exact private-turn and delivery counts from observed health-probe metrics", () => {
    const before = base()
    const cron = base(); cron.healthProbe = healthProbe("unit-16f-cron-fingerprint")
    const transitions = base(); transitions.healthProbe = healthProbe("unit-16g-health-transition")
    const digest = base(); digest.healthProbe = healthProbe("unit-16h-daily-digest")
    expect(deriveSanctuaryScenarioAssertions("unit-16f-cron-fingerprint", before, cron, 400_000)).toMatchObject({ providerInvocationCount: 0, messageCount: 0 })
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toEqual({ alertCount: 3, productionRestored: true, transitionObserved: true })
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toMatchObject({ firedWithinMs: 0, messageCount: 1 })
  })

  it("rejects health-probe phase, private-turn, provider-bound, and restoration drift", () => {
    const before = base()
    const cron = base(); cron.healthProbe = { ...healthProbe("unit-16f-cron-fingerprint"), providerInvocationCount: 1 }
    expect(deriveSanctuaryScenarioAssertions("unit-16f-cron-fingerprint", before, cron, 400_000)).toBeNull()

    const transitions = base(); transitions.healthProbe = healthProbe("unit-16g-health-transition")
    transitions.healthProbe.phases[4] = { ...transitions.healthProbe.phases[4]!, recovered: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), privateTurnCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), providerInvocationCount: 2 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()
    transitions.healthProbe = { ...healthProbe("unit-16g-health-transition"), providerInvocationCount: 1_001 }
    expect(deriveSanctuaryScenarioAssertions("unit-16g-health-transition", before, transitions, 400_000)).toBeNull()

    const digest = base(); digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), privateTurnCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
    digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), providerInvocationCount: 0 }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
    digest.healthProbe = { ...healthProbe("unit-16h-daily-digest"), restoredStateDigest: "9".repeat(64) }
    expect(deriveSanctuaryScenarioAssertions("unit-16h-daily-digest", before, digest, 400_000)).toBeNull()
  })

  it.each(["unit-16f-cron-fingerprint", "unit-16g-health-transition", "unit-16h-daily-digest"] as const)("binds %s restoration to the independently observed current cron", (label) => {
    const fingerprintDrift = base(); fingerprintDrift.healthProbe = healthProbe(label); fingerprintDrift.cron!.fingerprint = "9".repeat(64)
    expect(deriveSanctuaryScenarioAssertions(label, base(), fingerprintDrift, 400_000)).toBeNull()
    const registrationDrift = base(); registrationDrift.healthProbe = healthProbe(label); registrationDrift.cron!.registered = false
    expect(deriveSanctuaryScenarioAssertions(label, base(), registrationDrift, 400_000)).toBeNull()
  })
})
