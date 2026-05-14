import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type { ToolContext, ToolDefinition } from "../../repertoire/tools-base"
import { EVENT_CONTENT_MAX_CHARS } from "../../heart/session-events"
import { expectedCappedContent, expectedTruncationMarker, makeOversizedAgentContent } from "../helpers/content-cap"

let agentRoot = ""
const mockFetch = vi.fn()

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "slugger",
  getAgentRoot: () => agentRoot,
}))

vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => "test-openai-embeddings-key",
  getIntegrationsConfig: () => ({ openaiEmbeddingsApiKey: "test-openai-embeddings-key" }),
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

describe("record tools: note and consult_notes", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-05-14T17:42:13.000Z"))
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tools-record-"))
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

  it("note rejects callers without self trust", async () => {
    const handler = await handlerFor("note")
    const result = await handler({ content: "External callers cannot write canonical notes." } as never, trustedExternalContext())

    expect(result).toMatch(/self trust/i)
    expect(result).toMatch(/note/i)
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

  it("consult_notes returns an empty page when no canonical notes exist", async () => {
    const consultHandler = await handlerFor("consult_notes")
    const result = JSON.parse(await consultHandler({ query: "archive", limit: "3" } as never, selfContext())) as ConsultNotesResult

    expect(result).toEqual({ items: [] })
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
