import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  AUTONOMY_BUDGET_DEFAULT_POLICY,
  autonomyBudgetStatePath,
  autonomyReceiptsDir,
  readAutonomyBudgetState,
  readAutonomyStormBreakers,
  recordAutonomyFailure,
  resolveAutonomyBudgetPolicy,
  reserveAutonomyBudget,
} from "../../heart/autonomy-budget"

function tempAgentRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-autonomy-budget-"))
}

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    agent: "slugger",
    triggerType: "recovery",
    sourceKind: "sense",
    senseOrHabit: "bluebubbles",
    target: { messageGuid: "msg-1", transcript: "never store this" },
    idempotencyKey: "bb-recovery:msg-1",
    now: "2026-07-09T17:00:00.000Z",
    ...overrides,
  } as const
}

describe("autonomy budget", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
  })

  it("resolves the per-agent habit budget from validated agent config", () => {
    const sanctuaryRoot = tempAgentRoot()
    fs.writeFileSync(path.join(sanctuaryRoot, "agent.json"), JSON.stringify({ habitPaidTurnsPerDay: 24 }))
    expect(resolveAutonomyBudgetPolicy(sanctuaryRoot, "sanctuary").habitPaidTurnsPerDay).toBe(24)

    const genericRoot = tempAgentRoot()
    expect(resolveAutonomyBudgetPolicy(genericRoot, "slugger").habitPaidTurnsPerDay).toBe(4)
    expect(() => resolveAutonomyBudgetPolicy(genericRoot, "sanctuary")).toThrow("must explicitly set")
  })

  it.each([
    ["fractional", 1.5],
    ["negative", -1],
    ["above the maximum", 97],
  ])("rejects a %s per-agent habit budget", (_label, value) => {
    const agentRoot = tempAgentRoot()
    const configPath = path.join(agentRoot, "agent.json")
    fs.writeFileSync(configPath, JSON.stringify({ habitPaidTurnsPerDay: value }))

    expect(() => resolveAutonomyBudgetPolicy(agentRoot, "slugger")).toThrow("integer from 0 through 96")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "config_identity.error",
      meta: { path: configPath, value },
    }))
  })

  it.each([
    ["malformed JSON", "{", "failed to read autonomy budget"],
    ["null", "null", "must be an object"],
    ["a primitive", "42", "must be an object"],
    ["an array", "[]", "must be an object"],
  ])("fails closed when agent config contains %s", (_label, contents, message) => {
    const agentRoot = tempAgentRoot()
    fs.writeFileSync(path.join(agentRoot, "agent.json"), contents)

    expect(() => resolveAutonomyBudgetPolicy(agentRoot, "slugger")).toThrow(message)
  })

  it("allows a first recovery reservation and stores only content-free budget state", () => {
    const agentRoot = tempAgentRoot()

    const decision = reserveAutonomyBudget(agentRoot, baseRequest())

    expect(decision).toMatchObject({
      allowed: true,
      status: "allowed",
      actor: "agent-runnable",
      triggerType: "recovery",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
    })
    const state = readAutonomyBudgetState(agentRoot)
    expect(state.reservations).toHaveLength(1)
    expect(state.reservations[0]).toMatchObject({
      agent: "slugger",
      triggerType: "recovery",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      contentStored: false,
    })
    expect(fs.readFileSync(autonomyBudgetStatePath(agentRoot), "utf-8")).not.toContain("never store this")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.autonomy_budget_allowed",
      component: "heart",
    }))
  })

  it("blocks narrow recovery budgets without blocking unrelated inbound/manual work", () => {
    const agentRoot = tempAgentRoot()
    const now = "2026-07-09T17:00:00.000Z"
    for (let index = 0; index < AUTONOMY_BUDGET_DEFAULT_POLICY.senseRecoveryPaidTurnsPer15m; index++) {
      expect(reserveAutonomyBudget(agentRoot, baseRequest({
        idempotencyKey: `bb-recovery:msg-${index}`,
        target: { messageGuid: `msg-${index}`, transcript: "never store this" },
        now,
      })).allowed).toBe(true)
    }

    const blocked = reserveAutonomyBudget(agentRoot, baseRequest({
      idempotencyKey: "bb-recovery:overflow",
      target: { messageGuid: "overflow", transcript: "never store this" },
      now: "2026-07-09T17:10:00.000Z",
    }))
    const unrelated = reserveAutonomyBudget(agentRoot, baseRequest({
      triggerType: "manual",
      sourceKind: "cli",
      senseOrHabit: "operator",
      idempotencyKey: "manual:operator",
      target: { command: "status", transcript: "still not stored" },
      now: "2026-07-09T17:10:00.000Z",
    }))

    expect(blocked).toMatchObject({
      allowed: false,
      status: "blocked",
      actor: "agent-runnable",
      reason: expect.stringContaining("sense recovery paid turn budget exceeded"),
    })
    expect(unrelated.allowed).toBe(true)
    expect(fs.existsSync(path.join(autonomyReceiptsDir(agentRoot), `${blocked.receiptId}.json`))).toBe(true)
    expect(JSON.stringify(blocked)).not.toContain("never store this")
  })

  it("enforces rolling hour, agent day, and sense day budgets independently", () => {
    const hourlyRoot = tempAgentRoot()
    const hourlyPolicy = {
      ...AUTONOMY_BUDGET_DEFAULT_POLICY,
      agentProactivePaidTurnsPerHour: 1,
      agentProactivePaidTurnsPerDay: 10,
      senseRecoveryPaidTurnsPer15m: 10,
      senseRecoveryPaidTurnsPerDay: 10,
    }
    expect(reserveAutonomyBudget(hourlyRoot, baseRequest({
      idempotencyKey: "bb-recovery:hour-1",
      target: { messageGuid: "hour-1" },
    }), hourlyPolicy).allowed).toBe(true)
    expect(reserveAutonomyBudget(hourlyRoot, baseRequest({
      idempotencyKey: "bb-recovery:hour-2",
      target: { messageGuid: "hour-2" },
      now: "2026-07-09T17:30:00.000Z",
    }), hourlyPolicy).reason).toContain("rolling hour")

    const agentDayRoot = tempAgentRoot()
    const agentDayPolicy = {
      ...AUTONOMY_BUDGET_DEFAULT_POLICY,
      agentProactivePaidTurnsPerHour: 10,
      agentProactivePaidTurnsPerDay: 1,
      senseRecoveryPaidTurnsPer15m: 10,
      senseRecoveryPaidTurnsPerDay: 10,
    }
    expect(reserveAutonomyBudget(agentDayRoot, baseRequest({
      idempotencyKey: "bb-recovery:day-1",
      target: { messageGuid: "day-1" },
      now: "2026-07-09T00:00:00.000Z",
    }), agentDayPolicy).allowed).toBe(true)
    expect(reserveAutonomyBudget(agentDayRoot, baseRequest({
      idempotencyKey: "bb-recovery:day-2",
      target: { messageGuid: "day-2" },
      now: "2026-07-09T23:00:00.000Z",
    }), agentDayPolicy).reason).toContain("exceeded for day")

    const senseDayRoot = tempAgentRoot()
    const senseDayPolicy = {
      ...AUTONOMY_BUDGET_DEFAULT_POLICY,
      agentProactivePaidTurnsPerHour: 10,
      agentProactivePaidTurnsPerDay: 10,
      senseRecoveryPaidTurnsPer15m: 10,
      senseRecoveryPaidTurnsPerDay: 1,
    }
    expect(reserveAutonomyBudget(senseDayRoot, baseRequest({
      idempotencyKey: "bb-recovery:sense-day-1",
      target: { messageGuid: "sense-day-1" },
      now: "2026-07-09T00:00:00.000Z",
    }), senseDayPolicy).allowed).toBe(true)
    expect(reserveAutonomyBudget(senseDayRoot, baseRequest({
      idempotencyKey: "bb-recovery:sense-day-2",
      target: { messageGuid: "sense-day-2" },
      now: "2026-07-09T23:00:00.000Z",
    }), senseDayPolicy).reason).toContain("sense recovery paid turn budget exceeded for day")
  })

  it("deduplicates idempotency keys within their ttl and writes a skipped receipt", () => {
    const agentRoot = tempAgentRoot()
    expect(reserveAutonomyBudget(agentRoot, baseRequest()).allowed).toBe(true)

    const duplicate = reserveAutonomyBudget(agentRoot, baseRequest({
      now: "2026-07-09T17:02:00.000Z",
    }))

    expect(duplicate).toMatchObject({
      allowed: false,
      status: "duplicate",
      actor: "agent-runnable",
      reason: "duplicate trigger suppressed",
    })
    expect(readAutonomyBudgetState(agentRoot).reservations).toHaveLength(1)
    expect(fs.existsSync(path.join(autonomyReceiptsDir(agentRoot), `${duplicate.receiptId}.json`))).toBe(true)
  })

  it("treats malformed budget and storm state as empty without leaking content", () => {
    const agentRoot = tempAgentRoot()
    fs.mkdirSync(path.dirname(autonomyBudgetStatePath(agentRoot)), { recursive: true })
    fs.writeFileSync(autonomyBudgetStatePath(agentRoot), "{not-json with secret text}", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "state", "autonomy", "storm-breakers.jsonl"), [
      "{bad-json with secret text}",
      JSON.stringify({ schemaVersion: 1, contentStored: true, fingerprint: "ignored" }),
      "",
    ].join("\n"), "utf-8")

    expect(readAutonomyBudgetState(agentRoot).reservations).toEqual([])
    expect(readAutonomyStormBreakers(agentRoot)).toEqual([])
    const allowed = reserveAutonomyBudget(agentRoot, baseRequest({
      storm: {
        agent: "slugger",
        triggerType: "recovery",
        sourceKind: "sense",
        senseOrHabit: "bluebubbles",
        provider: "minimax",
        target: { messageGuid: "msg-1", transcript: "never store this" },
        normalizedErrorName: "TimeoutError",
        normalizedErrorCode: "ETIMEDOUT",
        codeLocation: "bluebubbles/recovery",
        idempotencyBucket: "bb-recovery",
      },
    }))

    expect(allowed.allowed).toBe(true)
    expect(fs.readFileSync(autonomyBudgetStatePath(agentRoot), "utf-8")).not.toContain("never store this")
  })

  it("normalizes parseable malformed state and uses current time when no timestamp is supplied", () => {
    const agentRoot = tempAgentRoot()
    fs.mkdirSync(path.dirname(autonomyBudgetStatePath(agentRoot)), { recursive: true })
    fs.writeFileSync(autonomyBudgetStatePath(agentRoot), JSON.stringify({
      updatedAt: 123,
      reservations: "not-an-array",
      failures: "not-an-array",
    }), "utf-8")

    expect(readAutonomyBudgetState(agentRoot)).toEqual(expect.objectContaining({
      schemaVersion: 1,
      reservations: [],
      failures: [],
    }))
    expect(reserveAutonomyBudget(agentRoot, {
      ...baseRequest({
        idempotencyKey: "bb-recovery:no-now",
        target: { messageGuid: "no-now" },
      }),
      now: undefined,
    }).allowed).toBe(true)
  })

  it("deduplicates habit idempotency keys with the habit ttl", () => {
    const agentRoot = tempAgentRoot()
    const request = {
      agent: "slugger",
      triggerType: "habit" as const,
      sourceKind: "private-runtime" as const,
      senseOrHabit: "rsvp",
      target: { habitName: "rsvp", body: "never store habit text" },
      idempotencyKey: "habit:rsvp:2026-07-09",
      now: "2026-07-09T17:00:00.000Z",
    }
    expect(reserveAutonomyBudget(agentRoot, request).allowed).toBe(true)

    const duplicate = reserveAutonomyBudget(agentRoot, {
      ...request,
      now: "2026-07-10T16:59:00.000Z",
    })

    expect(duplicate.status).toBe("duplicate")
    expect(fs.readFileSync(path.join(autonomyReceiptsDir(agentRoot), `${duplicate.receiptId}.json`), "utf-8")).not.toContain("never store habit text")
  })

  it("enforces the per-habit daily paid-turn budget", () => {
    const agentRoot = tempAgentRoot()
    const policy = {
      ...AUTONOMY_BUDGET_DEFAULT_POLICY,
      agentProactivePaidTurnsPerHour: 10,
      agentProactivePaidTurnsPerDay: 10,
      habitPaidTurnsPerDay: 1,
    }
    const request = {
      agent: "slugger",
      triggerType: "habit" as const,
      sourceKind: "private-runtime" as const,
      senseOrHabit: "rsvp",
      target: { habitName: "rsvp" },
      idempotencyKey: "habit:rsvp:first",
      now: "2026-07-09T17:00:00.000Z",
    }

    expect(reserveAutonomyBudget(agentRoot, request, policy).allowed).toBe(true)
    expect(reserveAutonomyBudget(agentRoot, {
      ...request,
      idempotencyKey: "habit:rsvp:second",
      now: "2026-07-09T18:00:00.000Z",
    }, policy)).toMatchObject({
      allowed: false,
      reason: "habit paid turn budget exceeded for day",
    })
  })

  it("marks failed reservations retryable while still counting the attempted turn", () => {
    const agentRoot = tempAgentRoot()
    const failure = {
      agent: "slugger",
      triggerType: "recovery" as const,
      sourceKind: "sense" as const,
      senseOrHabit: "bluebubbles",
      provider: "minimax",
      target: { messageGuid: "retry-me", transcript: "do not store retry text" },
      normalizedErrorName: "TimeoutError",
      normalizedErrorCode: "ETIMEDOUT",
      codeLocation: "bluebubbles/recovery",
      idempotencyBucket: "bb-recovery",
    }
    expect(reserveAutonomyBudget(agentRoot, baseRequest({
      idempotencyKey: "bb-recovery:retry-me",
      target: failure.target,
    })).allowed).toBe(true)
    expect(reserveAutonomyBudget(agentRoot, baseRequest({
      idempotencyKey: "bb-recovery:unrelated",
      target: { messageGuid: "unrelated", transcript: "do not store retry text" },
    })).allowed).toBe(true)

    recordAutonomyFailure(agentRoot, { ...failure, occurredAt: "2026-07-09T17:01:00.000Z" })
    const retry = reserveAutonomyBudget(agentRoot, baseRequest({
      idempotencyKey: "bb-recovery:retry-me",
      target: failure.target,
      now: "2026-07-09T17:02:00.000Z",
    }))

    const state = readAutonomyBudgetState(agentRoot)
    expect(retry.allowed).toBe(true)
    expect(state.reservations).toHaveLength(3)
    expect(state.reservations[0]).toEqual(expect.objectContaining({ status: "failed" }))
    expect(state.reservations[1]).toEqual(expect.objectContaining({ status: "reserved" }))
    expect(JSON.stringify(state)).not.toContain("do not store retry text")
  })

  it("blocks only matching storm fingerprints after repeated failures and expires the block", () => {
    const agentRoot = tempAgentRoot()
    const failure = {
      agent: "slugger",
      triggerType: "recovery" as const,
      sourceKind: "sense" as const,
      senseOrHabit: "bluebubbles",
      provider: "minimax",
      target: { chat: "chat-1", transcript: "do not store storm text" },
      normalizedErrorName: "TimeoutError",
      normalizedErrorCode: "ETIMEDOUT",
      codeLocation: "bluebubbles/recovery",
      idempotencyBucket: "bb-recovery",
    }
    recordAutonomyFailure(agentRoot, { ...failure, occurredAt: "2026-07-09T17:00:00.000Z" })
    recordAutonomyFailure(agentRoot, { ...failure, occurredAt: "2026-07-09T17:04:00.000Z" })
    recordAutonomyFailure(agentRoot, { ...failure, occurredAt: "2026-07-09T17:08:00.000Z" })

    const blocked = reserveAutonomyBudget(agentRoot, baseRequest({
      target: { chat: "chat-1", transcript: "do not store storm text" },
      idempotencyKey: "bb-recovery:storm",
      now: "2026-07-09T17:09:00.000Z",
      storm: failure,
    }))
    const differentTarget = reserveAutonomyBudget(agentRoot, baseRequest({
      target: { chat: "chat-2", transcript: "do not store storm text" },
      idempotencyKey: "bb-recovery:other-chat",
      now: "2026-07-09T17:09:00.000Z",
      storm: { ...failure, target: { chat: "chat-2", transcript: "do not store storm text" } },
    }))
    const expired = reserveAutonomyBudget(agentRoot, baseRequest({
      target: { chat: "chat-1", transcript: "do not store storm text" },
      idempotencyKey: "bb-recovery:storm-expired",
      now: "2026-07-09T17:39:01.000Z",
      storm: failure,
    }))
    const breaker = readAutonomyStormBreakers(agentRoot)[0]!
    fs.appendFileSync(path.join(agentRoot, "state", "autonomy", "storm-breakers.jsonl"), `${JSON.stringify({
      ...breaker,
      blockedAt: "2026-07-09T17:08:30.000Z",
      blockedUntil: "2026-07-09T17:38:30.000Z",
    })}\n`, "utf-8")
    const sortedBreakerBlock = reserveAutonomyBudget(agentRoot, baseRequest({
      target: { chat: "chat-1", transcript: "do not store storm text" },
      idempotencyKey: "bb-recovery:storm-sorted",
      now: "2026-07-09T17:09:30.000Z",
      storm: failure,
    }))

    expect(readAutonomyStormBreakers(agentRoot)).toHaveLength(2)
    expect(blocked).toMatchObject({
      allowed: false,
      status: "blocked",
      reason: expect.stringContaining("storm breaker active"),
    })
    expect(sortedBreakerBlock.allowed).toBe(false)
    expect(differentTarget.allowed).toBe(true)
    expect(expired.allowed).toBe(true)
    expect(fs.readFileSync(path.join(agentRoot, "state", "autonomy", "storm-breakers.jsonl"), "utf-8")).not.toContain("do not store storm text")
  })
})
