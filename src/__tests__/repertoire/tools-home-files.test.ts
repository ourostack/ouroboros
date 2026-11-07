import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
const identityRoot = vi.hoisted(() => ({ value: "" }))
vi.mock("../../heart/identity", async (importOriginal) => ({ ...(await importOriginal<typeof import("../../heart/identity")>()), getAgentRoot: () => identityRoot.value }))

import { baseToolDefinitions, editFileReadTracker, type ToolContext } from "../../repertoire/tools-base"
import { TOOL_MAX_CHARS, TOOL_MAX_LINES, looksBinary } from "../../repertoire/tool-limits"

describe("file tools work from the agent's home", () => {
  let home: string
  let ctx: ToolContext

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "home-files-test-"))
    ctx = { signin: async () => undefined, agentRoot: home }
    editFileReadTracker.clear()
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  const run = (name: string, args: Record<string, unknown>) => {
    const def = baseToolDefinitions.find((d) => d.tool.function.name === name)!
    return Promise.resolve(def.handler(args as any, ctx)) as Promise<string>
  }
  const put = (rel: string, body: string | Buffer) => {
    const full = path.join(home, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }

  it("tool descriptions stay within two sentences", () => {
    for (const name of ["read_file", "ls", "glob", "grep"]) {
      const d = baseToolDefinitions.find((x) => x.tool.function.name === name)!.tool.function.description!
      expect(d.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2)
    }
  })

  describe("relative paths", () => {
    it("read_file reads relative to home", async () => {
      put("psyche/me.md", "hello")
      expect(await run("read_file", { path: "psyche/me.md" })).toBe("hello")
    })
    it("a relative write lands in the bundle and edit works on it", async () => {
      expect(await run("write_file", { path: "notes/a.md", content: "one two" })).toContain("ok")
      expect(fs.readFileSync(path.join(home, "notes/a.md"), "utf-8")).toBe("one two")
      await run("read_file", { path: "notes/a.md" })
      await run("edit_file", { path: "notes/a.md", old_string: "two", new_string: "three" })
      expect(fs.readFileSync(path.join(home, "notes/a.md"), "utf-8")).toBe("one three")
    })
    it("an absolute path is unchanged", async () => {
      const abs = path.join(home, "abs.txt")
      fs.writeFileSync(abs, "abs")
      expect(await run("read_file", { path: abs })).toBe("abs")
    })
    it("falls back to the identity's agent root without ctx.agentRoot", async () => {
      identityRoot.value = home
      put("x/in.txt", "hi")
      const bare = { signin: async () => undefined }
      const call = (name: string, args: Record<string, unknown>) => baseToolDefinitions.find((d) => d.tool.function.name === name)!.handler(args as any, bare)
      expect(await call("read_file", { path: "x/in.txt" })).toBe("hi")
      expect(await call("ls", {})).toBe("x/")
    })
  })

  describe("read_file caps", () => {
    it("returns small files whole", async () => {
      put("s.txt", "a\nb\nc")
      expect(await run("read_file", { path: "s.txt" })).toBe("a\nb\nc")
    })
    it("honours offset and limit without a notice", async () => {
      put("s.txt", "a\nb\nc\nd")
      expect(await run("read_file", { path: "s.txt", offset: 2, limit: 2 })).toBe("b\nc")
      expect(await run("read_file", { path: "s.txt", limit: 1 })).toBe("a")
      expect(await run("read_file", { path: "s.txt", offset: 3 })).toBe("c\nd")
    })
    it("stops at 2000 lines and says how to read on", async () => {
      const total = TOOL_MAX_LINES + 50
      put("big.txt", Array.from({ length: total }, (_, i) => `l${i + 1}`).join("\n"))
      const out = await run("read_file", { path: "big.txt" })
      expect(out.endsWith(`[lines 1-${TOOL_MAX_LINES} of ${total} shown; read on with offset=${TOOL_MAX_LINES + 1}]`)).toBe(true)
      expect(out).toContain(`l${TOOL_MAX_LINES}\n`)
      expect(out).not.toContain(`l${TOOL_MAX_LINES + 1}\n`)
      const next = await run("read_file", { path: "big.txt", offset: TOOL_MAX_LINES + 1 })
      expect(next).toBe(`l${TOOL_MAX_LINES + 1}\n`.concat(Array.from({ length: 49 }, (_, i) => `l${TOOL_MAX_LINES + 2 + i}`).join("\n")))
    })
    it("stops at 30,000 characters", async () => {
      const line = "x".repeat(99)
      put("wide.txt", Array.from({ length: 1000 }, () => line).join("\n"))
      const out = await run("read_file", { path: "wide.txt" })
      expect(out).toMatch(/\[lines 1-\d+ of 1000 shown; read on with offset=\d+\]$/)
      expect(out.length).toBeLessThanOrEqual(TOOL_MAX_CHARS + 100)
    })
    it("cuts one enormous line to the cap", async () => {
      put("one.txt", "y".repeat(TOOL_MAX_CHARS * 2) + "\nnext")
      const out = await run("read_file", { path: "one.txt" })
      expect(out.startsWith("y".repeat(TOOL_MAX_CHARS))).toBe(true)
      expect(out).toContain("[lines 1-1 of 2 shown; read on with offset=2]")
    })
    it("refuses a binary file", async () => {
      put("b.bin", Buffer.from([1, 2, 0, 3]))
      expect(await run("read_file", { path: "b.bin" })).toBe("[binary file, 4 bytes; not shown]")
      expect(looksBinary(Buffer.from("text"))).toBe(false)
    })
  })

  describe("ls", () => {
    it("lists home sorted, dirs with slash, files with size, dotfiles included", async () => {
      put("b.txt", "12345")
      put("a/inner.txt", "x")
      put(".hidden", "")
      fs.symlinkSync(path.join(home, "gone"), path.join(home, "broken"))
      expect(await run("ls", {})).toBe([".hidden  0", "a/", "b.txt  5", "broken  0"].join("\n"))
    })
    it("lists a given subdirectory and reports an empty one", async () => {
      put("a/inner.txt", "xy")
      fs.mkdirSync(path.join(home, "empty"))
      expect(await run("ls", { path: "a" })).toBe("inner.txt  2")
      expect(await run("ls", { path: "empty" })).toBe("(empty)")
    })
    it("caps at 500 entries with a notice", async () => {
      for (let i = 0; i < 510; i++) fs.writeFileSync(path.join(home, `f${String(i).padStart(3, "0")}`), "")
      const out = (await run("ls", {})).split("\n")
      expect(out).toHaveLength(501)
      expect(out[500]).toBe("[500 of 510 entries shown; pass a subdirectory path to see the rest]")
    })
  })

  describe("glob", () => {
    it("defaults to home and ignores .git and node_modules", async () => {
      put("a.md", "")
      put(".git/x.md", "")
      put("node_modules/p/y.md", "")
      put("d/z.md", "")
      expect(await run("glob", { pattern: "**/*.md" })).toBe("a.md\nd/z.md")
    })
    it("honours cwd and caps at 500 with a notice", async () => {
      for (let i = 0; i < 505; i++) put(`m/f${String(i).padStart(3, "0")}.t`, "")
      const out = (await run("glob", { pattern: "*.t", cwd: "m" })).split("\n")
      expect(out).toHaveLength(501)
      expect(out[500]).toBe("[500 of 505 matches shown; narrow the pattern or cwd]")
    })
  })

  describe("grep", () => {
    it("defaults path to home, skips .git, node_modules and binary files", async () => {
      put("a.md", "needle here")
      put(".git/c", "needle")
      put("node_modules/p/i.js", "needle")
      put("bin.dat", Buffer.from("needle\0\0"))
      const out = await run("grep", { pattern: "needle" })
      expect(out).toBe(`${path.join(home, "a.md")}:1: needle here`)
    })
    it("ignore_case and relative path", async () => {
      put("d/a.md", "Needle")
      expect(await run("grep", { pattern: "needle", path: "d" })).toBe("")
      expect(await run("grep", { pattern: "needle", path: "d", ignore_case: true })).toContain("Needle")
    })
    it("files_only lists each matching file once", async () => {
      put("a.md", "n\nn\nn")
      put("b.md", "n")
      put("c.md", "zzz")
      expect(await run("grep", { pattern: "n", files_only: true })).toBe(`${path.join(home, "a.md")}\n${path.join(home, "b.md")}`)
    })
    it("caps at 100 matches with a notice", async () => {
      put("a.md", Array.from({ length: 150 }, () => "hit").join("\n"))
      put("b.md", "hit")
      const out = (await run("grep", { pattern: "hit" })).split("\n")
      expect(out).toHaveLength(101)
      expect(out[100]).toBe("[stopped at 100 matches; narrow the pattern or path]")
    })
    it("caps files_only at 100 files", async () => {
      for (let i = 0; i < 101; i++) put(`f${i}.md`, "hit")
      const out = (await run("grep", { pattern: "hit", files_only: true })).split("\n")
      expect(out).toHaveLength(101)
      expect(out[100]).toContain("stopped at 100")
    })
    it("cuts long lines at 500 characters", async () => {
      put("a.md", "hit" + "z".repeat(1000))
      const out = await run("grep", { pattern: "hit" })
      expect(out).toBe(`${path.join(home, "a.md")}:1: ${("hit" + "z".repeat(1000)).slice(0, 497)}...`)
    })
    it("shows context lines, searches a single file, and returns empty for a missing path", async () => {
      put("a.md", "x\nhit\ny\nz")
      expect(await run("grep", { pattern: "hit", path: "a.md", context_lines: 1 })).toBe(
        `-${path.join(home, "a.md")}:1: x\n${path.join(home, "a.md")}:2: hit\n-${path.join(home, "a.md")}:3: y`)
      expect(await run("grep", { pattern: "hit", path: "nope" })).toBe("")
    })
    it("include filters files", async () => {
      put("a.md", "hit")
      put("a.txt", "hit")
      expect(await run("grep", { pattern: "hit", include: "*.txt" })).toContain("a.txt")
    })
    it("skips unreadable files", async () => {
      put("a.md", "hit")
      fs.mkdirSync(path.join(home, "dir.md"))
      fs.symlinkSync(path.join(home, "nowhere"), path.join(home, "dead.md"))
      expect(await run("grep", { pattern: "hit" })).toContain("a.md")
    })
  })
})
