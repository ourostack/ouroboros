import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FileFriendStore } from "@ouro.bot/friends"

const harness = vi.hoisted(() => ({
  agentRoot: "",
  runAgent: vi.fn(),
}))

vi.mock("../../heart/core", async () => {
  const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
  return { ...actual, runAgent: (...args: unknown[]) => harness.runAgent(...args) }
})

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: () => "sanctuary",
    getAgentRoot: () => harness.agentRoot,
    getAgentStateRoot: () => path.join(harness.agentRoot, "state"),
    loadAgentConfig: () => JSON.parse(fs.readFileSync(path.join(harness.agentRoot, "agent.json"), "utf8")),
  }
})

vi.mock("../../mind/prompt", async () => {
  const actual = await vi.importActual<typeof import("../../mind/prompt")>("../../mind/prompt")
  return { ...actual, buildSystem: vi.fn(async () => ({ stable: "System", volatile: "" })) }
})

vi.mock("../../heart/bridges/manager", async () => {
  const actual = await vi.importActual<typeof import("../../heart/bridges/manager")>("../../heart/bridges/manager")
  return { ...actual, createBridgeManager: () => ({ findBridgesForSession: () => [] }) }
})

vi.mock("../../repertoire/mcp-manager", async () => {
  const actual = await vi.importActual<typeof import("../../repertoire/mcp-manager")>("../../repertoire/mcp-manager")
  return { ...actual, getSharedMcpManager: vi.fn(async () => null) }
})

import { resetConfigCache } from "../../heart/config"
import { resetIdentity } from "../../heart/identity"
import { loadSessionEnvelopeFile } from "../../heart/session-events"
import { createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import type { TelegramInboundMessage, TelegramLongPollOptions } from "../../senses/telegram-client"
import * as nervesRuntime from "../../nerves/runtime"

const DRAFT = "Yes, I can see titles like The Pitt."
const FINAL = "Yes, the shelf is visible again. I can see 11,870 movies and episodes."
const CATALOG_RESULT = JSON.stringify({
  ok: true,
  data: { totalItems: 11_870, matchedItems: 1, items: [{ untrustedTitle: "The Pitt" }] },
})

describe("Telegram text-terminal delivery causality", () => {
  let originalArgv: string[]

  beforeEach(() => {
    originalArgv = process.argv
    process.argv = [...process.argv, "--agent", "sanctuary"]
    harness.agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-text-terminal-causality-"))
    fs.cpSync(path.resolve("deploy/unraid/sanctuary.ouro"), harness.agentRoot, { recursive: true })
    harness.runAgent.mockReset()
    resetConfigCache()
  })

  afterEach(() => {
    process.argv = originalArgv
    resetConfigCache()
    resetIdentity()
    fs.rmSync(harness.agentRoot, { recursive: true, force: true })
  })

  it("sends and journals only the final plain assistant answer after catalog-tool prose", async () => {
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    const identityKey = "k".repeat(43)
    const botToken = "777:fake-telegram-token"
    const userId = "42"
    const chatId = "42"
    const subject = opaqueTelegramSubject(identityKey, botToken, userId, chatId)
    const friendId = `telegram-user:${subject}`
    const now = "2026-09-05T12:00:00.000Z"
    await new FileFriendStore(path.join(harness.agentRoot, "friends")).put("ari", {
      id: "ari",
      name: "Ari",
      trustLevel: "family",
      admissionState: "active",
      initiativePolicy: "proactive",
      capabilityProfileId: "sanctuary-owner",
      externalIds: [{ provider: "telegram-user", externalId: subject, linkedAt: now }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: now,
      updatedAt: now,
      schemaVersion: 1,
    })

    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any, channel: string, _signal: AbortSignal | undefined, options: any) => {
      expect(channel).toBe("telegram")
      expect(options.requiredToolCalls.names).toEqual(["sanctuary_search_media_catalog"])

      callbacks.onModelStart()
      callbacks.onTextChunk(DRAFT)
      messages.push({
        role: "assistant",
        content: DRAFT,
        tool_calls: [{
          id: "catalog-call",
          type: "function",
          function: { name: "sanctuary_search_media_catalog", arguments: JSON.stringify({ query: "" }) },
        }],
      })
      callbacks.onToolStart("sanctuary_search_media_catalog", { query: "" })
      expect(options.requiredToolCalls.validateRequiredToolResult("sanctuary_search_media_catalog", CATALOG_RESULT, { query: "" })).toBe(true)
      messages.push({ role: "tool", tool_call_id: "catalog-call", content: CATALOG_RESULT })
      callbacks.onToolEnd("sanctuary_search_media_catalog", "catalog visible", true)

      callbacks.onModelStart()
      callbacks.onTextChunk(FINAL)
      messages.push({ role: "assistant", content: FINAL })
      return {
        outcome: "settled",
        usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 },
      }
    })

    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
    const apiRequest = vi.fn(async () => ({ message_id: 4242 }))
    const app = createTelegramSenseApp({
      agentName: "sanctuary",
      credentials: { botToken, authorizedUserId: userId, authorizedChatId: chatId },
      identityKey,
      _agentRoot: harness.agentRoot,
      _toolContext: { signin: async () => undefined, agentRoot: harness.agentRoot } as never,
      api: { request: apiRequest, stop: vi.fn() },
      offsetStore: { load: () => 0, save: vi.fn() },
      createLongPoll: (options: TelegramLongPollOptions) => {
        onMessage = options.onMessage
        return { pollOnce: vi.fn(), run: vi.fn(), stop: vi.fn() }
      },
      approvalTransport: {
        sendApproval: vi.fn(),
        handleUpdate: vi.fn(async () => ({ handled: true, accepted: true, reason: "accepted" })),
        reconcileExpired: vi.fn(),
        terminalizeRecovered: vi.fn(),
      } as never,
      _createInteractiveControl: (() => ({ socketPath: "unused", start: vi.fn(), stop: vi.fn() })) as never,
      migrateIdentity: async () => undefined,
      resolveRelationshipAuthorization: vi.fn(async (input) => ({
        subject: { friendId: input.friendId, trustLevel: "family", admissionState: "active", initiativePolicy: "proactive" },
        profileId: "sanctuary-owner",
        authorizedContextScopes: ["household.status"],
        advertisedToolNames: ["sanctuary_search_media_catalog", "settle"],
        actor: { friendId: input.friendId, trustLevel: "family", sessionEventId: input.sessionEventId },
        authorizeTool: vi.fn(async () => ({ allowed: true })),
      } as any)),
    })

    try {
      await onMessage({ updateId: 1001, messageId: "1002", userId, chatId, text: "Can you see the library now?" })

      expect(nerves.mock.calls.find(([event]) => event.event === "senses.telegram_turn_error")?.[0]).toBeUndefined()

      const sends = apiRequest.mock.calls.filter(([method]) => method === "sendMessage")
      expect(sends).toEqual([["sendMessage", { chat_id: chatId, text: FINAL, parse_mode: "HTML" }, undefined]])

      const journalRoot = path.join(harness.agentRoot, "state", "telegram", "effects")
      const artifactFiles = fs.readdirSync(journalRoot).filter((name) => name.endsWith(".json"))
      expect(artifactFiles).toHaveLength(1)
      const artifact = JSON.parse(fs.readFileSync(path.join(journalRoot, artifactFiles[0]!), "utf8"))
      expect(artifact.effect).toEqual({ kind: "text", text: FINAL })
      expect(artifact.parts).toEqual([expect.objectContaining({ index: 0, text: FINAL, state: "session_recorded", messageId: 4242 })])

      const sessionFiles = fs.readdirSync(path.join(harness.agentRoot, "state", "sessions", friendId, "telegram"))
        .filter((name) => name.endsWith(".json"))
      expect(sessionFiles).toHaveLength(1)
      const envelope = loadSessionEnvelopeFile(path.join(harness.agentRoot, "state", "sessions", friendId, "telegram", sessionFiles[0]!))!
      const finalEvents = envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)
      expect(finalEvents).toHaveLength(1)
      const canonicalFinal = finalEvents[0]!
      expect(canonicalFinal.toolCalls).toEqual([])
      expect(canonicalFinal.provenance.captureKind).toBe("live")
      expect(canonicalFinal.relations.references).toEqual(expect.arrayContaining([
        `telegram-artifact:${artifact.id}`,
        "telegram-message:4242",
      ]))
      expect(artifact.parts[0].sessionEventId).toBe(canonicalFinal.id)
      expect(envelope.events.filter((event) => event.role === "assistant" && event.provenance.captureKind === "synthetic")).toEqual([])

      const draftEvent = envelope.events.find((event) => event.role === "assistant" && event.content === DRAFT)!
      expect(draftEvent.relations.references).not.toContain(`telegram-artifact:${artifact.id}`)
      expect([sends[0]![1].text, artifact.effect.text, artifact.parts[0].text, canonicalFinal.content]).toEqual([FINAL, FINAL, FINAL, FINAL])
    } finally {
      await app.stop()
    }
  }, 20_000)
})
