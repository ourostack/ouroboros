import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
// The tool registry loads first, as it does at runtime, so the guard and the tools see each other fully loaded.
import "../../repertoire/tools"
import { fileToolDefinitions } from "../../repertoire/tools-files"
import { editFileReadTracker, type ToolContext } from "../../repertoire/tools-base"
import { fileToolPath, guardInvocation, TACIT_REFUSAL } from "../../repertoire/guardrails"

// Spec R11.2: relative paths start at the bundle, or at a cwd the call names; a path that names nothing says where it looked.
const temps: string[] = []
function bundle(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-tools-cwd-")))
  temps.push(root)
  fs.mkdirSync(path.join(root, "psyche"))
  fs.mkdirSync(path.join(root, "notes"))
  fs.writeFileSync(path.join(root, "notes", "a.md"), "alpha\nbeta\n")
  fs.writeFileSync(path.join(root, "top.md"), "top\n")
  return root
}
afterEach(() => {
  for (const root of temps.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const handler = (name: string) => fileToolDefinitions.find((def) => def.tool.function.name === name)!.handler
const ctxFor = (agentRoot: string) => ({ agentRoot, agentName: "test" }) as unknown as ToolContext

describe("fileToolPath", () => {
  it("keeps an absolute path, and starts a relative one at cwd (itself from home) or at home", () => {
    expect(fileToolPath("/x/y", "notes", "/home")).toBe("/x/y")
    expect(fileToolPath("a.md", "notes", "/home")).toBe("/home/notes/a.md")
    expect(fileToolPath("a.md", "/repo", "/home")).toBe("/repo/a.md")
    expect(fileToolPath("a.md", undefined, "/home")).toBe("/home/a.md")
  })
})

describe("the guard checks the file the cwd points at", () => {
  const friend = { friendId: "f1", friendKind: "human" as const, trustLevel: "friend" as const, channel: "telegram" }

  it("refuses a friend turn's TACIT write reached through cwd, as it does the direct path", () => {
    const target = "/bundle/psyche/TACIT.md"
    const context = { readPaths: new Set([target]), agentRoot: "/bundle", ...friend }
    expect(guardInvocation("write_file", { path: target }, context)).toEqual({ allowed: false, reason: TACIT_REFUSAL })
    for (const tool of ["write_file", "edit_file"]) {
      expect(guardInvocation(tool, { cwd: "psyche", path: "TACIT.md" }, context), tool).toEqual({ allowed: false, reason: TACIT_REFUSAL })
    }
  })

  it("lets a relative path elsewhere through, and leaves calls without a cwd as they were", () => {
    const target = "/repo/src/a.ts"
    expect(guardInvocation("write_file", { cwd: "/repo", path: "src/a.ts" }, { readPaths: new Set([target]), agentRoot: "/bundle" })).toEqual({ allowed: true })
    expect(guardInvocation("grep", { cwd: "/repo", pattern: "x" }, { readPaths: new Set(), agentRoot: "/bundle" })).toEqual({ allowed: true })
    expect(guardInvocation("write_file", { cwd: "", path: "/repo/b.ts" }, { readPaths: new Set(["/repo/b.ts"]), agentRoot: "/bundle" })).toEqual({ allowed: true })
    expect(guardInvocation("write_file", { cwd: "/repo", content: "x" } as Record<string, string>, { readPaths: new Set(), agentRoot: "/bundle" }).allowed).toBe(true)
  })

  it("refuses a cwd when no home is known to resolve it from", () => {
    const result = guardInvocation("read_file", { cwd: "notes", path: "a.md" }, { readPaths: new Set(), agentRoot: undefined })
    expect(result).toEqual({ allowed: false, reason: expect.stringContaining("no home is known") })
  })
})

describe("file tools take a cwd and say where they looked", () => {
  it("reads, writes and edits a relative path from cwd", async () => {
    const root = bundle()
    const ctx = ctxFor(root)
    expect(await handler("read_file")({ path: "a.md", cwd: "notes" }, ctx)).toBe("alpha\nbeta\n")
    expect(await handler("write_file")({ path: "b.md", cwd: "notes", content: "new\n" }, ctx)).toMatch(/^ok/)
    expect(fs.readFileSync(path.join(root, "notes", "b.md"), "utf8")).toBe("new\n")
    expect(editFileReadTracker.has(path.join(root, "notes", "a.md"))).toBe(true)
    expect(await handler("edit_file")({ path: "a.md", cwd: "notes", old_string: "beta", new_string: "gamma" }, ctx)).toContain("gamma")
    expect(fs.readFileSync(path.join(root, "notes", "a.md"), "utf8")).toBe("alpha\ngamma\n")
    expect(await handler("read_file")({ path: "top.md" }, ctx)).toBe("top\n")
  })

  it("names the absolute path tried when nothing is there", async () => {
    const root = bundle()
    const ctx = ctxFor(root)
    const missing = path.join(root, "notes", "nope.md")
    expect(await handler("read_file")({ path: "nope.md", cwd: "notes" }, ctx)).toBe(`error: no file at ${missing} (from the relative path nope.md) (code: not-found)`)
    expect(await handler("read_file")({ path: missing }, ctx)).toBe(`error: no file at ${missing} (code: not-found)`)
    expect(await handler("edit_file")({ path: "nope.md", cwd: "notes", old_string: "a", new_string: "b" }, ctx)).toBe(`error: no file at ${missing} (from the relative path nope.md) (code: not-found)`)
    expect(await handler("glob")({ pattern: "*.md", cwd: "gone" }, ctx)).toBe(`error: no folder at ${path.join(root, "gone")} (from the relative path gone) (code: not-found)`)
    expect(await handler("grep")({ pattern: "x", path: "nope.md", cwd: "notes" }, ctx)).toBe(`error: no file or folder at ${missing} (from the relative path nope.md) (code: not-found)`)
    expect(await handler("grep")({ pattern: "x", cwd: "gone" }, ctx)).toBe(`error: no file or folder at ${path.join(root, "gone")} (from the relative path gone) (code: not-found)`)
  })

  it("still throws a read error that isn't a missing file", async () => {
    const root = bundle()
    await expect(Promise.resolve().then(() => handler("read_file")({ path: "notes" }, ctxFor(root)))).rejects.toThrow(/EISDIR/u)
  })

  it("greps from cwd, with paths shown from home", async () => {
    const root = bundle()
    expect(await handler("grep")({ pattern: "alpha", cwd: "notes" }, ctxFor(root))).toBe("notes/a.md:1: alpha")
    expect(await handler("grep")({ pattern: "alpha", path: "a.md", cwd: "notes" }, ctxFor(root))).toBe("notes/a.md:1: alpha")
  })

  it("names a missing home as the folder it looked for when glob has no cwd", async () => {
    const root = path.join(bundle(), "missing-home")
    expect(await handler("glob")({ pattern: "*.md" }, ctxFor(root))).toBe(`error: no folder at ${root} (code: not-found)`)
    expect(await handler("grep")({ pattern: "x" }, ctxFor(root))).toBe(`error: no file or folder at ${root} (code: not-found)`)
  })
})
