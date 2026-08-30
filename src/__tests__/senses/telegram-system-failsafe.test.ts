import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { afterEach, describe, expect, it, vi } from "vitest"

import { bindPrivilegedFailsafeArtifact, readExternalEventRecord, type ExternalEventRecord } from "../../heart/external-events/router"
import { createSabQueueProtectiveStateVerifier } from "../../senses/telegram"
import {
  FIXED_USENET_SYSTEM_FAILSAFE,
  FileTelegramEffectJournal,
  createTelegramAuthorizedEffectExecutor,
  reconcileTelegramSystemFailsafe,
  recordTelegramEffectsInSession,
  sweepTelegramSystemFailsafes,
} from "../../senses/telegram-effect-adapter"

const roots: string[] = []
const target = { kind: "approved_relationship" as const, friendId: "ari", sessionKey: "telegram:ari" }
const authorization = { allowed: true as const, receiptId: "owner-proactive-v1", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "42" } }

function root(name: string): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`))
  roots.push(value)
  return value
}

function record(overrides: Partial<ExternalEventRecord> = {}): ExternalEventRecord {
  const eventRoot = root("failsafe-event")
  const recordPath = path.join(eventRoot, "sanctuary", "sanctuary-usenet", "spend-guard.json")
  fs.mkdirSync(path.dirname(recordPath), { recursive: true })
  const value = {
    schemaVersion: 2 as const,
    agent: "sanctuary",
    source: "sanctuary-usenet",
    eventType: "usenet.protective_action",
    eventId: "spend-guard",
    summary: "Downloads were paused by the spend guard.",
    evidence: ["protective action receipt: sabnzbd:pause:2026-08-29"],
    payloadPath: null,
    priority: "critical",
    receivedAt: "2026-08-29T19:55:00.000Z",
    recordPath,
    duplicateCount: 0,
    updatedAt: "2026-08-29T19:56:00.000Z",
    version: 1,
    observationRevision: "a".repeat(64),
    observationDigest: "b".repeat(64),
    transition: "opened" as const,
    executionState: "retry_wait" as const,
    generation: 1,
    attemptCount: 1,
    claimOwner: null,
    claimExpiresAt: null,
    nextAttemptAt: "2026-08-29T19:56:01.000Z",
    lastError: "model provider unavailable",
    disposition: null,
    pendingObservation: null,
    dispatchEnabled: true,
    shouldWake: false,
    privilegedIngressNonce: "c".repeat(64),
    privilegedProtectiveAction: {
      action: "sabnzbd.pause" as const,
      actionReceipt: "sabnzbd:pause:2026-08-29",
      transitionId: "spend-pause:2026-08-29",
      critical: true,
      createdAt: "2026-08-29T19:55:00.000Z",
      expiresAt: "2026-08-29T20:10:00.000Z",
      verification: { verified: true, digest: "d".repeat(64), observedAt: "2026-08-29T19:55:01.000Z" },
    },
    ...overrides,
  }
  fs.writeFileSync(recordPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  return value
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Telegram system failsafe", () => {
  it("independently rereads SAB and verifies only a currently paused queue without retaining the credential", async () => {
    const iniPath = path.join(root("sab-verifier"), "sabnzbd.ini")
    fs.writeFileSync(iniPath, "api_key = test-only-secret\n")
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue: { paused: false } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue: { paused: true } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ queue: { paused: "yes" } })))
      .mockRejectedValueOnce(new Error("connect failed with credential"))
    const verify = createSabQueueProtectiveStateVerifier({ iniPath, fetch: fetchImpl, now: () => "2026-08-29T19:58:01.000Z" })
    const action = { ...record().privilegedProtectiveAction!, verification: { ...record().privilegedProtectiveAction!.verification, digest: createHash("sha256").update("sabnzbd.queue.paused=true").digest("hex") } }

    const unpaused = await verify(action)
    const paused = await verify(action)
    expect(unpaused).toEqual({ verified: false, reference: expect.stringMatching(/^sabnzbd\.queue\.paused:[a-f0-9]{64}:2026/u) })
    expect(paused).toEqual({ verified: true, reference: expect.stringMatching(/^sabnzbd\.queue\.paused:[a-f0-9]{64}:2026/u) })
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining("mode=queue"), expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(JSON.stringify([unpaused, paused])).not.toContain("test-only-secret")
    await expect(verify(action)).rejects.toThrow("response is malformed")
    await expect(verify(action)).rejects.toThrow("request failed")
  })

  it("rejects missing SAB credentials and non-object queue responses", async () => {
    const iniPath = path.join(root("sab-verifier-invalid"), "sabnzbd.ini")
    fs.writeFileSync(iniPath, "host = localhost\n")
    const action = record().privilegedProtectiveAction!
    await expect(createSabQueueProtectiveStateVerifier({ iniPath, fetch: vi.fn() })(action)).rejects.toThrow("credential is unavailable")
    fs.writeFileSync(iniPath, "api_key = test-only-secret\n")
    const verify = createSabQueueProtectiveStateVerifier({ iniPath, fetch: vi.fn(async () => new Response("null")) })
    await expect(verify(action)).rejects.toThrow("response is malformed")
  })

  it("sends one fixed typed artifact after the bounded outage window and binds verification to the canonical event and owner session", async () => {
    const initial = record()
    const store = new FileTelegramEffectJournal(root("failsafe-journal"))
    const request = vi.fn(async () => ({ message_id: 77 }))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })
    const sessionPath = path.join(root("failsafe-session"), "session.json")

    const result = await reconcileTelegramSystemFailsafe({
      record: initial,
      now: () => "2026-08-29T19:58:01.000Z",
      target,
      verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "sabnzbd-read:queue-paused:sha256:verified" })),
      execute,
      recordArtifact: async (artifact) => { await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [artifact] }) },
      bindArtifact: bindPrivilegedFailsafeArtifact,
    })

    expect(result).toMatchObject({ sent: true, artifactId: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith("sendMessage", expect.objectContaining({ text: FIXED_USENET_SYSTEM_FAILSAFE }), undefined)
    const artifact = store.read(result.artifactId!)
    expect(artifact).toMatchObject({ authorClass: "system_failsafe", effect: { kind: "text", text: FIXED_USENET_SYSTEM_FAILSAFE } })
    const persisted = readExternalEventRecord(initial.recordPath)
    expect(persisted.privilegedFailsafe).toMatchObject({ artifactId: artifact.id, verificationRef: "sabnzbd-read:queue-paused:sha256:verified" })
    const session = JSON.parse(fs.readFileSync(sessionPath, "utf8")) as { events: Array<{ role: string; name: string; content: string; relations: { references: string[] } }> }
    expect(session.events).toEqual([expect.objectContaining({ role: "system", name: "telegram-system-failsafe", content: expect.stringContaining(FIXED_USENET_SYSTEM_FAILSAFE) })])
  })

  it("denies noncritical, model-healthy, policy-blocked, unverified, unsupported-action, and pre-window states without preparing an effect", async () => {
    const execute = vi.fn()
    const base = { now: () => "2026-08-29T19:58:01.000Z", target, execute, recordArtifact: vi.fn(), bindArtifact: vi.fn() }
    const cases = [
      record({ privilegedProtectiveAction: { ...record().privilegedProtectiveAction!, critical: false } }),
      record({ executionState: "handled", lastError: null }),
      record({ dispatchEnabled: false }),
      record({ privilegedProtectiveAction: { ...record().privilegedProtectiveAction!, action: "prowlarr.disable-indexer" } }),
      record({ privilegedProtectiveAction: { ...record().privilegedProtectiveAction!, verification: { verified: false, digest: "e".repeat(64), observedAt: "2026-08-29T19:55:01.000Z" } } }),
    ]
    for (const candidate of cases) {
      await expect(reconcileTelegramSystemFailsafe({ ...base, record: candidate, verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "verified" })) })).resolves.toMatchObject({ sent: false })
    }
    await expect(reconcileTelegramSystemFailsafe({ ...base, record: record(), now: () => "2026-08-29T19:57:59.999Z", verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "verified" })) })).resolves.toMatchObject({ sent: false, reason: "unavailability_window" })
    await expect(reconcileTelegramSystemFailsafe({ ...base, record: record({ privilegedProtectiveAction: { ...record().privilegedProtectiveAction!, expiresAt: "2026-08-29T19:58:00.000Z" } }), verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "verified" })) })).resolves.toMatchObject({ sent: false, reason: "expired" })
    await expect(reconcileTelegramSystemFailsafe({ ...base, record: record(), verifyProtectiveState: vi.fn(async () => ({ verified: false, reference: "sabnzbd-read:not-paused" })) })).resolves.toMatchObject({ sent: false, reason: "unverified" })
    await expect(reconcileTelegramSystemFailsafe({ ...base, record: record(), verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "" })) })).resolves.toMatchObject({ sent: false, reason: "unverified" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("recovers a crash after Telegram acceptance without sending twice and remains once-only after event binding", async () => {
    const initial = record()
    const storeRoot = root("failsafe-crash-journal")
    const store = new FileTelegramEffectJournal(storeRoot)
    const request = vi.fn(async () => ({ message_id: 88 }))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request }, authorize: () => authorization })
    const sessionPath = path.join(root("failsafe-crash-session"), "session.json")
    const common = {
      now: () => "2026-08-29T19:58:01.000Z",
      target,
      verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "sabnzbd-read:queue-paused:sha256:crash" })),
      execute,
      bindArtifact: bindPrivilegedFailsafeArtifact,
    }

    await expect(reconcileTelegramSystemFailsafe({ ...common, record: initial, recordArtifact: async () => { throw new Error("crash before continuity") } })).rejects.toThrow("crash before continuity")
    expect(request).toHaveBeenCalledTimes(1)
    const recovered = await reconcileTelegramSystemFailsafe({ ...common, record: readExternalEventRecord(initial.recordPath), recordArtifact: async (artifact) => { await recordTelegramEffectsInSession({ store, sessionPath, artifacts: [artifact] }) } })
    expect(recovered.sent).toBe(true)
    expect(request).toHaveBeenCalledTimes(1)
    await expect(reconcileTelegramSystemFailsafe({ ...common, record: readExternalEventRecord(initial.recordPath), recordArtifact: vi.fn() })).resolves.toMatchObject({ sent: false, reason: "already_recorded" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("sweeps eligible persisted events with and without an injected clock", async () => {
    const eligible = record()
    const eventRoot = path.dirname(path.dirname(path.dirname(eligible.recordPath)))
    const store = new FileTelegramEffectJournal(root("failsafe-sweep-journal"))
    const execute = createTelegramAuthorizedEffectExecutor({ store, api: { request: vi.fn(async () => ({ message_id: 99 })) }, authorize: () => authorization })
    const common = {
      eventRoot,
      target,
      verifyProtectiveState: vi.fn(async () => ({ verified: true, reference: "sabnzbd-read:queue-paused:sha256:sweep" })),
      execute,
      recordArtifact: vi.fn(async () => undefined),
    }

    await expect(sweepTelegramSystemFailsafes({ ...common, now: () => "2026-08-29T19:58:01.000Z" })).resolves.toEqual({ inspected: 1, sent: 1 })

    const ineligible = record({ executionState: "handled", lastError: null })
    const ineligibleRoot = path.dirname(path.dirname(path.dirname(ineligible.recordPath)))
    await expect(sweepTelegramSystemFailsafes({ ...common, eventRoot: ineligibleRoot })).resolves.toEqual({ inspected: 1, sent: 0 })
  })
})
