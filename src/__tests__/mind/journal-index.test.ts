import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { expectCappedAgentContent, makeOversizedAgentContent } from "../helpers/content-cap"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("indexJournalFiles", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "journal-index-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("is exported from journal-index.ts", async () => {
    const mod = await import("../../mind/journal-index")
    expect(typeof mod.indexJournalFiles).toBe("function")
  })

  it("indexes new .md files and writes to sidecar", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# My notes\nSome content here about auth", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    expect(fs.existsSync(indexPath)).toBe(true)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index).toHaveLength(1)
    expect(index[0].filename).toBe("notes.md")
    expect(index[0].embedding).toEqual([0.1, 0.2, 0.3])
    expect(index[0].preview).toBe("My notes")
    expect(typeof index[0].mtime).toBe("number")
  })

  it("caps oversized derived previews before writing the journal sidecar JSON", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const oversized = makeOversizedAgentContent("# Oversized journal ")
    fs.writeFileSync(path.join(journalDir, "oversized.md"), oversized, "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    await indexJournalFiles(journalDir, indexPath, mockProvider)

    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index).toHaveLength(1)
    expectCappedAgentContent(index[0].preview, oversized.replace(/^#+\s*/, "").trim())
  })

  it("indexes .txt files as well", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "thoughts.txt"), "Just some thoughts about design", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.4, 0.5, 0.6]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].filename).toBe("thoughts.txt")
  })

  it("skips files already indexed with same mtime", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const filePath = path.join(journalDir, "notes.md")
    fs.writeFileSync(filePath, "# Notes", "utf8")
    const stat = fs.statSync(filePath)

    // Create an existing index with the same mtime
    const indexPath = path.join(journalDir, ".index.json")
    const existingIndex = [
      { filename: "notes.md", embedding: [0.1, 0.2, 0.3], mtime: stat.mtimeMs, preview: "Notes" },
    ]
    fs.writeFileSync(indexPath, JSON.stringify(existingIndex), "utf8")

    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.9, 0.8, 0.7]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    // Should skip the already-indexed file
    expect(count).toBe(0)
    // Provider should not have been called
    expect(mockProvider.embed).not.toHaveBeenCalled()
    // Index should remain unchanged
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].embedding).toEqual([0.1, 0.2, 0.3])
  })

  it("re-indexes files with changed mtime", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const filePath = path.join(journalDir, "notes.md")
    fs.writeFileSync(filePath, "# Updated notes", "utf8")
    const stat = fs.statSync(filePath)

    // Create an existing index with a different (older) mtime
    const indexPath = path.join(journalDir, ".index.json")
    const existingIndex = [
      { filename: "notes.md", embedding: [0.1, 0.2, 0.3], mtime: stat.mtimeMs - 10000, preview: "Old notes" },
    ]
    fs.writeFileSync(indexPath, JSON.stringify(existingIndex), "utf8")

    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.9, 0.8, 0.7]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].embedding).toEqual([0.9, 0.8, 0.7])
    expect(index[0].preview).toBe("Updated notes")
  })

  it("creates index file when it doesn't exist", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "first.md"), "# First entry", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    // Don't create the index file — it should be created
    expect(fs.existsSync(indexPath)).toBe(false)

    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    expect(fs.existsSync(indexPath)).toBe(true)
  })

  it("returns 0 when journal dir does not exist", async () => {
    const journalDir = path.join(tmpDir, "nonexistent-journal")
    const indexPath = path.join(journalDir, ".index.json")

    const mockProvider = {
      embed: vi.fn(),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(0)
    expect(mockProvider.embed).not.toHaveBeenCalled()
  })

  it("returns 0 when journal dir is empty", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const indexPath = path.join(journalDir, ".index.json")

    const mockProvider = {
      embed: vi.fn(),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(0)
  })

  it("ignores non-text files (e.g., .json, .png)", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "data.json"), '{"key":"value"}', "utf8")
    fs.writeFileSync(path.join(journalDir, "image.png"), "fake png", "utf8")
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Real notes", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    // Should only index the .md file
    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index).toHaveLength(1)
    expect(index[0].filename).toBe("notes.md")
  })

  it("reads first ~500 chars for embedding", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    const longContent = "# Title\n" + "x".repeat(1000)
    fs.writeFileSync(path.join(journalDir, "long.md"), longContent, "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    await indexJournalFiles(journalDir, indexPath, mockProvider)

    // The embed call should have received ~500 chars, not the full 1000+
    const embedArg = mockProvider.embed.mock.calls[0][0][0]
    expect(embedArg.length).toBeLessThanOrEqual(500)
  })

  it("stores empty embedding when provider is unavailable", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockRejectedValue(new Error("provider unavailable")),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    // Should still count the file as indexed (with empty embedding)
    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].embedding).toEqual([])
  })

  it("handles index entry format: { filename, embedding, mtime, preview }", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "test.md"), "# Test\nContent here", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.5, 0.5]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    await indexJournalFiles(journalDir, indexPath, mockProvider)

    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0]).toHaveProperty("filename")
    expect(index[0]).toHaveProperty("embedding")
    expect(index[0]).toHaveProperty("mtime")
    expect(index[0]).toHaveProperty("preview")
  })

  it("indexes multiple new files in one call", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "a.md"), "# Alpha", "utf8")
    fs.writeFileSync(path.join(journalDir, "b.md"), "# Beta", "utf8")
    fs.writeFileSync(path.join(journalDir, "c.txt"), "Gamma text", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn()
        .mockResolvedValueOnce([[0.1, 0.2]])
        .mockResolvedValueOnce([[0.3, 0.4]])
        .mockResolvedValueOnce([[0.5, 0.6]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(3)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index).toHaveLength(3)
  })

  it("handles malformed existing index gracefully", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    // Write malformed index
    const indexPath = path.join(journalDir, ".index.json")
    fs.writeFileSync(indexPath, "not-valid-json!!!", "utf8")

    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    // Should start fresh and index the file
    expect(count).toBe(1)
  })

  it("handles non-array existing index", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    // Write non-array JSON
    const indexPath = path.join(journalDir, ".index.json")
    fs.writeFileSync(indexPath, '{"not":"array"}', "utf8")

    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
  })

  it("skips subdirectories in journal dir", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.mkdirSync(path.join(journalDir, "subdir"))
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    // Should only index files, not directories
    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index).toHaveLength(1)
    expect(index[0].filename).toBe("notes.md")
  })

  it("handles embed returning empty first vector", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "notes.md"), "# Notes", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      // Returns an array where the first element is undefined
      embed: vi.fn().mockResolvedValue([undefined]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    // Should fall back to empty embedding via ?? []
    expect(index[0].embedding).toEqual([])
  })

  it("handles file with empty content", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, "empty.md"), "", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].preview).toBe("")
  })

  it("skips hidden files like .index.json", async () => {
    const journalDir = path.join(tmpDir, "journal")
    fs.mkdirSync(journalDir, { recursive: true })
    fs.writeFileSync(path.join(journalDir, ".hidden.md"), "# Hidden", "utf8")
    fs.writeFileSync(path.join(journalDir, "visible.md"), "# Visible", "utf8")

    const indexPath = path.join(journalDir, ".index.json")
    const mockProvider = {
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    }

    const { indexJournalFiles } = await import("../../mind/journal-index")
    const count = await indexJournalFiles(journalDir, indexPath, mockProvider)

    expect(count).toBe(1)
    const index = JSON.parse(fs.readFileSync(indexPath, "utf8"))
    expect(index[0].filename).toBe("visible.md")
  })
})
