import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { resolveDiaryRoot, type DiaryEntryProvenance } from "./diary"
import { classifyProvenanceTrust } from "./provenance-trust"
import { type EmbeddingProvider, createDefaultEmbeddingProvider } from "./embedding-provider"

// Re-export EmbeddingProvider so existing consumers don't break.
export type { EmbeddingProvider }

export interface DiaryEntryRecord {
  id: string
  text: string
  source: string
  createdAt: string
  embedding: number[]
  provenance?: DiaryEntryProvenance
}

export interface DiarySearchHit extends DiaryEntryRecord {
  score: number
}

export interface NoteSearchOptions {
  minScore?: number
  topK?: number
}

export interface JournalIndexEntry {
  filename: string
  embedding: number[]
  mtime: number
  preview: string
}

export interface JournalSearchHit {
  filename: string
  preview: string
  score: number
}

export interface InjectNoteSearchContextOptions extends NoteSearchOptions {
  provider?: EmbeddingProvider
  diaryRoot?: string
  journalDir?: string
}

const DEFAULT_MIN_SCORE = 0.5
const DEFAULT_TOP_K = 3

function createDefaultProvider(): EmbeddingProvider {
  const provider = createDefaultEmbeddingProvider()
  if (!provider) {
    throw new Error("openaiEmbeddingsApiKey not configured")
  }
  return provider
}

function readFacts(diaryRoot: string): DiaryEntryRecord[] {
  const factsPath = path.join(diaryRoot, "facts.jsonl")
  if (!fs.existsSync(factsPath)) return []
  const raw = fs.readFileSync(factsPath, "utf8").trim()
  if (!raw) return []
  const facts: DiaryEntryRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      facts.push(JSON.parse(trimmed) as DiaryEntryRecord)
    } catch {
      // Skip corrupt lines (e.g. partial write from a crash).
    }
  }
  return facts
}

function getLatestUserText(messages: OpenAI.ChatCompletionMessageParam[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    if (typeof message.content !== "string") continue
    const text = message.content.trim()
    if (text.length > 0) return text
  }
  return ""
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i++) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }
  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export async function searchDiaryFactsForQuery(
  query: string,
  facts: DiaryEntryRecord[],
  provider: EmbeddingProvider,
  options?: NoteSearchOptions,
): Promise<DiarySearchHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE
  const topK = options?.topK ?? DEFAULT_TOP_K
  const [queryEmbedding] = await provider.embed([trimmed])

  return facts
    .map((fact) => ({
      ...fact,
      score: cosineSimilarity(queryEmbedding, fact.embedding),
    }))
    .filter((fact) => fact.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
}

function readJournalIndex(journalDir: string): JournalIndexEntry[] {
  const indexPath = path.join(journalDir, ".index.json")
  try {
    const raw = fs.readFileSync(indexPath, "utf8")
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as JournalIndexEntry[]
  } catch {
    return []
  }
}

export function searchJournalIndex(
  queryEmbedding: number[],
  entries: JournalIndexEntry[],
  options?: { minScore?: number; topK?: number },
): JournalSearchHit[] {
  const minScore = options?.minScore ?? DEFAULT_MIN_SCORE
  const topK = options?.topK ?? DEFAULT_TOP_K

  return entries
    .filter((entry) => Array.isArray(entry.embedding) && entry.embedding.length > 0)
    .map((entry) => ({
      filename: entry.filename,
      preview: entry.preview,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }))
    .filter((entry) => entry.score >= minScore)
    .sort((left, right) => right.score - left.score)
    .slice(0, topK)
}

function resolveJournalDir(diaryRoot: string, explicitJournalDir?: string): string {
  if (explicitJournalDir) return explicitJournalDir
  // journal/ is a sibling of diary/ at the agent root level
  const agentRoot = path.dirname(diaryRoot)
  return path.join(agentRoot, "journal")
}

export async function injectNoteSearchContext(
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: InjectNoteSearchContextOptions,
): Promise<void> {
  try {
    if (messages[0]?.role !== "system" || typeof messages[0].content !== "string") return
    const query = getLatestUserText(messages)
    if (!query) return

    const diaryRoot = options?.diaryRoot ?? resolveDiaryRoot()
    const facts = readFacts(diaryRoot)
    const journalDir = resolveJournalDir(diaryRoot, options?.journalDir)
    const journalEntries = readJournalIndex(journalDir)

    if (facts.length === 0 && journalEntries.length === 0) return

    // Build combined result lines tagged by source
    const resultLines: Array<{ text: string; score: number }> = []
    let queryEmbedding: number[] | undefined

    // Search diary entries
    if (facts.length > 0) {
      let found: DiarySearchHit[]
      try {
        const provider = options?.provider ?? createDefaultProvider()
        found = await searchDiaryFactsForQuery(query, facts, provider, options)

        // Compute query embedding for journal search while provider is available
        if (journalEntries.length > 0) {
          const [qe] = await provider.embed([query.trim()])
          queryEmbedding = qe
        }
      } catch {
        // Embeddings unavailable — fall back to substring matching
        const lowerQuery = query.toLowerCase()
        const topK = options?.topK ?? DEFAULT_TOP_K
        found = facts
          .filter((fact) => fact.text.toLowerCase().includes(lowerQuery))
          .slice(0, topK)
          .map((fact) => ({ ...fact, score: 1 }))
        if (found.length > 0) {
          emitNervesEvent({
            level: "warn",
            component: "mind",
            event: "mind.note_search_fallback",
            message: "embeddings unavailable, used substring fallback",
            meta: { matchCount: found.length },
          })
        }
      }

      for (const fact of found) {
        let meta = `score=${fact.score.toFixed(3)} source=${fact.source}`
        if (fact.provenance) {
          if (fact.provenance.channel) meta += ` channel=${fact.provenance.channel}`
          if (fact.provenance.friendName) meta += ` friend=${fact.provenance.friendName}`
          if (fact.provenance.trust) meta += ` trust=${fact.provenance.trust}`
        }
        const tag = classifyProvenanceTrust(fact.provenance) === "external" ? "diary/external" : "diary"
        resultLines.push({
          text: `[${tag}] ${fact.text} [${meta}]`,
          score: fact.score,
        })
      }
    }

    // Search journal entries (works whether diary had results or not)
    if (journalEntries.length > 0) {
      try {
        if (!queryEmbedding) {
          const provider = options?.provider ?? createDefaultProvider()
          const [qe] = await provider.embed([query.trim()])
          queryEmbedding = qe
        }
        if (queryEmbedding) {
          const journalResults = searchJournalIndex(queryEmbedding, journalEntries, options)
          for (const entry of journalResults) {
            resultLines.push({
              text: `[journal] ${entry.filename}: ${entry.preview} [score=${entry.score.toFixed(3)}]`,
              score: entry.score,
            })
          }
        }
      } catch {
        // Embeddings unavailable — no journal fallback
      }
    }

    if (resultLines.length === 0) return

    // Sort all results by score descending
    resultLines.sort((left, right) => right.score - left.score)

    const noteSection = resultLines
      .map((entry, index) => `${index + 1}. ${entry.text}`)
      .join("\n")
    messages[0] = {
      role: "system",
      content: `${messages[0].content}\n\n## from my diary and journal\n${noteSection}`,
    }

    emitNervesEvent({
      component: "mind",
      event: "mind.note_search_context",
      message: "note search injected",
      meta: { count: resultLines.length },
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.note_search_context_error",
      message: "note search failed",
      meta: {
        reason: error instanceof Error ? error.message : /* v8 ignore start -- defensive: non-Error catch branch @preserve */ String(error) /* v8 ignore stop */,
      },
    })
  }
}
