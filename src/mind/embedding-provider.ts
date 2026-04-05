/**
 * Shared OpenAI embedding provider.
 *
 * Both diary.ts and associative-recall.ts need to call the OpenAI embeddings
 * API. This module provides the shared implementation so neither duplicates
 * the fetch logic.
 */

import { getOpenAIEmbeddingsApiKey } from "../heart/config"
import { emitNervesEvent } from "../nerves/runtime"

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small"

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private readonly apiKey: string
  private readonly model: string

  constructor(apiKey: string, model: string = DEFAULT_EMBEDDING_MODEL) {
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

/**
 * Create a default embedding provider from the configured API key.
 * Returns null if no key is configured.
 */
export function createDefaultEmbeddingProvider(): EmbeddingProvider | null {
  const apiKey = getOpenAIEmbeddingsApiKey().trim()
  if (!apiKey) return null

  emitNervesEvent({
    component: "mind",
    event: "mind.embedding_provider_created",
    message: "default embedding provider created",
    meta: { model: DEFAULT_EMBEDDING_MODEL },
  })

  return new OpenAIEmbeddingProvider(apiKey)
}
