import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { baseToolDefinitions, editFileReadTracker } from "../../repertoire/tools-base"
import { getToolsForChannel } from "../../repertoire/tools"
import { getChannelCapabilities } from "../../mind/friends/channel"

describe("edit_file tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "edit-file-test-"))
    editFileReadTracker.clear()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function getEditFileHandler() {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "edit_file")
    if (!def) throw new Error("edit_file tool not found in baseToolDefinitions")
    return def.handler
  }

  function getReadFileHandler() {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "read_file")
    if (!def) throw new Error("read_file tool not found in baseToolDefinitions")
    return def.handler
  }

  // --- Tool definition ---

  it("appears in baseToolDefinitions", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("edit_file")
  })

  it("tool definition has correct parameters", () => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "edit_file")!
    const params = def.tool.function.parameters as any
    expect(params.properties).toHaveProperty("path")
    expect(params.properties).toHaveProperty("old_string")
    expect(params.properties).toHaveProperty("new_string")
    expect(params.required).toEqual(expect.arrayContaining(["path", "old_string", "new_string"]))
  })

  // --- Must-read-first guard ---

  it("fails with clear error if file not previously read via read_file", async () => {
    const filePath = path.join(tmpDir, "unread.txt")
    fs.writeFileSync(filePath, "some content", "utf-8")

    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "some", new_string: "other" })

    expect(result).toContain("must read")
    expect(result.toLowerCase()).toContain("read_file")
  })

  it("succeeds after read_file on the same path", async () => {
    const filePath = path.join(tmpDir, "readable.txt")
    fs.writeFileSync(filePath, "hello world", "utf-8")

    // Read first
    const readHandler = getReadFileHandler()
    readHandler({ path: filePath })

    // Now edit should succeed
    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "hello", new_string: "goodbye" })

    expect(result).not.toContain("must read")
    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toBe("goodbye world")
  })

  // --- Replacement behavior ---

  it("replaces old_string with new_string in file", async () => {
    const filePath = path.join(tmpDir, "replace.txt")
    fs.writeFileSync(filePath, "the quick brown fox", "utf-8")

    editFileReadTracker.add(filePath)

    const handler = getEditFileHandler()
    await handler({ path: filePath, old_string: "quick brown", new_string: "slow red" })

    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toBe("the slow red fox")
  })

  it("fails if old_string not found in file", async () => {
    const filePath = path.join(tmpDir, "notfound.txt")
    fs.writeFileSync(filePath, "hello world", "utf-8")

    editFileReadTracker.add(filePath)

    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "nonexistent", new_string: "replacement" })

    expect(result).toContain("not found")
    // File should be unchanged
    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toBe("hello world")
  })

  it("fails if old_string matches multiple locations (ambiguous)", async () => {
    const filePath = path.join(tmpDir, "ambiguous.txt")
    fs.writeFileSync(filePath, "foo bar foo baz foo", "utf-8")

    editFileReadTracker.add(filePath)

    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "foo", new_string: "qux" })

    expect(result).toContain("ambiguous")
    // File should be unchanged
    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toBe("foo bar foo baz foo")
  })

  // --- Contextual diff output ---

  it("returns contextual diff showing surrounding lines and the change", async () => {
    const lines = [
      "line 1",
      "line 2",
      "line 3",
      "line 4 target",
      "line 5",
      "line 6",
      "line 7",
    ]
    const filePath = path.join(tmpDir, "diff.txt")
    fs.writeFileSync(filePath, lines.join("\n"), "utf-8")

    editFileReadTracker.add(filePath)

    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "line 4 target", new_string: "line 4 replaced" })

    // Should show context lines around the change
    expect(result).toContain("line 3")
    expect(result).toContain("line 4 replaced")
    expect(result).toContain("line 5")
  })

  // --- Read-tracking state management ---

  it("tracking is per-session and resettable", () => {
    editFileReadTracker.add("/some/path.txt")
    expect(editFileReadTracker.has("/some/path.txt")).toBe(true)

    editFileReadTracker.clear()
    expect(editFileReadTracker.has("/some/path.txt")).toBe(false)
  })

  it("different paths are tracked independently", async () => {
    const filePath1 = path.join(tmpDir, "file1.txt")
    const filePath2 = path.join(tmpDir, "file2.txt")
    fs.writeFileSync(filePath1, "content one", "utf-8")
    fs.writeFileSync(filePath2, "content two", "utf-8")

    // Only read file1
    const readHandler = getReadFileHandler()
    readHandler({ path: filePath1 })

    const handler = getEditFileHandler()

    // file1 should succeed
    const result1 = await handler({ path: filePath1, old_string: "content one", new_string: "edited one" })
    expect(result1).not.toContain("must read")

    // file2 should fail
    const result2 = await handler({ path: filePath2, old_string: "content two", new_string: "edited two" })
    expect(result2).toContain("must read")
  })

  // --- REMOTE_BLOCKED_LOCAL_TOOLS ---

  it("is in REMOTE_BLOCKED_LOCAL_TOOLS", () => {
    // Verify that edit_file is filtered from remote channel tool lists
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)

    expect(names).not.toContain("edit_file")
  })

  // --- Edge cases ---

  it("fails if file does not exist on disk", async () => {
    const filePath = path.join(tmpDir, "nonexistent.txt")
    editFileReadTracker.add(filePath)

    const handler = getEditFileHandler()
    const result = await handler({ path: filePath, old_string: "anything", new_string: "anything" })

    expect(result).toContain("error")
  })
})
