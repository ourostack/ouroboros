import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

vi.mock("../../heart/identity", () => ({
  getAgentName: () => "test-agent",
  getAgentRoot: () => "/tmp/test-agent-root",
}))
vi.mock("../../heart/config", () => ({
  getOpenAIEmbeddingsApiKey: () => "",
}))
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import {
  saveDiaryEntry,
  ensureDiaryStorePaths,
  type DiaryEntry,
  type DiaryEntryProvenance,
} from "../../mind/diary"

describe("DiaryEntryProvenance", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "diary-prov-"))
  })

  it("round-trips a DiaryEntry with full provenance through JSON serialization", () => {
    const entry: DiaryEntry = {
      id: "prov-1",
      text: "test entry with provenance",
      source: "tool:diary_write",
      createdAt: "2026-04-08T00:00:00.000Z",
      embedding: [0.1, 0.2],
      provenance: {
        tool: "diary_write",
        channel: "bluebubbles",
        friendId: "friend-123",
        friendName: "alice",
        trust: "family",
      },
    }
    const serialized = JSON.stringify(entry)
    const deserialized = JSON.parse(serialized) as DiaryEntry
    expect(deserialized.provenance).toEqual(entry.provenance)
    expect(deserialized.provenance!.tool).toBe("diary_write")
    expect(deserialized.provenance!.channel).toBe("bluebubbles")
    expect(deserialized.provenance!.friendId).toBe("friend-123")
    expect(deserialized.provenance!.friendName).toBe("alice")
    expect(deserialized.provenance!.trust).toBe("family")
  })

  it("parses a DiaryEntry without provenance (old format, backwards compat)", () => {
    const entry: DiaryEntry = {
      id: "old-1",
      text: "old entry without provenance",
      source: "tool:diary_write",
      createdAt: "2026-03-01T00:00:00.000Z",
      embedding: [],
    }
    const serialized = JSON.stringify(entry)
    const deserialized = JSON.parse(serialized) as DiaryEntry
    expect(deserialized.provenance).toBeUndefined()
    expect(deserialized.text).toBe("old entry without provenance")
  })

  it("saveDiaryEntry persists provenance when provided", async () => {
    const provenance: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "cli",
      friendId: "f-1",
      friendName: "bob",
      trust: "friend",
    }
    const result = await saveDiaryEntry({
      text: "entry with provenance",
      source: "tool:diary_write",
      diaryRoot: tmpDir,
      provenance,
      idFactory: () => "fixed-id-1",
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    })
    expect(result.added).toBe(1)

    const factsPath = path.join(tmpDir, "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toEqual(provenance)
  })

  it("saveDiaryEntry works without provenance (backwards compat)", async () => {
    const result = await saveDiaryEntry({
      text: "entry without provenance",
      source: "tool:diary_write",
      diaryRoot: tmpDir,
      idFactory: () => "fixed-id-2",
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    })
    expect(result.added).toBe(1)

    const factsPath = path.join(tmpDir, "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toBeUndefined()
  })

  it("saveDiaryEntry persists provenance with partial fields (channel only)", async () => {
    const provenance: DiaryEntryProvenance = {
      tool: "diary_write",
      channel: "teams",
    }
    const result = await saveDiaryEntry({
      text: "entry with partial provenance",
      source: "tool:diary_write",
      diaryRoot: tmpDir,
      provenance,
      idFactory: () => "fixed-id-3",
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    })
    expect(result.added).toBe(1)

    const factsPath = path.join(tmpDir, "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toEqual(provenance)
    expect(parsed.provenance!.friendId).toBeUndefined()
    expect(parsed.provenance!.friendName).toBeUndefined()
    expect(parsed.provenance!.trust).toBeUndefined()
  })

  it("saveDiaryEntry persists provenance with friend only (no channel)", async () => {
    const provenance: DiaryEntryProvenance = {
      tool: "diary_write",
      friendId: "f-2",
      friendName: "carol",
    }
    const result = await saveDiaryEntry({
      text: "entry with friend-only provenance",
      source: "tool:diary_write",
      diaryRoot: tmpDir,
      provenance,
      idFactory: () => "fixed-id-4",
      now: () => new Date("2026-04-08T00:00:00.000Z"),
    })
    expect(result.added).toBe(1)

    const factsPath = path.join(tmpDir, "facts.jsonl")
    const line = fs.readFileSync(factsPath, "utf8").trim()
    const parsed = JSON.parse(line) as DiaryEntry
    expect(parsed.provenance).toEqual(provenance)
    expect(parsed.provenance!.channel).toBeUndefined()
    expect(parsed.provenance!.trust).toBeUndefined()
  })
})
