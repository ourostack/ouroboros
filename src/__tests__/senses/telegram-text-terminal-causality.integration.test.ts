import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createHmac } from "node:crypto"
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
import { saveSession } from "../../mind/context"
import { createTelegramSenseApp, opaqueTelegramSubject } from "../../senses/telegram"
import { getSenseSessionPath } from "../../senses/shared-turn"
import type { TelegramInboundMessage, TelegramLongPollOptions } from "../../senses/telegram-client"
import * as nervesRuntime from "../../nerves/runtime"
import type { ProviderRuntime } from "../../heart/core"

const DRAFT = "Yes, I can see titles like The Pitt."
const MID_TURN = "i found the shelf — checking the final count now"
const FINAL = "Yes, the shelf is visible again. I can see 11,870 movies and episodes."
const OLD_ANSWER = "UNMISTAKABLE OLD ANSWER THAT MUST NEVER RETURN"
const CATALOG_RESULT = JSON.stringify({
  ok: true,
  data: { totalItems: 11_870, matchedItems: 1, items: [{ untrustedTitle: "The Pitt" }] },
})

describe("Telegram text-terminal delivery causality", () => {
  let originalArgv: string[]
  const identityKey = "k".repeat(43)
  const botToken = "777:fake-telegram-token"
  const userId = "42"
  const chatId = "42"
  const subject = opaqueTelegramSubject(identityKey, botToken, userId, chatId)
  const friendId = `telegram-user:${subject}`
  const sessionKey = `telegram:${subject}`

  beforeEach(async () => {
    originalArgv = process.argv
    process.argv = [...process.argv, "--agent", "sanctuary"]
    harness.agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-text-terminal-causality-"))
    fs.cpSync(path.resolve("deploy/unraid/sanctuary.ouro"), harness.agentRoot, { recursive: true })
    harness.runAgent.mockReset()
    resetConfigCache()
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
  })

  afterEach(() => {
    process.argv = originalArgv
    resetConfigCache()
    resetIdentity()
    fs.rmSync(harness.agentRoot, { recursive: true, force: true })
  })

  function createAuthorizedApp(apiRequest: ReturnType<typeof vi.fn>) {
    let onMessage!: (message: TelegramInboundMessage) => Promise<void>
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
    return { app, onMessage: (message: TelegramInboundMessage) => onMessage(message) }
  }

  function readArtifacts(): any[] {
    const journalRoot = path.join(harness.agentRoot, "state", "telegram", "effects")
    return fs.readdirSync(journalRoot).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(journalRoot, name), "utf8")))
  }

  function loadOnlySession() {
    const sessionFiles = fs.readdirSync(path.join(harness.agentRoot, "state", "sessions", friendId, "telegram")).filter((name) => name.endsWith(".json"))
    expect(sessionFiles).toHaveLength(1)
    return loadSessionEnvelopeFile(path.join(harness.agentRoot, "state", "sessions", friendId, "telegram", sessionFiles[0]!))!
  }

  it("A003 runs a rejected attempt through real core before one catalog receipt and one visible terminal", async () => {
    const prior: any[] = [{ role: "system", content: "System" }]
    for (let index = 0; index < 12; index++) prior.push({ role: "user", content: `Old question ${index}` }, { role: "assistant", content: OLD_ANSWER })
    const sessionPath = getSenseSessionPath("sanctuary", friendId, "telegram", sessionKey, harness.agentRoot)
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    saveSession(sessionPath, prior)
    const rejected = "REJECTED UNGROUNDED CATALOG DRAFT"
    const callerViews: any[][] = []
    const providerViews: any[][] = []
    const generated: any[][] = []
    const execTool = vi.fn(async () => CATALOG_RESULT)
    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any, channel: string, signal: AbortSignal | undefined, options: any) => {
      expect(messages.length).toBeGreaterThan(20)
      const ingress = messages.findLast((message) => message.role === "user")
      messages.splice(0, messages.length, { role: "system", content: "System" }, ingress)
      const runtime: ProviderRuntime = {
        id: "minimax", model: "a003-telegram-fixture", client: {}, capabilities: new Set(),
        resetTurnState: vi.fn(), appendToolOutput: vi.fn(), ping: vi.fn(), classifyError: () => "unknown",
        streamTurn: async (request) => {
          callerViews.push(structuredClone(messages))
          providerViews.push(structuredClone(request.messages))
          const step = providerViews.length
          const content = step === 1 ? rejected : step === 2 ? DRAFT : FINAL
          request.callbacks.onTextChunk(content)
          return {
            content,
            toolCalls: step === 2 ? [{ id: "a003-catalog-read", name: "sanctuary_search_media_catalog", arguments: '{"query":""}' }] : [],
            outputItems: [],
          }
        },
      }
      const actual = await vi.importActual<typeof import("../../heart/core")>("../../heart/core")
      return actual.runAgent(messages, callbacks, channel as any, signal, {
        ...options, providerRuntimeOverride: runtime, execTool, skipKeptNotes: true,
        captureGeneratedMessages: (accepted: any[]) => { generated.push(structuredClone(accepted)); options.captureGeneratedMessages?.(accepted) },
      })
    })
    const apiRequest = vi.fn(async () => ({ message_id: 4243 }))
    const { app, onMessage } = createAuthorizedApp(apiRequest)
    try {
      await onMessage({ updateId: 2001, messageId: "2002", userId, chatId, text: "Can you see the library now?" })
      expect(execTool).toHaveBeenCalledOnce()
      expect(apiRequest.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([
        ["sendMessage", { chat_id: chatId, text: FINAL, parse_mode: "HTML" }, undefined],
      ])
      expect(providerViews).toHaveLength(3)
      expect(JSON.stringify(providerViews[1])).toContain(rejected)
      expect(JSON.stringify(providerViews[1])).toContain("Missing required tool calls")
      expect(JSON.stringify(callerViews)).not.toContain(rejected)
      expect(JSON.stringify(callerViews)).not.toContain("Missing required tool calls")
      expect(JSON.stringify(generated)).not.toContain(rejected)
      expect(JSON.stringify(generated)).not.toContain("Missing required tool calls")
      const envelope = loadOnlySession()
      expect(JSON.stringify(envelope)).not.toContain(rejected)
      expect(JSON.stringify(envelope)).not.toContain("Missing required tool calls")
      expect(envelope.events.filter((event) => event.role === "tool" && event.toolCallId === "a003-catalog-read")).toHaveLength(1)
      const terminals = envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)
      expect(terminals).toHaveLength(1)
      const artifacts = readArtifacts()
      expect(artifacts).toHaveLength(1)
      expect(artifacts[0].parts[0].sessionEventId).toBe(terminals[0]!.id)
      expect(artifacts[0].effect.text).toBe(FINAL)
      expect(new Set(FINAL.split(/(?<=[.!?])\s+/u)).size).toBe(FINAL.split(/(?<=[.!?])\s+/u).length)
    } finally { app.stop() }
  })

  it("sends and journals only the final plain assistant answer after substantial history is replaced", async () => {
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    const priorMessages: any[] = [{ role: "system", content: "System" }]
    for (let index = 0; index < 12; index++) priorMessages.push({ role: "user", content: `Old question ${index}` }, { role: "assistant", content: index === 11 ? OLD_ANSWER : `Old answer ${index}` })
    const sessionPath = getSenseSessionPath("sanctuary", friendId, "telegram", sessionKey, harness.agentRoot)
    fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
    saveSession(sessionPath, priorMessages)

    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any, channel: string, _signal: AbortSignal | undefined, options: any) => {
      expect(channel).toBe("telegram")
      expect(options.requiredToolCalls.names).toEqual(["sanctuary_search_media_catalog"])
      const preTrimCount = messages.length
      expect(preTrimCount).toBeGreaterThan(20)
      const currentIngress = messages.findLast((message) => message.role === "user")
      expect(currentIngress?.content).toBe("Can you see the library now?")
      messages.splice(0, messages.length, { role: "system", content: "System" }, currentIngress)

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
      expect(messages.length).toBeLessThan(preTrimCount)
      return {
        outcome: "settled",
        usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 },
      }
    })

    const apiRequest = vi.fn(async () => ({ message_id: 4242 }))
    const { app, onMessage } = createAuthorizedApp(apiRequest)

    try {
      await onMessage({ updateId: 1001, messageId: "1002", userId, chatId, text: "Can you see the library now?" })

      expect(nerves.mock.calls.find(([event]) => event.event === "senses.telegram_turn_error")?.[0]).toBeUndefined()

      const sends = apiRequest.mock.calls.filter(([method]) => method === "sendMessage")
      expect(sends).toEqual([["sendMessage", { chat_id: chatId, text: FINAL, parse_mode: "HTML" }, undefined]])

      const artifacts = readArtifacts()
      expect(artifacts).toHaveLength(1)
      const artifact = artifacts[0]!
      expect(artifact.effect).toEqual({ kind: "text", text: FINAL })
      expect(artifact.parts).toEqual([expect.objectContaining({ index: 0, text: FINAL, state: "session_recorded", messageId: 4242 })])

      const envelope = loadOnlySession()
      const ingressReference = `telegram-inbound:${createHmac("sha256", identityKey).update(["1001", "1002"].join("\0")).digest("hex")}`
      expect(envelope.events.findLast((event) => event.role === "user" && event.content === "Can you see the library now?")?.relations.references).toContain(ingressReference)
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
      const deliveryRelatedAssistants = envelope.events.filter((event) => event.role === "assistant" && (
        event.relations.references.includes(`telegram-artifact:${artifact.id}`)
        || event.relations.references.includes("telegram-message:4242")
      ))
      expect(deliveryRelatedAssistants.map((event) => event.id)).toEqual([canonicalFinal.id])
      expect([sends[0]![1].text, artifact.effect.text, artifact.parts[0].text, canonicalFinal.content]).toEqual([FINAL, FINAL, FINAL, FINAL])
      expect(JSON.stringify(sends[0]![1])).not.toContain(OLD_ANSWER)
      expect(JSON.stringify(artifact)).not.toContain(OLD_ANSWER)
    } finally {
      await app.stop()
    }
  }, 20_000)

  it("reuses the canonical terminal event when the first final send fails before acceptance", async () => {
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk(FINAL)
      messages.push({ role: "assistant", content: FINAL })
      return { outcome: "settled", usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 } }
    })
    let sendAttempt = 0
    const acceptedPayloads: unknown[] = []
    const apiRequest = vi.fn(async (method: string, payload: unknown) => {
      if (method !== "sendMessage") return {}
      sendAttempt += 1
      if (sendAttempt === 1) throw new Error("network failed before Telegram acceptance")
      acceptedPayloads.push(payload)
      return { message_id: 5252 }
    })
    const { app, onMessage } = createAuthorizedApp(apiRequest)

    try {
      await onMessage({ updateId: 2001, messageId: "2002", userId, chatId, text: "Can you see the library now?" })

      expect(nerves.mock.calls.find(([event]) => event.event === "senses.telegram_turn_error")?.[0]).toBeUndefined()
      expect(apiRequest.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(2)
      expect(acceptedPayloads).toEqual([{ chat_id: chatId, text: FINAL, parse_mode: "HTML" }])

      const artifacts = readArtifacts()
      expect(artifacts).toHaveLength(2)
      const failed = artifacts.find((artifact) => artifact.parts[0]?.state === "indeterminate")!
      const accepted = artifacts.find((artifact) => artifact.parts[0]?.state === "session_recorded")!
      expect(failed.effect).toEqual({ kind: "text", text: FINAL })
      expect(failed.parts).toEqual([expect.objectContaining({ index: 0, text: FINAL, state: "indeterminate", attempts: 1 })])
      expect(failed.parts[0].messageId).toBeUndefined()
      expect(failed.parts[0].sessionEventId).toBeUndefined()
      expect(accepted.effect).toEqual({ kind: "text", text: FINAL })
      expect(accepted.parts).toEqual([expect.objectContaining({ index: 0, text: FINAL, state: "session_recorded", messageId: 5252 })])

      const envelope = loadOnlySession()
      expect(envelope.events.filter((event) => event.role === "assistant")).toHaveLength(1)
      const finalEvents = envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)
      expect(finalEvents).toHaveLength(1)
      const canonicalFinal = finalEvents[0]!
      expect(canonicalFinal.provenance.captureKind).toBe("live")
      expect(accepted.parts[0].sessionEventId).toBe(canonicalFinal.id)
      expect(canonicalFinal.relations.references).toEqual(expect.arrayContaining([`telegram-artifact:${accepted.id}`, "telegram-message:5252"]))
      const deliveryRelatedAssistants = envelope.events.filter((event) => event.role === "assistant" && (
        event.relations.references.includes(`telegram-artifact:${accepted.id}`)
        || event.relations.references.includes("telegram-message:5252")
      ))
      expect(deliveryRelatedAssistants.map((event) => event.id)).toEqual([canonicalFinal.id])
      expect(envelope.events.filter((event) => event.role === "assistant" && event.provenance.captureKind === "synthetic")).toEqual([])
      expect(envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)).toHaveLength(1)
    } finally {
      await app.stop()
    }
  }, 20_000)

  it("retries only a failed final after a successful mid-turn speak and binds both accepted effects", async () => {
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk(MID_TURN)
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: "speak-call", type: "function", function: { name: "speak", arguments: JSON.stringify({ message: MID_TURN }) } }] })
      await callbacks.flushNow()
      messages.push({ role: "tool", tool_call_id: "speak-call", content: "(spoken)" })
      callbacks.onToolEnd("speak", "spoken", true)
      callbacks.onModelStart()
      callbacks.onTextChunk(FINAL)
      messages.push({ role: "assistant", content: FINAL })
      return { outcome: "settled", usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 } }
    })
    let sendAttempt = 0
    const apiRequest = vi.fn(async (method: string) => {
      if (method !== "sendMessage") return {}
      sendAttempt += 1
      if (sendAttempt === 2) throw new Error("network failed before final Telegram acceptance")
      return { message_id: sendAttempt === 1 ? 6261 : 6262 }
    })
    const { app, onMessage } = createAuthorizedApp(apiRequest)

    try {
      await onMessage({ updateId: 3001, messageId: "3002", userId, chatId, text: "Can you see the library now?" })

      expect(nerves.mock.calls.find(([event]) => event.event === "senses.telegram_turn_error")?.[0]).toBeUndefined()
      const sends = apiRequest.mock.calls.filter(([method]) => method === "sendMessage")
      expect(sends.map(([, payload]) => payload)).toEqual([
        { chat_id: chatId, text: MID_TURN, parse_mode: "HTML" },
        { chat_id: chatId, text: FINAL, parse_mode: "HTML" },
        { chat_id: chatId, text: FINAL, parse_mode: "HTML" },
      ])
      expect(sends.filter(([, payload]) => payload.text === MID_TURN)).toHaveLength(1)
      expect(nerves.mock.calls.findLast(([event]) => event.event === "senses.telegram_turn_end")?.[0].meta).toMatchObject({ deliveryCount: 2 })

      const artifacts = readArtifacts()
      expect(artifacts).toHaveLength(3)
      const acceptedMid = artifacts.find((artifact) => artifact.effect.text === MID_TURN && artifact.parts[0]?.state === "session_recorded")!
      const failedFinal = artifacts.find((artifact) => artifact.effect.text === FINAL && artifact.parts[0]?.state === "indeterminate")!
      const acceptedFinal = artifacts.find((artifact) => artifact.effect.text === FINAL && artifact.parts[0]?.state === "session_recorded")!
      expect(failedFinal.parts[0]).toEqual(expect.objectContaining({ text: FINAL, attempts: 1 }))

      const envelope = loadOnlySession()
      const speakEvent = envelope.events.find((event) => event.role === "assistant" && event.toolCalls.some((call) => call.function.name === "speak"))!
      const finalEvents = envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)
      expect(finalEvents).toHaveLength(1)
      const finalEvent = finalEvents[0]!
      expect(acceptedMid.parts[0].sessionEventId).toBe(speakEvent.id)
      expect(acceptedFinal.parts[0].sessionEventId).toBe(finalEvent.id)
      expect(speakEvent.relations.references).toEqual(expect.arrayContaining([`telegram-artifact:${acceptedMid.id}`, "telegram-message:6261"]))
      expect(speakEvent.relations.references).not.toContain(`telegram-artifact:${acceptedFinal.id}`)
      expect(finalEvent.relations.references).toEqual(expect.arrayContaining([`telegram-artifact:${acceptedFinal.id}`, "telegram-message:6262"]))
      expect(envelope.events.filter((event) => event.role === "assistant" && event.provenance.captureKind === "synthetic")).toEqual([])
    } finally {
      await app.stop()
    }
  }, 20_000)

  it("does not replay a failed mid-turn speak after the final answer succeeds", async () => {
    const nerves = vi.spyOn(nervesRuntime, "emitNervesEvent")
    harness.runAgent.mockImplementationOnce(async (messages: any[], callbacks: any) => {
      callbacks.onModelStart()
      callbacks.onTextChunk(MID_TURN)
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: "failed-speak-call", type: "function", function: { name: "speak", arguments: JSON.stringify({ message: MID_TURN }) } }] })
      await expect(callbacks.flushNow()).rejects.toThrow("network failed before speak acceptance")
      messages.push({ role: "tool", tool_call_id: "failed-speak-call", content: "delivery failed" })
      callbacks.onToolEnd("speak", "delivery failed", false)
      callbacks.onModelStart()
      callbacks.onTextChunk(FINAL)
      messages.push({ role: "assistant", content: FINAL })
      return { outcome: "settled", usage: { input_tokens: 10, output_tokens: 5, reasoning_tokens: 0, total_tokens: 15 } }
    })
    let sendAttempt = 0
    const apiRequest = vi.fn(async (method: string) => {
      if (method !== "sendMessage") return {}
      sendAttempt += 1
      if (sendAttempt === 1) throw new Error("network failed before speak acceptance")
      return { message_id: 7370 + sendAttempt }
    })
    const { app, onMessage } = createAuthorizedApp(apiRequest)

    try {
      await onMessage({ updateId: 4001, messageId: "4002", userId, chatId, text: "Can you see the library now?" })

      expect(nerves.mock.calls.find(([event]) => event.event === "senses.telegram_turn_error")?.[0]).toBeUndefined()
      const sends = apiRequest.mock.calls.filter(([method]) => method === "sendMessage")
      expect(sends.map(([, payload]) => payload)).toEqual([
        { chat_id: chatId, text: MID_TURN, parse_mode: "HTML" },
        { chat_id: chatId, text: FINAL, parse_mode: "HTML" },
      ])

      const artifacts = readArtifacts()
      expect(artifacts).toHaveLength(2)
      const failedSpeak = artifacts.find((artifact) => artifact.effect.text === MID_TURN)!
      const acceptedFinal = artifacts.find((artifact) => artifact.effect.text === FINAL)!
      expect(failedSpeak.parts[0]).toEqual(expect.objectContaining({ text: MID_TURN, state: "indeterminate", attempts: 1 }))
      expect(acceptedFinal.parts[0]).toEqual(expect.objectContaining({ text: FINAL, state: "session_recorded", messageId: 7372 }))

      const envelope = loadOnlySession()
      const finalEvents = envelope.events.filter((event) => event.role === "assistant" && event.content === FINAL)
      expect(finalEvents).toHaveLength(1)
      expect(acceptedFinal.parts[0].sessionEventId).toBe(finalEvents[0]!.id)
      expect(envelope.events.filter((event) => event.role === "assistant" && event.provenance.captureKind === "synthetic")).toEqual([])
    } finally {
      await app.stop()
    }
  }, 20_000)
})
