import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  appendEntriesWithDedup,
  backfillEmbeddings,
  ensureDiaryStorePaths,
  saveDiaryEntry,
  searchDiaryEntries,
  type DiaryEntry,
} from "../../mind/diary";
import { cosineSimilarity } from "../../mind/associative-recall";
import { baseToolDefinitions } from "../../repertoire/tools-base";

describe("memory write path", () => {
  it("ensures memory data file paths exist in bundle psyche memory root", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-paths-"));
    const stores = ensureDiaryStorePaths(root);
    expect(stores.factsPath).toBe(path.join(root, "facts.jsonl"));
    expect(stores.entitiesPath).toBe(path.join(root, "entities.json"));
    expect(stores.dailyDir).toBe(path.join(root, "daily"));
    expect(fs.existsSync(stores.dailyDir)).toBe(true);

    const second = ensureDiaryStorePaths(root);
    expect(second).toEqual(stores);
  });

  it("writes novel facts and skips near-duplicates (>60% overlap)", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-dedup-"));
    const stores = ensureDiaryStorePaths(root);

    const first: DiaryEntry = {
      id: "f1",
      text: "ari prefers concise updates with explicit command outputs",
      source: "unit-test",
      createdAt: "2026-03-06T01:00:00.000Z",
      embedding: [0.1, 0.2],
    };
    const duplicate: DiaryEntry = {
      id: "f2",
      text: "ari prefers concise updates with explicit outputs",
      source: "unit-test",
      createdAt: "2026-03-06T01:01:00.000Z",
      embedding: [0.1, 0.2],
    };
    const novel: DiaryEntry = {
      id: "f3",
      text: "slugger should run coverage gate after branch merge",
      source: "unit-test",
      createdAt: "2026-03-06T01:02:00.000Z",
      embedding: [0.2, 0.3],
    };

    const firstWrite = appendEntriesWithDedup(stores, [first]);
    expect(firstWrite.added).toBe(1);
    expect(firstWrite.skipped).toBe(0);

    const secondWrite = appendEntriesWithDedup(stores, [duplicate, novel]);
    expect(secondWrite.added).toBe(1);
    expect(secondWrite.skipped).toBe(1);

    const lines = fs.readFileSync(stores.factsPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("skips semantically duplicate facts even when word overlap is below threshold", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-dedup-"));
    const stores = ensureDiaryStorePaths(root);
    const opts = { semanticThreshold: 0.95 };

    const original: DiaryEntry = {
      id: "sem-1",
      text: "the project deadline is next friday",
      source: "unit-test",
      createdAt: "2026-03-06T01:00:00.000Z",
      embedding: [1, 0, 0],
    };
    const paraphrase: DiaryEntry = {
      id: "sem-2",
      text: "deliverable is due by end of week",
      source: "unit-test",
      createdAt: "2026-03-06T01:01:00.000Z",
      embedding: [0.98, 0.1, 0.05],
    };

    const firstWrite = appendEntriesWithDedup(stores, [original], opts);
    expect(firstWrite).toEqual({ added: 1, skipped: 0 });

    const secondWrite = appendEntriesWithDedup(stores, [paraphrase], opts);
    expect(secondWrite).toEqual({ added: 0, skipped: 1 });
  });

  it("allows facts through when embedding similarity is below semantic threshold", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-below-"));
    const stores = ensureDiaryStorePaths(root);

    const factA: DiaryEntry = {
      id: "below-1",
      text: "ari prefers morning standups",
      source: "unit-test",
      createdAt: "2026-03-06T01:00:00.000Z",
      embedding: [1, 0, 0],
    };
    const factB: DiaryEntry = {
      id: "below-2",
      text: "slugger runs coverage checks nightly",
      source: "unit-test",
      createdAt: "2026-03-06T01:01:00.000Z",
      embedding: [0.5, 0.7, 0.5],
    };

    const result = appendEntriesWithDedup(stores, [factA, factB], { semanticThreshold: 0.95 });
    expect(result).toEqual({ added: 2, skipped: 0 });
  });

  it("skips semantic dedup when either fact lacks embeddings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-semantic-noembedding-"));
    const stores = ensureDiaryStorePaths(root);

    const withEmbedding: DiaryEntry = {
      id: "emb-1",
      text: "alpha fact with vector",
      source: "unit-test",
      createdAt: "2026-03-06T01:00:00.000Z",
      embedding: [1, 0, 0],
    };
    const withoutEmbedding: DiaryEntry = {
      id: "emb-2",
      text: "beta fact without vector",
      source: "unit-test",
      createdAt: "2026-03-06T01:01:00.000Z",
      embedding: [],
    };

    const result = appendEntriesWithDedup(stores, [withEmbedding, withoutEmbedding], { semanticThreshold: 0.95 });
    expect(result).toEqual({ added: 2, skipped: 0 });
  });

  it("covers cosineSimilarity edge cases used by semantic scoring", () => {
    expect(cosineSimilarity([], [1])).toBe(0);
    expect(cosineSimilarity([1], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [0, 0])).toBe(0);
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("handles missing facts file and zero-word facts safely", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-missing-facts-"));
    const stores = {
      rootDir: root,
      factsPath: path.join(root, "facts.jsonl"),
      entitiesPath: path.join(root, "entities.json"),
      dailyDir: path.join(root, "daily"),
    };
    fs.mkdirSync(stores.dailyDir, { recursive: true });
    fs.writeFileSync(stores.entitiesPath, "{}\n", "utf8");

    const result = appendEntriesWithDedup(stores, [
      { id: "blank-1", text: "", source: "unit-test", createdAt: "2026-03-06T01:03:00.000Z", embedding: [0] },
      { id: "blank-2", text: "", source: "unit-test", createdAt: "2026-03-06T01:04:00.000Z", embedding: [0] },
    ]);
    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("rebuilds entity index when entities file is missing", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-missing-entities-"));
    const stores = {
      rootDir: root,
      factsPath: path.join(root, "facts.jsonl"),
      entitiesPath: path.join(root, "entities.json"),
      dailyDir: path.join(root, "daily"),
    };
    fs.mkdirSync(stores.dailyDir, { recursive: true });

    const result = appendEntriesWithDedup(stores, [
      {
        id: "fact-missing-entities",
        text: "Ari tracks entity index recovery behavior",
        source: "unit-test",
        createdAt: "2026-03-06T01:05:00.000Z",
        embedding: [0.1, 0.2],
      },
    ]);

    expect(result).toEqual({ added: 1, skipped: 0 });
    const entities = JSON.parse(fs.readFileSync(stores.entitiesPath, "utf8"));
    expect(entities.ari.factIds).toContain("fact-missing-entities");
  });

  it("updates entity index and daily logs for newly added facts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-structures-"));
    const stores = ensureDiaryStorePaths(root);
    const facts: DiaryEntry[] = [
      {
        id: "f-entity-1",
        text: "Ari improved the harness memory layer",
        source: "unit-test",
        createdAt: "2026-03-06T10:00:00.000Z",
        embedding: [0.1, 0.2],
      },
      {
        id: "f-entity-2",
        text: "Slugger improved memory coverage",
        source: "unit-test",
        createdAt: "2026-03-06T10:05:00.000Z",
        embedding: [0.2, 0.3],
      },
    ];

    const result = appendEntriesWithDedup(stores, facts);
    expect(result).toEqual({ added: 2, skipped: 0 });

    const entities = JSON.parse(fs.readFileSync(stores.entitiesPath, "utf8"));
    expect(entities.ari.factIds).toContain("f-entity-1");
    expect(entities.slugger.factIds).toContain("f-entity-2");
    expect(entities.memory.factIds).toContain("f-entity-1");
    expect(entities.memory.factIds).toContain("f-entity-2");

    const dailyPath = path.join(stores.dailyDir, "2026-03-06.jsonl");
    expect(fs.existsSync(dailyPath)).toBe(true);
    const dailyLines = fs.readFileSync(dailyPath, "utf8").trim().split("\n");
    expect(dailyLines).toHaveLength(2);
  });

  it("recovers from malformed entities.json by rebuilding index", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entities-malformed-"));
    const stores = ensureDiaryStorePaths(root);
    fs.writeFileSync(stores.entitiesPath, "{not-json", "utf8");

    const result = appendEntriesWithDedup(stores, [
      {
        id: "f-malformed-1",
        text: "Ari documents restart behavior",
        source: "unit-test",
        createdAt: "2026-03-06T10:15:00.000Z",
        embedding: [0.4, 0.5],
      },
    ]);

    expect(result).toEqual({ added: 1, skipped: 0 });
    const entities = JSON.parse(fs.readFileSync(stores.entitiesPath, "utf8"));
    expect(entities.ari.factIds).toContain("f-malformed-1");
  });

  it("handles empty entities index files and avoids duplicate factIds for existing entities", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-entities-empty-"));
    const stores = ensureDiaryStorePaths(root);
    fs.writeFileSync(stores.entitiesPath, "", "utf8");

    const first: DiaryEntry = {
      id: "same-id",
      text: "ari alpha",
      source: "unit-test",
      createdAt: "",
      embedding: [0.1],
    };
    const second: DiaryEntry = {
      id: "same-id",
      text: "ari beta gamma",
      source: "unit-test",
      createdAt: "",
      embedding: [0.2],
    };

    const result = appendEntriesWithDedup(stores, [first, second]);
    expect(result).toEqual({ added: 2, skipped: 0 });

    const entities = JSON.parse(fs.readFileSync(stores.entitiesPath, "utf8"));
    expect(entities.ari.count).toBe(2);
    expect(entities.ari.factIds).toEqual(["same-id"]);

    const unknownDayPath = path.join(stores.dailyDir, "unknown.jsonl");
    expect(fs.existsSync(unknownDayPath)).toBe(true);
  });

  it("keeps friend memory tools available alongside agent diary tools", () => {
    const names = baseToolDefinitions.map((def) => def.tool.function.name);
    expect(names).toContain("save_friend_note");
    expect(names).toContain("recall");
  });

  it("saveDiaryEntry writes embedding vectors when provider succeeds", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-embedding-"));
    const fixedNow = "2026-03-06T12:00:00.000Z";

    const result = await saveDiaryEntry({
      diaryRoot: root,
      text: "Ari prefers crisp progress updates",
      about: "ari",
      source: "tool:memory_save",
      now: () => new Date(fixedNow),
      idFactory: () => "fact-embedded",
      embeddingProvider: {
        embed: async () => [[0.2, 0.4, 0.6]],
      },
    });

    expect(result).toEqual({ added: 1, skipped: 0 });
    const factsPath = path.join(root, "facts.jsonl");
    const saved = JSON.parse(fs.readFileSync(factsPath, "utf8").trim()) as DiaryEntry;
    expect(saved.id).toBe("fact-embedded");
    expect(saved.text).toBe("Ari prefers crisp progress updates");
    expect(saved.source).toBe("tool:memory_save");
    expect(saved.about).toBe("ari");
    expect(saved.createdAt).toBe(fixedNow);
    expect(saved.embedding).toEqual([0.2, 0.4, 0.6]);
  });

  it("saveDiaryEntry degrades gracefully to empty embeddings when provider fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-fallback-"));

    const result = await saveDiaryEntry({
      diaryRoot: root,
      text: "Store this even if embedding API is down",
      source: "tool:memory_save",
      idFactory: () => "fact-fallback",
      embeddingProvider: {
        embed: async () => {
          throw new Error("embedding service unavailable");
        },
      },
    });

    expect(result).toEqual({ added: 1, skipped: 0 });
    const factsPath = path.join(root, "facts.jsonl");
    const saved = JSON.parse(fs.readFileSync(factsPath, "utf8").trim()) as DiaryEntry;
    expect(saved.id).toBe("fact-fallback");
    expect(saved.embedding).toEqual([]);
  });

  it("saveDiaryEntry degrades gracefully when provider throws non-Error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-fallback-string-"));

    const result = await saveDiaryEntry({
      diaryRoot: root,
      text: "Store this even if embedding API throws a string",
      source: "tool:memory_save",
      idFactory: () => "fact-fallback-string",
      embeddingProvider: {
        embed: async () => {
          throw "embedding string failure";
        },
      },
    });

    expect(result).toEqual({ added: 1, skipped: 0 });
    const factsPath = path.join(root, "facts.jsonl");
    const saved = JSON.parse(fs.readFileSync(factsPath, "utf8").trim()) as DiaryEntry;
    expect(saved.id).toBe("fact-fallback-string");
    expect(saved.embedding).toEqual([]);
  });

  it("saveDiaryEntry falls back to empty embedding when provider returns no vectors", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-no-vectors-"));

    const result = await saveDiaryEntry({
      diaryRoot: root,
      text: "Save even when embedding vector list is empty",
      source: "tool:memory_save",
      idFactory: () => "fact-empty-vectors",
      embeddingProvider: {
        embed: async () => [],
      },
    });

    expect(result).toEqual({ added: 1, skipped: 0 });
    const factsPath = path.join(root, "facts.jsonl");
    const saved = JSON.parse(fs.readFileSync(factsPath, "utf8").trim()) as DiaryEntry;
    expect(saved.id).toBe("fact-empty-vectors");
    expect(saved.embedding).toEqual([]);
  });

  it("searchDiaryEntries falls back to substring matching for empty-embedding facts", async () => {
    const facts: DiaryEntry[] = [
      {
        id: "fallback-hit",
        text: "Ari likes mushroom pizza",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [],
      },
      {
        id: "embedded-hit",
        text: "Ari tracks strict TypeScript rules",
        source: "teams",
        createdAt: "2026-03-06T00:01:00.000Z",
        embedding: [1, 0],
      },
    ];

    const results = await searchDiaryEntries("pizza", facts, {
      embed: async () => [[1, 0]],
    });

    expect(results.map((fact) => fact.id)).toContain("fallback-hit");
  });

  it("searchDiaryEntries falls back to substring when embedding provider throws", async () => {
    const facts: DiaryEntry[] = [
      {
        id: "substring-hit",
        text: "Retry migration after the daemon restarts",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [0.2, 0.8],
      },
      {
        id: "substring-miss",
        text: "unrelated note",
        source: "cli",
        createdAt: "2026-03-06T00:00:01.000Z",
        embedding: [0.8, 0.2],
      },
    ];

    const results = await searchDiaryEntries("daemon", facts, {
      embed: async () => {
        throw new Error("query embedding failed");
      },
    });

    expect(results.map((fact) => fact.id)).toEqual(["substring-hit"]);
  });

  it("searchDiaryEntries returns empty list for blank queries", async () => {
    const results = await searchDiaryEntries("   ", [
      {
        id: "x",
        text: "anything",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [1, 0],
      },
    ]);
    expect(results).toEqual([]);
  });

  it("searchDiaryEntries falls back to substring when embedding provider throws non-Error", async () => {
    const facts: DiaryEntry[] = [
      {
        id: "substring-hit",
        text: "Daemon restart fallback note",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [0.2, 0.8],
      },
    ];

    const results = await searchDiaryEntries("daemon", facts, {
      embed: async () => {
        throw "non-error throw";
      },
    });

    expect(results.map((fact) => fact.id)).toEqual(["substring-hit"]);
  });

  it("searchDiaryEntries falls back when default embedding provider is unavailable", async () => {
    vi.resetModules();
    vi.doMock("../../heart/config", async () => {
      const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config");
      return { ...actual, getOpenAIEmbeddingsApiKey: () => "   " };
    });
    const { searchDiaryEntries: dynamicSearchDiaryEntrys } = await import("../../mind/diary");

    const facts: DiaryEntry[] = [
      {
        id: "daemon-hit",
        text: "Daemon keeps retrying this task",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [0.1, 0.2],
      },
      {
        id: "other",
        text: "completely unrelated memory",
        source: "cli",
        createdAt: "2026-03-06T00:00:01.000Z",
        embedding: [0.2, 0.1],
      },
    ];

    const results = await dynamicSearchDiaryEntrys("daemon", facts);
    expect(results.map((fact) => fact.id)).toEqual(["daemon-hit"]);
  });

  it("searchDiaryEntries falls back when query embedding is missing/empty", async () => {
    const facts: DiaryEntry[] = [
      {
        id: "fallback-hit",
        text: "Ari prefers daemon status updates",
        source: "cli",
        createdAt: "2026-03-06T00:00:00.000Z",
        embedding: [0.4, 0.6],
      },
      {
        id: "miss",
        text: "something else",
        source: "cli",
        createdAt: "2026-03-06T00:00:01.000Z",
        embedding: [0.6, 0.4],
      },
    ];

    const results = await searchDiaryEntries("daemon", facts, {
      embed: async () => [],
    });
    expect(results.map((fact) => fact.id)).toEqual(["fallback-hit"]);
  });

  it("searchDiaryEntries uses default OpenAI embedding provider and sorts scored results", async () => {
    vi.resetModules();
    vi.doMock("../../heart/config", async () => {
      const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config");
      return { ...actual, getOpenAIEmbeddingsApiKey: () => "test-openai-key" };
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: [{ embedding: [1, 0] }] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const { searchDiaryEntries: dynamicSearchDiaryEntrys } = await import("../../mind/diary");
      const facts: DiaryEntry[] = [
        {
          id: "best",
          text: "alpha strongest match",
          source: "cli",
          createdAt: "2026-03-06T00:00:00.000Z",
          embedding: [1, 0],
        },
        {
          id: "weaker",
          text: "alpha weaker match",
          source: "cli",
          createdAt: "2026-03-06T00:00:01.000Z",
          embedding: [0.6, 0.8],
        },
        {
          id: "fallback",
          text: "alpha substring fallback",
          source: "cli",
          createdAt: "2026-03-06T00:00:02.000Z",
          embedding: [],
        },
      ];

      const results = await dynamicSearchDiaryEntrys("alpha", facts);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.map((fact) => fact.id)).toEqual(["best", "weaker", "fallback"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("searchDiaryEntries falls back when default OpenAI embedding request is non-OK", async () => {
    vi.resetModules();
    vi.doMock("../../heart/config", async () => {
      const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config");
      return { ...actual, getOpenAIEmbeddingsApiKey: () => "test-openai-key" };
    });

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const { searchDiaryEntries: dynamicSearchDiaryEntrys } = await import("../../mind/diary");
      const results = await dynamicSearchDiaryEntrys("daemon", [
        {
          id: "fallback-hit",
          text: "daemon fallback entry",
          source: "cli",
          createdAt: "2026-03-06T00:00:00.000Z",
          embedding: [1, 0],
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.map((fact) => fact.id)).toEqual(["fallback-hit"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("backfillEmbeddings fills empty embeddings for existing facts", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-"));
    const factsPath = path.join(root, "facts.jsonl");
    const facts: DiaryEntry[] = [
      { id: "has-embed", text: "already embedded", source: "cli", createdAt: "2026-03-06T00:00:00.000Z", embedding: [0.1, 0.2] },
      { id: "no-embed-1", text: "needs embedding one", source: "cli", createdAt: "2026-03-06T00:01:00.000Z", embedding: [] },
      { id: "no-embed-2", text: "needs embedding two", source: "cli", createdAt: "2026-03-06T00:02:00.000Z", embedding: [] },
    ];
    fs.writeFileSync(factsPath, facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");

    const result = await backfillEmbeddings({
      diaryRoot: root,
      embeddingProvider: {
        embed: async (texts) => texts.map(() => [0.5, 0.6]),
      },
    });

    expect(result).toEqual({ total: 3, backfilled: 2, failed: 0 });
    const updated = fs.readFileSync(factsPath, "utf8").trim().split("\n").map((l) => JSON.parse(l) as DiaryEntry);
    expect(updated[0].embedding).toEqual([0.1, 0.2]); // untouched
    expect(updated[1].embedding).toEqual([0.5, 0.6]); // filled
    expect(updated[2].embedding).toEqual([0.5, 0.6]); // filled
  });

  it("backfillEmbeddings returns zeros when no facts need embedding", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-noop-"));
    const factsPath = path.join(root, "facts.jsonl");
    fs.writeFileSync(factsPath, JSON.stringify({ id: "ok", text: "good", source: "cli", createdAt: "", embedding: [1] }) + "\n", "utf8");

    const result = await backfillEmbeddings({ diaryRoot: root });
    expect(result).toEqual({ total: 1, backfilled: 0, failed: 0 });
  });

  it("backfillEmbeddings returns zeros for missing facts file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-missing-"));
    const result = await backfillEmbeddings({ diaryRoot: root });
    expect(result).toEqual({ total: 0, backfilled: 0, failed: 0 });
  });

  it("backfillEmbeddings reports failed count when provider is unavailable", async () => {
    vi.resetModules();
    vi.doMock("../../heart/config", async () => {
      const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config");
      return { ...actual, getOpenAIEmbeddingsApiKey: () => "" };
    });
    const { backfillEmbeddings: dynamicBackfill } = await import("../../mind/diary");

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-noprovider-"));
    const factsPath = path.join(root, "facts.jsonl");
    fs.writeFileSync(factsPath, JSON.stringify({ id: "x", text: "needs it", source: "cli", createdAt: "", embedding: [] }) + "\n", "utf8");

    const result = await dynamicBackfill({ diaryRoot: root });
    expect(result).toEqual({ total: 1, backfilled: 0, failed: 1 });
  });

  it("backfillEmbeddings handles batch errors gracefully", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-batcherr-"));
    const factsPath = path.join(root, "facts.jsonl");
    const facts: DiaryEntry[] = [
      { id: "f1", text: "first", source: "cli", createdAt: "", embedding: [] },
      { id: "f2", text: "second", source: "cli", createdAt: "", embedding: [] },
      { id: "f3", text: "third", source: "cli", createdAt: "", embedding: [] },
    ];
    fs.writeFileSync(factsPath, facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");

    let callCount = 0;
    const result = await backfillEmbeddings({
      diaryRoot: root,
      batchSize: 2,
      embeddingProvider: {
        embed: async (texts) => {
          callCount++;
          if (callCount === 1) throw new Error("batch 1 failed");
          return texts.map(() => [0.9]);
        },
      },
    });

    expect(result).toEqual({ total: 3, backfilled: 1, failed: 2 });
  });

  it("backfillEmbeddings handles undefined vector entries from provider", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-undef-"));
    const factsPath = path.join(root, "facts.jsonl");
    fs.writeFileSync(factsPath, JSON.stringify({ id: "f1", text: "test", source: "cli", createdAt: "", embedding: [] }) + "\n", "utf8");

    const result = await backfillEmbeddings({
      diaryRoot: root,
      embeddingProvider: {
        // Return fewer vectors than facts — vectors[1] is undefined
        embed: async () => [] as number[][],
      },
    });

    expect(result).toEqual({ total: 1, backfilled: 0, failed: 1 });
  });

  it("backfillEmbeddings uses default memoryRoot when not provided", async () => {
    vi.resetModules();
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-default-"));
    const memoryDir = path.join(tmpRoot, "psyche", "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const factsPath = path.join(memoryDir, "facts.jsonl");
    fs.writeFileSync(factsPath, JSON.stringify({ id: "f1", text: "test", source: "cli", createdAt: "", embedding: [] }) + "\n", "utf8");

    vi.doMock("../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity");
      return { ...actual, getAgentRoot: () => tmpRoot };
    });
    const { backfillEmbeddings: dynamicBackfill } = await import("../../mind/diary");

    const result = await dynamicBackfill({
      embeddingProvider: { embed: async () => [[0.1]] },
    });

    expect(result).toEqual({ total: 1, backfilled: 1, failed: 0 });
  });

  it("backfillEmbeddings counts empty vectors from provider as failed", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-emptyvec-"));
    const factsPath = path.join(root, "facts.jsonl");
    const facts: DiaryEntry[] = [
      { id: "f1", text: "gets a vector", source: "cli", createdAt: "", embedding: [] },
      { id: "f2", text: "gets empty", source: "cli", createdAt: "", embedding: [] },
    ];
    fs.writeFileSync(factsPath, facts.map((f) => JSON.stringify(f)).join("\n") + "\n", "utf8");

    const result = await backfillEmbeddings({
      diaryRoot: root,
      embeddingProvider: {
        embed: async () => [[0.5, 0.6], []],
      },
    });

    expect(result).toEqual({ total: 2, backfilled: 1, failed: 1 });
  });

  it("backfillEmbeddings handles batch error from non-Error throw", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-backfill-nonError-"));
    const factsPath = path.join(root, "facts.jsonl");
    fs.writeFileSync(factsPath, JSON.stringify({ id: "f1", text: "first", source: "cli", createdAt: "", embedding: [] }) + "\n", "utf8");

    const result = await backfillEmbeddings({
      diaryRoot: root,
      embeddingProvider: {
        embed: async () => { throw "string-error"; },
      },
    });

    expect(result).toEqual({ total: 1, backfilled: 0, failed: 1 });
  });

  it("saveDiaryEntry deduplicates paraphrased facts via semantic threshold", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-save-semantic-dedup-"));
    const nearIdenticalVector = [0.9, 0.1, 0.05];
    let callCount = 0;

    const result1 = await saveDiaryEntry({
      diaryRoot: root,
      text: "the project deadline is next friday",
      source: "tool:memory_save",
      idFactory: () => `sem-save-${++callCount}`,
      embeddingProvider: { embed: async () => [nearIdenticalVector] },
    });
    expect(result1).toEqual({ added: 1, skipped: 0 });

    const result2 = await saveDiaryEntry({
      diaryRoot: root,
      text: "deliverable is due by end of week",
      source: "tool:memory_save",
      idFactory: () => `sem-save-${++callCount}`,
      embeddingProvider: { embed: async () => [nearIdenticalVector] },
    });
    expect(result2).toEqual({ added: 0, skipped: 1 });

    const factsPath = path.join(root, "facts.jsonl");
    const stored = fs.readFileSync(factsPath, "utf8").trim().split("\n");
    expect(stored).toHaveLength(1);
  });

  it("searchDiaryEntries falls back when default OpenAI embedding payload is malformed", async () => {
    vi.resetModules();
    vi.doMock("../../heart/config", async () => {
      const actual = await vi.importActual<typeof import("../../heart/config")>("../../heart/config");
      return { ...actual, getOpenAIEmbeddingsApiKey: () => "test-openai-key" };
    });

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ data: [] }),
    }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    try {
      const { searchDiaryEntries: dynamicSearchDiaryEntrys } = await import("../../mind/diary");
      const results = await dynamicSearchDiaryEntrys("daemon", [
        {
          id: "fallback-hit",
          text: "daemon fallback entry",
          source: "cli",
          createdAt: "2026-03-06T00:00:00.000Z",
          embedding: [1, 0],
        },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(results.map((fact) => fact.id)).toEqual(["fallback-hit"]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
