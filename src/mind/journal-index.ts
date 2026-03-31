import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import type { JournalIndexEntry } from "./associative-recall"

export interface JournalEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

const TEXT_EXTENSIONS = new Set([".md", ".txt"])
const PREVIEW_CHAR_LIMIT = 500

function readExistingIndex(indexPath: string): JournalIndexEntry[] {
  try {
    const raw = fs.readFileSync(indexPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as JournalIndexEntry[]
  } catch {
    return []
  }
}

function extractPreview(content: string): string {
  const trimmed = content.trim()
  if (!trimmed) return ""
  return trimmed.split("\n")[0].replace(/^#+\s*/, "").trim()
}

export async function indexJournalFiles(
  journalDir: string,
  indexPath: string,
  embedProvider: JournalEmbeddingProvider,
): Promise<number> {
  // Read existing index
  const existingIndex = readExistingIndex(indexPath)
  const indexMap = new Map<string, JournalIndexEntry>()
  for (const entry of existingIndex) {
    indexMap.set(entry.filename, entry)
  }

  // Scan journal dir for text files
  let dirEntries: fs.Dirent[]
  try {
    dirEntries = fs.readdirSync(journalDir, { withFileTypes: true })
  } catch {
    emitNervesEvent({
      component: "mind",
      event: "mind.journal_index_scan",
      message: "journal dir not found or unreadable",
      meta: { journalDir },
    })
    return 0
  }

  const textFiles = dirEntries.filter((entry) => {
    if (!entry.isFile()) return false
    if (entry.name.startsWith(".")) return false
    const ext = path.extname(entry.name).toLowerCase()
    return TEXT_EXTENSIONS.has(ext)
  })

  if (textFiles.length === 0) {
    emitNervesEvent({
      component: "mind",
      event: "mind.journal_index_scan",
      message: "no text files found in journal",
      meta: { journalDir },
    })
    return 0
  }

  let newlyIndexed = 0

  for (const file of textFiles) {
    const filePath = path.join(journalDir, file.name)
    let stat: fs.Stats
    try {
      stat = fs.statSync(filePath)
    } catch {
      /* v8 ignore next -- filesystem race: file deleted between readdir and stat @preserve */
      continue
    }

    // Check if already indexed with same mtime
    const existing = indexMap.get(file.name)
    if (existing && existing.mtime === stat.mtimeMs) {
      continue
    }

    // Read content for embedding
    let content: string
    try {
      content = fs.readFileSync(filePath, "utf8")
    } catch {
      /* v8 ignore next -- filesystem race: file deleted between stat and read @preserve */
      continue
    }

    const preview = extractPreview(content)
    const embedText = content.slice(0, PREVIEW_CHAR_LIMIT)

    // Generate embedding
    let embedding: number[]
    try {
      const vectors = await embedProvider.embed([embedText])
      embedding = vectors[0] ?? []
    } catch {
      emitNervesEvent({
        level: "warn",
        component: "mind",
        event: "mind.journal_embedding_error",
        message: "embedding failed for journal file",
        meta: { filename: file.name },
      })
      embedding = []
    }

    indexMap.set(file.name, {
      filename: file.name,
      embedding,
      mtime: stat.mtimeMs,
      preview,
    })
    newlyIndexed++
  }

  // Write updated index back
  if (newlyIndexed > 0) {
    const updatedIndex = Array.from(indexMap.values())
    fs.writeFileSync(indexPath, JSON.stringify(updatedIndex, null, 2), "utf8")
  }

  emitNervesEvent({
    component: "mind",
    event: "mind.journal_index_complete",
    message: "journal indexing complete",
    meta: { journalDir, newlyIndexed, total: indexMap.size },
  })

  return newlyIndexed
}
