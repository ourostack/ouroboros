import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { a003Envelope, a003RetainedHistoryEnvelope, A003_AT } from "../fixtures/a003-session"
import {
  appendSyntheticAssistantEvent,
  buildCanonicalSessionEnvelope,
  parseSessionEnvelope,
  projectProviderMessages,
  projectedSessionEventIds,
  type SessionEnvelope,
} from "../../heart/session-events"
import { computeSessionStats } from "../../heart/session-stats"
import { runSessionPlayback } from "../../heart/session-playback"
import { summarizeSessionTail } from "../../heart/session-transcript"
import { listSessionActivity } from "../../heart/session-activity"
import { readSessionInventory, readSessionTranscript } from "../../heart/mailbox/readers/sessions"
import { loadSession, postTurnPersist, postTurnTrim, type UsageData } from "../../mind/context"
import { currentSessionTurnLease, readSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"
import { estimateTokensForMessages } from "../../mind/token-estimate"
import {
  appendTelegramArtifactEvents,
  appendTelegramInboundEvent,
  executeTelegramEffect,
  FileTelegramEffectJournal,
  prepareTelegramEffect,
  recordTelegramEffectsInSession,
} from "../../senses/telegram-effect-adapter"

vi.mock("../../heart/config", async (original) => ({
  ...await original<typeof import("../../heart/config")>(),
  getContextConfig: () => ({ maxTokens: 800, contextMargin: 20 }),
}))
vi.mock("../../nerves/runtime", async (original) => ({
  ...await original<typeof import("../../nerves/runtime")>(),
  emitNervesEvent: vi.fn(),
}))

const roots: string[] = []
const stores: FileTelegramEffectJournal[] = []
const target = { kind: "approved_relationship" as const, friendId: "ari", sessionKey: "telegram:owner", requestId: "fixture-request" }
const authorization = { allowed: true as const, receiptId: "fixture-authorization", expiresAt: "2099-01-01T00:00:00.000Z", transport: { chatId: "42" } }
const usage: UsageData = { input_tokens: 1_000, output_tokens: 20, reasoning_tokens: 0, total_tokens: 1_020 }
const finalText = "Current choices:\n1. Fresh\n2. Current"

function fixture(envelope = a003RetainedHistoryEnvelope()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-preservation-"))
  roots.push(root)
  const agentRoot = path.join(root, "fixture.ouro")
  const file = path.join(agentRoot, "state", "sessions", "ari", "telegram", "owner.json")
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, JSON.stringify(envelope), { mode: 0o600 })
  return { root, agentRoot, file, envelope }
}

function raw(file: string): SessionEnvelope {
  return JSON.parse(fs.readFileSync(file, "utf8"))
}

async function acceptedReceipt(root: string) {
  const store = new FileTelegramEffectJournal(path.join(root, "effects"))
  stores.push(store)
  const prepared = prepareTelegramEffect(store, {
    idempotencyKey: "fixture-separate-receipt", target, authorClass: "butler",
    effect: { kind: "text", text: "Separate approved receipt." }, authorization,
  })
  const request = vi.fn(async () => ({ message_id: 23 }))
  const artifact = await executeTelegramEffect(store, prepared.id, { request }, () => authorization)
  expect(request).toHaveBeenCalledOnce()
  expect(artifact.parts[0]?.state).toBe("accepted")
  return { store, artifact }
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("D006 native history and projection preservation", () => {
  it("retains the prepared history and real same-lease receipt through two persistence cycles and native readers", async () => {
    const { root, agentRoot, file, envelope } = fixture()
    await withSessionTurnLease(file, async (lease) => {
      expect(currentSessionTurnLease(file)).toBe(lease)
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        ...projectProviderMessages(envelope), { role: "assistant", content: finalText },
      ]
      const prepared = postTurnTrim(messages, usage)
      expect(prepared.currentMessages).toHaveLength(5)
      expect(prepared.currentMessages[1]).toMatchObject({
        role: "assistant", content: expect.stringContaining("Older choices:"),
        tool_calls: [{ id: "historical-read", function: { name: "read_file" } }],
      })
      expect(prepared.trimmedMessages).toEqual([
        { role: "user", content: "current question" }, { role: "assistant", content: finalText },
      ])
      const beforeReceipt = readSessionTransaction(file, lease).revision
      const { store, artifact } = await acceptedReceipt(root)
      await recordTelegramEffectsInSession({ store, sessionPath: file, artifacts: [artifact] })
      const recorded = store.read(artifact.id).parts[0]!
      expect(recorded).toMatchObject({ state: "session_recorded", sessionEventId: "evt-000008", attempts: 1 })
      const receipt = raw(file).events.find((event) => event.id === recorded.sessionEventId)!
      expect(receipt.relations.references).toContain(`telegram-artifact:${artifact.id}`)
      expect(readSessionTransaction(file, lease).revision).not.toBe(beforeReceipt)

      postTurnPersist(file, prepared, usage)
      const first = raw(file)
      expect(first.events).toHaveLength(9)
      for (const event of envelope.events) expect(first.events.find((entry) => entry.id === event.id)).toEqual(event)
      expect(first.events.find((event) => event.id === recorded.sessionEventId)).toEqual(receipt)
      expect(first.projection).toMatchObject({ eventIds: ["evt-000005", "evt-000009"], trimmed: true })
      expect(first.structuredOutputs?.map((output) => output.sourceEventId)).toEqual(["evt-000009"])

      const loaded = loadSession(file)!
      expect(loaded.events).toEqual(first.events)
      expect(loaded.messages).toEqual(prepared.trimmedMessages)
      expect(loaded.structuredOutputs).toEqual(first.structuredOutputs)
      postTurnPersist(file, postTurnTrim([...loaded.messages], { ...usage, input_tokens: 100, total_tokens: 120 }))
      const second = raw(file)
      expect(second.events).toEqual(first.events)
      expect(second.projection).toMatchObject({ eventIds: ["evt-000005", "evt-000009"], trimmed: true })
      expect(second.structuredOutputs).toEqual(first.structuredOutputs)
      expect(store.read(artifact.id).parts[0]?.sessionEventId).toBe(recorded.sessionEventId)

      const transcript = await summarizeSessionTail({ sessionPath: file, friendId: "ari", channel: "telegram", key: "owner", messageCount: 20 })
      expect(transcript.kind).toBe("ok")
      if (transcript.kind !== "ok") throw new Error("fixture transcript missing")
      expect(transcript.tailMessages.map((message) => message.id)).toEqual(["evt-000001", "evt-000002", "evt-000005", "evt-000008", "evt-000009"])
      expect(transcript.transcript).not.toContain("engine-only correction")
      const mailbox = readSessionTranscript("fixture", "ari", "telegram", "owner", { bundlesRoot: root })!
      expect(mailbox.messages.map((event) => event.id)).toEqual(["evt-000001", "evt-000002", "evt-000003", "evt-000004", "evt-000005", "evt-000008", "evt-000009"])
      expect(mailbox.truncatedHistory).toBe(true)
      expect(readSessionInventory("fixture", { bundlesRoot: root }).items[0]).toMatchObject({
        messageCount: 7, latestUserExcerpt: "current question", latestToolCallNames: ["read_file"],
      })
      expect(listSessionActivity({
        sessionsDir: path.join(agentRoot, "state", "sessions"), friendsDir: path.join(agentRoot, "friends"),
        agentName: "fixture", activeThresholdMs: Infinity,
      })[0]).toMatchObject({ lastInboundAt: A003_AT, activitySource: "friend-facing" })
      expect(computeSessionStats(second, file)).toMatchObject({
        totalEvents: 9, toolCalls: { total: 1 }, projection: { eventCount: 2, omittedFromProjection: 7, trimmed: true },
      })
      expect(runSessionPlayback({ sessionPath: file })).toMatchObject({
        inputMessageCount: 2, sanitizedMessageCount: 2, totals: { dropped: 0, syntheticAdded: 0 },
      })
    })
  })

  const states = [
    { name: "selected", eventIds: ["evt-000005"], trimmed: true, expected: ["evt-000005"] },
    { name: "legacy empty", eventIds: [], trimmed: false, expected: ["evt-000001", "evt-000002", "evt-000003", "evt-000004", "evt-000005"] },
    { name: "intentionally empty", eventIds: [], trimmed: true, expected: [] },
  ]

  it.each(states)("keeps $name semantics through parse, native load, stats, playback and two rebuilds", ({ eventIds, trimmed, expected }) => {
    const envelope = a003RetainedHistoryEnvelope()
    envelope.projection = { ...envelope.projection, eventIds, trimmed }
    const { file } = fixture(envelope)
    let current = parseSessionEnvelope(envelope)!
    expect(projectedSessionEventIds(current)).toEqual(expected)
    expect(loadSession(file)?.projectionEventIds).toEqual(expected)
    expect(computeSessionStats(current, file).projection).toMatchObject({
      eventCount: expected.length, omittedFromProjection: 7 - expected.length,
    })
    expect(runSessionPlayback({ sessionPath: file }).inputMessageCount).toBe(expected.length)
    expect(current.structuredOutputs?.map((output) => output.sourceEventId)).toEqual(expected.includes("evt-000002") ? ["evt-000002"] : [])
    for (let cycle = 0; cycle < 2; cycle++) {
      const messages = projectProviderMessages(current)
      current = buildCanonicalSessionEnvelope({
        existing: current, previousMessages: messages, currentMessages: messages, trimmedMessages: messages,
        recordedAt: "2026-09-08T00:00:00.000Z", lastUsage: null, state: null,
        projectionBasis: { maxTokens: 800, contextMargin: 20, inputTokens: 100 },
      }).envelope
      expect(current.events).toEqual(envelope.events)
      expect(current.projection).toMatchObject({ eventIds: expected, trimmed })
      expect(projectProviderMessages(current)).toEqual(messages)
    }
  })

  it.each(states)("preserves $name prior projection through all three native appenders", async ({ eventIds, trimmed, expected }) => {
    const envelope = a003RetainedHistoryEnvelope()
    envelope.projection = { ...envelope.projection, eventIds, trimmed }
    const { root } = fixture(envelope)
    const parsed = parseSessionEnvelope(envelope)!
    const { artifact } = await acceptedReceipt(root)
    const variants = [
      appendSyntheticAssistantEvent(parsed, "Synthetic receipt.", "2026-09-08T00:00:00.000Z"),
      appendTelegramInboundEvent(parsed, { text: "New ingress.", reference: "telegram-inbound:fixture", recordedAt: "2026-09-08T00:00:00.000Z" }),
      appendTelegramArtifactEvents(parsed, artifact, "2026-09-08T00:00:00.000Z").envelope,
    ]
    for (const appended of variants) {
      expect(appended.events.slice(0, 7)).toEqual(envelope.events)
      expect(appended.projection).toMatchObject({ eventIds: [...expected, "evt-000008"], trimmed })
      expect(projectedSessionEventIds(appended)).toEqual([...expected, "evt-000008"])
      expect(parseSessionEnvelope(appended)?.structuredOutputs?.map((output) => output.sourceEventId))
        .toEqual(expected.includes("evt-000002") ? ["evt-000002"] : [])
    }
  })

  it("does not turn unresolved nonempty IDs into a legacy full-history fallback", () => {
    const envelope = a003RetainedHistoryEnvelope()
    envelope.projection = { ...envelope.projection, eventIds: ["missing", "evt-000006", "evt-000007"], trimmed: false }
    const parsed = parseSessionEnvelope(envelope)!
    expect(projectedSessionEventIds(parsed)).toEqual([])
    expect(projectProviderMessages(parsed)).toEqual([])
    const appended = appendSyntheticAssistantEvent(parsed, "New receipt.", "2026-09-08T00:00:00.000Z")
    expect(appended.projection).toMatchObject({ eventIds: ["evt-000008"], trimmed: true })
    expect(appended.structuredOutputs).toEqual([])
  })

  it("bounds the persisted projection when reported usage describes a smaller provider attempt", async () => {
    const { file } = fixture(a003Envelope([]))
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    for (let index = 0; index < 8; index++) {
      messages.push({ role: "user", content: `old question ${index} ` + "old ".repeat(200) })
      messages.push({ role: "assistant", content: `old answer ${index} ` + "old ".repeat(200) })
    }
    messages.push({ role: "user", content: "current question" }, { role: "assistant", content: "current answer" })
    const canonical = structuredClone(messages)
    const prepared = postTurnTrim(messages, { ...usage, input_tokens: 100, total_tokens: 120 })
    expect(prepared.currentMessages).toEqual(canonical)
    expect(estimateTokensForMessages(prepared.trimmedMessages)).toBeLessThanOrEqual(800)
    expect(prepared.trimmedMessages.length).toBeLessThan(canonical.length)
    await withSessionTurnLease(file, async () => {
      postTurnPersist(file, prepared)
      const persisted = raw(file)
      expect(persisted.events).toHaveLength(canonical.length)
      expect(projectProviderMessages(persisted)).toEqual(prepared.trimmedMessages)
    })
  })
})
