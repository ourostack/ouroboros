import { describe, it, expect, beforeEach, afterEach } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { editFileReadTracker } from "../../repertoire/tools-base"
import { fileToolDefinitions } from "../../repertoire/tools-files"

const tool = (name: string) => fileToolDefinitions.find((d) => d.tool.function.name === name)!

describe("file tools' Ouro AX cards", () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-cards-"))
    editFileReadTracker.clear()
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("gives every file tool a card named after it", () => {
    for (const def of fileToolDefinitions) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.group).toBe("turn-files")
    }
  })

  it("backs each read card with a profile that changes nothing", () => {
    for (const name of ["read_file", "ls", "glob", "grep"]) {
      expect(tool(name).ax?.effect).toBe("read")
      expect(tool(name).riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
    expect(tool("write_file").ax?.effect).toBe("write")
    expect(tool("edit_file").ax?.effect).toBe("write")
  })

  it("ends each edit_file refusal with the code its card names", async () => {
    const file = path.join(dir, "a.txt")
    fs.writeFileSync(file, "one two two", "utf-8")
    const edit = tool("edit_file").handler
    expect(await edit({ path: file, old_string: "one", new_string: "1" })).toBe(
      `error: you must read the file with read_file before editing it. call read_file on ${file} first. (code: read-first)`,
    )
    await tool("read_file").handler({ path: file })
    expect(await edit({ path: file, old_string: "three", new_string: "3" })).toBe(`error: old_string not found in ${file} (code: no-match)`)
    expect(await edit({ path: file, old_string: "two", new_string: "2" })).toBe(
      `error: old_string is ambiguous -- found 2 matches in ${file}. provide more context to make the match unique. (code: ambiguous-match)`,
    )
    const codes = tool("edit_file").ax!.errors.map((e) => e.code)
    expect(codes).toEqual(expect.arrayContaining(["read-first", "no-match", "ambiguous-match"]))
  })
})
