import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
const mockGetAgentRoot = vi.hoisted(() => vi.fn())

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
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
  postTurnTrim: vi.fn(),
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
  reserveAutonomyBudget,
} from "../../../heart/autonomy-budget"
import { recordBlueBubblesMutation } from "../../../senses/bluebubbles/mutation-log"
import { recoverMissedBlueBubblesMessages } from "../../../senses/bluebubbles"

function tempAgentRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-bb-recovery-budget-"))
}

function mutation(messageGuid: string) {
  return {
    kind: "mutation" as const,
    eventType: "updated-message",
    mutationType: "delivery" as const,
    messageGuid,
    timestamp: Date.parse("2026-07-09T17:00:00.000Z"),
    fromMe: false,
    sender: {
      provider: "imessage-handle" as const,
      externalId: "ari@mendelow.me",
      rawId: "ari@mendelow.me",
      displayName: "ari@mendelow.me",
    },
    chat: {
      chatGuid: "any;-;ari@mendelow.me",
      chatIdentifier: "ari@mendelow.me",
      isGroup: false,
      sessionKey: "chat:any;-;ari@mendelow.me",
      sendTarget: { kind: "chat_guid" as const, value: "any;-;ari@mendelow.me" },
      participantHandles: [],
    },
    shouldNotifyAgent: false,
    textForAgent: "message marked as delivered",
    requiresRepair: false,
  }
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

describe("BlueBubbles recovery autonomy budget", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mockEmitNervesEvent.mockReset()
  })

  it("skips over-budget recovery before the provider path and leaves a receipt", async () => {
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
    recordBlueBubblesMutation("testagent", mutation("blocked-message-guid"))
    const runAgent = vi.fn()

    const result = await recoverMissedBlueBubblesMessages({
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
})
