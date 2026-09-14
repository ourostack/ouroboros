import type OpenAI from "openai"
import { describe, expect, it, vi } from "vitest"
import { buildCanonicalSessionEnvelope, projectProviderMessages } from "../../heart/session-events"
import { postTurnTrim, type PostTurnPrepared, type UsageData } from "../../mind/context"
import { estimateTokensForMessages } from "../../mind/token-estimate"

vi.mock("../../heart/config", async (original) => ({
  ...await original<typeof import("../../heart/config")>(),
  getContextConfig: () => ({ maxTokens: 800, contextMargin: 20 }),
}))
vi.mock("../../nerves/runtime", async (original) => ({
  ...await original<typeof import("../../nerves/runtime")>(),
  emitNervesEvent: vi.fn(),
}))

function envelopeFor(prepared: PostTurnPrepared, usage?: UsageData) {
  return buildCanonicalSessionEnvelope({
    ...prepared,
    existing: null,
    previousMessages: [],
    recordedAt: "2026-09-11T00:00:00.000Z",
    lastUsage: usage ?? null,
    state: null,
    projectionBasis: { maxTokens: prepared.maxTokens, contextMargin: prepared.contextMargin, inputTokens: usage?.input_tokens ?? null },
  }).envelope
}

describe("D006 estimated post-turn projection budget", () => {
  it.each([undefined, 0, 100])("bounds canonical history without replacing reported usage %s with an estimate", (inputTokens) => {
    const messages: OpenAI.ChatCompletionMessageParam[] = []
    for (let index = 0; index < 8; index++) {
      messages.push({ role: "user", content: `old question ${index}` }, { role: "assistant", content: `old answer ${index}` })
    }
    messages.push(
      { role: "user", content: "large old question " + "x".repeat(10_000) },
      { role: "assistant", content: "large old answer " + "y".repeat(10_000) },
      { role: "user", content: "current question" },
      { role: "assistant", content: "current answer" },
    )
    const canonical = structuredClone(messages)
    const usage = inputTokens === undefined ? undefined : {
      input_tokens: inputTokens, output_tokens: 20, reasoning_tokens: 0, total_tokens: inputTokens + 20,
    }
    const prepared = postTurnTrim(messages, usage)
    expect(estimateTokensForMessages(prepared.trimmedMessages)).toBeLessThanOrEqual(800)
    expect(prepared.trimmedMessages.slice(-2)).toEqual(canonical.slice(-2))
    expect(prepared.currentMessages).toEqual(canonical)
    expect(messages).toEqual(prepared.trimmedMessages)
    const envelope = envelopeFor(prepared, usage)
    expect(envelope.events).toHaveLength(canonical.length)
    expect(projectProviderMessages(envelope)).toEqual(prepared.trimmedMessages)
    expect(envelope.projection).toMatchObject({ maxTokens: 800, inputTokens: inputTokens ?? null, trimmed: true })
    expect(envelope.lastUsage).toEqual(usage ?? null)
  })

  it("drops a large optional tool block as a whole while keeping the exact current request and answer", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "system instructions" },
      { role: "user", content: "old read request" },
      { role: "assistant", content: null, tool_calls: [{ id: "large-read", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/fixture"}' } }] },
      { role: "tool", tool_call_id: "large-read", content: "x".repeat(10_000) },
      { role: "assistant", content: "old read completed" },
      { role: "user", content: "current question" },
      { role: "assistant", content: "current answer" },
    ]
    const canonical = structuredClone(messages)
    const prepared = postTurnTrim(messages)
    expect(estimateTokensForMessages(prepared.trimmedMessages)).toBeLessThanOrEqual(800)
    expect(prepared.trimmedMessages).toContainEqual(canonical[0])
    expect(prepared.trimmedMessages.slice(-2)).toEqual(canonical.slice(-2))
    expect(prepared.trimmedMessages.some((message) => message.role === "tool" || message.role === "assistant" && message.tool_calls?.length)).toBe(false)
    expect(prepared.currentMessages).toEqual(canonical)
    expect(envelopeFor(prepared).events.slice(2, 4)).toMatchObject([
      { role: "assistant", toolCalls: [{ id: "large-read" }] },
      { role: "tool", toolCallId: "large-read", content: "x".repeat(10_000) },
    ])
  })

  it("keeps the latest request and answer when they fit the limit but exceed its reserve target", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "old " + "x".repeat(10_000) },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "u".repeat(2_200) },
      { role: "assistant", content: "a".repeat(600) },
    ]
    const currentTurn = structuredClone(messages.slice(-2))
    const prepared = postTurnTrim(messages)
    expect(prepared.trimmedMessages).toEqual(currentTurn)
    expect(estimateTokensForMessages(currentTurn)).toBeGreaterThan(640)
    expect(estimateTokensForMessages(currentTurn)).toBeLessThanOrEqual(800)
    expect(envelopeFor(prepared).events).toHaveLength(4)
  })

  it.each(["system", "user", "assistant"] as const)("retains all native records with an intentionally empty projection when required %s content cannot fit", (oversizedRole) => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: oversizedRole === "system" ? "x".repeat(4_000) : "system instructions" },
      { role: "user", content: oversizedRole === "user" ? "x".repeat(4_000) : "current question" },
      { role: "assistant", content: oversizedRole === "assistant" ? "x".repeat(4_000) : "current answer" },
    ]
    const canonical = structuredClone(messages)
    const prepared = postTurnTrim(messages)
    expect(prepared.trimmedMessages).toEqual([])
    expect(prepared.currentMessages).toEqual(canonical)
    const envelope = envelopeFor(prepared)
    expect(envelope.events).toHaveLength(3)
    expect(envelope.projection).toMatchObject({ eventIds: [], trimmed: true, inputTokens: null })
    expect(projectProviderMessages(envelope)).toEqual([])
  })

  it("leaves an already bounded current turn unchanged", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "current question" }, { role: "assistant", content: "current answer" },
    ]
    const canonical = structuredClone(messages)
    const prepared = postTurnTrim(messages)
    expect(prepared.currentMessages).toEqual(canonical)
    expect(prepared.trimmedMessages).toEqual(canonical)
    expect(envelopeFor(prepared).projection.trimmed).toBe(false)
  })
})
