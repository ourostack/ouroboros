import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { getAgentRoot } from "../heart/identity";
import { capStructuredRecordString } from "../heart/session-events";
import { emitNervesEvent } from "../nerves/runtime";
import { cosineSimilarity } from "./note-search";
import { detectSuspiciousContent } from "./diary-integrity";
import { type EmbeddingProvider, createDefaultEmbeddingProvider } from "./embedding-provider";

export interface DiaryStorePaths {
  rootDir: string;
  factsPath: string;
  entitiesPath: string;
  dailyDir: string;
}

export interface DiaryEntryProvenance {
  tool: string;
  channel?: string;
  friendId?: string;
  friendName?: string;
  trust?: string;
}

export interface DiaryEntry {
  id: string;
  text: string;
  source: string;
  createdAt: string;
  about?: string;
  embedding: number[];
  provenance?: DiaryEntryProvenance;
}

export interface DiaryWriteResult {
  added: number;
  skipped: number;
}

/** @deprecated Use EmbeddingProvider from ./embedding-provider instead. */
export type DiaryEmbeddingProvider = EmbeddingProvider;

export interface SaveDiaryEntryOptions {
  text: string;
  source: string;
  about?: string;
  diaryRoot?: string;
  now?: () => Date;
  idFactory?: () => string;
  embeddingProvider?: EmbeddingProvider;
  provenance?: DiaryEntryProvenance;
}

export interface EntityIndexEntry {
  count: number;
  factIds: string[];
  lastSeenAt: string;
}

export type EntityIndex = Record<string, EntityIndexEntry>;

const DEDUP_THRESHOLD = 0.6;
const SEMANTIC_DEDUP_THRESHOLD = 0.95;
const ENTITY_TOKEN = /[a-z0-9]+/g;

export function ensureDiaryStorePaths(rootDir: string): DiaryStorePaths {
  const factsPath = path.join(rootDir, "facts.jsonl");
  const entitiesPath = path.join(rootDir, "entities.json");
  const dailyDir = path.join(rootDir, "daily");

  fs.mkdirSync(rootDir, { recursive: true });
  fs.mkdirSync(dailyDir, { recursive: true });
  if (!fs.existsSync(factsPath)) fs.writeFileSync(factsPath, "", "utf8");
  if (!fs.existsSync(entitiesPath)) fs.writeFileSync(entitiesPath, "{}\n", "utf8");

  emitNervesEvent({
    component: "mind",
    event: "mind.diary_paths_ready",
    message: "diary store paths ready",
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

function readExistingEntries(factsPath: string): DiaryEntry[] {
  if (!fs.existsSync(factsPath)) return [];
  const raw = fs.readFileSync(factsPath, "utf8").trim();
  if (!raw) return [];
  const facts: DiaryEntry[] = [];
  for (const line of raw.split("\n")) {
    try {
      facts.push(JSON.parse(line) as DiaryEntry);
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

function updateEntityIndex(entitiesPath: string, fact: DiaryEntry): void {
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

function appendDailyFact(dailyDir: string, fact: DiaryEntry): void {
  fs.mkdirSync(dailyDir, { recursive: true });
  const day = fact.createdAt.slice(0, 10) || "unknown";
  const dayPath = path.join(dailyDir, `${day}.jsonl`);
  fs.appendFileSync(dayPath, `${JSON.stringify(fact)}\n`, "utf8");
}

export interface AppendEntriesOptions {
  semanticThreshold?: number;
}

export function appendEntriesWithDedup(stores: DiaryStorePaths, incoming: DiaryEntry[], options?: AppendEntriesOptions): DiaryWriteResult {
  const existing = readExistingEntries(stores.factsPath);
  const cappedIncoming = incoming.map((fact) => ({
    ...fact,
    text: capStructuredRecordString(fact.text),
  }));
  const all = [...existing];
  let added = 0;
  let skipped = 0;
  const semanticThreshold = options?.semanticThreshold;

  for (const fact of cappedIncoming) {
    const duplicate = all.some((prior) => {
      if (overlapScore(prior.text, fact.text) > DEDUP_THRESHOLD) return true;
      if (
        semanticThreshold !== undefined &&
        Array.isArray(fact.embedding) && fact.embedding.length > 0 &&
        Array.isArray(prior.embedding) && prior.embedding.length > 0 &&
        fact.embedding.length === prior.embedding.length
      ) {
        return cosineSimilarity(fact.embedding, prior.embedding) > semanticThreshold;
      }
      return false;
    });
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
    event: "mind.diary_write",
    message: "diary write completed",
    meta: { added, skipped },
  });
  return { added, skipped };
}

async function buildEmbedding(text: string, embeddingProvider?: EmbeddingProvider): Promise<number[]> {
  const provider = embeddingProvider ?? createDefaultEmbeddingProvider();
  if (!provider) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.diary_embedding_unavailable",
      message: "embedding provider unavailable for diary write",
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
      event: "mind.diary_embedding_unavailable",
      message: "embedding provider unavailable for diary write",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return [];
  }
}

export function resolveDiaryRoot(explicitRoot?: string): string {
  if (explicitRoot) return explicitRoot;
  const agentRoot = getAgentRoot();
  return path.join(agentRoot, "diary");
}

export function readDiaryEntries(diaryRoot?: string): DiaryEntry[] {
  return readExistingEntries(path.join(resolveDiaryRoot(diaryRoot), "facts.jsonl"));
}

export async function saveDiaryEntry(options: SaveDiaryEntryOptions): Promise<DiaryWriteResult> {
  const text = options.text.trim();
  const diaryRoot = resolveDiaryRoot(options.diaryRoot);
  const stores = ensureDiaryStorePaths(diaryRoot);
  const embedding = await buildEmbedding(text, options.embeddingProvider);

  const fact: DiaryEntry = {
    id: options.idFactory ? options.idFactory() : randomUUID(),
    text,
    source: options.source,
    about: options.about?.trim() || undefined,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    embedding,
    ...(options.provenance ? { provenance: options.provenance } : {}),
  };

  const integrity = detectSuspiciousContent(text);
  if (integrity.suspicious) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.diary_integrity_warning",
      message: "suspicious content detected in diary entry",
      meta: {
        patterns: integrity.patterns,
        textPreview: text.slice(0, 200),
        entryId: fact.id,
      },
    });
  }

  return appendEntriesWithDedup(stores, [fact], { semanticThreshold: SEMANTIC_DEDUP_THRESHOLD });
}

export interface BackfillEmbeddingsResult {
  total: number;
  backfilled: number;
  failed: number;
}

export async function backfillEmbeddings(options?: {
  diaryRoot?: string;
  embeddingProvider?: EmbeddingProvider;
  batchSize?: number;
}): Promise<BackfillEmbeddingsResult> {
  const diaryRoot = resolveDiaryRoot(options?.diaryRoot);
  const factsPath = path.join(diaryRoot, "facts.jsonl");
  if (!fs.existsSync(factsPath)) return { total: 0, backfilled: 0, failed: 0 };

  const facts = readExistingEntries(factsPath);
  const needsEmbedding = facts.filter((f) => !Array.isArray(f.embedding) || f.embedding.length === 0);
  if (needsEmbedding.length === 0) return { total: facts.length, backfilled: 0, failed: 0 };

  const provider = options?.embeddingProvider ?? createDefaultEmbeddingProvider();
  if (!provider) {
    emitNervesEvent({
      level: "warn",
      component: "mind",
      event: "mind.diary_backfill_skipped",
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
        event: "mind.diary_backfill_batch_error",
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
    event: "mind.diary_backfill_complete",
    message: "embedding backfill completed",
    meta: { total: facts.length, backfilled, failed },
  });

  return { total: facts.length, backfilled, failed };
}

function substringMatches(queryLower: string, facts: DiaryEntry[]): DiaryEntry[] {
  return facts.filter((fact) => fact.text.toLowerCase().includes(queryLower));
}

function uniqueFacts(facts: DiaryEntry[]): DiaryEntry[] {
  const seen = new Set<string>();
  const unique: DiaryEntry[] = [];
  for (const fact of facts) {
    if (seen.has(fact.id)) continue;
    seen.add(fact.id);
    unique.push(fact);
  }
  return unique;
}

export async function searchDiaryEntries(
  query: string,
  facts: DiaryEntry[],
  embeddingProvider?: EmbeddingProvider,
): Promise<DiaryEntry[]> {
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
      event: "mind.diary_embedding_unavailable",
      message: "embedding provider unavailable for diary search",
      meta: {
        reason: error instanceof Error ? error.message : String(error),
      },
    });
    return substringFallback();
  }
}
