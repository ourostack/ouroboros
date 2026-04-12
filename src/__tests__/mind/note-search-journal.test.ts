import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockGetAgentRoot = vi.fn()
const mockGetOpenAIEmbeddingsApiKey = vi.fn().mockReturnValue("")
vi.mock("../../heart/identity", () => ({
  getAgentName: () => "test-agent",
  getAgentRoot: () => mockGetAgentRoot(),
}))
vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => mockGetOpenAIEmbeddingsApiKey(),
}))
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

// ── search_notes tool handler: journal search ──────────────────────────

describe("search_notes tool: journal search via .index.json", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "search_notes-journal-"))
    mockGetAgentRoot.mockReturnValue(tmpDir)
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("test-key")
    mockFetch.mockReset()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("includes journal results tagged [journal] from .index.json", async () => {
    // Create diary/ with a fact
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "oauth2 is our auth method", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    // Create journal/.index.json sidecar with an indexed file
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "auth-thoughts.md"), "# Auth thoughts\nThinking about auth redesign...", "utf8")
    const journalIndex = [
      { filename: "auth-thoughts.md", embedding: [0.85, 0.15, 0.0], mtime: Date.now(), preview: "Auth thoughts" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    // Mock embedding API
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    expect(searchNotesTool).toBeDefined()

    const result = await searchNotesTool!.handler({ query: "auth" }, undefined)
    // Should contain journal results tagged [journal]
    expect(result).toContain("[journal]")
    expect(result).toContain("auth-thoughts.md")
    expect(result).toContain("Auth thoughts")
  })

  it("tags diary results as [diary]", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "auth uses oauth2", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "auth" }, undefined)
    expect(result).toContain("[diary]")
  })

  it("journal results include filename and preview snippet", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Project notes\nSome details...", "utf8")
    const journalIndex = [
      { filename: "notes.md", embedding: [0.8, 0.2, 0.0], mtime: Date.now(), preview: "Project notes" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    // No diary entries
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.8, 0.2, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "project" }, undefined)
    expect(result).toContain("[journal]")
    expect(result).toContain("notes.md")
    expect(result).toContain("Project notes")
  })

  it("matches journal entries by filename when preview doesn't match", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    // Filename matches query but preview does not
    fs.writeFileSync(path.join(journalDir, "auth-redesign.md"), "# Some ideas", "utf8")
    const journalIndex = [
      { filename: "auth-redesign.md", embedding: [0.5, 0.5, 0.0], mtime: Date.now(), preview: "Some ideas" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5, 0.5, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "auth" }, undefined)
    expect(result).toContain("[journal]")
    expect(result).toContain("auth-redesign.md")
  })

  it("handles malformed journal index gracefully", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, ".index.json"), "not-json!!!", "utf8")

    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5, 0.5, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "test" }, undefined)
    // Should not crash — just return empty
    expect(result).toBe("")
  })

  it("handles non-array journal index gracefully", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, ".index.json"), '{"not":"array"}', "utf8")

    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "test" }, undefined)
    expect(result).toBe("")
  })

  it("returns empty when no journal index exists and no diary entries match", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5, 0.5, 0.0] }] }),
    })

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const searchNotesTool = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    const result = await searchNotesTool!.handler({ query: "something" }, undefined)
    // When no matches, result should be empty or indicate no results
    expect(result).toBe("")
  })
})

// ── injectNoteSearchContext: diary + journal tagging ────────────

describe("injectNoteSearchContext diary+journal tagging", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assoc-search_notes-journal-"))
    mockGetAgentRoot.mockReturnValue(tmpDir)
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("test-key")
    mockFetch.mockReset()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("tags diary results as [diary] in from my diary and journal", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "auth uses oauth2", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about auth" },
    ]

    await injectNoteSearchContext(messages)
    expect(messages[0].content).toContain("[diary]")
    expect(messages[0].content).toContain("auth uses oauth2")
  })

  it("includes journal results tagged [journal] in from my diary and journal", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    // Create journal index with matching content
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "api-design.md"), "# API Design\nThinking about endpoints...", "utf8")
    const journalIndex = [
      { filename: "api-design.md", embedding: [0.85, 0.15, 0.0], mtime: Date.now(), preview: "API Design" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.85, 0.15, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about API design" },
    ]

    await injectNoteSearchContext(messages)
    expect(messages[0].content).toContain("[journal]")
    expect(messages[0].content).toContain("api-design.md")
  })

  it("merges diary and journal results sorted by score", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "auth is important", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.8, 0.2, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "auth-notes.md"), "# Auth notes", "utf8")
    const journalIndex = [
      { filename: "auth-notes.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "Auth notes" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.85, 0.15, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about auth" },
    ]

    await injectNoteSearchContext(messages)
    const content = messages[0].content
    expect(content).toContain("[diary]")
    expect(content).toContain("[journal]")
  })

  it("handles missing journal index gracefully", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "some fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    // No journal dir at all
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about some fact" },
    ]

    await injectNoteSearchContext(messages)
    // Should still have diary results even without journal
    expect(messages[0].content).toContain("[diary]")
  })

  it("handles empty journal index", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "test data", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, ".index.json"), "[]", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about test data" },
    ]

    await injectNoteSearchContext(messages)
    expect(messages[0].content).toContain("[diary]")
    expect(messages[0].content).not.toContain("[journal]")
  })

  it("handles journal-only search (no diary entries at all)", async () => {
    // Empty diary
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    // Journal with index
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const journalIndex = [
      { filename: "notes.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "My notes" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about notes" },
    ]

    await injectNoteSearchContext(messages)
    expect(messages[0].content).toContain("[journal]")
    expect(messages[0].content).toContain("notes.md")
    expect(messages[0].content).not.toContain("[diary]")
  })

  it("handles no diary and no journal entries (returns without injection)", async () => {
    // Empty diary
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    // No journal dir

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "anything" },
    ]

    await injectNoteSearchContext(messages)
    // No from my diary and journal should be injected
    expect(messages[0].content).toBe("you are helpful")
  })

  it("uses explicit journalDir option when provided", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "test fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    // Create journal in a non-standard location
    const customJournalDir = path.join(tmpDir, "custom-journal")
    fs.mkdirSync(customJournalDir, { recursive: true })
    const journalIndex = [
      { filename: "custom.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "Custom journal" },
    ]
    fs.writeFileSync(path.join(customJournalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about custom" },
    ]

    await injectNoteSearchContext(messages, { journalDir: customJournalDir })
    expect(messages[0].content).toContain("[journal]")
    expect(messages[0].content).toContain("custom.md")
  })

  it("handles non-array journal index in injectNoteSearchContext", async () => {
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "auth fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.9, 0.1, 0.0] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    // Non-array JSON
    fs.writeFileSync(path.join(journalDir, ".index.json"), '{"not":"array"}', "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.9, 0.1, 0.0] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about auth" },
    ]

    await injectNoteSearchContext(messages)
    // Should still work with diary results
    expect(messages[0].content).toContain("[diary]")
    expect(messages[0].content).not.toContain("[journal]")
  })

  it("handles journal-only when embed returns empty array", async () => {
    // Empty diary
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    // Journal with index
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const journalIndex = [
      { filename: "notes.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "My notes" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    // Make fetch return data with undefined embedding — embed returns [undefined]
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{}] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about notes" },
    ]

    // Should not crash — embed returns empty, so queryEmbedding is undefined
    await injectNoteSearchContext(messages)
    // No results should be injected since embedding failed
    expect(messages[0].content).toBe("you are helpful")
  })

  it("handles journal-only with embedding failure (catch branch)", async () => {
    // Empty diary
    const diaryDir = path.join(tmpDir, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), "", "utf8")

    // Journal with index
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const journalIndex = [
      { filename: "notes.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "My notes" },
    ]
    fs.writeFileSync(path.join(journalDir, ".index.json"), JSON.stringify(journalIndex), "utf8")

    // Make fetch throw to trigger the catch branch
    mockFetch.mockRejectedValue(new Error("network error"))

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about notes" },
    ]

    await injectNoteSearchContext(messages)
    // Should not crash -- just no journal results injected
    expect(messages[0].content).toBe("you are helpful")
  })
})

// ── searchJournalIndex unit tests ────────────────────────────────

describe("searchJournalIndex", () => {
  it("returns matching entries above minScore", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = [
      { filename: "a.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "A" },
      { filename: "b.md", embedding: [0.1, 0.9, 0.0], mtime: Date.now(), preview: "B" },
    ]
    const queryEmbedding = [0.9, 0.1, 0.0]
    const results = searchJournalIndex(queryEmbedding, entries, { minScore: 0.5 })
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].filename).toBe("a.md")
  })

  it("filters out entries with empty embeddings", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = [
      { filename: "a.md", embedding: [], mtime: Date.now(), preview: "A" },
      { filename: "b.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "B" },
    ]
    const queryEmbedding = [0.9, 0.1, 0.0]
    const results = searchJournalIndex(queryEmbedding, entries, { minScore: 0.0 })
    expect(results.every((r) => r.filename !== "a.md")).toBe(true)
  })

  it("sorts results by score descending", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = [
      { filename: "low.md", embedding: [0.1, 0.9, 0.0], mtime: Date.now(), preview: "Low" },
      { filename: "high.md", embedding: [0.95, 0.05, 0.0], mtime: Date.now(), preview: "High" },
      { filename: "mid.md", embedding: [0.5, 0.5, 0.0], mtime: Date.now(), preview: "Mid" },
    ]
    const queryEmbedding = [0.9, 0.1, 0.0]
    const results = searchJournalIndex(queryEmbedding, entries, { minScore: 0.0 })
    expect(results.length).toBe(3)
    expect(results[0].filename).toBe("high.md")
    // Scores should be descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score)
    }
  })

  it("respects topK limit", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = Array.from({ length: 10 }, (_, i) => ({
      filename: `f${i}.md`,
      embedding: [0.9 - i * 0.05, 0.1 + i * 0.05, 0.0],
      mtime: Date.now(),
      preview: `File ${i}`,
    }))
    const queryEmbedding = [0.9, 0.1, 0.0]
    const results = searchJournalIndex(queryEmbedding, entries, { minScore: 0.0, topK: 3 })
    expect(results.length).toBe(3)
  })

  it("returns zero-score results when query embedding is empty", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = [
      { filename: "a.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "A" },
    ]
    // cosineSimilarity returns 0 for empty query embedding, which is below default minScore (0.5)
    const results = searchJournalIndex([], entries)
    expect(results).toEqual([])
  })

  it("uses defaults when no options provided", async () => {
    const { searchJournalIndex } = await import("../../mind/note-search")
    const entries = [
      { filename: "a.md", embedding: [0.9, 0.1, 0.0], mtime: Date.now(), preview: "A" },
    ]
    const queryEmbedding = [0.9, 0.1, 0.0]
    const results = searchJournalIndex(queryEmbedding, entries)
    expect(results.length).toBe(1)
  })
})
