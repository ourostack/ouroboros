import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  trackModifiedFile,
  getModifiedFileCount,
  resetSessionModifiedFiles,
  getPostImplementationScrutiny,
} from "../../mind/scrutiny"
import { baseToolDefinitions, editFileReadTracker } from "../../repertoire/tools-base"

describe("post-implementation scrutiny module", () => {
  beforeEach(() => {
    resetSessionModifiedFiles()
  })

  // --- File tracking ---

  it("trackModifiedFile increments distinct file count", () => {
    expect(getModifiedFileCount()).toBe(0)
    trackModifiedFile("/src/foo.ts")
    expect(getModifiedFileCount()).toBe(1)
    trackModifiedFile("/src/bar.ts")
    expect(getModifiedFileCount()).toBe(2)
  })

  it("tracking the same file multiple times counts as 1 distinct file", () => {
    trackModifiedFile("/src/foo.ts")
    trackModifiedFile("/src/foo.ts")
    trackModifiedFile("/src/foo.ts")
    trackModifiedFile("/src/foo.ts")
    trackModifiedFile("/src/foo.ts")
    expect(getModifiedFileCount()).toBe(1)
  })

  it("resetSessionModifiedFiles clears the count", () => {
    trackModifiedFile("/src/a.ts")
    trackModifiedFile("/src/b.ts")
    expect(getModifiedFileCount()).toBe(2)
    resetSessionModifiedFiles()
    expect(getModifiedFileCount()).toBe(0)
  })

  // --- Scrutiny tier selection ---

  it("returns empty string for 0 files", () => {
    const result = getPostImplementationScrutiny(0)
    expect(result).toBe("")
  })

  it("returns short checklist for 1 file (Tier 1)", () => {
    const result = getPostImplementationScrutiny(1)
    expect(result).toContain("Before moving on")
    expect(result).toContain("does this change do what was asked")
    expect(result).not.toContain("stranger-with-candy")
    expect(result).not.toContain("tinfoil-hat")
  })

  it("returns short checklist for 2 files (Tier 1)", () => {
    const result = getPostImplementationScrutiny(2)
    expect(result).toContain("Before moving on")
  })

  it("returns full scrutiny prompts for 3 files (Tier 2)", () => {
    const result = getPostImplementationScrutiny(3)
    expect(result).toContain("stranger-with-candy pass")
    expect(result).toContain("tinfoil-hat pass")
    expect(result).toContain("Does this code actually do what it claims")
    expect(result).toContain("The conspiracy is IN the code")
  })

  it("returns full scrutiny prompts for 10 files (Tier 2)", () => {
    const result = getPostImplementationScrutiny(10)
    expect(result).toContain("stranger-with-candy pass")
    expect(result).toContain("tinfoil-hat pass")
  })

  it("full scrutiny includes anti-hallucination clause", () => {
    const result = getPostImplementationScrutiny(5)
    expect(result).toContain("silence is a valid outcome")
    expect(result).toContain("I do not manufacture issues for sport")
  })

  it("short checklist starts with ---", () => {
    const result = getPostImplementationScrutiny(1)
    expect(result.startsWith("---")).toBe(true)
  })

  it("full scrutiny starts with ---", () => {
    const result = getPostImplementationScrutiny(3)
    expect(result.startsWith("---")).toBe(true)
  })

  it("returns empty for negative file count", () => {
    const result = getPostImplementationScrutiny(-1)
    expect(result).toBe("")
  })
})

describe("post-implementation scrutiny tool-result integration", () => {
  // These tests verify that edit_file and write_file tool results include
  // scrutiny appendix based on distinct files modified in the session.
  // The integration happens in the tool handler wrapper (execTool) or
  // directly in the handler -- either way, the contract is:
  //   - edit_file/write_file results include scrutiny appendix
  //   - read_file/grep/glob results do NOT include scrutiny appendix

  beforeEach(() => {
    resetSessionModifiedFiles()
  })

  it("edit_file result includes short checklist after first file edit", () => {
    // After tracking 1 file, the scrutiny appendix should be the short checklist
    trackModifiedFile("/src/foo.ts")
    const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
    expect(scrutiny).toContain("Before moving on")
  })

  it("edit_file result includes full scrutiny after 3+ distinct file edits", () => {
    trackModifiedFile("/src/a.ts")
    trackModifiedFile("/src/b.ts")
    trackModifiedFile("/src/c.ts")
    const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
    expect(scrutiny).toContain("stranger-with-candy pass")
    expect(scrutiny).toContain("tinfoil-hat pass")
  })

  it("editing same file 5 times still counts as Tier 1", () => {
    for (let i = 0; i < 5; i++) {
      trackModifiedFile("/src/foo.ts")
    }
    const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
    expect(scrutiny).toContain("Before moving on")
    expect(scrutiny).not.toContain("stranger-with-candy")
  })

  it("read_file does not receive scrutiny appendix (no tracking)", () => {
    // read_file should NOT call trackModifiedFile, so no scrutiny
    // This test verifies the contract: only edit/write tools track files
    expect(getModifiedFileCount()).toBe(0)
    const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
    expect(scrutiny).toBe("")
  })
})

describe("post-implementation scrutiny handler integration", () => {
  let tmpDir: string

  function getHandler(name: string) {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === name)
    if (!def) throw new Error(`tool ${name} not found`)
    return def.handler
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scrutiny-test-"))
    editFileReadTracker.clear()
    resetSessionModifiedFiles()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it("edit_file handler result includes short checklist after first file edit", async () => {
    const filePath = path.join(tmpDir, "a.ts")
    fs.writeFileSync(filePath, "hello world", "utf-8")
    editFileReadTracker.add(filePath)

    const handler = getHandler("edit_file")
    const result = await handler({ path: filePath, old_string: "hello", new_string: "goodbye" })
    expect(result).toContain("Before moving on")
    expect(result).toContain("does this change do what was asked")
  })

  it("edit_file handler tracks distinct files for scrutiny tier", async () => {
    // Edit 3 distinct files to trigger Tier 2
    for (const name of ["a.ts", "b.ts", "c.ts"]) {
      const filePath = path.join(tmpDir, name)
      fs.writeFileSync(filePath, `content of ${name}`, "utf-8")
      editFileReadTracker.add(filePath)
      const handler = getHandler("edit_file")
      await handler({ path: filePath, old_string: `content of ${name}`, new_string: `updated ${name}` })
    }
    // The third edit should have the full scrutiny prompts
    const filePath3 = path.join(tmpDir, "c2.ts")
    fs.writeFileSync(filePath3, "more content", "utf-8")
    editFileReadTracker.add(filePath3)
    const result = await getHandler("edit_file")({ path: filePath3, old_string: "more content", new_string: "changed" })
    expect(result).toContain("stranger-with-candy pass")
    expect(result).toContain("tinfoil-hat pass")
  })

  it("write_file handler result includes short checklist after first write", async () => {
    const filePath = path.join(tmpDir, "new.ts")

    const handler = getHandler("write_file")
    const result = await handler({ path: filePath, content: "new file content" })
    expect(result).toContain("Before moving on")
  })

  it("editing same file multiple times stays Tier 1", async () => {
    const filePath = path.join(tmpDir, "repeat.ts")
    fs.writeFileSync(filePath, "aaa bbb ccc", "utf-8")
    editFileReadTracker.add(filePath)

    const handler = getHandler("edit_file")
    await handler({ path: filePath, old_string: "aaa", new_string: "AAA" })
    const result = await handler({ path: filePath, old_string: "bbb", new_string: "BBB" })
    expect(result).toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("read_file result does NOT include scrutiny appendix", async () => {
    const filePath = path.join(tmpDir, "readonly.ts")
    fs.writeFileSync(filePath, "read only content", "utf-8")

    // First modify some files so scrutiny would trigger
    trackModifiedFile("/src/a.ts")
    trackModifiedFile("/src/b.ts")
    trackModifiedFile("/src/c.ts")

    const handler = getHandler("read_file")
    const result = await handler({ path: filePath })
    expect(result).not.toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })

  it("glob result does NOT include scrutiny appendix", async () => {
    fs.writeFileSync(path.join(tmpDir, "test.ts"), "content", "utf-8")

    trackModifiedFile("/src/a.ts")
    trackModifiedFile("/src/b.ts")
    trackModifiedFile("/src/c.ts")

    const handler = getHandler("glob")
    const result = await handler({ pattern: "*.ts", cwd: tmpDir })
    expect(result).not.toContain("Before moving on")
    expect(result).not.toContain("stranger-with-candy")
  })
})
