import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"

const privateRuntimeModulePath = "../../../heart/private-runtime"

type PrivateRuntimeModule = Record<string, any>

async function loadPrivateRuntime(): Promise<PrivateRuntimeModule> {
  return import(privateRuntimeModulePath)
}

function tempLedgerPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-")), "decisions.jsonl")
}

function readLedger(pathname: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(pathname)) return []
  return fs.readFileSync(pathname, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

function privateTurnRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent: "slugger",
    origin: "habit.poke",
    reason: "manual habit poke",
    providerLane: "inner",
    triggerSource: "manual",
    idempotencyKey: "habit:slugger:heartbeat:manual:2026-07-03T20:00:00.000Z",
    budgetClass: "interactive",
    originRefs: [
      { kind: "habit", id: "heartbeat" },
      { kind: "session", id: "sess_123" },
    ],
    turn: {
      kind: "habit",
      prompt: "Run the heartbeat habit.",
    },
    ...overrides,
  }
}

function policyDeps(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ledgerPath: tempLedgerPath(),
    now: () => "2026-07-03T20:00:00.000Z",
    resolveProviderLane: vi.fn(async () => ({
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.5",
      source: "agent.json",
      credentialRevision: "cred_openai_codex",
    })),
    readProviderCredentialPool: vi.fn(),
    pingProvider: vi.fn(),
    emitNervesEvent: vi.fn(),
    ...overrides,
  }
}

describe("private-runtime public API", () => {
  it("exports the policy, ledger, fingerprint, and reader entrypoints", async () => {
    const privateRuntime = await loadPrivateRuntime()

    expect(privateRuntime.createPrivateTurnRequestFingerprint).toEqual(expect.any(Function))
    expect(privateRuntime.createPrivateTurnIdempotencyKey).toEqual(expect.any(Function))
    expect(privateRuntime.requestPrivateTurnDecision).toEqual(expect.any(Function))
    expect(privateRuntime.recordPrivateTurnDecision).toEqual(expect.any(Function))
    expect(privateRuntime.readPrivateTurnLedger).toEqual(expect.any(Function))
  })
})

describe("private-runtime request identity", () => {
  it("creates a canonical fingerprint from the spend-relevant request fields", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const request = privateTurnRequest({
      originRefs: [
        { id: "sess_123", kind: "session" },
        { id: "heartbeat", kind: "habit" },
      ],
    })
    const sameRequestDifferentKeyOrder = privateTurnRequest({
      originRefs: [
        { kind: "habit", id: "heartbeat" },
        { kind: "session", id: "sess_123" },
      ],
    })

    const fingerprint = privateRuntime.createPrivateTurnRequestFingerprint(request)

    expect(fingerprint).toMatch(/^ptr_[0-9a-f]{64}$/)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(sameRequestDifferentKeyOrder)).toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ agent: "ouroboros" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ origin: "await.expiry" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ reason: "overdue habit catch-up" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ providerLane: "outward" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ triggerSource: "scheduled" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ idempotencyKey: "habit:slugger:other" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ budgetClass: "background" }))).not.toBe(fingerprint)
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ originRefs: [{ kind: "habit", id: "other" }] }))).not.toBe(fingerprint)
  })

  it("derives a stable idempotency key when one is not supplied", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const { idempotencyKey: _omitted, ...request } = privateTurnRequest()

    const key = privateRuntime.createPrivateTurnIdempotencyKey(request)

    expect(key).toMatch(/^ptk_[0-9a-f]{64}$/)
    expect(privateRuntime.createPrivateTurnIdempotencyKey({ ...request })).toBe(key)
    expect(privateRuntime.createPrivateTurnIdempotencyKey({ ...request, origin: "await.expiry" })).not.toBe(key)
  })
})

describe("private-runtime policy and ledger", () => {
  it("denies by default, records the decision, and never reads credentials or pings providers", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps()

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)

    expect(decision).toMatchObject({
      agent: "slugger",
      result: "deny",
      providerLane: {
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
      },
    })
    expect(decision.requestFingerprint).toBe(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest()))
    expect(deps.resolveProviderLane).toHaveBeenCalledWith("slugger", "inner")
    expect(deps.readProviderCredentialPool).not.toHaveBeenCalled()
    expect(deps.pingProvider).not.toHaveBeenCalled()
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(1)
  })

  it("resolves provider metadata from the configured lane and ignores request-supplied provider/model", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      resolveProviderLane: vi.fn(async () => ({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
        credentialRevision: "cred_openai_codex",
      })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      provider: "minimax",
      model: "abab6.5s-chat",
      providerLane: "inner",
    }), deps)

    expect(deps.resolveProviderLane).toHaveBeenCalledWith("slugger", "inner")
    expect(decision.providerLane).toMatchObject({
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.5",
      source: "agent.json",
    })
    expect(decision.providerLane.provider).not.toBe("minimax")
    expect(decision.providerLane.model).not.toBe("abab6.5s-chat")
    expect(deps.readProviderCredentialPool).not.toHaveBeenCalled()
    expect(deps.pingProvider).not.toHaveBeenCalled()
  })

  it("records explicit allow decisions before returning an executable receipt", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "manual operator-approved habit poke" })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)
    const ledgerRows = readLedger(deps.ledgerPath as string)

    expect(decision).toMatchObject({
      result: "allow",
      reason: "manual operator-approved habit poke",
      ledgerLocator: { path: deps.ledgerPath },
    })
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0]).toMatchObject({
      result: "allow",
      agent: "slugger",
      origin: "habit.poke",
      reason: "manual operator-approved habit poke",
      idempotencyKey: "habit:slugger:heartbeat:manual:2026-07-03T20:00:00.000Z",
      providerLane: {
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
      },
    })
    expect(deps.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "private-runtime",
      event: "private_runtime.decision_recorded",
      level: "info",
      meta: expect.objectContaining({
        agent: "slugger",
        origin: "habit.poke",
        result: "allow",
      }),
    }))
  })

  it("fails closed when an allow decision cannot be written to the durable ledger", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      ledgerPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-readonly-")), "missing", "decisions.jsonl"),
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "manual operator-approved habit poke" })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)

    expect(decision).toMatchObject({
      result: "deny",
      deniedReason: "ledger write failed",
      executable: false,
    })
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(0)
    expect(deps.readProviderCredentialPool).not.toHaveBeenCalled()
    expect(deps.pingProvider).not.toHaveBeenCalled()
    expect(deps.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "private-runtime",
      event: "private_runtime.decision_record_failed",
      level: "error",
    }))
  })

  it("collapses concurrent same-key same-fingerprint decisions into one ledger receipt", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "duplicate-safe" })),
    })
    const request = privateTurnRequest()

    const decisions = await Promise.all([
      privateRuntime.requestPrivateTurnDecision(request, deps),
      privateRuntime.requestPrivateTurnDecision({ ...request }, deps),
      privateRuntime.requestPrivateTurnDecision({ ...request }, deps),
    ])

    expect(new Set(decisions.map((decision: Record<string, unknown>) => decision.receiptId)).size).toBe(1)
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(1)
    expect(deps.pingProvider).not.toHaveBeenCalled()
  })

  it("rejects same-key different-fingerprint decisions without overwriting the original receipt", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "operator-approved" })),
    })

    const first = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)
    const second = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({ reason: "different work" }), deps)

    expect(first.result).toBe("allow")
    expect(second).toMatchObject({
      result: "deny",
      deniedReason: "idempotency-key fingerprint mismatch",
      idempotencyKey: first.idempotencyKey,
    })
    const ledgerRows = readLedger(deps.ledgerPath as string)
    expect(ledgerRows).toHaveLength(2)
    expect(ledgerRows[0].requestFingerprint).toBe(first.requestFingerprint)
    expect(ledgerRows[1]).toMatchObject({
      result: "deny",
      deniedReason: "idempotency-key fingerprint mismatch",
    })
  })
})
