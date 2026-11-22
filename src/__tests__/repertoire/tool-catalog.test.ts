import { beforeEach, describe, expect, it } from "vitest"
import type OpenAI from "openai"
import { buildToolCatalog, catalogDoor, formatLoadedDoors, loadedDoorNames, searchCatalog, TURN_TOOL_NAMES, type CatalogSource } from "../../repertoire/tool-catalog"
import { emitNervesEvent } from "../../nerves/runtime"

const tool = (name: string, description = ""): OpenAI.ChatCompletionFunctionTool =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties: {} } } })

describe("tool catalog", () => {
  beforeEach(() => {
    emitNervesEvent({ component: "repertoire", event: "repertoire.test_run", message: "tool catalog unit test", meta: { test: true } })
  })

  it("reads group, when, effect and eager from the door's card", () => {
    expect(catalogDoor({ tool: tool("mail_send"), ax: { group: "turn-mail", when: "Pick this to send a draft.", effect: "consequential" } }))
      .toEqual({ name: "mail_send", group: "turn-mail", when: "Pick this to send a draft.", effect: "consequential", eager: false })
    expect(catalogDoor({ tool: tool("shell"), ax: { group: "turn-shell", when: "Run a command.", effect: "write", eager: true } }).eager).toBe(true)
  })

  it("keeps the engine's turn tools eager even without a card", () => {
    for (const name of ["settle", "ponder", "observe", "rest", "speak", "surface"]) {
      expect(TURN_TOOL_NAMES.has(name)).toBe(true)
      expect(catalogDoor({ tool: tool(name, "end the turn") }).eager).toBe(true)
    }
  })

  it("files a cardless MCP tool under its server, with its description's first sentence as when", () => {
    const door = catalogDoor({ tool: tool("media_search", "Search or browse the media catalogue. Use query for a title."), mcpServer: "media" })
    expect(door).toEqual({ name: "media_search", group: "mcp:media", when: "Search or browse the media catalogue.", effect: "write", eager: false })
  })

  it("files a cardless tool with no server under other, and clips a long when line", () => {
    const long = `${"word ".repeat(60)}end`
    const door = catalogDoor({ tool: tool("bare", long) })
    expect(door.group).toBe("other")
    expect(door.when.length).toBe(200)
    expect(door.when.endsWith("…")).toBe(true)
    expect(catalogDoor({ tool: { type: "function", function: { name: "nodesc" } } as OpenAI.ChatCompletionFunctionTool }).when).toBe("")
  })

  it("lists each used group once, with its census when line or none", () => {
    const sources: CatalogSource[] = [
      { tool: tool("a"), ax: { group: "g1", when: "a", effect: "read" } },
      { tool: tool("b"), ax: { group: "g1", when: "b", effect: "read" } },
      { tool: tool("c"), ax: { group: "g2", when: "c", effect: "read" } },
    ]
    const catalog = buildToolCatalog(sources, [{ id: "g1", when: "Group one." }, { id: "unused", when: "x" }])
    expect(catalog.groups).toEqual([{ id: "g1", when: "Group one." }, { id: "g2", when: "" }])
    expect(catalog.doors.map((door) => door.name)).toEqual(["a", "b", "c"])
    expect(buildToolCatalog([]).groups).toEqual([])
  })

  describe("search", () => {
    const sources: CatalogSource[] = [
      { tool: tool("coding_spawn", "start a coding agent"), ax: { group: "turn-coding", when: "Hand coding work to a worker.", effect: "write" } },
      { tool: tool("coding_status", "check a coding agent"), ax: { group: "turn-coding", when: "See how a worker is doing.", effect: "read" } },
      { tool: tool("weather_lookup", "forecast"), ax: { group: "turn-travel", when: "Check the weather somewhere.", effect: "read" } },
      { tool: tool("trip_upsert", "save a trip"), ax: { group: "turn-travel", when: "Save a booked trip.", effect: "write" } },
      { tool: tool("loose", "no card at all") },
    ]
    const catalog = buildToolCatalog(sources, [{ id: "turn-travel", when: "Help with travel: flights and hotels." }])
    const candidates = sources.map((source) => source.tool)

    it("loads exact names with select:, ignoring names it can't offer", () => {
      expect(searchCatalog(catalog, candidates, "select: trip_upsert, nope, trip_upsert")).toEqual(["trip_upsert"])
      expect(searchCatalog(catalog, candidates, "SELECT:loose")).toEqual(["loose"])
    })

    it("ranks a name match over a when match over a group match", () => {
      expect(searchCatalog(catalog, candidates, "weather")[0]).toBe("weather_lookup")
      expect(searchCatalog(catalog, candidates, "worker")).toEqual(["coding_spawn", "coding_status"])
      expect(searchCatalog(catalog, candidates, "hotels")).toEqual(["weather_lookup", "trip_upsert"])
      expect(searchCatalog(catalog, candidates, "card")).toEqual(["loose"])
      expect(searchCatalog(catalog, candidates, "spaw")).toEqual(["coding_spawn"])
      expect(searchCatalog(catalog, candidates, "coding_spawn")[0]).toBe("coding_spawn")
    })

    it("returns nothing for an empty or stopword-only query", () => {
      expect(searchCatalog(catalog, candidates, "")).toEqual([])
      expect(searchCatalog(catalog, candidates, "please use the tool")).toEqual([])
    })

    it("searches a door the catalog doesn't know by its description", () => {
      expect(searchCatalog(catalog, [...candidates, tool("stray", "polish the silverware")], "silverware")).toEqual(["stray"])
      const bare = { type: "function", function: { name: "bare_door" } } as OpenAI.ChatCompletionFunctionTool
      expect(searchCatalog(catalog, [...candidates, bare], "bare")).toEqual(["bare_door"])
    })
  })

  describe("loaded doors", () => {
    const withArgs: OpenAI.ChatCompletionFunctionTool = { type: "function", function: { name: "mail_send", description: "send a draft", parameters: { type: "object", properties: { draft: {}, note: {} }, required: ["draft"] } } }

    it("lists each loaded door with its arguments, required ones bare and optional ones marked", () => {
      expect(formatLoadedDoors([withArgs, tool("ping")])).toBe("loaded; callable on your next step:\n- mail_send(draft, note?): send a draft\n- ping(): ")
      expect(formatLoadedDoors([{ type: "function", function: { name: "np" } } as OpenAI.ChatCompletionFunctionTool])).toBe("loaded; callable on your next step:\n- np(): ")
    })

    it("says how to search again when nothing matched", () => {
      expect(formatLoadedDoors([])).toContain("no matching tools")
      expect(loadedDoorNames(formatLoadedDoors([]))).toEqual([])
    })

    it("reads the loaded names back from the reply, and nothing from other text", () => {
      expect(loadedDoorNames(formatLoadedDoors([withArgs, tool("ping")]))).toEqual(["mail_send", "ping"])
      expect(loadedDoorNames("- mail_send(draft): not a loaded reply")).toEqual([])
      expect(loadedDoorNames(`${formatLoadedDoors([tool("ping")])}\nsee also the mail tools`)).toEqual(["ping"])
    })
  })
})
