import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { baseToolDefinitions } from "../../repertoire/tools-base"
import { getToolsForChannel } from "../../repertoire/tools"
import { getChannelCapabilities } from "../../mind/friends/channel"

describe("glob tool", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "glob-tool-test-"))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function getGlobHandler() {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "glob")
    if (!def) throw new Error("glob tool not found in baseToolDefinitions")
    return def.handler
  }

  // --- Tool definition ---

  it("appears in baseToolDefinitions", () => {
    const names = baseToolDefinitions.map((d) => d.tool.function.name)
    expect(names).toContain("glob")
  })

  it("tool definition has correct parameters", () => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === "glob")!
    const params = def.tool.function.parameters as any
    expect(params.properties).toHaveProperty("pattern")
    expect(params.required).toEqual(expect.arrayContaining(["pattern"]))
    expect(params.properties).toHaveProperty("cwd")
  })

  // --- Matching behavior ---

  it("returns matching file paths for a pattern", async () => {
    fs.writeFileSync(path.join(tmpDir, "one.ts"), "a", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "two.ts"), "b", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "three.js"), "c", "utf-8")

    const handler = getGlobHandler()
    const result = await handler({ pattern: "**/*.ts", cwd: tmpDir })

    expect(result).toContain("one.ts")
    expect(result).toContain("two.ts")
    expect(result).not.toContain("three.js")
  })

  it("returns empty result for no matches (not an error)", async () => {
    const handler = getGlobHandler()
    const result = await handler({ pattern: "**/*.xyz", cwd: tmpDir })

    expect(result).not.toContain("error")
    // Should be empty or a "no matches" indicator, not an error
    expect(result.trim()).toBe("")
  })

  it("respects cwd parameter", async () => {
    const subDir = path.join(tmpDir, "sub")
    fs.mkdirSync(subDir)
    fs.writeFileSync(path.join(tmpDir, "root.ts"), "a", "utf-8")
    fs.writeFileSync(path.join(subDir, "nested.ts"), "b", "utf-8")

    const handler = getGlobHandler()
    const result = await handler({ pattern: "*.ts", cwd: subDir })

    expect(result).toContain("nested.ts")
    expect(result).not.toContain("root.ts")
  })

  it("returns paths sorted alphabetically (deterministic output)", async () => {
    fs.writeFileSync(path.join(tmpDir, "charlie.ts"), "c", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "alpha.ts"), "a", "utf-8")
    fs.writeFileSync(path.join(tmpDir, "bravo.ts"), "b", "utf-8")

    const handler = getGlobHandler()
    const result = await handler({ pattern: "**/*.ts", cwd: tmpDir })

    const lines = result.split("\n").filter(Boolean)
    expect(lines).toEqual([...lines].sort())
    expect(lines[0]).toContain("alpha.ts")
    expect(lines[1]).toContain("bravo.ts")
    expect(lines[2]).toContain("charlie.ts")
  })

  // --- tool availability ---

  it("is available in all channel tool lists (guardrails handle safety at exec time)", () => {
    const tools = getToolsForChannel(getChannelCapabilities("teams"))
    const names = tools.map((t) => t.function.name)
    expect(names).toContain("glob")
  })

  // --- Defaults ---

  it("defaults cwd to process.cwd() when not provided", async () => {
    // Write a file in actual cwd to test the default
    const marker = `glob-test-marker-${Date.now()}.tmp`
    const markerPath = path.join(process.cwd(), marker)
    fs.writeFileSync(markerPath, "marker", "utf-8")

    try {
      const handler = getGlobHandler()
      const result = await handler({ pattern: marker })
      expect(result).toContain(marker)
    } finally {
      fs.unlinkSync(markerPath)
    }
  })
})
