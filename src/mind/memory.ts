import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getOpenAIEmbeddingsApiKey } from "../heart/config";
import { getAgentRoot } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";

export interface MemoryStorePaths {
  rootDir: string;
  factsPath: string;
  entitiesPath: string;
  dailyDir: string;
}

export interface MemoryFact {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  about?: string;
  embedding: number[];
}

export interface MemoryWriteResult {
  added: number;
  skipped: number;
}

export interface MemoryEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface SaveMemoryFactOptions {
  text: string;
  source: string;
  about?: string;
  memoryRoot?: string;
  now?: () => Date;
  idFactory?: () => string;
  embeddingProvider?: MemoryEmbeddingProvider;
}

export interface EntityIndexEntry {
  count: number;
  factIds: string[];
  lastSeenAt: string;
}

export type EntityIndex = Record<string, EntityIndexEntry>;

const DEDUP_THRESHOLD = 0.6;
const ENTITY_TOKEN = /[a-z0-9]+/g;
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

class OpenAIEmbeddingProvider implements MemoryEmbeddingProvider {
  constructor(private readonly apiKey: string, private readonly model: string = DEFAULT_EMBEDDING_MODEL) {}

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
    });

    if (!response.ok) {
      throw new Error(`embedding request failed: ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as { data?: Array<{ embedding: number[] }> };
    if (!payload.data || payload.data.length !== texts.length) {
      throw new Error("embedding response missing expected vectors");
    }

    return payload.data.map((entry) => entry.embedding);
  }
}

export function ensureMemoryStorePaths(rootDir: string): MemoryStorePaths {
  const factsPath = path.join(rootDir, "facts.jsonl");
  const entitiesPath = path.join(rootDir, "entities.json");
  const dailyDir = path.join(rootDir, "daily");

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(dailyDir, { recursive: true });
  if (!fs.existsSync(factsPath)) fs.writeFileSync(factsPath, "", "utf8");
  if (!fs.existsSync(entitiesPath)) fs.writeFileSync(entitiesPath, "{}\n", "utf8");

  emitNervesEvent({
    component: "mind",
    event: "mind.memory_paths_ready",
    message: "memory store paths ready",
    meta: { rootDir },
  });
  return { rootDir, factsPath, entitiesPath, dailyDir };
}


function overlapScore(left: string, right: string): number {
  const leftWords = new Set(
    left
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean),
  );
  const rightWords = new Set(
    right
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .filter(Boolean),
  );
  if (leftWords.size === 0 || rightWords.size === 0) return 0;
  let common = 0;
  for (const word of leftWords) {
    if (rightWords.has(word)) common++;
  }
  return common / Math.min(leftWords.size, rightWords.size);
}

function readExistingFacts(factsPath: string): MemoryFact[] {
  if (!fs.existsSync(factsPath)) return [];
  const raw = fs.readFileSync(factsPath, "utf8").trim();
  if (!raw) return [];
  const facts: MemoryFact[] = [];
  for (const line of raw.split("\n")) {
    try {
      facts.push(JSON.parse(line) as MemoryFact);
    } catch {
      // Skip corrupt lines (e.g. partial write from a crash).
    }
  }
  return facts;
}

function readEntityIndex(entitiesPath: string): EntityIndex {
  if (!fs.existsSync(entitiesPath)) return {};
  try {
    const raw = fs.readFileSync(entitiesPath, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as EntityIndex;
  } catch {
    return {};
  }
}

function writeEntityIndex(entitiesPath: string, index: EntityIndex): void {
  fs.writeFileSync(entitiesPath, JSON.stringify(index, null, 2) + "\n", "utf8");
}

function extractEntityTokens(text: string): string[] {
  const matches = text.toLowerCase().match(ENTITY_TOKEN) ?? [];
  return [...new Set(matches.filter((token) => token.length >= 3))];
}

function updateEntityIndex(entitiesPath: string, fact: MemoryFact): void {
  const index = readEntityIndex(entitiesPath);
  const tokens = extractEntityTokens(fact.text);
  for (const token of tokens) {
    const existing = index[token];
    if (existing) {
      existing.count += 1;
      if (!existing.factIds.includes(fact.id)) existing.factIds.push(fact.id);
      existing.lastSeenAt = fact.createdAt;
      continue;
    }
    index[token] = {
      count: 1,
      factIds: [fact.id],
      lastSeenAt: fact.createdAt,
    };
  }
  writeEntityIndex(entitiesPath, index);
}

function appendDailyFact(dailyDir: string, fact: MemoryFact): void {
  fs.mkdirSync(dailyDir, { recursive: true });
  const day = fact.createdAt.slice(0, 10) || "unknown";
  const dayPath = path.join(dailyDir, `${day}.jsonl`);
  fs.appendFileSync(dayPath, `${JSON.stringify(fact)}\n`, "utf8");
}

export function appendFactsWithDedup(stores: MemoryStorePaths, incoming: MemoryFact[]): MemoryWriteResult {
  const existing = readExistingFacts(stores.factsPath);
  const all = [...existing];
  let added = 0;
  let skipped = 0;

  for (const fact of incoming) {
    const duplicate = all.some((prior) => overlapScore(prior.text, fact.text) > DEDUP_THRESHOLD);
    if (duplicate) {
      skipped++;
      continue;
    }
    all.push(fact);
    added++;
    fs.appendFileSync(stores.factsPath, `${JSON.stringify(fact)}\n`, "utf8");
    updateEntityIndex(stores.entitiesPath, fact);
    appendDailyFact(stores.dailyDir, fact);
  }

  emitNervesEvent({
    component: "mind",
    event: "mind.memory_write",
    message: "memory write completed",
    meta: { added, skipped },
  });
  return { added, skipped };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i];
    leftNorm += left[i] * left[i];
    rightNorm += right[i] * right[i];
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export const __memoryTestUtils = {
  cosineSimilarity,
};

function createDefaultEmbeddingProvider(): MemoryEmbeddingProvider | null {
  const apiKey = getOpenAIEmbeddingsApiKey().trim();
  if (!apiKey) return null;
  return new OpenAIEmbeddingProvider(apiKey);
}

async function buildEmbedding(text: string, embeddingProvider?: MemoryEmbeddingProvider): Promise<number[]> {
  const provider = embeddingProvider ?? createDefaultEmbeddingProvider();
  if (!provider) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.memory_embedding_unavailable",
      message: "embedding provider unavailable for memory write",
      meta: { reason: "missing_openai_embeddings_key" },
    });
    return [];
  }

  try {
    const vectors = await provider.embed([text]);
    return vectors[0] ?? [];
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.memory_embedding_unavailable",
      message: "embedding provider unavailable for memory write",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return [];
  }
}

export function readMemoryFacts(memoryRoot = path.join(getAgentRoot(), "psyche", "memory")): MemoryFact[] {
  return readExistingFacts(path.join(memoryRoot, "facts.jsonl"));
}

export async function saveMemoryFact(options: SaveMemoryFactOptions): Promise<MemoryWriteResult> {
  const text = options.text.trim();
  const memoryRoot = options.memoryRoot ?? path.join(getAgentRoot(), "psyche", "memory");
  const stores = ensureMemoryStorePaths(memoryRoot);
  const embedding = await buildEmbedding(text, options.embeddingProvider);

  const fact: MemoryFact = {
    id: options.idFactory ? options.idFactory() : randomUUID(),
    text,
    source: options.source,
    about: options.about?.trim() || undefined,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    embedding,
  };

  return appendFactsWithDedup(stores, [fact]);
}

export interface BackfillEmbeddingsResult {
  total: number;
  backfilled: number;
  failed: number;
}

export async function backfillEmbeddings(options?: {
  memoryRoot?: string;
  embeddingProvider?: MemoryEmbeddingProvider;
  batchSize?: number;
}): Promise<BackfillEmbeddingsResult> {
  const memoryRoot = options?.memoryRoot ?? path.join(getAgentRoot(), "psyche", "memory");
  const factsPath = path.join(memoryRoot, "facts.jsonl");
  if (!fs.existsSync(factsPath)) return { total: 0, backfilled: 0, failed: 0 };

  const facts = readExistingFacts(factsPath);
  const needsEmbedding = facts.filter((f) => !Array.isArray(f.embedding) || f.embedding.length === 0);
  if (needsEmbedding.length === 0) return { total: facts.length, backfilled: 0, failed: 0 };

  const provider = options?.embeddingProvider ?? createDefaultEmbeddingProvider();
  if (!provider) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.memory_backfill_skipped",
      message: "embedding provider unavailable for backfill",
      meta: { needsEmbedding: needsEmbedding.length },
    });
    return { total: facts.length, backfilled: 0, failed: needsEmbedding.length };
  }

  const batchSize = options?.batchSize ?? 50;
  let backfilled = 0;
  let failed = 0;

  for (let i = 0; i < needsEmbedding.length; i += batchSize) {
    const batch = needsEmbedding.slice(i, i + batchSize);
    try {
      const vectors = await provider.embed(batch.map((f) => f.text));
      for (let j = 0; j < batch.length; j++) {
        batch[j].embedding = vectors[j] ?? [];
        if (batch[j].embedding.length > 0) backfilled++;
        else failed++;
      }
    } catch (error) {
      failed += batch.length;
      emitNervesEvent({
        level: "warn",
        component: "mind",
        event: "mind.memory_backfill_batch_error",
        message: "embedding backfill batch failed",
        meta: {
          batchStart: i,
          batchSize: batch.length,
          reason: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  // Rewrite facts file with updated embeddings
  const lines = facts.map((f) => JSON.stringify(f)).join("\n") + "\n";
  fs.writeFileSync(factsPath, lines, "utf8");

  emitNervesEvent({
    component: "mind",
    event: "mind.memory_backfill_complete",
    message: "embedding backfill completed",
    meta: { total: facts.length, backfilled, failed },
  });

  return { total: facts.length, backfilled, failed };
}

function substringMatches(queryLower: string, facts: MemoryFact[]): MemoryFact[] {
  return facts.filter((fact) => fact.text.toLowerCase().includes(queryLower));
}

function uniqueFacts(facts: MemoryFact[]): MemoryFact[] {
  const seen = new Set<string>();
  const unique: MemoryFact[] = [];
  for (const fact of facts) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    unique.push(fact);
  }
  return unique;
}

export async function searchMemoryFacts(
  query: string,
  facts: MemoryFact[],
  embeddingProvider?: MemoryEmbeddingProvider,
): Promise<MemoryFact[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const queryLower = trimmed.toLowerCase();
  const substringFallback = () => substringMatches(queryLower, facts).slice(0, 5);

  const embeddedFacts = facts.filter((fact) => Array.isArray(fact.embedding) && fact.embedding.length > 0);
  if (embeddedFacts.length === 0) {
    return substringFallback();
  }

  const provider = embeddingProvider ?? createDefaultEmbeddingProvider();
  if (!provider) {
    return substringFallback();
  }

  try {
    const vectors = await provider.embed([trimmed]);
    const queryEmbedding = vectors[0];
    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return substringFallback();
    }

    const scored = embeddedFacts
      .filter((fact) => fact.embedding.length === queryEmbedding.length)
      .map((fact) => ({
        fact,
        score: cosineSimilarity(queryEmbedding, fact.embedding),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.fact);

    const fallback = substringFallback();
    return uniqueFacts([...scored, ...fallback]).slice(0, 5);
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.memory_embedding_unavailable",
      message: "embedding provider unavailable for memory search",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return substringFallback();
  }
}
