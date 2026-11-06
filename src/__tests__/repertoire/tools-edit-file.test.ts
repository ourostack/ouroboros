import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { baseToolDefinitions, editFileReadTracker } from "../../repertoire/tools-base"
import { getToolsForChannel } from "../../repertoire/tools"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { makeOversizedAgentContent } from "../helpers/content-cap"

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

  it("preserves oversized replacement content exactly without applying the structured record cap", async () => {
    const filePath = path.join(tmpDir, "oversized-replace.txt")
    fs.writeFileSync(filePath, "before\nPLACEHOLDER\nafter", "utf-8")
    editFileReadTracker.add(filePath)
    const oversized = makeOversizedAgentContent("edit-file replacement ")

    const handler = getEditFileHandler()
    await handler({ path: filePath, old_string: "PLACEHOLDER", new_string: oversized })

    const content = fs.readFileSync(filePath, "utf-8")
    expect(content).toBe(`before\n${oversized}\nafter`)
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

  // --- tool availability ---

  it("is available in all channel tool lists (guardrails handle safety at exec time)", () => {
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)

    expect(names).toContain("edit_file")
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

describe("file tools note a change to the agent's own psyche", () => {
  let agentRoot: string

  beforeEach(() => {
    agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "psyche-note-"))
    fs.mkdirSync(path.join(agentRoot, "psyche"))
    fs.writeFileSync(path.join(agentRoot, "psyche", "SOUL.md"), "I am calm.\n")
    fs.writeFileSync(path.join(agentRoot, "psyche", "TACIT.md"), "The router is in the closet.\n")
    editFileReadTracker.clear()
  })

  afterEach(() => {
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  const handler = (name: string) => baseToolDefinitions.find((d) => d.tool.function.name === name)!.handler
  const NOTE = "psyche edit: I changed psyche/SOUL.md. I tell my owner in one line which file changed and why."

  it("ends a successful edit_file on psyche/SOUL.md with the psyche edit note", async () => {
    const soul = path.join(agentRoot, "psyche", "SOUL.md")
    editFileReadTracker.add(soul)
    const result = await handler("edit_file")({ path: soul, old_string: "calm", new_string: "warm" }, { agentRoot } as never)
    expect(result.endsWith(NOTE)).toBe(true)
  })

  it("leaves a successful edit_file on psyche/TACIT.md without the note", async () => {
    const tacit = path.join(agentRoot, "psyche", "TACIT.md")
    editFileReadTracker.add(tacit)
    const result = await handler("edit_file")({ path: tacit, old_string: "closet", new_string: "hall" }, { agentRoot } as never)
    expect(result).not.toContain("psyche edit:")
  })

  it("ends a write_file on a new identity file with the note naming it, and leaves files outside psyche alone", async () => {
    const lore = path.join(agentRoot, "psyche", "LORE.md")
    expect(await handler("write_file")({ path: lore, content: "x" }, { agentRoot } as never)).toContain("psyche edit: I changed psyche/LORE.md.")
    expect(await handler("write_file")({ path: path.join(agentRoot, "notes.md"), content: "x" }, { agentRoot } as never)).not.toContain("psyche edit:")
  })

  it("names SOUL when the write went to a TACIT that links to it", async () => {
    fs.rmSync(path.join(agentRoot, "psyche", "TACIT.md"))
    fs.symlinkSync(path.join(agentRoot, "psyche", "SOUL.md"), path.join(agentRoot, "psyche", "TACIT.md"))
    expect(await handler("write_file")({ path: path.join(agentRoot, "psyche", "TACIT.md"), content: "x" }, { agentRoot } as never)).toContain(NOTE)
  })

  it("names the real file when the write went through an alias outside psyche/", async () => {
    const alias = path.join(agentRoot, "soul-link.md")
    fs.symlinkSync(path.join(agentRoot, "psyche", "SOUL.md"), alias)
    expect(await handler("write_file")({ path: alias, content: "x" }, { agentRoot } as never)).toContain(NOTE)
  })
})
