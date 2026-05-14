import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import { EVENT_CONTENT_MAX_CHARS } from "../../heart/session-events"
import { expectedCappedContent, expectedTruncationMarker, makeOversizedAgentContent } from "../helpers/content-cap"

let agentRoot = ""
let embeddingsApiKey = "test-openai-embeddings-key"
const mockFetch = vi.fn()

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "slugger",
  getAgentRoot: () => agentRoot,
}))

vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => embeddingsApiKey,
  getIntegrationsConfig: () => ({ openaiEmbeddingsApiKey: embeddingsApiKey }),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.stubGlobal("fetch", mockFetch)

type NoteHandlerResult = string | {
  ok?: boolean
  path?: string
  error?: string
}

type ConsultNotesResult = {
  items: Array<{
    path?: string
    filename?: string
    excerpt: string
    score: number
  }>
  nextCursor?: string
}

function selfContext(): ToolContext {
  return {
    signin: async () => undefined,
    context: {
      channel: { channel: "inner" },
    },
  } as ToolContext
}

function innerSelfFriendContext(): ToolContext {
  return {
    signin: async () => undefined,
    context: {
      channel: { channel: "inner" },
      friend: {
        id: "self",
        name: "slugger",
        trustLevel: "family",
      },
    },
  } as unknown as ToolContext
}

function trustedExternalContext(): ToolContext {
  return {
    signin: async () => undefined,
    context: {
      channel: { channel: "bluebubbles" },
      friend: {
        id: "friend-1",
        name: "Ari",
        trustLevel: "family",
      },
    },
  } as unknown as ToolContext
}

async function recordTools(): Promise<ToolDefinition[]> {
  const module = await import("../../repertoire/tools-record")
  return module.recordToolDefinitions
}

async function handlerFor(name: "note" | "consult_notes") {
  const definitions = await recordTools()
  const definition = definitions.find((entry) => entry.tool.function.name === name)
  expect(definition).toBeDefined()
  return definition!.handler
}

function parseNoteFile(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  expect(raw.startsWith("---\n")).toBe(true)
  const end = raw.indexOf("\n---\n", 4)
  expect(end).toBeGreaterThan(0)
  const frontmatterRaw = raw.slice(4, end)
  const body = raw.slice(end + "\n---\n".length)
  const frontmatter: Record<string, unknown> = {}
  const lines = frontmatterRaw.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const [key, ...rest] = line.split(":")
    const value = rest.join(":").trim()
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = JSON.parse(value)
    } else if (!value) {
      const sequence: string[] = []
      while (lines[i + 1]?.trimStart().startsWith("- ")) {
        i += 1
        sequence.push(lines[i].trimStart().slice(2).trim().replace(/^"|"$/g, ""))
      }
      frontmatter[key] = sequence
    } else {
      frontmatter[key] = value.replace(/^"|"$/g, "")
    }
  }
  return { frontmatter, body }
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8"))
}

function writeCanonicalNote(notesDir: string, filename: string, body = "Archive searchable note."): string {
  const filePath = path.join(notesDir, filename)
  fs.mkdirSync(notesDir, { recursive: true })
  fs.writeFileSync(filePath, [
    "---",
    "created_at: 2026-05-14T17:42:13.000Z",
    "---",
    body,
  ].join("\n"), "utf8")
  return filePath
}

function writeFreshIndex(notesDir: string, filePath: string, embedding: number[]): void {
  const stat = fs.statSync(filePath)
  fs.writeFileSync(path.join(notesDir, ".index.json"), `${JSON.stringify({
    version: 1,
    entries: [{
      filename: path.basename(filePath),
      path: filePath,
      preview: "Archive searchable note.",
      embedding,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }],
  }, null, 2)}\n`, "utf8")
}

describe("record tools: note and consult_notes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-14T17:42:13.000Z"))
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-record-"))
    embeddingsApiKey = "test-openai-embeddings-key"
    mockFetch.mockReset()
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [1, 0] }] }),
    })
  })

  it("registers note and consult_notes with the expected tool names", async () => {
    const definitions = await recordTools()
    expect(definitions.map((definition) => definition.tool.function.name)).toEqual([
      "note",
      "consult_notes",
    ])
  })

  it("note writes canonical markdown with minimal frontmatter and returns the file path", async () => {
    const handler = await handlerFor("note")
    const result = await handler({
      content: "Remember the mailbox UI should show envelope-only transcripts.",
      tags: ["mailbox", "archive-removal"],
    } as never, selfContext()) as NoteHandlerResult

    const savedPath = typeof result === "string" ? result : result.path
    expect(typeof result).toBe("string")
    expect(savedPath).toBe(path.join(agentRoot, "notes", "2026-05-14-remember-the-mailbox-ui-should-show-enve.md"))

    const saved = parseNoteFile(fs.readFileSync(savedPath!, "utf8"))
    expect(Object.keys(saved.frontmatter).sort()).toEqual(["created_at", "tags"])
    expect(saved.frontmatter.created_at).toBe("2026-05-14T17:42:13.000Z")
    expect(saved.frontmatter.tags).toEqual(["mailbox", "archive-removal"])
    expect(saved.body).toBe("Remember the mailbox UI should show envelope-only transcripts.\n")
  })

  it("note accepts the real inner-dialog self friend context", async () => {
    const handler = await handlerFor("note")
    const result = await handler({
      content: "Inner dialog self context can write durable notes.",
    } as never, innerSelfFriendContext()) as NoteHandlerResult

    expect(typeof result).toBe("string")
    expect(fs.existsSync(result as string)).toBe(true)
  })

  it("note omits tags frontmatter when tags are not provided", async () => {
    const handler = await handlerFor("note")
    const result = await handler({
      content: "Short durable note.",
    } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path

    const saved = parseNoteFile(fs.readFileSync(savedPath!, "utf8"))
    expect(saved.frontmatter).toEqual({ created_at: "2026-05-14T17:42:13.000Z" })
    expect(saved.body).toBe("Short durable note.\n")
  })

  it("note accepts comma-separated tags and filters empty tag arrays", async () => {
    const handler = await handlerFor("note")
    const stringTagsResult = await handler({
      content: "Comma-separated tags.",
      tags: "mailbox, archive-removal",
    } as never, selfContext()) as NoteHandlerResult
    const stringTagsPath = typeof stringTagsResult === "string" ? stringTagsResult : stringTagsResult.path
    const filteredTagsResult = await handler({
      content: "Filtered tag array.",
      tags: [7, " ", ""],
    } as never, selfContext()) as NoteHandlerResult
    const filteredTagsPath = typeof filteredTagsResult === "string" ? filteredTagsResult : filteredTagsResult.path
    const ignoredTagsResult = await handler({
      content: "Ignored numeric tags.",
      tags: 7,
    } as never, selfContext()) as NoteHandlerResult
    const ignoredTagsPath = typeof ignoredTagsResult === "string" ? ignoredTagsResult : ignoredTagsResult.path

    expect(parseNoteFile(fs.readFileSync(stringTagsPath!, "utf8")).frontmatter.tags).toEqual(["mailbox", "archive-removal"])
    expect(parseNoteFile(fs.readFileSync(filteredTagsPath!, "utf8")).frontmatter.tags).toBeUndefined()
    expect(parseNoteFile(fs.readFileSync(ignoredTagsPath!, "utf8")).frontmatter.tags).toBeUndefined()
  })

  it("note slug uses lowercase alphanumeric dashes capped at 40 characters", async () => {
    const handler = await handlerFor("note")
    const result = await handler({
      content: "Launch!!! The Archive Replacement, with durable notes and richer lookup.",
    } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path

    const slug = path.basename(savedPath!, ".md").replace(/^2026-05-14-/, "")
    expect(slug).toBe("launch-the-archive-replacement-with-dura")
    expect(slug).toHaveLength(40)
  })

  it("note falls back to a generic slug when content has no alphanumerics", async () => {
    const handler = await handlerFor("note")
    const result = await handler({ content: "!!!" } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path

    expect(path.basename(savedPath!)).toBe("2026-05-14-note.md")
  })

  it("note keeps duplicate slug filenames capped at 40 characters including suffix", async () => {
    const handler = await handlerFor("note")
    const content = "Launch!!! The Archive Replacement, with durable notes and richer lookup."

    await handler({ content } as never, selfContext())
    const result = await handler({ content } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path
    const slug = path.basename(savedPath!, ".md").replace(/^2026-05-14-/, "")

    expect(slug).toBe("launch-the-archive-replacement-with-du-2")
    expect(slug).toHaveLength(40)
  })

  it("note updates the notes-native derived index beside canonical markdown", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.8, 0.2, 0.1] }] }),
    })
    const handler = await handlerFor("note")
    const result = await handler({
      content: "Archive removal notes should be searchable semantically.",
      tags: ["search"],
    } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path

    const indexPath = path.join(agentRoot, "notes", ".index.json")
    const index = readJson(indexPath) as {
      version: number
      entries: Array<{ filename: string; path: string; preview: string; embedding: number[] }>
    }
    expect(index.version).toBe(1)
    expect(index.entries).toEqual([
      expect.objectContaining({
        filename: path.basename(savedPath!),
        path: savedPath,
        preview: "Archive removal notes should be searchable semantically.",
        embedding: [0.8, 0.2, 0.1],
      }),
    ])
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer test-openai-embeddings-key",
        }),
      }),
    )
  })

  it("note caps oversized body content with the Unit 1 truncation marker", async () => {
    const handler = await handlerFor("note")
    const oversized = makeOversizedAgentContent("record note ")
    const result = await handler({ content: oversized } as never, selfContext()) as NoteHandlerResult
    const savedPath = typeof result === "string" ? result : result.path

    const saved = parseNoteFile(fs.readFileSync(savedPath!, "utf8"))
    const body = saved.body.trimEnd()
    expect(body.length).toBeLessThanOrEqual(EVENT_CONTENT_MAX_CHARS)
    expect(body).toBe(expectedCappedContent(oversized))
    expect(body).toContain(expectedTruncationMarker(oversized))
  })

  it("note returns a friendly error when the write cannot complete", async () => {
    fs.writeFileSync(path.join(agentRoot, "notes"), "not a directory", "utf8")
    const handler = await handlerFor("note")

    const result = await handler({ content: "This cannot be written." } as never, selfContext()) as NoteHandlerResult
    const rendered = typeof result === "string" ? result : result.error

    expect(rendered).toMatch(/error/i)
    expect(rendered).toMatch(/couldn't save|could not save|unable to save|failed to save/i)
    expect(rendered).not.toMatch(/TypeError|ENOENT|ENOTDIR|stack/i)
  })

  it("note returns a friendly error when indexing throws a non-Error value", async () => {
    mockFetch.mockRejectedValueOnce("embedding service down")
    const handler = await handlerFor("note")

    const result = await handler({ content: "This cannot be indexed." } as never, selfContext())

    expect(result).toBe("error: couldn't save the note right now.")
  })

  it("note returns a friendly error when embeddings are not configured", async () => {
    embeddingsApiKey = ""
    const handler = await handlerFor("note")

    const result = await handler({ content: "No embeddings key." } as never, selfContext())

    expect(result).toBe("error: note couldn't use notes because embeddings are not configured.")
  })

  it("note rejects callers without self trust", async () => {
    const handler = await handlerFor("note")
    const result = await handler({ content: "External callers cannot write canonical notes." } as never, trustedExternalContext())

    expect(result).toMatch(/self trust/i)
    expect(result).toMatch(/note/i)
  })

  it("note requires string content", async () => {
    const handler = await handlerFor("note")

    const result = await handler({ content: 7 } as never, selfContext())

    expect(result).toBe("content is required")
  })

  it("note rejects calls without an inner self context", async () => {
    const handler = await handlerFor("note")

    const result = await handler({ content: "No context should not write notes." } as never)

    expect(result).toMatch(/self trust/i)
  })

  it("consult_notes returns ranked note excerpts by embedding similarity", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.9, 0.1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1, 0.9] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    await noteHandler({ content: "Archive removal needs canonical notes.", tags: ["archive"] } as never, selfContext())
    await noteHandler({ content: "Voice latency tuning belongs somewhere else.", tags: ["voice"] } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive notes", limit: "5" } as never, selfContext())) as ConsultNotesResult

    expect(result.items).toHaveLength(1)
    expect(result.items[0].excerpt).toContain("Archive removal needs canonical notes.")
    expect(result.items[0].score).toBeGreaterThan(0.8)
    expect(result.nextCursor).toBeUndefined()
  })

  it("consult_notes paginates ranked results with a cursor", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.9, 0.1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.8, 0.2] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.7, 0.3] }] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    await noteHandler({ content: "First archive note." } as never, selfContext())
    await noteHandler({ content: "Second archive note." } as never, selfContext())
    await noteHandler({ content: "Third archive note." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const firstPage = JSON.parse(await consultHandler({ query: "archive", limit: "2" } as never, selfContext())) as ConsultNotesResult
    expect(firstPage.items.map((item) => item.excerpt)).toEqual([
      expect.stringContaining("First archive note."),
      expect.stringContaining("Second archive note."),
    ])
    expect(firstPage.nextCursor).toBeTruthy()

    const secondPage = JSON.parse(await consultHandler({ query: "archive", limit: "2", cursor: firstPage.nextCursor } as never, selfContext())) as ConsultNotesResult
    expect(secondPage.items.map((item) => item.excerpt)).toEqual([
      expect.stringContaining("Third archive note."),
    ])
    expect(secondPage.nextCursor).toBeUndefined()
  })

  it("consult_notes accepts numeric paging and scoring arguments", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.9, 0.1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.8, 0.2] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.7, 0.3] }] }) })
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    await noteHandler({ content: "First archive note." } as never, selfContext())
    await noteHandler({ content: "Second archive note." } as never, selfContext())
    await noteHandler({ content: "Third archive note." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: 1, cursor: 1, minScore: 0 } as never, selfContext())) as ConsultNotesResult

    expect(result.items.map((item) => item.excerpt)).toEqual([expect.stringContaining("Second archive note.")])
    expect(result.nextCursor).toBe("2")
  })

  it("consult_notes falls back from invalid paging and scoring arguments", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    await noteHandler({ content: "Archive searchable note." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "0", cursor: "-1", minScore: "not-a-number" } as never, selfContext())) as ConsultNotesResult

    expect(result.items).toHaveLength(1)
    expect(result.nextCursor).toBeUndefined()
  })

  it("consult_notes returns an empty page when no canonical notes exist", async () => {
    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "3" } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
  })

  it("consult_notes returns an empty page for a blank query", async () => {
    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "   " } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
  })

  it("consult_notes returns an empty page for non-string queries", async () => {
    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: 7 } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
  })

  it("consult_notes returns a friendly error when embeddings are not configured", async () => {
    const notesDir = path.join(agentRoot, "notes")
    writeCanonicalNote(notesDir, "2026-05-14-provider-missing.md")
    embeddingsApiKey = ""
    const consultHandler = await handlerFor("consult_notes")

    const result = await consultHandler({ query: "archive" } as never, selfContext())

    expect(result).toBe("error: consult_notes couldn't use notes because embeddings are not configured.")
  })

  it("consult_notes handles indexes with empty note embeddings", async () => {
    const notesDir = path.join(agentRoot, "notes")
    const filePath = writeCanonicalNote(notesDir, "2026-05-14-empty-embedding.md")
    writeFreshIndex(notesDir, filePath, [])
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", minScore: "0" } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
  })

  it("consult_notes rebuilds malformed and stale indexes from canonical markdown", async () => {
    const notesDir = path.join(agentRoot, "notes")
    fs.mkdirSync(notesDir, { recursive: true })
    const filePath = path.join(notesDir, "2026-05-14-archive-rebuild.md")
    fs.writeFileSync(filePath, [
      "---",
      "created_at: 2026-05-14T17:42:13.000Z",
      "tags: [\"archive\"]",
      "---",
      "Archive rebuild note.",
    ].join("\n"), "utf8")
    fs.writeFileSync(path.join(notesDir, ".index.json"), "{not json", "utf8")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "5" } as never, selfContext())) as ConsultNotesResult

    expect(result.items[0]!.filename).toBe("2026-05-14-archive-rebuild.md")
    const rebuilt = readJson(path.join(notesDir, ".index.json")) as { version: number; entries: unknown[] }
    expect(rebuilt.version).toBe(1)
    expect(rebuilt.entries).toHaveLength(1)
  })

  it("consult_notes rebuilds invalid and stale index shapes", async () => {
    const notesDir = path.join(agentRoot, "notes")
    const filePath = writeCanonicalNote(notesDir, "2026-05-14-stale-index-shapes.md")
    const stat = fs.statSync(filePath)
    const validButWrongEntry = {
      filename: "other-note.md",
      path: filePath,
      preview: "Archive searchable note.",
      embedding: [1, 0],
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
    const validButStaleEntry = {
      filename: "2026-05-14-stale-index-shapes.md",
      path: filePath,
      preview: "stale preview",
      embedding: [1, 0],
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
    const consultHandler = await handlerFor("consult_notes")

    for (const staleIndex of [
      { version: 2, entries: [] },
      { version: 1, entries: "not-an-array" },
      { version: 1, entries: [null] },
      { version: 1, entries: [] },
      { version: 1, entries: [validButWrongEntry] },
      { version: 1, entries: [validButStaleEntry] },
    ]) {
      fs.writeFileSync(path.join(notesDir, ".index.json"), `${JSON.stringify(staleIndex)}\n`, "utf8")

      const result = JSON.parse(await consultHandler({ query: "archive", limit: "5" } as never, selfContext())) as ConsultNotesResult

      expect(result.items[0]!.filename).toBe("2026-05-14-stale-index-shapes.md")
    }
  })

  it("consult_notes rebuilds notes without created_at and ignores malformed frontmatter lines", async () => {
    const notesDir = path.join(agentRoot, "notes")
    fs.mkdirSync(notesDir, { recursive: true })
    fs.writeFileSync(path.join(notesDir, "2026-05-14-no-created-at.md"), [
      "---",
      "not a key",
      "tags:",
      "  - archive",
      "---",
      "Archive note without a timestamp.",
    ].join("\n"), "utf8")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "5" } as never, selfContext())) as ConsultNotesResult

    expect(result.items[0]!.filename).toBe("2026-05-14-no-created-at.md")
    const rebuilt = readJson(path.join(notesDir, ".index.json")) as { entries: Array<{ created_at?: string; tags?: string[] }> }
    expect(rebuilt.entries[0]).not.toHaveProperty("created_at")
    expect(rebuilt.entries[0]!.tags).toEqual(["archive"])
  })

  it("consult_notes skips empty notes and tolerates sparse markdown frontmatter", async () => {
    const notesDir = path.join(agentRoot, "notes")
    fs.mkdirSync(notesDir, { recursive: true })
    fs.writeFileSync(path.join(notesDir, "2026-05-14-empty-body.md"), [
      "---",
      "created_at: 2026-05-14T17:42:13.000Z",
      "---",
      "   ",
    ].join("\n"), "utf8")
    fs.writeFileSync(path.join(notesDir, "2026-05-14-json-tags.md"), [
      "---",
      "",
      "created_at: 2026-05-14T17:42:13.000Z",
      "tags: [\"archive\", 7]",
      "---",
      "Archive note with filtered JSON tags.",
    ].join("\n"), "utf8")
    fs.writeFileSync(path.join(notesDir, "2026-05-14-empty-tags.md"), [
      "---",
      "tags:",
      "created_at: 2026-05-14T17:42:13.000Z",
      "---",
      "Archive note with empty tags.",
    ].join("\n"), "utf8")
    fs.writeFileSync(path.join(notesDir, "2026-05-14-open-frontmatter.md"), [
      "---",
      "created_at: 2026-05-14T17:42:13.000Z",
      "Open frontmatter note.",
    ].join("\n"), "utf8")

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "5", minScore: "0" } as never, selfContext())) as ConsultNotesResult

    expect(result.items.map((item) => item.filename)).toEqual([
      "2026-05-14-empty-tags.md",
      "2026-05-14-json-tags.md",
      "2026-05-14-open-frontmatter.md",
    ])
    const rebuilt = readJson(path.join(notesDir, ".index.json")) as { entries: Array<{ filename: string; tags?: string[] }> }
    expect(rebuilt.entries.map((entry) => entry.filename)).not.toContain("2026-05-14-empty-body.md")
    expect(rebuilt.entries.find((entry) => entry.filename === "2026-05-14-json-tags.md")!.tags).toEqual(["archive"])
    expect(rebuilt.entries.find((entry) => entry.filename === "2026-05-14-empty-tags.md")).not.toHaveProperty("tags")
  })

  it("consult_notes skips unreadable canonical markdown while rebuilding", async () => {
    const notesDir = path.join(agentRoot, "notes")
    fs.mkdirSync(notesDir, { recursive: true })
    const badPath = path.join(notesDir, "2026-05-14-unreadable.md")
    fs.writeFileSync(badPath, "Unreadable note.", "utf8")
    fs.chmodSync(badPath, 0)

    try {
      const consultHandler = await handlerFor("consult_notes")
      const result = JSON.parse(await consultHandler({ query: "anything" } as never, selfContext())) as ConsultNotesResult

      expect(result).toEqual({ items: [] })
    } finally {
      fs.chmodSync(badPath, 0o600)
    }
  })

  it("consult_notes rebuilds notes with malformed JSON tag frontmatter", async () => {
    const notesDir = path.join(agentRoot, "notes")
    fs.mkdirSync(notesDir, { recursive: true })
    fs.writeFileSync(path.join(notesDir, "2026-05-14-malformed-tags.md"), [
      "---",
      "created_at: 2026-05-14T17:42:13.000Z",
      "tags: [not-json]",
      "---",
      "Malformed tag note.",
    ].join("\n"), "utf8")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "malformed" } as never, selfContext())) as ConsultNotesResult

    expect(result.items[0]!.filename).toBe("2026-05-14-malformed-tags.md")
  })

  it("consult_notes returns a friendly error when query embeddings fail", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockRejectedValueOnce(new Error("embedding service down"))

    await noteHandler({ content: "Archive searchable note." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = await consultHandler({ query: "archive" } as never, selfContext())

    expect(result).toBe("error: consult_notes couldn't search notes right now.")
  })

  it("consult_notes sanitizes non-Error embedding failures", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })
      .mockRejectedValueOnce("embedding service down")

    await noteHandler({ content: "Archive searchable note." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = await consultHandler({ query: "archive" } as never, selfContext())

    expect(result).toBe("error: consult_notes couldn't search notes right now.")
  })

  it("consult_notes returns an empty page when no embedding match clears the threshold", async () => {
    const noteHandler = await handlerFor("note")
    mockFetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0, 1] }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [1, 0] }] }) })

    await noteHandler({ content: "Voice latency tuning belongs somewhere else." } as never, selfContext())

    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "5", minScore: "0.75" } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
  })

  it("consult_notes rejects callers without self trust", async () => {
    const consultHandler = await handlerFor("consult_notes")
    const result = await consultHandler({ query: "archive" } as never, trustedExternalContext())

    expect(result).toMatch(/self trust/i)
    expect(result).toMatch(/consult_notes/i)
  })
})
