import type OpenAI from "openai"
import { beforeEach, describe, expect, it } from "vitest"
import {
  buildFindToolsSchema,
  buildToolCatalog,
  findToolsDefinition,
  findToolsNote,
  formatFindToolsReply,
  formatLoadedDoors,
  doorsFoundInHistory,
  loadedDoorNames,
  namesLoadedInHistory,
  partitionCatalog,
  recordFindTools,
} from "../../repertoire/tool-catalog"
import { emitNervesEvent } from "../../nerves/runtime"

const tool = (name: string, description = `${name} does things`): OpenAI.ChatCompletionFunctionTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties: {} } },
})

const tools = [tool("settle"), tool("shell"), tool("coding_spawn"), tool("coding_status"), tool("mail_send"), tool("mystery")]
const catalog = buildToolCatalog([
  { tool: tools[0]! },
  { tool: tools[1]!, ax: { group: "shell", when: "run a command", effect: "write", eager: true } },
  { tool: tools[2]!, ax: { group: "coding", when: "start a coding agent", effect: "write" } },
  { tool: tools[3]!, ax: { group: "coding", when: "check a coding agent", effect: "read" } },
  { tool: tools[4]!, ax: { group: "mail", when: "send mail", effect: "write" } },
])

describe("catalog deferral", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "repertoire", event: "repertoire.test_run", message: "catalog deferral", meta: { test: true } })
  })

  it("keeps eager doors, kept names and doors the catalog doesn't know, then find_tools, then loaded doors in load order", () => {
    const { active, deferred } = partitionCatalog(tools, catalog, ["mail_send", "coding_status", "nope"], new Set(["coding_spawn"]))
    expect(active.map((entry) => entry.function.name)).toEqual(["settle", "shell", "coding_spawn", "mystery", "find_tools", "mail_send", "coding_status"])
    expect(deferred.map((entry) => entry.function.name)).toEqual(["coding_status", "mail_send"])
  })

  it("adds no find_tools when nothing is deferred", () => {
    const { active, deferred } = partitionCatalog([tools[0]!, tools[1]!], catalog, [], new Set())
    expect(active.map((entry) => entry.function.name)).toEqual(["settle", "shell"])
    expect(deferred).toEqual([])
  })

  it("lists the held-back doors by catalog group in find_tools's description", () => {
    const schema = buildFindToolsSchema([tools[2]!, tools[3]!, tools[4]!], catalog)
    expect(schema.function.name).toBe("find_tools")
    expect(schema.function.description).toContain("coding: coding_spawn, coding_status; mail: mail_send")
    expect(schema.function.parameters).toMatchObject({ required: ["query"] })
    expect(buildFindToolsSchema([tool("orphan")], catalog).function.description).toContain("other: orphan")
  })

  it("reads back the doors a conversation already called or loaded, once each, in order", () => {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [
        { id: "f1", type: "function", function: { name: "find_tools", arguments: "{}" } },
        { id: "c1", type: "function", function: { name: "coding_status", arguments: "{}" } },
        { id: "s1", type: "function", function: { name: "shell", arguments: "{}" } },
      ] },
      { role: "tool", tool_call_id: "f1", content: formatLoadedDoors([tools[4]!, tools[3]!]) },
      { role: "tool", tool_call_id: "c1", content: formatLoadedDoors([tools[2]!]) },
      { role: "tool", tool_call_id: "s1", content: [{ type: "text", text: "ok" }] },
    ]
    expect(namesLoadedInHistory(messages, new Set(["mail_send", "coding_status", "coding_spawn"]))).toEqual(["coding_status", "mail_send"])
    expect(doorsFoundInHistory(messages)).toEqual(["mail_send", "coding_status"])
  })

  it("tags an empty find_tools reply with its error code", () => {
    expect(formatLoadedDoors([])).toContain("no-matching-tools")
  })

  it("carries find_tools's card with the same schema name", () => {
    expect(findToolsDefinition.tool.function.name).toBe("find_tools")
    expect(findToolsDefinition.ax.id).toBe("tool:find_tools")
  })

  it("records a find_tools search as counts only", () => {
    expect(() => recordFindTools({ query: "select:a,b", matched: 2, deferred: 9 })).not.toThrow()
    expect(() => recordFindTools({ query: "send mail", matched: 0, deferred: 9 })).not.toThrow()
  })

  it("puts a skill note after the loaded doors under its own header, and reads it back", () => {
    const note = "skill shelf documents this, in \"Removing\" (load_skill shelf for the whole skill):\n`shelf remove <id>`"
    expect(formatFindToolsReply([tool("mail_send")], "")).toBe(formatLoadedDoors([tool("mail_send")]))
    expect(formatFindToolsReply([], "")).toBe(formatLoadedDoors([]))
    const both = formatFindToolsReply([tool("mail_send", "send.\n\nreally")], note)
    expect(loadedDoorNames(both)).toEqual(["mail_send"])
    expect(findToolsNote(both)).toBe(`skills that document this job:\n${note}`)
    const alone = formatFindToolsReply([], note)
    expect(alone).toBe(`no held-back tool matched (try other words, or select:name1,name2 with a name from the find_tools list).\n\nskills that document this job:\n${note}`)
    expect(loadedDoorNames(alone)).toEqual([])
    expect(findToolsNote(alone)).toBe("")
    expect(findToolsNote(formatLoadedDoors([tool("mail_send", "a\n\nb")]))).toBe("")
  })

  it("never reads a list line in a skill note as a loaded door", () => {
    const reply = formatFindToolsReply([tool("mail_send")], "skill x documents this, in \"Y\" (load_skill x for the whole skill):\n- held_door(arg) example line")
    expect(loadedDoorNames(reply)).toEqual(["mail_send"])
    expect(namesLoadedInHistory([
      { role: "assistant", content: null, tool_calls: [{ id: "f", type: "function", function: { name: "find_tools", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "f", content: reply },
    ], new Set(["mail_send", "held_door"]))).toEqual(["mail_send"])
  })

  it("counts the skills a search found", () => {
    expect(() => recordFindTools({ query: "remove book", matched: 0, deferred: 9, skills: 1 })).not.toThrow()
  })
})
