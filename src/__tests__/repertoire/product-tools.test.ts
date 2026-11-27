import { afterEach, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { loadProduct, PRODUCT_SEAM_VERSION } from "../../heart/product/active"
import type { OuroProduct, ProductToolSelectionInput } from "../../heart/product/types"
import { executeTool, registeredToolDefinitions, selectToolsForChannel, ToolSelectionError, type ToolContext, type ToolDefinition } from "../../repertoire/tools"

/** Core's side of a product's tools (J3), with a fixture product: registration, selection, and the dispatcher's `authorize`. */
const PATH = "/opt/example/dist/product.js"

function probe(name: string, authorize?: ToolDefinition["authorize"]) {
  const handler = vi.fn(async () => `${name} ran`)
  const definition: ToolDefinition = {
    tool: { type: "function", function: { name, description: "a fixture tool", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } } },
    ax: { id: `tool:${name}`, group: "turn-files", when: "Never: a fixture.", effect: "read", errors: [] },
    handler,
    ...(authorize ? { authorize } : {}),
  }
  return { definition, handler }
}

function useProduct(tools: NonNullable<OuroProduct["tools"]>): void {
  loadProduct(PATH, () => ({ product: { seamVersion: PRODUCT_SEAM_VERSION, id: "example", agents: ["helper"], tools } }))
}

function select(channel: string, context: Partial<ToolContext> = {}) {
  return selectToolsForChannel(getChannelCapabilities(channel as never), undefined, undefined, undefined, undefined, undefined, { agentName: "helper", agentRoot: "/bundles/helper.ouro", ...context } as ToolContext)
}

const names = (selection: { ordinary: readonly ToolDefinition[] }) => selection.ordinary.map((definition) => definition.tool.function.name)

afterEach(() => { loadProduct(undefined) })

describe("a product's tools", () => {
  it("are registered while the product is loaded, and offered only when its selection returns them", () => {
    const { definition } = probe("helper_probe")
    expect(registeredToolDefinitions()).not.toContain(definition)
    useProduct({ definitions: [definition] })
    expect(registeredToolDefinitions()).toContain(definition)
    expect(names(select("inner"))).not.toContain("helper_probe")
    useProduct({ definitions: [definition], select: () => [definition] })
    expect(names(select("inner"))).toContain("helper_probe")
    expect(names(selectToolsForChannel(getChannelCapabilities("inner"), undefined, undefined, undefined, undefined, undefined, { agentName: "slugger" }))).not.toContain("helper_probe")
  })

  it("collide with core's tools at selection", () => {
    const { definition } = probe("read_file")
    useProduct({ definitions: [definition] })
    expect(() => select("cli")).toThrow(ToolSelectionError)
  })

  it("may add core's own registered tools, and copies of the product's with the same handler, but nothing else", () => {
    const { definition } = probe("helper_probe")
    const seen: ProductToolSelectionInput[] = []
    useProduct({ definitions: [definition], select: (input) => { seen.push(input); return [input.registered("read_file")!, Object.freeze({ ...definition })] } })
    expect(names(select("inner")).slice(-3)).toEqual(["read_file", "helper_probe", "surface"])
    expect(seen[0]).toMatchObject({ channel: "inner", relationshipScoped: false, context: { agentName: "helper" } })
    expect(seen[0]!.registered("no_such_tool")).toBeUndefined()
    const stranger = probe("helper_probe").definition
    useProduct({ definitions: [definition], select: () => [stranger] })
    expect(() => select("inner")).toThrow("the product selected a tool that isn't registered: helper_probe")
    useProduct({ definitions: [definition], select: () => [probe("unlisted").definition] })
    expect(() => select("inner")).toThrow(ToolSelectionError)
  })

  it("scope the agent's remote and relationship turns to a relationship when the product says so", () => {
    useProduct({ definitions: [] })
    expect(select("telegram").ordinary.length).toBeGreaterThan(0)
    useProduct({ definitions: [], relationshipScoped: true })
    expect(select("telegram").ordinary).toEqual([])
    expect(select("cli").ordinary.length).toBeGreaterThan(0)
    const relationshipAuthorization = { profileId: "household", authorizedContextScopes: [], advertisedToolNames: ["read_file"], authorizeTool: vi.fn() }
    expect(select("cli", { relationshipAuthorization } as never).ordinary).toEqual([])
  })

  it("re-select a relationship turn's tools at dispatch for a relationship-scoped product", async () => {
    useProduct({ definitions: [], relationshipScoped: true })
    const authorizeTool = vi.fn(async () => ({ allowed: true as const, receiptId: "r", profileVersion: 1 }))
    const ctx = { signin: async () => undefined, agentName: "helper", agentRoot: "/bundles/helper.ouro", toolSelection: select("cli"),
      relationshipAuthorization: { profileId: "household", authorizedContextScopes: [], advertisedToolNames: ["read_file"], authorizeTool } } as unknown as ToolContext
    // Unscoped when selected, but the dispatcher's fresh selection for this relationship has no tools, so the call is refused.
    const outcome = await executeTool("read_file", { path: "/bundles/helper.ouro/agent.json" }, ctx)
    expect(outcome).toMatchObject({ kind: "rejected_before_handler", text: expect.stringContaining("(code: tool-changed)") })
  })
})

describe("a tool's own authorize", () => {
  it("rejects the call before the handler, and the dispatcher doesn't also ask the relationship", async () => {
    const authorize = vi.fn(async () => { throw new Error("not this turn (code: probe-denied)") })
    const { definition, handler } = probe("guarded_probe", authorize)
    useProduct({ definitions: [definition], select: () => [definition] })
    const authorizeTool = vi.fn(async () => ({ allowed: true as const, receiptId: "r", profileVersion: 1 }))
    const ctx = { signin: async () => undefined, agentName: "helper", agentRoot: "/bundles/helper.ouro",
      relationshipAuthorization: { profileId: "owner", authorizedContextScopes: [], advertisedToolNames: ["guarded_probe"], authorizeTool } } as unknown as ToolContext
    ctx.toolSelection = select("inner", ctx)
    // The selection keeps the definition itself, so an authorization can be bound to it.
    expect(ctx.toolSelection.ordinary).toContain(definition)
    const outcome = await executeTool("guarded_probe", { value: "x" }, ctx)
    expect(outcome).toEqual({ kind: "rejected_before_handler", text: "rejected: not this turn (code: probe-denied)", error: expect.any(Error) })
    expect(authorize).toHaveBeenCalledWith(ctx, { value: "x" })
    expect(handler).not.toHaveBeenCalled()
    expect(authorizeTool).not.toHaveBeenCalled()
  })

  it("is asked only after the arguments match the schema", async () => {
    const authorize = vi.fn(async () => undefined)
    const { definition, handler } = probe("guarded_probe", authorize)
    useProduct({ definitions: [definition], select: () => [definition] })
    const ctx = { signin: async () => undefined, agentName: "helper", agentRoot: "/bundles/helper.ouro" } as ToolContext
    ctx.toolSelection = select("inner", ctx)
    expect(await executeTool("guarded_probe", {}, ctx)).toMatchObject({ kind: "rejected_before_handler", text: expect.stringContaining("(code: invalid-arguments)") })
    expect(authorize).not.toHaveBeenCalled()
    expect(await executeTool("guarded_probe", { value: "x" }, ctx)).toEqual({ kind: "handler_succeeded", text: "guarded_probe ran" })
    expect(authorize).toHaveBeenCalledOnce()
    expect(handler).toHaveBeenCalledOnce()
  })
})
