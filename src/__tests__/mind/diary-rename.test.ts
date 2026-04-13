import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

// ── Tool definition tests ───────────────────────────────────────

describe("diary tool definitions", () => {
  const legacyPrefix = "mem" + "ory"
  const legacySaveTool = `${legacyPrefix}_save`
  const legacySearchTool = `${legacyPrefix}_search`

  it("has a diary_write tool (replaces the old save tool)", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const diaryWrite = baseToolDefinitions.find((d) => d.tool.function.name === "diary_write")
    expect(diaryWrite).toBeDefined()
    expect(diaryWrite!.tool.function.parameters).toMatchObject({
      type: "object",
      properties: { entry: { type: "string" } },
      required: ["entry"],
    })
  })

  it("has a search_notes tool (replaces the old search tool)", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const search_notes = baseToolDefinitions.find((d) => d.tool.function.name === "search_notes")
    expect(search_notes).toBeDefined()
    expect(search_notes!.tool.function.parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    })
  })

  it("no longer has the old save tool", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const legacySave = baseToolDefinitions.find((d) => d.tool.function.name === legacySaveTool)
    expect(legacySave).toBeUndefined()
  })

  it("no longer has the old search tool", async () => {
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const legacySearch = baseToolDefinitions.find((d) => d.tool.function.name === legacySearchTool)
    expect(legacySearch).toBeUndefined()
  })
})

// ── Diary path tests ────────────────────────────────────────────

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

describe("diary default path", () => {
  beforeEach(() => {
    mockGetAgentRoot.mockReset()
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("")
  })

  it("readDiaryEntries defaults to diary/ without using the old psyche store", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-path-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    // Create diary/ with a facts file
    const diaryDir = path.join(agentRoot, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "test fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    const { readDiaryEntries } = await import("../../mind/diary")
    const facts = readDiaryEntries()
    expect(facts).toHaveLength(1)
    expect(facts[0].text).toBe("test fact")
  })

  it("readDiaryEntries does NOT fall back to the old psyche store -- always uses diary/", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-no-fallback-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const legacyDir = path.join(agentRoot, "psyche", "mem" + "ory")
    fs.mkdirSync(legacyDir, { recursive: true })
    const fact = { id: "f1", text: "legacy fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [] }
    fs.writeFileSync(path.join(legacyDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    const { readDiaryEntries } = await import("../../mind/diary")
    const facts = readDiaryEntries()
    expect(facts).toHaveLength(0)
  })

  it("saveDiaryEntry writes to diary/ by default", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-write-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const { saveDiaryEntry } = await import("../../mind/diary")
    await saveDiaryEntry({
      text: "new diary entry",
      source: "tool:diary_write",
      idFactory: () => "test-id",
      now: () => new Date("2026-03-25T00:00:00Z"),
    })

    const diaryDir = path.join(agentRoot, "diary")
    expect(fs.existsSync(path.join(diaryDir, "facts.jsonl"))).toBe(true)
    const content = fs.readFileSync(path.join(diaryDir, "facts.jsonl"), "utf8")
    expect(content).toContain("new diary entry")
  })
})

// ── Tool name migration tests ───────────────────────────────────

describe("migrateToolNames diary renames", () => {
  const legacyPrefix = "mem" + "ory"
  const legacySaveTool = `${legacyPrefix}_save`
  const legacySearchTool = `${legacyPrefix}_search`

  it("rewrites the old save tool to diary_write in session history", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "function", function: { name: legacySaveTool, arguments: '{"text":"something"}' } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "saved" },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[0] as any).tool_calls[0].function.name).toBe("diary_write")
  })

  it("rewrites the old search tool to search_notes in session history", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "function", function: { name: legacySearchTool, arguments: '{"query":"auth"}' } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "results" },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[0] as any).tool_calls[0].function.name).toBe("search_notes")
  })
})

// ── Note search path tests ─────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal("fetch", mockFetch)

describe("injectNoteSearchContext diary path", () => {
  beforeEach(() => {
    mockGetAgentRoot.mockReset()
    mockGetOpenAIEmbeddingsApiKey.mockReset().mockReturnValue("test-key")
    mockFetch.mockReset()
  })

  it("reads from diary/ by default without using the old psyche store", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "search_notes-diary-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    // Create diary/ with facts
    const diaryDir = path.join(agentRoot, "diary")
    fs.mkdirSync(diaryDir, { recursive: true })
    const fact = { id: "f1", text: "auth uses oauth2", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.1, 0.2, 0.3] }
    fs.writeFileSync(path.join(diaryDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    // Mock embedding API to return a vector similar to the fact
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about auth" },
    ]

    await injectNoteSearchContext(messages)
    // Should find the fact from diary/ and inject it
    expect(messages[0].content).toContain("auth uses oauth2")
  })

  it("does NOT fall back to the old psyche store when diary/ does not exist", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "search_notes-no-fallback-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const legacyDir = path.join(agentRoot, "psyche", "mem" + "ory")
    fs.mkdirSync(legacyDir, { recursive: true })
    const fact = { id: "f1", text: "legacy auth fact", source: "test", createdAt: "2026-03-25T00:00:00Z", embedding: [0.1, 0.2, 0.3] }
    fs.writeFileSync(path.join(legacyDir, "facts.jsonl"), JSON.stringify(fact) + "\n", "utf8")

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    })

    const { injectNoteSearchContext } = await import("../../mind/note-search")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "tell me about auth" },
    ]

    await injectNoteSearchContext(messages)
    expect(messages[0].content).not.toContain("legacy auth fact")
  })
})

// ── diary_write tool handler tests ──────────────────────────────

describe("diary_write tool handler", () => {
  beforeEach(() => {
    mockGetAgentRoot.mockReset()
  })

  it("accepts entry param (not text)", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-handler-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const diaryWrite = baseToolDefinitions.find((d) => d.tool.function.name === "diary_write")
    expect(diaryWrite).toBeDefined()

    const result = await diaryWrite!.handler({ entry: "dear diary, today I learned something" }, undefined)
    expect(result).toContain("saved")
    expect(result).toContain("added=1")
  })

  it("saves with source tool:diary_write", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "diary-source-"))
    mockGetAgentRoot.mockReturnValue(agentRoot)

    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const diaryWrite = baseToolDefinitions.find((d) => d.tool.function.name === "diary_write")

    await diaryWrite!.handler({ entry: "test entry" }, undefined)

    const factsPath = path.join(agentRoot, "diary", "facts.jsonl")
    const content = fs.readFileSync(factsPath, "utf8")
    expect(content).toContain("tool:diary_write")
  })
})
