import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"

const pipeline = vi.hoisted(() => ({
  agentName: "",
  agentRoot: "",
  barrier: null as null | { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> },
  contextCount: 0,
  toolCount: 0,
  runAgent: vi.fn(),
}))

vi.mock("../../heart/core", async () => {
  const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
  return { ...actual, runAgent: (...args: unknown[]) => pipeline.runAgent(...args) }
})

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: () => pipeline.agentName || actual.getAgentName(),
    getAgentRoot: () => pipeline.agentRoot || actual.getAgentRoot(),
  }
})

vi.mock("../../heart/turn-context", async () => {
  const actual = await vi.importActual<typeof import("../../heart/turn-context")>("../../heart/turn-context")
  return {
    ...actual,
    buildTurnContext: async (...args: Parameters<typeof actual.buildTurnContext>) => {
      const context = await actual.buildTurnContext(...args)
      pipeline.contextCount += 1
      const barrier = pipeline.barrier
      if (barrier) {
        barrier.entered.resolve()
        await barrier.release.promise
      }
      return context
    },
  }
})

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return { ...actual, createBridgeManager: () => ({ findBridgesForSession: () => [] }) }
})

vi.mock("../../mind/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../mind/prompt")>("../../mind/prompt")
  return { ...actual, buildSystem: vi.fn(async () => ({ stable: "System", volatile: "" })) }
})

import { createProductionTelegramRelationshipComposition, createTelegramSenseApp } from "../../senses/telegram"
import type { TelegramLongPollOptions } from "../../senses/telegram-client"
import { loadSessionEnvelopeFile } from "../../heart/session-events"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { patchRuntimeConfig, resetConfigCache } from "../../heart/config"
import { getSenseSessionPath } from "../../senses/shared-turn"

const roots: string[] = []
afterEach(() => {
  pipeline.agentName = ""
  pipeline.agentRoot = ""
  pipeline.barrier = null
  pipeline.contextCount = 0
  pipeline.toolCount = 0
  pipeline.runAgent.mockReset()
  resetConfigCache()
  resetIdentity()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Telegram admission live authority", () => {
  it("carries the exact live envelope into the real pipeline and stops completely when revoked before provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-live-authority-"))
    roots.push(root)
    pipeline.agentName = "butler-live-authority"
    pipeline.agentRoot = root
    setAgentName(pipeline.agentName)
    patchRuntimeConfig({ context: { maxTokens: 80_000, contextMargin: 20 } })
    fs.writeFileSync(path.join(root, "tool-profiles.json"), JSON.stringify({ version: 2, profiles: {
      "sanctuary-owner": { version: 1, contextScopes: ["household.private"], toolNames: [], effectScopes: ["telegram.owner_event", "telegram.proactive"] },
      "sanctuary-household": { version: 1, contextScopes: ["own_requests"], toolNames: [], effectScopes: ["telegram.request_return"] },
    } }))
    const friends = new FileFriendStore(path.join(root, "friends"))
    const now = new Date().toISOString()
    await friends.put("ari", { id: "ari", name: "Ari", trustLevel: "family", admissionState: "active", initiativePolicy: "proactive", capabilityProfileId: "sanctuary-owner",
      externalIds: [{ provider: "telegram-user", externalId: "42", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })
    await friends.put("sibling", { id: "sibling", name: "Household member", trustLevel: "friend", admissionState: "active", initiativePolicy: "request_follow_up_only", capabilityProfileId: "sanctuary-household",
      externalIds: [{ provider: "telegram-user", externalId: "888", tenantId: "777", linkedAt: now }], tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0, createdAt: now, updatedAt: now, schemaVersion: 1 })
    const credentials = { botToken: "777:secret", botId: "777", authorizedUserId: "42", authorizedChatId: "42" }
    const composition = await createProductionTelegramRelationshipComposition(pipeline.agentName, credentials, root)
    let pollOptions!: TelegramLongPollOptions
    const requests: Array<{ method: string; body: Record<string, unknown> }> = []
    let deliveryCount = 0
    let effectCount = 0
    const app = createTelegramSenseApp({
      agentName: pipeline.agentName,
      credentials,
      _agentRoot: root,
      ...composition,
      api: { request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        effectCount += 1
        if (method === "sendMessage") deliveryCount += 1
        requests.push({ method, body })
        return method === "sendMessage" ? { message_id: requests.length } : true
      }), stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options) => { pollOptions = options; return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() } },
      migrateIdentity: async () => undefined,
    })

    let receivedAuthorization: unknown
    pipeline.runAgent.mockImplementationOnce(async (_messages, callbacks, _channel, _signal, options) => {
      receivedAuthorization = options.toolContext.relationshipAuthorization
      callbacks.onModelStart()
      pipeline.toolCount += 1
      callbacks.onToolStart("observed_tool", {})
      callbacks.onToolEnd("observed_tool", "observed", true)
      callbacks.onTextChunk("Happy to help.")
      return { outcome: "settled", usage: { input_tokens: 1, output_tokens: 1, reasoning_tokens: 0, total_tokens: 2 } }
    })
    await pollOptions.onUnknownMessage!({ updateId: 1, messageId: 1, botId: "777", userId: "888", chatId: "888", text: "hello", displayLabel: "Sibling", hasAttachments: false })
    const sessionPath = getSenseSessionPath(pipeline.agentName, "sibling", "telegram", "telegram:777:888", root)
    const positiveEnvelope = loadSessionEnvelopeFile(sessionPath)!
    const positiveIngress = positiveEnvelope.events.find((event) => event.role === "user" && event.content === "hello")!
    expect(receivedAuthorization).toMatchObject({
      authorizedContextScopes: ["own_requests"],
      advertisedToolNames: [],
      actor: { friendId: "sibling", trustLevel: "friend", sessionEventId: positiveIngress.id },
    })
    expect(requests.filter((request) => request.method === "sendMessage")).toHaveLength(1)
    expect({ provider: pipeline.runAgent.mock.calls.length, tools: pipeline.toolCount, deliveries: deliveryCount, effects: effectCount }).toEqual({ provider: 1, tools: 1, deliveries: 1, effects: 1 })

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    pipeline.barrier = { entered, release }
    const turn = pollOptions.onUnknownMessage!({ updateId: 2, messageId: 2, botId: "777", userId: "888", chatId: "888", text: "race", displayLabel: "Sibling", hasAttachments: false })
    await entered.promise
    const atBarrier = fs.readFileSync(sessionPath, "utf8")
    const friend = await friends.get("sibling")
    await friends.put("sibling", { ...friend!, admissionState: "revoked", initiativePolicy: "none", updatedAt: new Date().toISOString() })
    const countersAtBarrier = { context: pipeline.contextCount, provider: pipeline.runAgent.mock.calls.length, tools: pipeline.toolCount, deliveries: deliveryCount, effects: effectCount }
    release.resolve()
    await expect(turn).rejects.toThrow(/identity binding is not active/iu)
    expect({ context: pipeline.contextCount, provider: pipeline.runAgent.mock.calls.length, tools: pipeline.toolCount, deliveries: deliveryCount, effects: effectCount }).toEqual(countersAtBarrier)
    expect(fs.readFileSync(sessionPath, "utf8")).toBe(atBarrier)
    await app.stop()
  })
})
