import * as fs from "fs"
import * as path from "path"
import { capStructuredRecordString } from "../heart/session-events"
import { getAgentRoot } from "../heart/identity"
import { type EmbeddingProvider, createDefaultEmbeddingProvider } from "../mind/embedding-provider"
import { cosineSimilarity } from "../mind/note-search"
import { emitNervesEvent } from "../nerves/runtime"
import type { ToolContext, ToolDefinition } from "./tools-base"

const NOTES_INDEX_VERSION = 1
const NOTE_SLUG_MAX_CHARS = 40
const DEFAULT_LIMIT = 5
const MAX_LIMIT = 25
const DEFAULT_MIN_SCORE = 0.5
const PREVIEW_CHAR_LIMIT = 500

interface NoteRecord {
  filename: string
  filePath: string
  body: string
  preview: string
  createdAt?: string
  tags?: string[]
  mtimeMs: number
  size: number
}

interface NotesIndexEntry {
  filename: string
  path: string
  preview: string
  embedding: number[]
  created_at?: string
  tags?: string[]
  mtimeMs: number
  size: number
}

interface NotesIndex {
  version: 1
  entries: NotesIndexEntry[]
}

function hasSelfTrust(ctx?: ToolContext): boolean {
  const channel = ctx?.context?.channel?.channel
  if (channel !== "inner") return false
  const friend = ctx?.context?.friend
  return !friend || friend.id === "self"
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined
  const rawTags = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []
  const tags = rawTags
    .map((tag) => (typeof tag === "string" ? tag.trim() : ""))
    .filter((tag) => tag.length > 0)
  return tags.length > 0 ? tags : undefined
}

function slugForContent(content: string): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, NOTE_SLUG_MAX_CHARS)
    .replace(/-+$/g, "")
  return slug || "note"
}

function renderNote(createdAt: string, content: string, tags?: string[]): string {
  const frontmatter = [`created_at: ${createdAt}`]
  if (tags?.length) {
    frontmatter.push("tags:")
    for (const tag of tags) {
      frontmatter.push(`  - ${JSON.stringify(tag)}`)
    }
  }
  return `---\n${frontmatter.join("\n")}\n---\n${content}\n`
}

function ensureUniquePath(notesDir: string, date: string, slug: string): string {
  let candidate = path.join(notesDir, `${date}-${slug}.md`)
  let suffix = 2
  while (fs.existsSync(candidate)) {
    const suffixText = `-${suffix}`
    const cappedSlug = `${slug.slice(0, Math.max(0, NOTE_SLUG_MAX_CHARS - suffixText.length)).replace(/-+$/g, "")}${suffixText}`
    candidate = path.join(notesDir, `${date}-${cappedSlug}.md`)
    suffix += 1
  }
  return candidate
}

function extractPreview(body: string): string {
  const firstLine = body.trim().split("\n").find((line) => line.trim().length > 0)!
  return capStructuredRecordString(firstLine.trim()).slice(0, PREVIEW_CHAR_LIMIT)
}

function parseTagsFromFrontmatter(lines: string[], startIndex: number): { tags: string[]; nextIndex: number } {
  const tags: string[] = []
  let i = startIndex
  while (lines[i + 1]?.trimStart().startsWith("- ")) {
    i += 1
    tags.push(lines[i].trimStart().slice(2).trim().replace(/^"|"$/g, ""))
  }
  return { tags, nextIndex: i }
}

function parseCanonicalNote(filePath: string, stat: fs.Stats): NoteRecord | null {
  const raw = fs.readFileSync(filePath, "utf8")
  let body = raw
  let createdAt: string | undefined
  let tags: string[] | undefined

  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4)
    if (end > 0) {
      const frontmatterRaw = raw.slice(4, end)
      body = raw.slice(end + "\n---\n".length)
      const lines = frontmatterRaw.split("\n")
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (!line.trim()) continue
        const colonIndex = line.indexOf(":")
        if (colonIndex < 0) continue
        const key = line.slice(0, colonIndex)
        const value = line.slice(colonIndex + 1).trim()
        if (key === "created_at" && value) {
          createdAt = value.replace(/^"|"$/g, "")
        }
        if (key === "tags") {
          if (value.startsWith("[") && value.endsWith("]")) {
            try {
              const parsed = JSON.parse(value) as unknown[]
              tags = parsed.filter((tag): tag is string => typeof tag === "string")
            } catch {
              tags = undefined
            }
          } else {
            const parsedTags = parseTagsFromFrontmatter(lines, i)
            tags = parsedTags.tags.length > 0 ? parsedTags.tags : undefined
            i = parsedTags.nextIndex
          }
        }
      }
    }
  }

  const trimmedBody = body.trim()
  if (!trimmedBody) return null
  return {
    filename: path.basename(filePath),
    filePath,
    body: trimmedBody,
    preview: extractPreview(trimmedBody),
    createdAt,
    tags,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
}

function listCanonicalNotes(notesDir: string): NoteRecord[] {
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(notesDir, { withFileTypes: true })
  } catch {
    return []
  }

  return dirEntries
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".md"))
    .map((entry) => {
      const filePath = path.join(notesDir, entry.name)
      try {
        return parseCanonicalNote(filePath, fs.statSync(filePath))
      } catch {
        return null
      }
    })
    .filter((record): record is NoteRecord => record !== null)
    .sort((left, right) => left.filename.localeCompare(right.filename))
}

function readIndex(indexPath: string): NotesIndex | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as Partial<NotesIndex>
    if (parsed.version !== NOTES_INDEX_VERSION || !Array.isArray(parsed.entries)) return null
    if (!parsed.entries.every(isIndexEntry)) return null
    return parsed as NotesIndex
  } catch {
    return null
  }
}

function isIndexEntry(value: unknown): value is NotesIndexEntry {
  if (!value || typeof value !== "object") return false
  const entry = value as Partial<NotesIndexEntry>
  return (
    typeof entry.filename === "string" &&
    typeof entry.path === "string" &&
    typeof entry.preview === "string" &&
    Array.isArray(entry.embedding) &&
    entry.embedding.every((item) => typeof item === "number") &&
    typeof entry.mtimeMs === "number" &&
    typeof entry.size === "number"
  )
}

function entryMatchesRecord(entry: NotesIndexEntry, record: NoteRecord): boolean {
  return (
    entry.filename === record.filename &&
    entry.path === record.filePath &&
    entry.mtimeMs === record.mtimeMs &&
    entry.size === record.size &&
    entry.preview === record.preview
  )
}

function indexFreshForRecords(index: NotesIndex | null, records: NoteRecord[]): index is NotesIndex {
  if (!index) return false
  if (index.entries.length !== records.length) return false
  const recordsByFilename = new Map(records.map((record) => [record.filename, record]))
  const seenFilenames = new Set<string>()
  for (const entry of index.entries) {
    if (seenFilenames.has(entry.filename)) return false
    const record = recordsByFilename.get(entry.filename)
    if (!record || !entryMatchesRecord(entry, record)) return false
    seenFilenames.add(entry.filename)
  }
  return seenFilenames.size === recordsByFilename.size
}

function indexFreshExcept(index: NotesIndex | null, records: NoteRecord[], filename: string): index is NotesIndex {
  if (!index) return false
  const otherRecords = records.filter((record) => record.filename !== filename)
  const otherEntries = index.entries.filter((entry) => entry.filename !== filename)
  return indexFreshForRecords({ version: NOTES_INDEX_VERSION, entries: otherEntries }, otherRecords)
}

function makeEntry(record: NoteRecord, embedding: number[]): NotesIndexEntry {
  return {
    filename: record.filename,
    path: record.filePath,
    preview: record.preview,
    embedding,
    ...(record.createdAt ? { created_at: record.createdAt } : {}),
    ...(record.tags ? { tags: record.tags } : {}),
    mtimeMs: record.mtimeMs,
    size: record.size,
  }
}

function writeIndex(indexPath: string, index: NotesIndex): void {
  fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8")
}

async function embedRecord(provider: EmbeddingProvider, record: NoteRecord): Promise<NotesIndexEntry> {
  const [embedding] = await provider.embed([record.body])
  return makeEntry(record, embedding!)
}

async function rebuildNotesIndex(notesDir: string, indexPath: string, provider: EmbeddingProvider): Promise<NotesIndex> {
  const records = listCanonicalNotes(notesDir)
  const entries: NotesIndexEntry[] = []
  for (const record of records) {
    entries.push(await embedRecord(provider, record))
  }
  const index: NotesIndex = { version: NOTES_INDEX_VERSION, entries }
  writeIndex(indexPath, index)
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.record_notes_index_rebuilt",
    message: "notes native index rebuilt",
    meta: { notesDir, count: entries.length },
  })
  return index
}

async function updateIndexForSavedNote(
  notesDir: string,
  indexPath: string,
  savedPath: string,
  provider: EmbeddingProvider,
): Promise<void> {
  const savedRecord = parseCanonicalNote(savedPath, fs.statSync(savedPath))!
  const records = [
    ...listCanonicalNotes(notesDir).filter((record) => record.filePath !== savedPath),
    savedRecord,
  ].sort((left, right) => left.filename.localeCompare(right.filename))

  const existing = readIndex(indexPath)
  if (!indexFreshExcept(existing, records, savedRecord.filename)) {
    await rebuildNotesIndex(notesDir, indexPath, provider)
    return
  }

  const savedEntry = await embedRecord(provider, savedRecord)
  const entries = [
    ...existing.entries.filter((entry) => entry.filename !== savedRecord.filename),
    savedEntry,
  ].sort((left, right) => left.filename.localeCompare(right.filename))
  writeIndex(indexPath, { version: NOTES_INDEX_VERSION, entries })
}

async function getFreshIndex(notesDir: string, indexPath: string, provider: EmbeddingProvider): Promise<NotesIndex> {
  const records = listCanonicalNotes(notesDir)
  const existing = readIndex(indexPath)
  if (indexFreshForRecords(existing, records)) return existing
  return rebuildNotesIndex(notesDir, indexPath, provider)
}

function createProviderForTool(toolName: string): EmbeddingProvider | string {
  const provider = createDefaultEmbeddingProvider()
  if (!provider) {
    return `error: ${toolName} couldn't use notes because embeddings are not configured.`
  }
  return provider
}

function parseLimit(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : DEFAULT_LIMIT
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(parsed), MAX_LIMIT)
}

function parseMinScore(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : DEFAULT_MIN_SCORE
  if (!Number.isFinite(parsed)) return DEFAULT_MIN_SCORE
  return parsed
}

function parseCursor(raw: unknown): number {
  const parsed = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : 0
  if (!Number.isFinite(parsed) || parsed < 0) return 0
  return Math.floor(parsed)
}

export const recordToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "note",
        description:
          "Write a durable self note as canonical markdown in my notes folder. Only available to my self/inner context, not external callers.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string" },
            tags: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["content"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!hasSelfTrust(ctx)) return "error: note requires self trust and cannot be used from an external caller context."

      const rawArgs = args as Record<string, unknown>
      const content = typeof rawArgs.content === "string" ? rawArgs.content.trim() : ""
      if (!content) return "content is required"

      const provider = createProviderForTool("note")
      if (typeof provider === "string") return provider

      const cappedContent = capStructuredRecordString(content)
      const createdAt = new Date().toISOString()
      const date = createdAt.slice(0, 10)
      const tags = normalizeTags(rawArgs.tags)
      const notesDir = path.join(getAgentRoot(), "notes")
      const indexPath = path.join(notesDir, ".index.json")

      try {
        fs.mkdirSync(notesDir, { recursive: true })
        const savedPath = ensureUniquePath(notesDir, date, slugForContent(content))
        fs.writeFileSync(savedPath, renderNote(createdAt, cappedContent, tags), "utf8")
        await updateIndexForSavedNote(notesDir, indexPath, savedPath, provider)
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.record_note_saved",
          message: "canonical note saved",
          meta: { path: savedPath, hasTags: Boolean(tags?.length) },
        })
        return savedPath
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "repertoire",
          event: "repertoire.record_note_save_error",
          message: "canonical note save failed",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
        return "error: couldn't save the note right now."
      }
    },
    summaryKeys: ["content", "tags"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "consult_notes",
        description:
          "Search my canonical markdown notes semantically using the notes-native index. Only available to my self/inner context, not external callers.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            cursor: { type: "string" },
            limit: { type: "string" },
            minScore: { type: "string" },
          },
          required: ["query"],
        },
      },
    },
    handler: async (args, ctx) => {
      if (!hasSelfTrust(ctx)) return "error: consult_notes requires self trust and cannot be used from an external caller context."

      const rawArgs = args as Record<string, unknown>
      const query = typeof rawArgs.query === "string" ? rawArgs.query.trim() : ""
      if (!query) return JSON.stringify({ items: [] })

      const notesDir = path.join(getAgentRoot(), "notes")
      const indexPath = path.join(notesDir, ".index.json")
      const records = listCanonicalNotes(notesDir)
      if (records.length === 0) return JSON.stringify({ items: [] })

      const provider = createProviderForTool("consult_notes")
      if (typeof provider === "string") return provider

      try {
        const index = await getFreshIndex(notesDir, indexPath, provider)

        const [queryEmbedding] = await provider.embed([query])
        const minScore = parseMinScore(rawArgs.minScore)
        const offset = parseCursor(rawArgs.cursor)
        const limit = parseLimit(rawArgs.limit)
        const ranked = index.entries
          .filter((entry) => entry.embedding.length > 0)
          .map((entry) => ({
            path: entry.path,
            filename: entry.filename,
            excerpt: entry.preview,
            score: cosineSimilarity(queryEmbedding!, entry.embedding),
          }))
          .filter((entry) => entry.score >= minScore)
          .sort((left, right) => right.score - left.score)

        const items = ranked.slice(offset, offset + limit)
        const nextOffset = offset + limit
        const result = nextOffset < ranked.length ? { items, nextCursor: String(nextOffset) } : { items }
        emitNervesEvent({
          component: "repertoire",
          event: "repertoire.record_notes_consulted",
          message: "canonical notes consulted",
          meta: { count: items.length, totalMatches: ranked.length },
        })
        return JSON.stringify(result)
      } catch (error) {
        emitNervesEvent({
          level: "warn",
          component: "repertoire",
          event: "repertoire.record_notes_consult_error",
          message: "canonical notes consult failed",
          meta: { reason: error instanceof Error ? error.message : String(error) },
        })
        return "error: consult_notes couldn't search notes right now."
      }
    },
    summaryKeys: ["query"],
  },
]
