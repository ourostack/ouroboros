import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { baseToolDefinitions, editFileReadTracker } from "../../repertoire/tools-base"

describe("read_file offset/limit", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "read-file-test-"))
    editFileReadTracker.clear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function getReadFileHandler() {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "read_file")
    if (!def) throw new Error("read_file tool not found in baseToolDefinitions")
    return def.handler
  }

  function writeTestFile(name: string, content: string): string {
    const filePath = path.join(tmpDir, name)
    fs.writeFileSync(filePath, content, "utf-8")
    return filePath
  }

  // 10 lines: "line 1\nline 2\n...\nline 10"
  function tenLineContent(): string {
    return Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
  }

  // --- Tool schema ---

  it("read_file schema includes offset and limit as optional number parameters", () => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "read_file")!
    const params = def.tool.function.parameters as any
    expect(params.properties).toHaveProperty("offset")
    expect(params.properties.offset.type).toBe("number")
    expect(params.properties).toHaveProperty("limit")
    expect(params.properties.limit.type).toBe("number")
    // offset and limit should NOT be required
    expect(params.required).toEqual(["path"])
  })

  // --- Backward compat: no offset/limit ---

  it("reads full file when no offset or limit provided", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("full.txt", content)
    const handler = getReadFileHandler()

    const result = await handler({ path: filePath })
    expect(result).toBe(content)
  })

  // --- offset only ---

  it("reads from line offset to end of file (1-based)", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("offset.txt", content)
    const handler = getReadFileHandler()

    // offset=3 means start at line 3 (1-based), so lines 3-10
    const result = await handler({ path: filePath, offset: "3" })
    const expected = Array.from({ length: 8 }, (_, i) => `line ${i + 3}`).join("\n")
    expect(result).toBe(expected)
  })

  // --- limit only ---

  it("reads first N lines when only limit provided", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("limit.txt", content)
    const handler = getReadFileHandler()

    // limit=4 means first 4 lines
    const result = await handler({ path: filePath, limit: "4" })
    const expected = Array.from({ length: 4 }, (_, i) => `line ${i + 1}`).join("\n")
    expect(result).toBe(expected)
  })

  // --- offset + limit ---

  it("reads limit lines starting from offset", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("both.txt", content)
    const handler = getReadFileHandler()

    // offset=3, limit=4 means lines 3,4,5,6
    const result = await handler({ path: filePath, offset: "3", limit: "4" })
    const expected = Array.from({ length: 4 }, (_, i) => `line ${i + 3}`).join("\n")
    expect(result).toBe(expected)
  })

  // --- Edge: offset beyond file length ---

  it("returns empty string when offset exceeds file line count", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("beyond.txt", content)
    const handler = getReadFileHandler()

    const result = await handler({ path: filePath, offset: "100" })
    expect(result).toBe("")
  })

  // --- Edge: limit exceeds remaining lines ---

  it("returns available lines when limit exceeds remaining", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("exceed.txt", content)
    const handler = getReadFileHandler()

    // offset=8, limit=100 -> only lines 8,9,10 available
    const result = await handler({ path: filePath, offset: "8", limit: "100" })
    const expected = Array.from({ length: 3 }, (_, i) => `line ${i + 8}`).join("\n")
    expect(result).toBe(expected)
  })

  // --- Edge: offset=1 is same as full file ---

  it("offset=1 returns full file (1-based indexing)", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("offset1.txt", content)
    const handler = getReadFileHandler()

    const result = await handler({ path: filePath, offset: "1" })
    expect(result).toBe(content)
  })

  // --- Still populates editFileReadTracker ---

  it("populates editFileReadTracker even with offset/limit", async () => {
    const content = tenLineContent()
    const filePath = writeTestFile("tracker.txt", content)
    const handler = getReadFileHandler()

    expect(editFileReadTracker.has(filePath)).toBe(false)
    await handler({ path: filePath, offset: "2", limit: "3" })
    expect(editFileReadTracker.has(filePath)).toBe(true)
  })
})
