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

export interface InjectNoteSearchContextOptions extends NoteSearchOptions {
  provider?: EmbeddingProvider
  diaryRoot?: string
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

    if (facts.length === 0) return

    const resultLines: Array<{ text: string; score: number }> = []

    let found: DiarySearchHit[]
    try {
      const provider = options?.provider ?? createDefaultProvider()
      found = await searchDiaryFactsForQuery(query, facts, provider, options)
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

    if (resultLines.length === 0) return

    resultLines.sort((left, right) => right.score - left.score)

    const noteSection = resultLines
      .map((entry, index) => `${index + 1}. ${entry.text}`)
      .join("\n")
    messages[0] = {
      role: "system",
      content: `${messages[0].content}\n\n## retrieved from my Desk record diary\n${noteSection}`,
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
