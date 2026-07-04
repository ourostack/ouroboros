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

function tempBundlesRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-bundles-"))
}

function writeAgentBundle(
  bundlesRoot: string,
  agent = "slugger",
  overrides: Record<string, unknown> = {},
): void {
  const agentRoot = path.join(bundlesRoot, `${agent}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "agent.json"), `${JSON.stringify({
    version: 2,
    enabled: true,
    humanFacing: { provider: "minimax", model: "MiniMax-M2.5" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.5" },
    senses: {},
    ...overrides,
  }, null, 2)}\n`, "utf-8")
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
    expect(privateRuntime.createPrivateTurnRequestFingerprint(privateTurnRequest({ idempotencyKey: undefined }))).toMatch(/^ptr_[0-9a-f]{64}$/)
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

  it("resolves lane metadata from agent.json without provider credential or ping probes", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const bundlesRoot = tempBundlesRoot()
    writeAgentBundle(bundlesRoot)
    const deps = policyDeps({
      bundlesRoot,
      resolveProviderLane: undefined,
      evaluatePolicy: vi.fn(async () => ({ result: "deny", deniedReason: "coverage deny" })),
      now: () => new Date("2026-07-03T20:00:00.000Z"),
    })

    const inner = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "configured-inner",
      originRefs: undefined,
    }), deps)
    const outward = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "configured-outward",
      providerLane: "outward",
    }), deps)

    expect(inner).toMatchObject({
      result: "deny",
      reason: "manual habit poke",
      deniedReason: "coverage deny",
      providerLane: {
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
      },
      originRefs: [],
    })
    expect(outward.providerLane).toMatchObject({
      lane: "outward",
      provider: "minimax",
      model: "MiniMax-M2.5",
    })
    expect(deps.readProviderCredentialPool).not.toHaveBeenCalled()
    expect(deps.pingProvider).not.toHaveBeenCalled()
  })

  it("fails closed when provider lane resolution fails", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      resolveProviderLane: vi.fn(async () => Promise.reject("agent.json missing provider lane")),
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "should not run" })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)

    expect(decision).toMatchObject({
      result: "deny",
      executable: false,
      reason: "agent.json missing provider lane",
      deniedReason: "provider lane resolution failed",
      providerLane: {
        lane: "inner",
        provider: "unconfigured",
        model: "-",
        source: "agent.json",
      },
    })
    expect(deps.evaluatePolicy).not.toHaveBeenCalled()
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(1)
  })

  it("uses the implicit bundle root when no bundlesRoot override is supplied", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-home-"))
    const previousHome = process.env.HOME
    process.env.HOME = homeDir
    try {
      const bundlesRoot = path.join(homeDir, "AgentBundles")
      writeAgentBundle(bundlesRoot)

      expect(privateRuntime.privateTurnLedgerPath("slugger")).toBe(
        path.join(bundlesRoot, "slugger.ouro", "state", "private-runtime", "decisions.jsonl"),
      )

      const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
        idempotencyKey: "implicit-bundle-root",
      }), {
        ledgerPath: tempLedgerPath(),
        now: () => "2026-07-03T20:00:00.000Z",
        evaluatePolicy: vi.fn(async () => ({ result: "deny", deniedReason: "implicit root deny" })),
        emitNervesEvent: vi.fn(),
      })

      expect(decision.providerLane).toMatchObject({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
      })
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = previousHome
      }
    }
  })

  it("keeps provider resolution failures closed for ordinary Error objects", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      resolveProviderLane: vi.fn(async () => Promise.reject(new Error("provider lane boom"))),
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "should not run" })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "error-provider-lane",
    }), deps)

    expect(decision).toMatchObject({
      result: "deny",
      reason: "provider lane boom",
      deniedReason: "provider lane resolution failed",
      executable: false,
    })
  })

  it("derives idempotency and fallback denied reasons without test event doubles", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const { idempotencyKey: _omitted, ...requestWithoutKey } = privateTurnRequest({
      originRefs: undefined,
    })
    const deps = {
      ledgerPath: tempLedgerPath(),
      resolveProviderLane: vi.fn(async () => ({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
      })),
      evaluatePolicy: vi.fn(async () => ({ result: "deny", reason: "policy denied without explicit deniedReason" })),
    }

    const decision = await privateRuntime.requestPrivateTurnDecision(requestWithoutKey, deps)

    expect(decision).toMatchObject({
      result: "deny",
      reason: "policy denied without explicit deniedReason",
      deniedReason: "policy denied without explicit deniedReason",
      executable: false,
      originRefs: [],
    })
    expect(decision.idempotencyKey).toMatch(/^ptk_[0-9a-f]{64}$/)
    expect(decision.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it("uses the built-in event emitter and default ledger path when no test doubles are supplied", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const bundlesRoot = tempBundlesRoot()
    const expectedLedgerPath = path.join(bundlesRoot, "slugger.ouro", "state", "private-runtime", "decisions.jsonl")
    const deps = {
      bundlesRoot,
      now: () => new Date("2026-07-03T20:00:00.000Z"),
      resolveProviderLane: vi.fn(async () => ({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
      })),
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "default ledger path coverage" })),
    }

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "default-ledger-path",
    }), deps)

    expect(decision).toMatchObject({
      result: "allow",
      executable: true,
      ledgerLocator: { path: expectedLedgerPath, line: 1 },
    })
    expect(readLedger(expectedLedgerPath)).toMatchObject([
      {
        receiptId: decision.receiptId,
        ledgerLocator: { path: expectedLedgerPath, line: 1 },
      },
    ])
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

  it("reads empty ledgers and preserves supplied direct-record receipts", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const ledgerPath = tempLedgerPath()
    fs.writeFileSync(ledgerPath, "", "utf-8")
    const directDecision = {
      schemaVersion: 1,
      receiptId: "ptrr_supplied",
      agent: "slugger",
      origin: "habit.poke",
      reason: "direct record coverage",
      providerLane: {
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
      },
      triggerSource: "manual",
      idempotencyKey: "direct-record",
      budgetClass: "interactive",
      originRefs: [],
      requestFingerprint: "ptr_direct",
      result: "deny",
      executable: false,
      decidedAt: "2026-07-03T20:00:00.000Z",
      ledgerLocator: { path: "" },
      deniedReason: "direct deny",
    }

    expect(privateRuntime.readPrivateTurnLedger(ledgerPath)).toEqual([])
    const recorded = privateRuntime.recordPrivateTurnDecision(directDecision, {
      ledgerPath,
      emitNervesEvent: vi.fn(),
    })

    expect(recorded).toMatchObject({
      receiptId: "ptrr_supplied",
      ledgerLocator: { path: ledgerPath, line: 1 },
    })
    expect(privateRuntime.readPrivateTurnLedger(ledgerPath)).toMatchObject([
      {
        receiptId: "ptrr_supplied",
        ledgerLocator: { path: ledgerPath, line: 1 },
      },
    ])
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

  it("fails closed with the built-in event emitter when ledger write fails", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = {
      ledgerPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-private-runtime-readonly-")), "missing", "decisions.jsonl"),
      now: () => "2026-07-03T20:00:00.000Z",
      resolveProviderLane: vi.fn(async () => ({
        lane: "inner",
        provider: "openai-codex",
        model: "gpt-5.5",
        source: "agent.json",
      })),
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "manual operator-approved habit poke" })),
    }

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "built-in-failed-write",
    }), deps)

    expect(decision).toMatchObject({
      result: "deny",
      deniedReason: "ledger write failed",
      executable: false,
    })
    expect(readLedger(deps.ledgerPath)).toHaveLength(0)
  })

  it("fails closed when existing ledger state is malformed", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const ledgerPath = tempLedgerPath()
    fs.writeFileSync(ledgerPath, "{not-json}\n", "utf-8")
    const deps = policyDeps({
      ledgerPath,
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "manual operator-approved habit poke" })),
    })

    const decision = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest({
      idempotencyKey: "malformed-ledger-row",
    }), deps)

    expect(decision).toMatchObject({
      result: "deny",
      deniedReason: "ledger write failed",
      executable: false,
    })
    expect(decision.error).toContain("JSON")
    expect(fs.readFileSync(ledgerPath, "utf-8")).toBe("{not-json}\n")
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
    expect(decisions.filter((decision: Record<string, unknown>) => decision.executable === true)).toHaveLength(1)
    const duplicateDecisions = decisions.filter((decision: Record<string, unknown>) => decision.executable === false)
    expect(duplicateDecisions).toHaveLength(2)
    expect(duplicateDecisions).toEqual([
      expect.objectContaining({
        result: "allow",
        deniedReason: "duplicate private-turn decision already recorded",
        duplicateOf: decisions.find((decision: Record<string, unknown>) => decision.executable === true)?.receiptId,
      }),
      expect.objectContaining({
        result: "allow",
        deniedReason: "duplicate private-turn decision already recorded",
        duplicateOf: decisions.find((decision: Record<string, unknown>) => decision.executable === true)?.receiptId,
      }),
    ])
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(1)
    expect(deps.pingProvider).not.toHaveBeenCalled()
  })

  it("collapses duplicate same-key same-fingerprint denies into the prior parked decision", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn(async () => ({ result: "deny", reason: "wait", deniedReason: "wait" })),
    })

    const first = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)
    const second = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)

    expect(first).toMatchObject({ result: "deny", executable: false, deniedReason: "wait" })
    expect(second).toMatchObject({
      result: "deny",
      executable: false,
      deniedReason: "wait",
      receiptId: first.receiptId,
    })
    expect(readLedger(deps.ledgerPath as string)).toHaveLength(1)
  })

  it("records the first executable allow after an earlier deny for the same request", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn()
        .mockResolvedValueOnce({ result: "deny", reason: "wait", deniedReason: "wait" })
        .mockResolvedValueOnce({ result: "allow", reason: "operator-approved" }),
    })

    const first = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)
    const second = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)

    expect(first).toMatchObject({ result: "deny", executable: false, deniedReason: "wait" })
    expect(second).toMatchObject({ result: "allow", executable: true })
    const ledgerRows = readLedger(deps.ledgerPath as string)
    expect(ledgerRows).toHaveLength(2)
    expect(ledgerRows.map((row) => row.result)).toEqual(["deny", "allow"])
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

  it("keeps the original idempotency fingerprint authoritative after mismatch rows", async () => {
    const privateRuntime = await loadPrivateRuntime()
    const deps = policyDeps({
      evaluatePolicy: vi.fn(async () => ({ result: "allow", reason: "operator-approved" })),
    })

    const first = await privateRuntime.requestPrivateTurnDecision(privateTurnRequest(), deps)
    const mismatchedRequest = privateTurnRequest({ reason: "different work" })
    const mismatch = await privateRuntime.requestPrivateTurnDecision(mismatchedRequest, deps)
    const retry = await privateRuntime.requestPrivateTurnDecision(mismatchedRequest, deps)

    expect(first).toMatchObject({ result: "allow", executable: true })
    expect(mismatch).toMatchObject({
      result: "deny",
      executable: false,
      deniedReason: "idempotency-key fingerprint mismatch",
      duplicateOf: first.receiptId,
    })
    expect(retry).toMatchObject({
      result: "deny",
      executable: false,
      deniedReason: "idempotency-key fingerprint mismatch",
      duplicateOf: first.receiptId,
    })
    const mismatchedFingerprint = privateRuntime.createPrivateTurnRequestFingerprint(mismatchedRequest)
    const ledgerRows = readLedger(deps.ledgerPath as string)
    expect(ledgerRows.filter((row) => row.requestFingerprint === mismatchedFingerprint && row.executable === true)).toHaveLength(0)
  })
})
