import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { baseToolDefinitions } from "../../repertoire/tools-base"
import { getToolsForChannel } from "../../repertoire/tools"
import { getChannelCapabilities } from "../../mind/friends/channel"

describe("grep tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "grep-tool-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function getGrepHandler() {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "grep")
    if (!def) throw new Error("grep tool not found in baseToolDefinitions")
    return def.handler
  }

  // --- Tool definition ---

  it("appears in baseToolDefinitions", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("grep")
  })

  it("tool definition has correct parameters", () => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "grep")!
    const params = def.tool.function.parameters as any
    expect(params.properties).toHaveProperty("pattern")
    expect(params.properties).toHaveProperty("path")
    expect(params.properties).toHaveProperty("context_lines")
    expect(params.properties).toHaveProperty("include")
    expect(params.required).toEqual(expect.arrayContaining(["pattern", "path"]))
  })

  // --- Matching behavior ---

  it("finds matching lines with file path and line numbers", async () => {
    const filePath = path.join(tmpDir, "sample.ts")
    fs.writeFileSync(filePath, "line one\nline two\nline three\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "two", path: filePath })

    expect(result).toContain("sample.ts")
    expect(result).toContain("2")
    expect(result).toContain("line two")
  })

  it("supports regex patterns", async () => {
    const filePath = path.join(tmpDir, "regex.ts")
    fs.writeFileSync(filePath, "logInfo: ok\nlogError: bad\nlogWarn: maybe\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "log.*Error", path: filePath })

    expect(result).toContain("logError: bad")
    expect(result).not.toContain("logInfo")
    expect(result).not.toContain("logWarn")
  })

  it("supports context_lines parameter for surrounding context", async () => {
    const lines = [
      "alpha",
      "bravo",
      "charlie",
      "delta TARGET",
      "echo",
      "foxtrot",
      "golf",
    ]
    const filePath = path.join(tmpDir, "context.txt")
    fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "TARGET", path: filePath, context_lines: "2" })

    // Should include 2 lines before and 2 lines after
    expect(result).toContain("bravo")
    expect(result).toContain("charlie")
    expect(result).toContain("delta TARGET")
    expect(result).toContain("echo")
    expect(result).toContain("foxtrot")
    // alpha and golf should NOT appear (outside 2-line context window)
    expect(result).not.toContain("alpha")
    expect(result).not.toContain("golf")
  })

  it("returns empty result for no matches (not an error)", async () => {
    const filePath = path.join(tmpDir, "nope.txt")
    fs.writeFileSync(filePath, "nothing interesting here\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "nonexistent_pattern_xyz", path: filePath })

    expect(result).not.toContain("error")
    expect(result.trim()).toBe("")
  })

  it("supports include glob filter to limit searched files", async () => {
    fs.writeFileSync(path.join(tmpDir, "yes.ts"), "findme here\n", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "no.js"), "findme here too\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "findme", path: tmpDir, include: "*.ts" })

    expect(result).toContain("yes.ts")
    expect(result).not.toContain("no.js")
  })

  it("searches directory recursively by default", async () => {
    const subDir = path.join(tmpDir, "sub", "deep")
    fs.mkdirSync(subDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, "root.txt"), "target line\n", "utf-8")
    fs.writeFileSync(path.join(subDir, "nested.txt"), "target line\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "target", path: tmpDir })

    expect(result).toContain("root.txt")
    expect(result).toContain("nested.txt")
  })

  it("searches single file when path is a file", async () => {
    const filePath = path.join(tmpDir, "single.txt")
    fs.writeFileSync(filePath, "alpha\nbeta\ngamma\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "beta", path: filePath })

    expect(result).toContain("single.txt")
    expect(result).toContain("beta")
    expect(result).not.toContain("alpha")
    expect(result).not.toContain("gamma")
  })

  // --- REMOTE_BLOCKED_LOCAL_TOOLS ---

  it("is in REMOTE_BLOCKED_LOCAL_TOOLS (filtered from remote channel tool lists)", () => {
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)
    expect(names).not.toContain("grep")
  })

  // --- Edge cases ---

  it("handles empty files gracefully", async () => {
    const filePath = path.join(tmpDir, "empty.txt")
    fs.writeFileSync(filePath, "", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "anything", path: filePath })

    expect(result).not.toContain("error")
    expect(result.trim()).toBe("")
  })

  it("handles binary-like files without crashing", async () => {
    const filePath = path.join(tmpDir, "binary.bin")
    const buf = Buffer.from([0x00, 0x01, 0xff, 0x48, 0x65, 0x6c, 0x6c, 0x6f])
    fs.writeFileSync(filePath, buf)

    const handler = getGrepHandler()
    // Should not throw -- binary files just won't match text patterns well
    const result = await handler({ pattern: "Hello", path: filePath })
    expect(typeof result).toBe("string")
  })

  it("context lines at start of file are clamped (no negative indices)", async () => {
    const filePath = path.join(tmpDir, "edge-start.txt")
    fs.writeFileSync(filePath, "match\nsecond\nthird\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "match", path: filePath, context_lines: "5" })

    // Should include the match line and following context (clamped to file bounds)
    expect(result).toContain("match")
    expect(result).toContain("second")
    expect(result).toContain("third")
  })

  it("context lines at end of file are clamped (no out of bounds)", async () => {
    const filePath = path.join(tmpDir, "edge-end.txt")
    fs.writeFileSync(filePath, "first\nsecond\nmatch\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "match", path: filePath, context_lines: "5" })

    expect(result).toContain("first")
    expect(result).toContain("second")
    expect(result).toContain("match")
  })

  it("multiple matches in same file produce multiple result blocks", async () => {
    const filePath = path.join(tmpDir, "multi.txt")
    fs.writeFileSync(filePath, "error: one\nok\nerror: two\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "error", path: filePath })

    expect(result).toContain("error: one")
    expect(result).toContain("error: two")
    // Both should have line numbers
    const lines = result.split("\n").filter(Boolean)
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it("output format uses filepath:lineNumber: line content", async () => {
    const filePath = path.join(tmpDir, "format.txt")
    fs.writeFileSync(filePath, "aaa\nbbb\nccc\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "bbb", path: filePath })

    // Format: {filepath}:{lineNumber}: {line}
    expect(result).toMatch(/format\.txt:2:/)
    expect(result).toContain("bbb")
  })

  it("context lines use - prefix to distinguish from match lines", async () => {
    const filePath = path.join(tmpDir, "ctx-prefix.txt")
    fs.writeFileSync(filePath, "before\nmatch line\nafter\n", "utf-8")

    const handler = getGrepHandler()
    const result = await handler({ pattern: "match", path: filePath, context_lines: "1" })

    const lines = result.split("\n").filter(Boolean)
    // Context lines should be prefixed with -
    const contextLines = lines.filter((l) => l.includes("before") || l.includes("after"))
    for (const cl of contextLines) {
      expect(cl.startsWith("-")).toBe(true)
    }
    // Match line should NOT start with -
    const matchLines = lines.filter((l) => l.includes("match line"))
    expect(matchLines.length).toBeGreaterThan(0)
    for (const ml of matchLines) {
      expect(ml.startsWith("-")).toBe(false)
    }
  })
})
