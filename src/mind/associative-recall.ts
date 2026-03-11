import type OpenAI from "openai"
import * as fs from "fs"
import * as path from "path"
import { getOpenAIEmbeddingsApiKey } from "../heart/config"
import { getAgentRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

export interface MemoryFactRecord {
  id: string
  text: string
  source: string
  createdAt: string
  embedding: number[]
}

export interface RecalledFact extends MemoryFactRecord {
  score: number
}

export interface RecallQueryOptions {
  minScore?: number
  topK?: number
}

export interface InjectAssociativeRecallOptions extends RecallQueryOptions {
  provider?: EmbeddingProvider
  memoryRoot?: string
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"
const DEFAULT_MIN_SCORE = 0.5
const DEFAULT_TOP_K = 3

class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private apiKey: string
  private model: string

  constructor(apiKey: string, model = DEFAULT_EMBEDDING_MODEL) {
    this.apiKey = apiKey
    this.model = model
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    })
    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status} ${response.statusText}`)
    }
    const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> }
    if (!payload.data || payload.data.length !== texts.length) {
      throw new Error("embedding response missing expected vectors")
    }
    return payload.data.map((entry) => entry.embedding)
  }
}

function createDefaultProvider(): EmbeddingProvider {
  const apiKey = getOpenAIEmbeddingsApiKey()
  if (!apiKey) {
    throw new Error("openaiEmbeddingsApiKey not configured")
  }
  return new OpenAIEmbeddingProvider(apiKey)
}

function readFacts(memoryRoot: string): MemoryFactRecord[] {
  const factsPath = path.join(memoryRoot, "facts.jsonl")
  if (!fs.existsSync(factsPath)) return []
  const raw = fs.readFileSync(factsPath, "utf8").trim()
  if (!raw) return []
  const facts: MemoryFactRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      facts.push(JSON.parse(trimmed) as MemoryFactRecord)
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

export async function recallFactsForQuery(
  query: string,
  facts: MemoryFactRecord[],
  provider: EmbeddingProvider,
  options?: RecallQueryOptions,
): Promise<RecalledFact[]> {
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

export async function injectAssociativeRecall(
  messages: OpenAI.ChatCompletionMessageParam[],
  options?: InjectAssociativeRecallOptions,
): Promise<void> {
  try {
    if (messages[0]?.role !== "system" || typeof messages[0].content !== "string") return
    const query = getLatestUserText(messages)
    if (!query) return

    const memoryRoot = options?.memoryRoot ?? path.join(getAgentRoot(), "psyche", "memory")
    const facts = readFacts(memoryRoot)
    if (facts.length === 0) return

    let recalled: RecalledFact[]
    try {
      const provider = options?.provider ?? createDefaultProvider()
      recalled = await recallFactsForQuery(query, facts, provider, options)
    } catch {
      // Embeddings unavailable — fall back to substring matching
      const lowerQuery = query.toLowerCase()
      const topK = options?.topK ?? DEFAULT_TOP_K
      recalled = facts
        .filter((fact) => fact.text.toLowerCase().includes(lowerQuery))
        .slice(0, topK)
        .map((fact) => ({ ...fact, score: 1 }))
      if (recalled.length > 0) {
        emitNervesEvent({
          level: "warn",
          component: "mind",
          event: "mind.associative_recall_fallback",
          message: "embeddings unavailable, used substring fallback",
          meta: { matchCount: recalled.length },
        })
      }
    }
    if (recalled.length === 0) return

    const recallSection = recalled
      .map((fact, index) => `${index + 1}. ${fact.text} [score=${fact.score.toFixed(3)} source=${fact.source}]`)
      .join("\n")
    messages[0] = {
      role: "system",
      content: `${messages[0].content}\n\n## recalled context\n${recallSection}`,
    }

    emitNervesEvent({
      component: "mind",
      event: "mind.associative_recall",
      message: "associative recall injected",
      meta: { count: recalled.length },
    })
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.associative_recall_error",
      message: "associative recall failed",
      meta: {
        reason: error instanceof Error ? error.message : /* v8 ignore start -- defensive: non-Error catch branch @preserve */ String(error) /* v8 ignore stop */,
      },
    })
  }
}
