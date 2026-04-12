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
  injectNoteSearchContext,
  searchDiaryFactsForQuery,
  type EmbeddingProvider,
} from "../../mind/note-search"

describe("note search", () => {
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

  function writeFacts(diaryRoot: string, facts: Array<ReturnType<typeof makeFact>>) {
    fs.mkdirSync(diaryRoot, { recursive: true })
    fs.writeFileSync(path.join(diaryRoot, "facts.jsonl"), facts.map((fact) => JSON.stringify(fact)).join("\n"), "utf8")
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

    const found = await searchDiaryFactsForQuery("pizza", facts, provider, { minScore: 0.5, topK: 2 })
    expect(found).toHaveLength(2)
    expect(found[0].id).toBe("f1")
    expect(found[1].id).toBe("f2")
  })

  it("returns no hits for blank queries without calling provider", async () => {
    const provider = { embed: vi.fn() }
    const found = await searchDiaryFactsForQuery("   ", [makeFact("f1", "anything", [1, 0])], provider)
    expect(found).toEqual([])
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("injects from my diary and journal into the system prompt before model call", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])

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

    await injectNoteSearchContext(messages, {
      provider,
      diaryRoot,
      minScore: 0.5,
      topK: 1,
    })

    expect(typeof messages[0].content).toBe("string")
    expect(messages[0].content).toContain("## from my diary and journal")
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_context",
        message: "note search injected",
      }),
    )
  })

  it("does nothing when message[0] is not a system string message", async () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [{ role: "user", content: "hello" }]
    await injectNoteSearchContext(messages, { diaryRoot: "/tmp/unused" })
    expect(mockEmitNervesEvent).not.toHaveBeenCalled()
  })

  it("does nothing when there is no plain-text user query", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider = { embed: vi.fn() }

    const messages = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: [{ type: "text", text: "pizza?" }] },
    ] as unknown as OpenAI.ChatCompletionMessageParam[]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })

  it("does nothing when latest user text is only whitespace", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider = { embed: vi.fn() }

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "   " },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })

  it("does nothing when facts file is missing", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("does nothing when facts file is blank", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    fs.writeFileSync(path.join(diaryRoot, "facts.jsonl"), "\n", "utf8")
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
  })

  it("does nothing when search_notes returns no matches above threshold", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0, 1])])
    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider, minScore: 0.95 })
    expect(messages[0].content).toBe("base system prompt")
  })

  it("uses default OpenAI embedding provider when no provider is passed", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
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

    await injectNoteSearchContext(messages, { diaryRoot, minScore: 0.5 })
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

  it("uses default agent-root diary path when options.diaryRoot is omitted", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-root-"))
    const diaryRoot = path.join(agentRoot, "diary")
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectNoteSearchContext(messages, { provider, minScore: 0.5 })
    expect(mockGetAgentRoot).toHaveBeenCalled()
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
  })

  it("falls back to substring matching when embeddings API key is missing", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetOpenAIEmbeddingsApiKey.mockReturnValue("")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_fallback",
        meta: expect.objectContaining({ matchCount: 1 }),
      }),
    )
  })

  it("silently degrades when embeddings fail and no substring match exists", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockGetOpenAIEmbeddingsApiKey.mockReturnValue("")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "basketball" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot })
    expect(messages[0].content).toBe("base system prompt")
    expect(mockEmitNervesEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "mind.note_search_fallback" }),
    )
  })

  it("falls back to substring matching when embedding request fails", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Boom",
    })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "mushroom" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_fallback",
      }),
    )
  })

  it("falls back to substring matching when embedding response vectors are missing", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
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

    await injectNoteSearchContext(messages, { diaryRoot })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_fallback",
      }),
    )
  })

  it("converts non-Error thrown values gracefully in substring fallback", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    writeFacts(diaryRoot, [makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01])])
    const provider: EmbeddingProvider = {
      embed: async () => {
        throw "boom-value"
      },
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    // Falls back to substring, finds match, injects search_notes
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_fallback",
      }),
    )
  })

  it("emits outer error event with string reason for non-Error throws", async () => {
    mockGetAgentRoot.mockImplementation(() => { throw "non-error-value" })
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "anything" },
    ]

    await injectNoteSearchContext(messages)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.note_search_context_error",
        meta: expect.objectContaining({ reason: "non-error-value" }),
      }),
    )
  })

  it("skips corrupt lines in facts file and finds valid ones", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    const validFact = JSON.stringify(makeFact("f1", "Ari likes mushroom pizza", [0.99, 0.01]))
    fs.writeFileSync(path.join(diaryRoot, "facts.jsonl"), `not valid json\n\n${validFact}\n`, "utf8")

    const provider: EmbeddingProvider = {
      embed: async () => [[1, 0]],
    }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "pizza?" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider, minScore: 0.5 })
    expect(messages[0].content).toContain("Ari likes mushroom pizza")
  })

  it("does nothing when facts file contains only invalid JSON", async () => {
    const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "note-search-"))
    fs.writeFileSync(path.join(diaryRoot, "facts.jsonl"), "not valid json\n", "utf8")
    const provider = { embed: vi.fn() }
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "base system prompt" },
      { role: "user", content: "anything" },
    ]

    await injectNoteSearchContext(messages, { diaryRoot, provider })
    expect(provider.embed).not.toHaveBeenCalled()
    expect(messages[0].content).toBe("base system prompt")
  })
})
