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

const event = (name: string) => ({ event: name, at: 1, meta: {} })
const turnReceipt = (toolResultDigests: string[] = []) => ({ status: "success" as const, updateDigest: "1".repeat(64), sequenceDigest: "2".repeat(64), responseDigest: "3".repeat(64), toolResultDigests, providerTurnCount: 1, toolInvocationCount: toolResultDigests.length, deliveryCount: 1, telegramMessageIdDigests: ["4".repeat(64)], completedAt: 10_000 })
const approval = (state: string) => ({ approvalId: "approval-1", state, toolName: "unraid_restart_container", createdAt: 1_000, expiresAt: 301_000, updatedAt: 302_000, attempted: state === "succeeded", continuationCompleted: true, buttonsRemoved: true, terminalPrompt: true, callbackCount: 0, settledCount: 0, claimCount: state === "succeeded" ? 1 : 0, replayMutationCount: 0, staleAcknowledged: true, argumentDigest: "d".repeat(64), target: "calibre-web" })
const successfulRestart = () => ([
  { state: "attempt_not_started" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 1_000, mutationAcknowledged: false, afterState: null },
  { state: "attempting" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 2_000, mutationAcknowledged: false, afterState: null },
  { state: "succeeded" as const, actionDigest: "e".repeat(64), argumentDigest: "d".repeat(64), target: "calibre-web", approvalId: "approval-1", attemptId: "attempt-1", observedAt: 3_000, mutationAcknowledged: true, afterState: "running" },
])
const base = (): SanctuaryScenarioFacts => ({
  capturedAt: 0,
  sourceValues: Object.fromEntries(["identity-key", "telegram-audit", "telegram-offset", "approval-journal", "approval-checkpoints", "container-inspect", "provider-live-check", "cron-runtime", "health-runtime", "digest-runtime", "reboot-checkpoint"].map((key) => [key, { key }])),
  events: [], approvals: [],
  restartAttempts: [],
  telegramTurns: [],
  identity: { keyPresent: true, subjectOpaque: true, rawIdentityAbsent: true, liveSubjectObserved: true, inspectedRecordCount: 1, opaqueSubjectCount: 1, mismatchCount: 0, rawLeakCount: 0, surfaceDigest: "a".repeat(64) },
  container: { exactImage: true, running: true, healthy: true, user: "10001:10001", readOnlyRoot: true, mountCount: 2, publishedPortCount: 0, restartPolicy: "unless-stopped", restartCount: 0, autostartExact: true, updaterDisabled: true, vaultUnlocked: true, manualAuthRequired: false },
  provider: { outwardReady: true, innerReady: true, geminiCandidateReady: true, providersDistinct: true, silentFallback: false, credentialRevisionsPresent: true, requestSemanticsExact: true, fallbackAttemptCount: 0 },
  cron: { registered: true, fingerprint: "a".repeat(64), receiptDigest: "b".repeat(64), sweepCount: 0 },
  health: { transitionCount: 0, alertCount: 0, productionRestored: true },
  digest: { scheduleObserved: true, messageCount: 0, firedWithinMs: 1_000, productionRestored: true },
  reboot: { requestDigest: "c".repeat(64), requestCount: 1, checkpointPersisted: true, unrelatedHostOperations: 0, bootIdentityChanged: true, hostReady: true, arrayReady: true, dockerReady: true, butlerReady: true, tailscaleReady: true, sshReady: true },
  containment: { auditComplete: true, readOnlyBoundaryHeld: true, sensitiveMaterialObserved: false, stopDenied: true, restartDenied: true, denialAuditCount: 1, denialStateUnchanged: true, denialProbeCompleted: true },
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

describe("Sanctuary live scenario capture", () => {
  it("derives every Unit 16 assertion contract from event, journal, and runtime facts", () => {
    for (const label of SANCTUARY_UNIT_16_EVIDENCE_LABELS) {
      const before = base()
      const after = base()
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
      if (label === "unit-16f-cron-fingerprint") after.cron!.sweepCount = 1
      if (label === "unit-16g-health-transition") { after.health!.transitionCount = 1; after.health!.alertCount = 1 }
      if (label === "unit-16h-daily-digest") after.digest!.messageCount = 1
      if (label === "unit-16i-delayed-approval") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart() }
      if (label === "unit-16k-timeout-stale") { after.approvals = [approval("expired")]; after.events.push(event("telegram.update_dropped")) }
      if (label === "unit-16l-duplicate-callback") { after.approvals = [{ ...approval("succeeded"), callbackCount: 2, settledCount: 2, claimCount: 1 }]; after.restartAttempts = successfulRestart(); after.events.push(event("telegram.callback_settled"), event("telegram.callback_settled"), event("approval.acceptance_transition")) }
      if (label === "unit-16m-restart-continuation") { after.approvals = [approval("succeeded")]; after.restartAttempts = successfulRestart(); after.events.push(event("senses.telegram_approved_restart_end")) }
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
  })
})
