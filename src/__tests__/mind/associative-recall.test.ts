import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type OpenAI from "openai"

const mockGetOpenAIEmbeddingsApiKey = vi.fn()
const mockGetAgentRoot = vi.fn()
const mockEmitNervesEvent = vi.fn()
const mockFetch = vi.fn()

vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => mockGetOpenAIEmbeddingsApiKey(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: () => mockGetAgentRoot(),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.stubGlobal("fetch", mockFetch)

import {
  cosineSimilarity,
  injectAssociativeRecall,
  recallFactsForQuery,
  type EmbeddingProvider,
} from "../../mind/associative-recall"

describe("associative recall", () => {
  beforeEach(() => {
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("test-openai-key")
    mockGetAgentRoot.mockReset().mockReturnValue("/mock/agent")
    mockEmitNervesEvent.mockReset()
    mockFetch.mockReset()
  })

  function makeFact(id: string, text: string, embedding: number[]) {
    return {
      id,
      text,
      source: "cli",
      createdAt: "2026-03-06T00:00:00.000Z",
      embedding,
    }
  }

  function writeFacts(memoryRoot: string, facts: Array<ReturnType<typeof makeFact>>) {
    fs.mkdirSync(memoryRoot, { recursive: true })
    fs.writeFileSync(path.join(memoryRoot, "facts.jsonl"), facts.map((fact) => JSON.stringify(fact)).join("\n"), "utf8")
  }

  it("computes cosine similarity and handles edge cases", () => {
    expect(cosineSimilarity([], [])).toBe(0)
    expect(cosineSimilarity([1], [1, 2])).toBe(0)
    expect(cosineSimilarity([0, 0], [0, 1])).toBe(0)
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6)
  })

  it("uses provider-agnostic embeddings to rank and order relevant facts", async () => {
    const provider: EmbeddingProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 1 && texts[0] === "pizza") return [[1, 0]]
        throw new Error(`unexpected embed request: ${JSON.stringify(texts)}`)
      },
    }

    const facts = [
      makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01]),
      makeFact("f2", "Ari likes margherita pizza", [0.8, 0.2]),
      makeFact("f3", "Ari prefers strict TypeScript checks", [0.1, 0.9]),
    ]

    const recalled = await recallFactsForQuery("pizza", facts, provider, { minScore: 0.5, topK: 2 })
    expect(recalled).toHaveLength(2)
    expect(recalled[0].id).toBe("f1")
    expect(recalled[1].id).toBe("f2")
  })

  it("returns no recalls for blank queries without calling provider", async () => {
    const provider = { embed: vi.fn() }
    const recalled = await recallFactsForQuery("   ", [makeFact("f1", "anything", [1, 0])], provider)
    expect(recalled).toEqual([])
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("injects recalled context into the system prompt before model call", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])

    const provider: EmbeddingProvider = {
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 1 && texts[0].includes("pizza")) return [[1, 0]]
        throw new Error(`unexpected embed request: ${JSON.stringify(texts)}`)
      },
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "can we order pizza tonight?" },
    ]

    await injectAssociativeRecall(messages, {
      provider,
      memoryRoot,
      minScore: 0.5,
      topK: 1,
    })

    expect(typeof messages[0].content).toBe("string")
    expect(messages[0].content).toContain("## recalled context")
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall",
        message: "associative recall injected",
      }),
    )
  })

  it("does nothing when message[0] is not a system string message", async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "hello" }]
    await injectAssociativeRecall(messages, { memoryRoot: "/tmp/unused" })
    expect(mockEmitNervesEvent).not.toHaveBeenCalled()
  })

  it("does nothing when there is no plain-text user query", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider = { embed: vi.fn() }

    const messages = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: [{ type: "text", text: "pizza?" }] },
    ] as unknown as OpenAI.ChatCompletionMessageParam[]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })

  it("does nothing when latest user text is only whitespace", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider = { embed: vi.fn() }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "   " },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })

  it("does nothing when facts file is missing", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("does nothing when facts file is blank", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    fs.writeFileSync(path.join(memoryRoot, "facts.jsonl"), "\n", "utf8")
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("does nothing when recall returns no matches above threshold", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0, 1])])
    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider, minScore: 0.95 })
    expect(messages[0].content).toBe("base system prompt")
  })

  it("uses default OpenAI embedding provider when no provider is passed", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [1, 0] }],
      }),
    })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, minScore: 0.5 })
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-openai-key",
          "Content-Type": "application/json",
        }),
      }),
    )
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
  })

  it("uses default agent-root memory path when options.memoryRoot is omitted", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-root-"))
    const memoryRoot = path.join(agentRoot, "psyche", "memory")
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { provider, minScore: 0.5 })
    expect(mockGetAgentRoot).toHaveBeenCalled()
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
  })

  it("falls back to substring matching when embeddings API key is missing", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetOpenAIEmbeddingsApiKey.mockReturnValue("")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall_fallback",
        meta: expect.objectContaining({ matchCount: 1 }),
      }),
    )
  })

  it("silently degrades when embeddings fail and no substring match exists", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetOpenAIEmbeddingsApiKey.mockReturnValue("")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "basketball" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot })
    expect(messages[0].content).toBe("base system prompt")
    expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "mind.associative_recall_fallback" }),
    )
  })

  it("falls back to substring matching when embedding request fails", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Boom",
    })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "mushroom" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall_fallback",
      }),
    )
  })

  it("falls back to substring matching when embedding response vectors are missing", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [],
      }),
    })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall_fallback",
      }),
    )
  })

  it("converts non-Error thrown values gracefully in substring fallback", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    writeFacts(memoryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider: EmbeddingProvider = {
      embed: async () => {
        throw "boom-value"
      },
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    // Falls back to substring, finds match, injects recall
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall_fallback",
      }),
    )
  })

  it("emits outer error event with string reason for non-Error throws", async () => {
    mockGetAgentRoot.mockImplementation(() => { throw "non-error-value" })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "anything" },
    ]

    await injectAssociativeRecall(messages)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.associative_recall_error",
        meta: expect.objectContaining({ reason: "non-error-value" }),
      }),
    )
  })

  it("skips corrupt lines in facts file and recalls valid ones", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    const validFact = JSON.stringify(makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01]))
    fs.writeFileSync(path.join(memoryRoot, "facts.jsonl"), `not valid json\n\n${validFact}\n`, "utf8")

    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider, minScore: 0.5 })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
  })

  it("does nothing when facts file contains only invalid JSON", async () => {
    const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "associative-recall-"))
    fs.writeFileSync(path.join(memoryRoot, "facts.jsonl"), "not valid json\n", "utf8")
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "anything" },
    ]

    await injectAssociativeRecall(messages, { memoryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })
})
