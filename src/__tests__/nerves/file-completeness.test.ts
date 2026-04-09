import { describe, it, expect } from "vitest"

/**
 * Tests for the file completeness check (Rule 5).
 *
 * The check should:
 * 1. Flag production files with zero emitNervesEvent calls (fail)
 * 2. Exempt type-only files (only type/interface/enum, no function/class/const)
 * 3. Pass for files that have at least one emitNervesEvent call
 */

import { checkFileCompleteness, isTypeOnlyFile } from "../../nerves/coverage/file-completeness"

describe("file completeness (Rule 5)", () => {
  describe("isTypeOnlyFile", () => {
    it("returns true for file with only type/interface/enum declarations", () => {
      const source = `
export type Foo = { bar: string }
export interface Baz { qux: number }
export enum Status { Active, Inactive }
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns false for file with function declaration", () => {
      const source = `
export type Foo = { bar: string }
export function doSomething(): void {}
`
      expect(isTypeOnlyFile(source)).toBe(false)
    })

    it("returns false for file with const declaration", () => {
      const source = `
export type Foo = { bar: string }
export const VALUE = 42
`
      expect(isTypeOnlyFile(source)).toBe(false)
    })

    it("returns false for file with class declaration", () => {
      const source = `
export type Foo = { bar: string }
export class MyClass {}
`
      expect(isTypeOnlyFile(source)).toBe(false)
    })

    it("returns true for file with const-as-const declarations (type-equivalent frozen values)", () => {
      const source = `
export const PHASES = ["a", "b", "c"] as const
export type Phase = (typeof PHASES)[number]
export interface Config { phase: Phase }
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns false for file mixing const-as-const and regular const", () => {
      const source = `
export const PHASES = ["a", "b"] as const
export const VALUE = 42
`
      expect(isTypeOnlyFile(source)).toBe(false)
    })

    it("returns true for empty file", () => {
      expect(isTypeOnlyFile("")).toBe(true)
    })

    it("returns true for file with only const object declarations (schemas)", () => {
      const source = `
export const myTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: { name: "my_tool" },
}
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns true for file with only const array assembly", () => {
      const source = `
export const allDefs: ToolDef[] = [
  ...fileTools,
  ...shellTools,
]
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns true for file with const .map() derivation", () => {
      const source = `
export const tools = baseToolDefinitions.map((d) => d.tool)
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns true for file with const Set construction", () => {
      const source = `
export const LEVELS = new Set(["a", "b"])
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })

    it("returns true for file with const Map construction", () => {
      const source = `
const cache = new Map()
`
      expect(isTypeOnlyFile(source)).toBe(true)
    })
  })

  describe("checkFileCompleteness", () => {
    it("passes for file with emitNervesEvent call", () => {
      const files = new Map<string, string[]>([
        ["src/engine/core.ts", ["engine:engine.turn_start"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/engine/core.ts", 'emitNervesEvent({ component: "engine", event: "engine.turn_start" })'],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("pass")
      expect(result.missing).toHaveLength(0)
    })

    it("fails for production file with zero emitNervesEvent calls", () => {
      const files = new Map<string, string[]>([
        ["src/engine/core.ts", ["engine:engine.turn_start"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/engine/core.ts", 'emitNervesEvent({ component: "engine", event: "engine.turn_start" })'],
        ["src/engine/helper.ts", "export function helper() { return 42 }"],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("fail")
      expect(result.missing).toContain("src/engine/helper.ts")
    })

    it("exempts type-only file with zero calls", () => {
      const files = new Map<string, string[]>([
        ["src/engine/core.ts", ["engine:engine.turn_start"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/engine/core.ts", 'emitNervesEvent({ component: "engine", event: "engine.turn_start" })'],
        ["src/engine/types.ts", "export type Foo = { bar: string }\nexport interface Baz {}"],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("pass")
      expect(result.missing).toHaveLength(0)
    })

    it("exempts dispatch-pattern tool handler sub-modules", () => {
      const files = new Map<string, string[]>([
        ["src/repertoire/tools.ts", ["tools:tool.start"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/repertoire/tools.ts", 'emitNervesEvent({ component: "tools", event: "tool.start" })'],
        ["src/repertoire/tools-files.ts", "export function readFile() {}"],
        ["src/repertoire/tools-shell.ts", "export function runShell() {}"],
        ["src/repertoire/tools-memory.ts", "export function saveNote() {}"],
        ["src/repertoire/tools-bridge.ts", "export function manageBridge() {}"],
        ["src/repertoire/tools-session.ts", "export function querySession() {}"],
        ["src/repertoire/tools-continuity.ts", "export function queryEpisodes() {}"],
        ["src/repertoire/tools-surface.ts", "export function handleSurface() {}"],
        ["src/repertoire/tools-config.ts", "export function readConfig() {}"],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("pass")
      expect(result.missing).toHaveLength(0)
      expect(result.exempt).toContain("src/repertoire/tools-files.ts")
      expect(result.exempt).toContain("src/repertoire/tools-config.ts")
    })

    it("exempts CLI sub-modules dispatched through cli-exec.ts router", () => {
      const files = new Map<string, string[]>([
        ["src/heart/daemon/cli-exec.ts", ["daemon:daemon.cli_command"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/heart/daemon/cli-exec.ts", 'emitNervesEvent({ component: "daemon", event: "daemon.cli_command" })'],
        ["src/heart/daemon/cli-parse.ts", "export function parseOuroCommand() {}"],
        ["src/heart/daemon/cli-render.ts", "export function formatTable() {}"],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("pass")
      expect(result.missing).toHaveLength(0)
      expect(result.exempt).toContain("src/heart/daemon/cli-parse.ts")
      expect(result.exempt).toContain("src/heart/daemon/cli-render.ts")
    })

    it("exempts pure attachment helper modules whose callers own observability", () => {
      const files = new Map<string, string[]>([
        ["src/heart/attachments/materialize.ts", ["engine:engine.attachment_materialized"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/heart/attachments/materialize.ts", 'emitNervesEvent({ component: "engine", event: "engine.attachment_materialized" })'],
        ["src/heart/attachments/originals.ts", "export function originalStoragePath() {}"],
        ["src/heart/attachments/sources/index.ts", "export function getAttachmentSourceAdapter() {}"],
        ["src/heart/attachments/sources/cli-local-file.ts", "export function buildCliLocalFileAttachmentRecord() {}"],
      ])

      const result = checkFileCompleteness(files, fileContents)

      expect(result.status).toBe("pass")
      expect(result.missing).toHaveLength(0)
      expect(result.exempt).toContain("src/heart/attachments/originals.ts")
      expect(result.exempt).toContain("src/heart/attachments/sources/index.ts")
      expect(result.exempt).toContain("src/heart/attachments/sources/cli-local-file.ts")
    })

    it("returns pass when all files have events or are exempt", () => {
      const files = new Map<string, string[]>([
        ["src/a.ts", ["x:y"]],
        ["src/b.ts", ["x:z"]],
      ])
      const fileContents = new Map<string, string>([
        ["src/a.ts", 'emitNervesEvent({ component: "x", event: "y" })'],
        ["src/b.ts", 'emitNervesEvent({ component: "x", event: "z" })'],
      ])
      const result = checkFileCompleteness(files, fileContents)
      expect(result.status).toBe("pass")
    })
  })
})
