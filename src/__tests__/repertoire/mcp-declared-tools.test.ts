import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeMcpView, shutdownMcpFixtures } from "./mcp-fixture"

const nervesEvents: Array<Record<string, unknown>> = []
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn((event: Record<string, unknown>) => { nervesEvents.push(event) }),
}))

import { declaredRiskProfile, loadDeclaredTools, parseDeclaredTools } from "../../repertoire/mcp-declared-tools"
import { mcpToolsAsDefinitions } from "../../repertoire/mcp-tools"
import { McpManager } from "../../repertoire/mcp-manager"

const FIXTURE = path.join(__dirname, "fixtures", "declared-tools", "tools.json")
const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"))
const served = (name: string, description = "served description") => ({ name, description, inputSchema: { type: "object", properties: { served: { type: "string" } } } })
const tool = (name: string, ax: Record<string, unknown>) => ({ type: "function", function: { name, description: "Does it.", parameters: { type: "object", properties: {} } }, ax })
const card = { group: "turn-x", when: "Pick this to do it.", effect: "write", errors: [] }

afterEach(shutdownMcpFixtures)
beforeEach(() => { nervesEvents.length = 0 })

describe("parseDeclaredTools", () => {
  it("reads every tool of a tools.json written by ouro-actions-tools, with its card", () => {
    const { tools, problems } = parseDeclaredTools(fixture)
    expect(problems).toEqual([])
    expect([...tools.keys()]).toEqual(["get_shopping_list", "add_shopping_list_item", "remove_shopping_list_item", "share_shopping_list"])
    const share = tools.get("share_shopping_list")!
    expect(share.description).toBe(fixture.tools[3].function.description)
    expect(share.parameters).toEqual(fixture.tools[3].function.parameters)
    expect(share.ax).toEqual({ ...fixture.tools[3].ax, id: "tool:share_shopping_list" })
    expect(tools.get("get_shopping_list")!.ax.idempotent).toBe(true)
    expect(tools.get("remove_shopping_list_item")!.ax.destructive).toBe(true)
  })

  it("leaves out an entry that isn't a whole declaration, saying why, so its tool stays undeclared", () => {
    const { tools, problems } = parseDeclaredTools({ tools: [
      null,
      { type: "function", function: { name: "" } },
      { type: "function", function: { name: "a", description: "two\nlines", parameters: { type: "object" } }, ax: card },
      { type: "function", function: { name: "b", description: "B.", parameters: { type: "array" } }, ax: card },
      { type: "function", function: { name: "c", description: "C.", parameters: { type: "object" } } },
      tool("d", { ...card, effect: undefined }),
      tool("e", { ...card, effect: "maybe" }),
      tool("f", { ...card, when: "" }),
      tool("g", { ...card, group: undefined }),
      tool("h", { ...card, errors: "none" }),
      tool("i", { ...card, errors: [{ code: "x", means: "y" }] }),
      tool("j", { ...card, effect: "consequential" }),
      tool("ok", card),
      tool("ok", card),
    ] })
    expect([...tools.keys()]).toEqual(["ok"])
    expect(problems).toEqual([
      "an entry is not a function tool with a name",
      "an entry is not a function tool with a name",
      "a: no one-line description",
      "b: parameters is not an object schema",
      "c: no ax card",
      "d: the card has no effect",
      "e: the card has no effect",
      "f: the card has no when line",
      "g: the card has no group",
      "h: the card's errors are not { code, means, fix } lines",
      "i: the card's errors are not { code, means, fix } lines",
      "j: a consequential card has no confirm question",
      "ok: declared twice",
    ])
    expect(tools.get("ok")!.ax).toEqual({ id: "tool:ok", group: "turn-x", when: "Pick this to do it.", effect: "write", errors: [] })
  })

  it("has nothing to read without a tools list", () => {
    expect(parseDeclaredTools([]).problems).toEqual(["it has no tools list"])
    expect(parseDeclaredTools({ tools: {} }).tools.size).toBe(0)
  })
})

describe("loadDeclaredTools", () => {
  let root: string
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-tools-"))
    fs.mkdirSync(path.join(root, "mcp"))
    fs.copyFileSync(FIXTURE, path.join(root, "mcp", "tools.json"))
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it("reads a path inside the bundle, relative or absolute", () => {
    expect(loadDeclaredTools(root, "mcp/tools.json", "shop")!.size).toBe(4)
    expect(loadDeclaredTools(root, path.join(root, "mcp", "tools.json"), "shop")!.size).toBe(4)
    expect(nervesEvents).toEqual([])
  })

  it("refuses a path outside the bundle, and a file it can't read, with a warning", () => {
    expect(loadDeclaredTools(root, "../elsewhere/tools.json", "shop")).toBeNull()
    expect(loadDeclaredTools(root, "mcp/missing.json", "shop")).toBeNull()
    fs.writeFileSync(path.join(root, "mcp", "bad.json"), "{")
    expect(loadDeclaredTools(root, "mcp/bad.json", "shop")).toBeNull()
    expect(nervesEvents.map((e) => [e.event, (e.meta as { reason: string }).reason.slice(0, 40)])).toEqual([
      ["mcp.declared_tools_unreadable", "the tools path is outside the agent bund"],
      ["mcp.declared_tools_unreadable", expect.stringContaining("ENOENT")],
      ["mcp.declared_tools_unreadable", expect.any(String)],
    ])
  })

  it("warns about the entries it left out and keeps the rest", () => {
    fs.writeFileSync(path.join(root, "mcp", "part.json"), JSON.stringify({ tools: [tool("ok", card), tool("bad", { ...card, effect: undefined })] }))
    expect([...loadDeclaredTools(root, "mcp/part.json", "shop")!.keys()]).toEqual(["ok"])
    expect(nervesEvents).toEqual([expect.objectContaining({ event: "mcp.declared_tools_incomplete", meta: { server: "shop", problems: ["bad: the card has no effect"] } })])
  })
})

describe("declaredRiskProfile", () => {
  it("is low only for a declared read", () => {
    expect(declaredRiskProfile("read")).toMatchObject({ mutates: "none", risk: "low" })
    expect(declaredRiskProfile("write")).toMatchObject({ mutates: "durable_state_write", risk: "high" })
    expect(declaredRiskProfile("consequential")).toMatchObject({ mutates: "external_side_effect", risk: "high" })
  })
})

describe("declared tools on a bundle's MCP server", () => {
  const declared = parseDeclaredTools(fixture).tools

  it("surfaces each served tool with the declared description, parameters and card, and the served schema in its binding", () => {
    const view = makeMcpView([{ server: "shop", tools: [served("get_shopping_list"), served("share_shopping_list"), served("place_grocery_order")], declared } as never])
    const defs = mcpToolsAsDefinitions(view)
    const get = defs.find((d) => d.tool.function.name === "shop_get_shopping_list")!
    expect(get.tool.function.description).toBe(fixture.tools[0].function.description)
    expect(get.tool.function.parameters).toEqual(fixture.tools[0].function.parameters)
    expect(get.ax).toEqual({ ...fixture.tools[0].ax, id: "tool:shop_get_shopping_list" })
    expect(get.riskProfile).toMatchObject({ mutates: "none", risk: "low" })
    const share = defs.find((d) => d.tool.function.name === "shop_share_shopping_list")!
    expect(share.ax!.confirm).toBe(fixture.tools[3].ax.confirm)
    expect(share.riskProfile).toMatchObject({ risk: "high", mutates: "external_side_effect" })
    expect(share.approvalPolicy!({})).toEqual({ kind: "required", policyId: "mcp.declared.consequential.v1", actionClass: "mcp.shop.share_shopping_list", requiresSoleCall: true })
    expect(get.approvalPolicy).toBeUndefined()
    expect(get.mcpBinding!.surfacedName).toBe("shop_get_shopping_list")
    // A served tool the declaration doesn't name stays as every MCP tool is: the card made from what its server says, high risk.
    const order = defs.find((d) => d.tool.function.name === "shop_place_grocery_order")!
    expect(order.ax).toMatchObject({ id: "tool:shop_place_grocery_order", group: "mcp:shop", effect: "write" })
    expect(order.tool.function.description).toBe("served description")
    expect(order.riskProfile).toMatchObject({ risk: "high" })
  })

  it("warns when the bundle declares a tool its server doesn't serve, and doesn't surface it", () => {
    const view = makeMcpView([{ server: "shop", tools: [served("get_shopping_list")], declared } as never])
    expect(mcpToolsAsDefinitions(view).map((d) => d.tool.function.name)).toEqual(["shop_get_shopping_list"])
    expect(nervesEvents).toContainEqual(expect.objectContaining({
      event: "mcp.declared_tool_unserved", meta: { server: "shop", missing: ["add_shopping_list_item", "remove_shopping_list_item", "share_shopping_list"] },
    }))
  })

  it("never surfaces a tool the bundle declares person-only", () => {
    const personOnly = parseDeclaredTools({ tools: [tool("pay", { ...card, effect: "person-only" })] }).tools
    const view = makeMcpView([{ server: "shop", tools: [served("pay")], declared: personOnly } as never])
    expect(mcpToolsAsDefinitions(view)).toEqual([])
  })
})

describe("McpManager reads the declaration for the bundle's own servers", () => {
  it("attaches it to the frozen view of a builtin server with tools, and to no other", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "declared-view-"))
    try {
      fs.copyFileSync(FIXTURE, path.join(root, "tools.json"))
      const manager = new McpManager()
      const owner = { agentName: "a", agentRoot: root }
      const entry = (name: string, source: string, tools?: string) => ({
        owner, name, source, config: { command: "x", ...(tools ? { tools } : {}) },
        client: { shutdown: () => undefined }, cachedTools: [served("get_shopping_list")], configDigest: "d", generation: 1, consecutiveFailures: 0,
      })
      const internals = manager as unknown as { servers: Map<string, unknown>; desiredGenerations: Map<string, number>; freezeView(o: typeof owner): { entries: Array<{ server: string; declared?: Map<string, unknown> }> } }
      for (const e of [entry("own", "builtin", "tools.json"), entry("bare", "builtin"), entry("plug", "plugin", "tools.json")]) {
        const key = JSON.stringify([owner.agentName, owner.agentRoot, e.name])
        internals.servers.set(key, e)
        internals.desiredGenerations.set(key, 1)
      }
      const view = internals.freezeView(owner)
      expect(view.entries.map((e) => [e.server, e.declared?.size])).toEqual([["own", 4], ["bare", undefined], ["plug", undefined]])
      internals.servers.clear()
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
