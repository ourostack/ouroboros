import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

describe("Desk record paths", () => {
  let agentRoot: string

  beforeEach(async () => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "record-paths-"))
    mockEmitNervesEvent.mockReset()
    const { resetRecordStoreMigrationTrackingForTests } = await import("../../mind/record-paths")
    resetRecordStoreMigrationTrackingForTests()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("resolves canonical Desk record paths", async () => {
    const { resolveDeskRecordPaths } = await import("../../mind/record-paths")
    const paths = resolveDeskRecordPaths(agentRoot)

    expect(paths.recordRoot).toBe(path.join(agentRoot, "desk", "_record"))
    expect(paths.diaryRoot).toBe(path.join(agentRoot, "desk", "_record", "diary"))
    expect(paths.notesRoot).toBe(path.join(agentRoot, "desk", "_record", "notes"))
    expect(paths.factsPath).toBe(path.join(agentRoot, "desk", "_record", "diary", "facts.jsonl"))
  })

  it("migrates legacy stores into Desk record and removes obsolete roots", async () => {
    fs.mkdirSync(path.join(agentRoot, "psyche", "memory"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "psyche", "memory", "facts.jsonl"), '{"id":"legacy"}\n', "utf-8")
    fs.mkdirSync(path.join(agentRoot, "diary", "daily"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "diary", "daily", "2026-06-08.jsonl"), '{"id":"daily"}\n', "utf-8")
    fs.mkdirSync(path.join(agentRoot, "notes"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "notes", "handoff.md"), "handoff note", "utf-8")
    fs.mkdirSync(path.join(agentRoot, "journal", "scratch"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "journal", "Idea!.md"), "journal idea", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", "scratch", "Nested Idea.md"), "nested journal idea", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", ".draft.md"), "hidden draft", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", "scratch", ".private-notes.txt"), "hidden private note", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", "!!!.md"), "punctuation journal", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", ".index.json"), "[]", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", ".binary"), "hidden binary", "utf-8")
    fs.writeFileSync(path.join(agentRoot, "journal", "image.png"), "not text", "utf-8")

    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    expect(fs.existsSync(path.join(agentRoot, "psyche", "memory"))).toBe(false)
    expect(fs.existsSync(path.join(agentRoot, "diary"))).toBe(false)
    expect(fs.existsSync(path.join(agentRoot, "notes"))).toBe(false)
    expect(fs.existsSync(path.join(agentRoot, "journal"))).toBe(false)
    expect(fs.readFileSync(paths.factsPath, "utf-8")).toContain('"legacy"')
    expect(fs.existsSync(path.join(paths.diaryDailyDir, "2026-06-08.jsonl"))).toBe(true)
    expect(fs.readFileSync(path.join(paths.notesRoot, "handoff.md"), "utf-8")).toBe("handoff note")
    expect(fs.readFileSync(path.join(paths.notesRoot, "journal-idea.md"), "utf-8")).toBe("journal idea")
    expect(fs.readFileSync(path.join(paths.notesRoot, "journal-scratch-nested-idea.md"), "utf-8")).toBe("nested journal idea")
    expect(fs.readFileSync(path.join(paths.notesRoot, "journal-draft.md"), "utf-8")).toBe("hidden draft")
    expect(fs.readFileSync(path.join(paths.notesRoot, "journal-scratch-private-notes.md"), "utf-8")).toBe("hidden private note")
    expect(fs.readFileSync(path.join(paths.notesRoot, "journal-entry.md"), "utf-8")).toBe("punctuation journal")
    expect(fs.readFileSync(path.join(paths.recordRoot, "migration-quarantine", "journal", ".binary"), "utf-8")).toBe("hidden binary")
    expect(fs.readFileSync(path.join(paths.recordRoot, "migration-quarantine", "journal", "image.png"), "utf-8")).toBe("not text")

    const report = fs.readFileSync(paths.migrationReportPath, "utf-8")
    expect(report).toContain("legacy pre-diary fact store moved into Desk record diary")
    expect(report).toContain("top-level journal is no longer an active substrate")
    expect(report).toContain("derived journal index is obsolete")
    expect(report).toContain("non-text journal scratch quarantined")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.record_store_migration_start",
    }))
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.record_store_migration_end",
    }))
  })

  it("keeps both files when merging a colliding legacy note into Desk record notes", async () => {
    const existingNotesRoot = path.join(agentRoot, "desk", "_record", "notes")
    const legacyNotesRoot = path.join(agentRoot, "notes")
    fs.mkdirSync(existingNotesRoot, { recursive: true })
    fs.mkdirSync(legacyNotesRoot, { recursive: true })
    const destination = path.join(existingNotesRoot, "handoff.md")
    const source = path.join(legacyNotesRoot, "handoff.md")
    fs.writeFileSync(destination, "old desk note", "utf-8")
    fs.writeFileSync(source, "new legacy note", "utf-8")
    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    expect(fs.readFileSync(path.join(paths.notesRoot, "handoff.md"), "utf-8")).toBe("old desk note")
    expect(fs.readFileSync(path.join(paths.notesRoot, "handoff.migrated-1.md"), "utf-8")).toBe("new legacy note")
    expect(fs.existsSync(legacyNotesRoot)).toBe(false)
  })

  it("merges facts and entities without losing either side", async () => {
    const existingDiaryRoot = path.join(agentRoot, "desk", "_record", "diary")
    const legacyDiaryRoot = path.join(agentRoot, "diary")
    fs.mkdirSync(existingDiaryRoot, { recursive: true })
    fs.mkdirSync(legacyDiaryRoot, { recursive: true })
    fs.writeFileSync(path.join(existingDiaryRoot, "facts.jsonl"), '{"id":"desk"}\n{"id":"dupe"}\n', "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "facts.jsonl"), '{"id":"dupe"}\n{"id":"legacy"}\n', "utf-8")
    fs.writeFileSync(path.join(existingDiaryRoot, "entities.json"), '{"ari":{"source":"desk"},"shared":{"source":"desk"},"same":{"source":"both"}}\n', "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "entities.json"), '{"slugger":{"source":"legacy"},"shared":{"source":"legacy"},"same":{"source":"both"}}\n', "utf-8")

    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    const facts = fs.readFileSync(paths.factsPath, "utf-8")
    expect(facts.match(/"dupe"/g)).toHaveLength(1)
    expect(facts).toContain('"desk"')
    expect(facts).toContain('"legacy"')
    expect(JSON.parse(fs.readFileSync(paths.entitiesPath, "utf-8"))).toMatchObject({
      ari: { source: "desk" },
      slugger: { source: "legacy" },
      shared: { source: "desk" },
      same: { source: "both" },
    })
    expect(fs.readFileSync(path.join(existingDiaryRoot, "entities.migration-conflicts.migrated-1.json"), "utf-8")).toContain('"legacy"')
  })

  it("handles lossless merge edge cases without dropping legacy files", async () => {
    const existingDiaryRoot = path.join(agentRoot, "desk", "_record", "diary")
    const legacyDiaryRoot = path.join(agentRoot, "diary")
    const existingNotesRoot = path.join(agentRoot, "desk", "_record", "notes")
    const legacyNotesRoot = path.join(agentRoot, "notes")
    fs.mkdirSync(existingDiaryRoot, { recursive: true })
    fs.mkdirSync(legacyDiaryRoot, { recursive: true })
    fs.mkdirSync(existingNotesRoot, { recursive: true })
    fs.mkdirSync(legacyNotesRoot, { recursive: true })
    fs.writeFileSync(path.join(existingDiaryRoot, "facts.jsonl"), '{"id":"desk"}', "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "facts.jsonl"), '{"id":"legacy"}\n', "utf-8")
    fs.writeFileSync(path.join(existingDiaryRoot, "entities.json"), "not json", "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "entities.json"), '{"legacy":true}\n', "utf-8")
    fs.writeFileSync(path.join(existingNotesRoot, "empty.md"), "", "utf-8")
    fs.writeFileSync(path.join(legacyNotesRoot, "empty.md"), "legacy fills empty destination", "utf-8")
    fs.writeFileSync(path.join(legacyNotesRoot, "entities.json"), '{"noteEntity":true}\n', "utf-8")

    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    expect(fs.readFileSync(paths.factsPath, "utf-8")).toBe('{"id":"desk"}\n{"id":"legacy"}\n')
    expect(fs.readFileSync(path.join(paths.diaryRoot, "entities.migrated-1.json"), "utf-8")).toContain('"legacy"')
    expect(fs.readFileSync(path.join(paths.notesRoot, "empty.md"), "utf-8")).toBe("legacy fills empty destination")
    expect(fs.readFileSync(path.join(paths.notesRoot, "entities.json"), "utf-8")).toContain("noteEntity")
  })

  it("keeps an existing entity file unchanged when the legacy entity object is empty", async () => {
    const existingDiaryRoot = path.join(agentRoot, "desk", "_record", "diary")
    const legacyDiaryRoot = path.join(agentRoot, "diary")
    fs.mkdirSync(existingDiaryRoot, { recursive: true })
    fs.mkdirSync(legacyDiaryRoot, { recursive: true })
    fs.writeFileSync(path.join(existingDiaryRoot, "entities.json"), '{"desk":true}\n', "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "entities.json"), "{}\n", "utf-8")

    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    expect(fs.readFileSync(paths.entitiesPath, "utf-8")).toContain('"desk"')
  })

  it("treats identical malformed entity files as already preserved", async () => {
    const existingDiaryRoot = path.join(agentRoot, "desk", "_record", "diary")
    const legacyDiaryRoot = path.join(agentRoot, "diary")
    fs.mkdirSync(existingDiaryRoot, { recursive: true })
    fs.mkdirSync(legacyDiaryRoot, { recursive: true })
    fs.writeFileSync(path.join(existingDiaryRoot, "entities.json"), "not json", "utf-8")
    fs.writeFileSync(path.join(legacyDiaryRoot, "entities.json"), "not json", "utf-8")

    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const paths = migrateLegacyRecordStores(agentRoot)

    expect(fs.readFileSync(paths.entitiesPath, "utf-8")).toBe("not json")
    expect(fs.existsSync(path.join(paths.diaryRoot, "entities.migrated-1.json"))).toBe(false)
  })

  it("reruns migration in the same process if a sync restores legacy roots", async () => {
    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const first = migrateLegacyRecordStores(agentRoot)
    fs.mkdirSync(path.join(agentRoot, "notes"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "notes", "restored.md"), "restored legacy note", "utf-8")

    const second = migrateLegacyRecordStores(agentRoot)

    expect(second.notesRoot).toBe(first.notesRoot)
    expect(fs.existsSync(path.join(agentRoot, "notes"))).toBe(false)
    expect(fs.readFileSync(path.join(second.notesRoot, "restored.md"), "utf-8")).toBe("restored legacy note")
  })

  it("is idempotent after a migration has already run", async () => {
    const { migrateLegacyRecordStores } = await import("../../mind/record-paths")
    const first = migrateLegacyRecordStores(agentRoot)
    fs.writeFileSync(first.factsPath, '{"id":"kept"}\n', "utf-8")

    const second = migrateLegacyRecordStores(agentRoot)

    expect(second.factsPath).toBe(first.factsPath)
    expect(fs.readFileSync(second.factsPath, "utf-8")).toContain("kept")
  })
})
