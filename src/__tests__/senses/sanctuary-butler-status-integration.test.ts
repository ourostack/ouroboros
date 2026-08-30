import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"

const harness = vi.hoisted(() => ({
  agentRoot: "",
  providerCreate: vi.fn(),
}))

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: () => "sanctuary",
    getAgentRoot: () => harness.agentRoot,
    getAgentStateRoot: () => `${harness.agentRoot}/state`,
    loadAgentConfig: () => ({
      name: "sanctuary",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: actual.DEFAULT_AGENT_PHRASES,
    }),
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: harness.providerCreate } }
    responses = { create: vi.fn() }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(() => []), loadSkill: vi.fn() }))
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

import { patchRuntimeConfig, resetConfigCache } from "../../heart/config"
import { readStewardPolicy } from "../../heart/steward-policy"
import { createRelationshipAuthorizationEvaluator, loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramBotApi, TelegramInboundMessage, TelegramLongPoll } from "../../senses/telegram-client"

function stream(chunks: unknown[]) {
  return { [Symbol.asyncIterator]: async function* () { for (const chunk of chunks) yield chunk } }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] }])
}

describe("Sanctuary Telegram stored-status integration", () => {
  beforeEach(() => {
    harness.agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-status-integration-"))
    fs.cpSync(path.resolve("deploy/unraid/sanctuary.ouro"), harness.agentRoot, { recursive: true })
    harness.providerCreate.mockReset()
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "minimax-text-01" } } })
  })

  afterEach(() => {
    resetConfigCache()
    fs.rmSync(harness.agentRoot, { recursive: true, force: true })
  })

  it("turns Ari's natural Books preference into both exact desired states without restart noise and reverses both", async () => {
    const identityKey = "k".repeat(43)
    const botToken = "test-token"
    const userId = "42"
    const chatId = "42"
    const subject = opaqueTelegramSubject(identityKey, botToken, userId, chatId)
    const registry = loadRelationshipCapabilityRegistry(harness.agentRoot)
    const owner = {
      id: "ari", name: "Ari", trustLevel: "family" as const, admissionState: "active" as const, initiativePolicy: "proactive" as const,
      capabilityProfileId: "sanctuary-owner", externalIds: [{ provider: "telegram-user" as const, externalId: subject, linkedAt: "2026-08-29T00:00:00.000Z" }],
      tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: "2026-08-29T00:00:00.000Z", updatedAt: "2026-08-29T00:00:00.000Z", schemaVersion: 1 as const,
    }
    await new FileFriendStore(path.join(harness.agentRoot, "friends")).put(owner.id, owner)
    const relationshipAuthorization = createRelationshipAuthorizationEvaluator({
      friend: owner,
      registry,
      requestId: "telegram-status-request",
      requestPhase: "inbound",
      sessionEventId: "telegram-status-event",
    })
    let advertisedTools: string[] = []
    const invokedTools: string[] = []
    const invoke = (id: string, name: string, args: Record<string, unknown>) => (request: any) => {
      advertisedTools = request.tools.map((tool: any) => tool.function.name)
      invokedTools.push(name)
      return toolCall(id, name, args)
    }
    harness.providerCreate
      .mockImplementationOnce(invoke("read-before-off", "steward_policy_manage", { action: "read" }))
      .mockImplementationOnce(invoke("set-calibre-off", "steward_policy_manage", {
        action: "set_desired_state", expectedVersion: 0, key: "container:calibre", value: "intentionally_off", provenance: "stated", source: "Ari said Books can stay off when unused",
      }))
      .mockImplementationOnce(invoke("set-calibre-web-off", "steward_policy_manage", {
        action: "set_desired_state", expectedVersion: 1, key: "container:calibre-web", value: "intentionally_off", provenance: "stated", source: "Ari said Books can stay off when unused",
      }))
      .mockImplementationOnce(invoke("confirm-off", "settle", { answer: "Got it. I’ll leave Books quietly off until you ask for it again.", intent: "direct_reply" }))
      .mockImplementationOnce(invoke("read-before-on", "steward_policy_manage", { action: "read" }))
      .mockImplementationOnce(invoke("set-calibre-on", "steward_policy_manage", {
        action: "set_desired_state", expectedVersion: 2, key: "container:calibre", value: "on_demand", provenance: "stated", source: "Ari asked for Books again",
      }))
      .mockImplementationOnce(invoke("set-calibre-web-on", "steward_policy_manage", {
        action: "set_desired_state", expectedVersion: 3, key: "container:calibre-web", value: "on_demand", provenance: "stated", source: "Ari asked for Books again",
      }))
      .mockImplementationOnce(invoke("confirm-on", "settle", { answer: "Books is expected on again. I’ll check both parts.", intent: "direct_reply" }))

    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const api: TelegramBotApi = { request: vi.fn(async () => ({ message_id: 71 })), stop: vi.fn() }
    const poll: TelegramLongPoll = { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }
    const sendApproval = vi.fn()
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken, authorizedUserId: userId, authorizedChatId: chatId },
      identityKey,
      _agentRoot: harness.agentRoot,
      _toolContext: { signin: async () => undefined, agentRoot: harness.agentRoot, relationshipAuthorization } as any,
      api,
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { onMessage = options.onMessage; return poll },
      approvalTransport: { sendApproval, handleUpdate: vi.fn(async () => ({ handled: true, accepted: true, reason: "accepted" })), reconcileExpired: vi.fn(), terminalizeRecovered: vi.fn() } as any,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as any,
      migrateIdentity: async () => undefined,
    })

    try {
      await onMessage({ updateId: 1, messageId: "2", userId, chatId, text: "Books can stay off when I’m not using it." })
      expect(advertisedTools).toContain("steward_policy_manage")
      const offPolicy = readStewardPolicy(harness.agentRoot)
      expect(Object.keys(offPolicy.desiredStates).sort()).toEqual(["container:calibre", "container:calibre-web"])
      expect(offPolicy.desiredStates["container:calibre"]?.value).toBe("intentionally_off")
      expect(offPolicy.desiredStates["container:calibre-web"]?.value).toBe("intentionally_off")
      expect(offPolicy.desiredStates["container:books"]).toBeUndefined()

      await onMessage({ updateId: 2, messageId: "3", userId, chatId, text: "I want Books again." })
      const onPolicy = readStewardPolicy(harness.agentRoot)
      expect(Object.keys(onPolicy.desiredStates).sort()).toEqual(["container:calibre", "container:calibre-web"])
      expect(onPolicy.desiredStates["container:calibre"]?.value).toBe("on_demand")
      expect(onPolicy.desiredStates["container:calibre-web"]?.value).toBe("on_demand")
      expect(invokedTools).not.toContain("unraid_restart_container")
      expect(sendApproval).not.toHaveBeenCalled()
      const delivered = vi.mocked(api.request).mock.calls
        .filter(([method]) => method === "sendMessage")
        .map(([, parameters]) => String((parameters as { text?: unknown }).text ?? ""))
      expect(delivered).toEqual([
        "Got it. I’ll leave Books quietly off until you ask for it again.",
        "Books is expected on again. I’ll check both parts.",
      ])
    } finally {
      await app.stop()
    }
  }, 20_000)
})
