import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { nervesEvents } = vi.hoisted(() => ({ nervesEvents: [] as Array<Record<string, unknown>> }))
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => { nervesEvents.push(event) }),
}))

import { MAILBOX_CLI_WORDS } from "../../../heart/daemon/cli-parse"
import {
  MailboxDoorError,
  getToolSchemas,
  listTools,
  mailboxCliDeclarations,
  mailboxMcpSchema,
  mailboxMcpSchemas,
  readMailboxDoors,
  resetMailboxDoorsForTest,
  runMailboxAction,
} from "../../../heart/letters/doors"
import { declaredToolSchema, mailboxToolDefinitions } from "../../../heart/letters/doors-tools"

const root = path.resolve(__dirname, "../../../..")
const generated = (file: string) => JSON.parse(fs.readFileSync(path.join(root, "actions/generated", file), "utf8"))
const temps: string[] = []

function fakeRoot(files: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c21-doors-"))
  temps.push(dir)
  for (const [file, json] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, "actions/generated", path.dirname(file)), { recursive: true })
    fs.writeFileSync(path.join(dir, "actions/generated", file), typeof json === "string" ? json : JSON.stringify(json))
  }
  return dir
}

beforeEach(() => {
  nervesEvents.length = 0
  resetMailboxDoorsForTest()
})
afterEach(() => {
  resetMailboxDoorsForTest()
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("the mailbox group's generated doors", () => {
  it("reads every door from the generated files, not from a hand copy", () => {
    const doors = readMailboxDoors()
    expect(doors.commands).toEqual(generated("mailbox/commands.json").commands)
    expect(doors.mcpTools).toEqual(generated("mailbox/mcp.json").tools)
    expect(doors.actions).toEqual(generated("mailbox/actions.json").actions)
    expect([...doors.tools.keys()]).toEqual(generated("mailbox-tools/tools.json").tools.map((t: { function: { name: string } }) => t.function.name))
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.doors_loaded", meta: { commands: 1, mcp: 1, tools: 1 } }))
  })

  it("reads the files once and serves the same doors after", () => {
    const first = readMailboxDoors()
    expect(readMailboxDoors()).toBe(first)
  })

  it("holds the parser's word table (in cli-parse, where the census reads it) to the generated commands", () => {
    const fromGenerated = Object.fromEntries(
      generated("mailbox/commands.json").commands.map((c: { name: string }) => [c.name.replace(/^mailbox /, ""), generated("mailbox/actions.json").actions.find((a: { cli: string }) => a.cli === c.name).id]),
    )
    expect(MAILBOX_CLI_WORDS).toEqual(fromGenerated)
  })

  it("fails loudly when a generated file is missing or has drifted out of shape", () => {
    expect(() => readMailboxDoors(fakeRoot({}))).toThrow(/actions\/generated\/mailbox\/commands\.json/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": "{", "mailbox/mcp.json": {}, "mailbox-tools/tools.json": {} }))).toThrow(/commands\.json/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: "x" }, "mailbox-tools/tools.json": { tools: [] } }))).toThrow(/mcp\.json has no tools list/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: 1 }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] } }))).toThrow(/commands\.json has no commands list/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [{ type: "function" }] } }))).toThrow(/tools\.json: an entry is not a function tool/)
    expect(() => readMailboxDoors(fakeRoot({ "mailbox/commands.json": { commands: [] }, "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": {} }))).toThrow(/actions\.json has no actions list/)
  })

  it("refuses a generated command no generated action names as its cli", () => {
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [{ name: "mailbox stray", summary: "s", effect: "private", output: "o" }] },
      "mailbox/mcp.json": { tools: [] }, "mailbox-tools/tools.json": { tools: [] }, "mailbox/actions.json": { actions: [] },
    }))
    expect(() => mailboxCliDeclarations()).toThrow(/mailbox stray.*no action/)
  })
})

describe("mailbox_list before the letters store exists", () => {
  it("returns an empty pile with outcome done", () => {
    expect(runMailboxAction("mailbox_list", {})).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.action_run", meta: { action: "mailbox_list", outcome: "done" } }))
  })

  it("refuses an input it doesn't take, by its card's code", () => {
    const error = (() => { try { runMailboxAction("mailbox_list", { all: true }); return null } catch (e) { return e } })()
    expect(error).toBeInstanceOf(MailboxDoorError)
    expect((error as MailboxDoorError).code).toBe("unknown-input")
    expect((error as Error).message).toContain("all")
  })

  it("refuses an action the group doesn't have", () => {
    expect(() => runMailboxAction("mailbox_frobnicate", {})).toThrow(expect.objectContaining({ code: "unknown-door" }))
  })
})

describe("each door's projection", () => {
  it("gives the CLI a declaration with the generated summary and a card in the mailbox group", () => {
    const [list, group] = mailboxCliDeclarations()
    const command = generated("mailbox/commands.json").commands[0]
    expect(list).toEqual({
      name: "mailbox list", effect: "private", readOnly: true, summary: command.summary, example: "mailbox list --json",
      ax: expect.objectContaining({ id: "cli:mailbox list", group: "mailbox", effect: "read", idempotent: true, when: expect.stringMatching(/^From a shell, pick this to see /) }),
    })
    expect(list!.ax!.errors.map((e) => e.code)).toEqual(["unknown-flag"])
    expect(group).toEqual(expect.objectContaining({ name: "mailbox", readOnly: true, ax: expect.objectContaining({ id: "cli:mailbox", group: "mailbox", effect: "read" }) }))
  })

  it("gives each door its own when line, so the census never reads two as one door", () => {
    const whens = [mailboxCliDeclarations()[0]!.ax!.when, mailboxMcpSchemas()[0]!.ax.when, mailboxToolDefinitions()[0]!.ax!.when]
    expect(new Set(whens).size).toBe(3)
    expect(whens[2]).toBe(generated("mailbox-tools/tools.json").tools[0].ax.when)
  })

  it("carries a write action's card and command as generated, with no read-only or idempotent claim", () => {
    const declared = generated("mailbox-tools/tools.json").tools[0]
    const { idempotent: _idempotent, ...writeCard } = declared.ax
    readMailboxDoors(fakeRoot({
      "mailbox/commands.json": { commands: [{ name: "mailbox file", summary: "File a letter.", effect: "others", output: "{ outcome }" }] },
      "mailbox/mcp.json": { tools: [] },
      "mailbox-tools/tools.json": { tools: [{ ...declared, function: { ...declared.function, name: "mailbox_file" }, ax: { ...writeCard, id: "tool:mailbox_file", effect: "write" } }] },
      "mailbox/actions.json": { actions: [{ id: "mailbox_file", cli: "mailbox file" }] },
    }))
    const [file] = mailboxCliDeclarations()
    expect(file).not.toHaveProperty("readOnly")
    expect(file!.ax).not.toHaveProperty("idempotent")
    expect(file!.ax!.effect).toBe("write")
  })

  it("gives the MCP server one generated tool by name, and fails loudly on a name mcp.json lacks", () => {
    expect(mailboxMcpSchema("mailbox_list")).toEqual(mailboxMcpSchemas()[0])
    expect(() => mailboxMcpSchema("mailbox_gone")).toThrow(/mcp\.json has no tool mailbox_gone/)
  })

  it("builds an in-turn schema only from the declared tool it is given", () => {
    const declared = readMailboxDoors().tools.get("mailbox_list")!
    expect(declaredToolSchema("mailbox", "mailbox_list", declared as never)).toEqual({ type: "function", function: { name: "mailbox_list", description: declared.description, parameters: declared.parameters } })
  })

  it("gives the MCP server the generated tool, with its card as an mcp door", () => {
    const [schema] = mailboxMcpSchemas()
    const tool = generated("mailbox/mcp.json").tools[0]
    expect(schema).toEqual({
      name: "mailbox_list", description: tool.description, inputSchema: tool.inputSchema,
      ax: expect.objectContaining({ id: "mcp:mailbox_list", group: "mailbox", effect: "read", idempotent: true, when: expect.stringMatching(/^From a coding tool, pick this to see /) }),
    })
    expect(schema!.ax.errors.map((e) => e.code)).toEqual(["unknown-input"])
  })

  it("gives the in-turn registry a definition that runs the action", async () => {
    const [definition] = mailboxToolDefinitions()
    const declared = generated("mailbox-tools/tools.json").tools[0]
    expect(definition!.tool).toEqual({ type: "function", function: declared.function })
    expect(definition!.ax).toEqual({ ...declared.ax, id: "tool:mailbox_list" })
    expect(definition!.riskProfile).toEqual(expect.objectContaining({ mutates: "none" }))
    expect(JSON.parse(await definition!.handler({}))).toEqual({ outcome: "done", count: 0, listing: "" })
    expect(nervesEvents).toContainEqual(expect.objectContaining({ event: "mailbox.tools_registered", meta: { tools: 1 } }))
  })

  it("serves the declared tools for the census as the generated MCP tools list them", () => {
    expect(getToolSchemas()).toEqual(generated("mailbox/mcp.json").tools.map((t: Record<string, unknown>) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })))
    expect(listTools()).toEqual(getToolSchemas())
  })
})
