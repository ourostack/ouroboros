import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
const mockGetAgentRoot = vi.hoisted(() => vi.fn())

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../../heart/identity", () => ({
  getAgentName: () => "testagent",
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
  loadAgentConfig: () => ({
    name: "testagent",
    provider: "minimax",
    phrases: { thinking: [], tool: [], followup: [] },
  }),
}))

vi.mock("../../../heart/config", () => ({
  sanitizeKey: (value: string) => value.replace(/[^a-zA-Z0-9;+.-]+/g, "_"),
  getBlueBubblesConfig: () => ({
    serverUrl: "http://bluebubbles.local",
    password: "secret-token",
    accountId: "default",
    ownHandles: [],
  }),
  getBlueBubblesChannelConfig: () => ({
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  }),
  sessionPath: () => "/tmp/bluebubbles-session.json",
}))

vi.mock("../../../heart/core", () => ({
  runAgent: vi.fn(),
  createSummarize: () => vi.fn(),
}))

vi.mock("../../../mind/prompt", () => ({
  buildSystem: vi.fn(),
  flattenSystemPrompt: () => "system prompt",
}))

vi.mock("../../../mind/context", () => ({
  loadSession: () => null,
  saveSession: vi.fn(),
  postTurnTrim: vi.fn(),
  postTurnPersist: vi.fn(),
  deferPostTurnPersist: vi.fn(),
}))

vi.mock("../../../mind/pending", () => ({
  getPendingDir: () => "/tmp/pending",
  drainPending: () => [],
  drainDeferredReturns: () => [],
}))

vi.mock("../../../senses/trust-gate", () => ({
  enforceTrustGate: () => ({ allowed: true }),
}))

import {
  AUTONOMY_BUDGET_DEFAULT_POLICY,
  autonomyReceiptsDir,
  readAutonomyStormBreakers,
  reserveAutonomyBudget,
} from "../../../heart/autonomy-budget"
import {
  buildBlueBubblesSemanticCapture,
  initializeBlueBubblesSemanticCutover,
  listPendingBlueBubblesSemanticCaptures,
  writeBlueBubblesSemanticCapture,
} from "../../../senses/bluebubbles/semantic-receipts"
import { recoverCapturedBlueBubblesInboundMessages } from "../../../senses/bluebubbles"

function tempAgentRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-bb-recovery-budget-"))
}

function repairedMessage(messageGuid: string) {
  return {
    kind: "message" as const,
    eventType: "new-message",
    messageGuid,
    timestamp: Date.parse("2026-07-09T17:00:00.000Z"),
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: "ari@mendelow.me",
      rawId: "ari@mendelow.me",
      displayName: "ari@mendelow.me",
      observed: true,
    },
    chat: {
      chatGuid: "any;-;ari@mendelow.me",
      chatIdentifier: "ari@mendelow.me",
      isGroup: false,
      sessionKey: "chat:any;-;ari@mendelow.me",
      sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
      participantHandles: [],
    },
    text: "who is pending?",
    textForAgent: "who is pending?",
    attachments: [],
    hasPayloadData: false,
    requiresRepair: false,
  }
}

function recordSemanticMessage(messageGuid: string): void {
  const cutover = initializeBlueBubblesSemanticCutover("testagent", {
    now: () => new Date("2026-07-09T16:59:00.000Z"),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
  })
  const capture = buildBlueBubblesSemanticCapture({
    cutover,
    capturedAt: "2026-07-09T17:00:00.000Z",
    event: repairedMessage(messageGuid),
    targetAuthorship: null,
  })
  if (!capture) throw new Error("failed to build semantic recovery fixture")
  writeBlueBubblesSemanticCapture("testagent", capture)
}

function repairedMessageWithoutRoute(messageGuid: string) {
  const repaired = repairedMessage(messageGuid)
  return {
    ...repaired,
    chat: {
      isGroup: false,
      sessionKey: "chat:route-missing",
      sendTarget: { kind: "chat_identifier" as const, value: "route-missing" },
      participantHandles: [],
    },
  }
}

describe("BlueBubbles recovery autonomy budget", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockEmitNervesEvent.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("skips over-budget recovery before the provider path and leaves a receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-07-09T17:00:00.000Z"))
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    for (let index = 0; index < AUTONOMY_BUDGET_DEFAULT_POLICY.senseRecoveryPaidTurnsPer15m; index++) {
      reserveAutonomyBudget(agentRoot, {
        agent: "testagent",
        triggerType: "recovery",
        sourceKind: "sense",
        senseOrHabit: "bluebubbles",
        target: { messageGuid: `prior-${index}`, text: "do not store prior text" },
        idempotencyKey: `bb-recovery:prior-${index}`,
        now: "2026-07-09T17:00:00.000Z",
      })
    }
    recordSemanticMessage("blocked-message-guid")
    const runAgent = vi.fn()

    const result = await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({
        repairEvent: vi.fn(async () => repairedMessage("blocked-message-guid")),
      } as any),
      runAgent: runAgent as any,
    })

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, failed: 0 }))
    expect(runAgent).not.toHaveBeenCalled()
    expect(fs.readdirSync(autonomyReceiptsDir(agentRoot)).some((name) => name.endsWith(".json"))).toBe(true)
    expect(JSON.stringify(result)).not.toContain("who is pending")
  })

  it("keeps an over-budget message pending so a later recovery pass retries it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-07-09T17:00:00.000Z"))
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    for (let index = 0; index < AUTONOMY_BUDGET_DEFAULT_POLICY.senseRecoveryPaidTurnsPer15m; index++) {
      reserveAutonomyBudget(agentRoot, {
        agent: "testagent",
        triggerType: "recovery",
        sourceKind: "sense",
        senseOrHabit: "bluebubbles",
        target: { messageGuid: `prior-release-${index}`, text: "do not store prior text" },
        idempotencyKey: `bb-recovery:prior-release-${index}`,
        now: "2026-07-09T17:00:00.000Z",
      })
    }
    recordSemanticMessage("blocked-release-guid")
    const repairEvent = vi.fn(async () => repairedMessage("blocked-release-guid"))

    const first = await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({ repairEvent } as any),
      runAgent: vi.fn() as any,
    })
    const second = await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({ repairEvent } as any),
      runAgent: vi.fn() as any,
    })

    expect(first).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, failed: 0 }))
    expect(second).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, failed: 0 }))
    expect(repairEvent).toHaveBeenCalledTimes(2)
    expect(listPendingBlueBubblesSemanticCaptures("testagent").map((capture) => capture.event.eventGuid))
      .toContain("blocked-release-guid")
  })

  it("keeps a storm-breaker-blocked message pending and recovers it after the breaker lifts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-26T15:00:00.000Z"))
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    recordSemanticMessage("storm-blocked-guid")
    const failingRepair = vi.fn(async () => {
      throw new Error("identity resolution failed")
    })
    for (let attempt = 0; attempt < AUTONOMY_BUDGET_DEFAULT_POLICY.stormFailureThreshold; attempt++) {
      const failed = await recoverCapturedBlueBubblesInboundMessages({
        getAgentName: () => "testagent",
        createClient: () => ({ repairEvent: failingRepair } as any),
        runAgent: vi.fn() as any,
      })
      expect(failed).toEqual(expect.objectContaining({ recovered: 0, failed: 1 }))
    }
    const [breaker] = readAutonomyStormBreakers(agentRoot)
    expect(breaker).toBeDefined()
    expect(Date.parse(breaker.blockedUntil)).toBeGreaterThan(Date.now())

    const repairEvent = vi.fn(async () => repairedMessage("storm-blocked-guid"))
    const blocked = await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({ repairEvent } as any),
      runAgent: vi.fn() as any,
    })
    expect(blocked).toEqual(expect.objectContaining({ recovered: 0, skipped: 1, failed: 0 }))
    expect(listPendingBlueBubblesSemanticCaptures("testagent").map((capture) => capture.event.eventGuid))
      .toContain("storm-blocked-guid")

    vi.setSystemTime(Date.parse(breaker.blockedUntil) + 1_000)
    mockEmitNervesEvent.mockClear()
    await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({ repairEvent } as any),
      runAgent: vi.fn() as any,
    })

    expect(repairEvent).toHaveBeenCalledTimes(2)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.autonomy_budget_allowed",
    }))
  })

  it("fails an unresolved repaired route before starting over-budget recovery work", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-07-09T17:00:00.000Z"))
    const agentRoot = tempAgentRoot()
    mockGetAgentRoot.mockReturnValue(agentRoot)
    for (let index = 0; index < AUTONOMY_BUDGET_DEFAULT_POLICY.senseRecoveryPaidTurnsPer15m; index++) {
      reserveAutonomyBudget(agentRoot, {
        agent: "testagent",
        triggerType: "recovery",
        sourceKind: "sense",
        senseOrHabit: "bluebubbles",
        target: { messageGuid: `prior-route-missing-${index}`, text: "do not store prior text" },
        idempotencyKey: `bb-recovery:prior-route-missing-${index}`,
        now: "2026-07-09T17:00:00.000Z",
      })
    }
    recordSemanticMessage("route-missing-guid")
    const runAgent = vi.fn()

    const result = await recoverCapturedBlueBubblesInboundMessages({
      getAgentName: () => "testagent",
      createClient: () => ({
        repairEvent: vi.fn(async () => repairedMessageWithoutRoute("route-missing-guid")),
      } as any),
      runAgent: runAgent as any,
    })

    expect(result).toEqual(expect.objectContaining({ recovered: 0, skipped: 0, failed: 1 }))
    expect(runAgent).not.toHaveBeenCalled()
  })
})
