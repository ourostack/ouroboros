import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getChannelCapabilities } from "@ouro.bot/friends"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { loadRelationshipCapabilityRegistry } from "../../repertoire/relationship-authorization"
import { baseToolDefinitions, restTool, type ToolContext, type ToolDefinition } from "../../repertoire/tools-base"
import { buildToolResultSummary, execTool, executeTool, getToolsForChannel, preflightToolCall, selectToolsForChannel } from "../../repertoire/tools"
import { McpCallRejectedError, mcpToolsAsDefinitions } from "../../repertoire/mcp-tools"
import { teamsToolDefinitions } from "../../repertoire/tools-teams"
import { makeMcpView, MCP_CONTEXT, MCP_OWNER, shutdownMcpFixtures } from "./mcp-fixture"

const OWNER_ADDITIONS = [
  "shell", "shell_status", "shell_tail", "read_file", "write_file", "edit_file", "glob", "grep",
  "web_search", "search_facts", "consult_diary", "consult_notes", "get_friend_note",
  "session_summary", "query_session", "set_reasoning_effort", "restart_runtime", "revive_sense",
]
const registry = loadRelationshipCapabilityRegistry(path.resolve(__dirname, "../../../deploy/unraid/sanctuary.ouro"))
const temporaryDefinitions: ToolDefinition[] = []

function relationshipContext(profileId: string, extra: string[] = []): ToolContext {
  return {
    ...MCP_CONTEXT,
    relationshipAuthorization: {
      profileId,
      authorizedContextScopes: [],
      advertisedToolNames: [...registry.profiles[profileId]!.toolNames, ...extra],
      authorizeTool: vi.fn(async () => ({ allowed: true, receiptId: "relationship-fixture", profileVersion: 8 })),
    },
  }
}

function schemas(context: ToolContext, view?: ReturnType<typeof makeMcpView>, capabilities?: ReadonlySet<string>) {
  return Reflect.apply(getToolsForChannel, undefined, [
    getChannelCapabilities(context.relationshipAuthorization?.profileId === "sanctuary-event" ? "inner" : "telegram"),
    undefined, undefined, capabilities, view, undefined, context,
  ]) as ReturnType<typeof getToolsForChannel>
}

function addProbe() {
  const handler = vi.fn(async () => "handler ran")
  const definition: ToolDefinition = {
    tool: {
      type: "function",
      function: {
        name: "turn_selection_probe",
        description: "Read the controlled fixture",
        parameters: {
          type: "object", properties: { value: { type: "string" } },
          required: ["value"], additionalProperties: false,
        },
      },
    },
    handler,
  }
  baseToolDefinitions.push(definition)
  temporaryDefinitions.push(definition)
  return { definition, handler }
}

describe("turn-local canonical tool selection", () => {
  beforeEach(() => setAgentName("sanctuary"))
  afterEach(async () => {
    await shutdownMcpFixtures()
    for (const definition of temporaryDefinitions.splice(0)) {
      baseToolDefinitions.splice(baseToolDefinitions.indexOf(definition), 1)
    }
    resetIdentity()
  })

  it.each(["sanctuary-retired", undefined])("A001a coverage keeps unknown Sanctuary authority out of ordinary selection: %s", (profileId) => {
    const context = relationshipContext("sanctuary-owner")
    context.agentName = "sanctuary"
    context.relationshipAuthorization!.profileId = profileId
    expect(selectToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, undefined, undefined, undefined, context).ordinary).toEqual([])
    expect(selectToolsForChannel(getChannelCapabilities("telegram"), undefined, undefined, undefined, undefined, undefined, { agentName: "sanctuary" }).ordinary).toEqual([])
    expect(selectToolsForChannel(getChannelCapabilities("cli"), undefined, undefined, undefined, undefined, undefined, { agentName: "other" }).ordinary.length).toBeGreaterThan(0)
  })

  it("A001a coverage retains channel-local legacy integration definitions without preference metadata", () => {
    const definition = teamsToolDefinitions[0]
    const integration = definition.integration
    try {
      delete definition.integration
      const capabilities = { ...getChannelCapabilities("teams"), availableIntegrations: ["graph"] }
      expect(selectToolsForChannel(capabilities).ordinary.map(({ tool }) => tool.function.name)).toContain(definition.tool.function.name)
      expect(selectToolsForChannel({ ...capabilities, channel: "cli" }).ordinary.map(({ tool }) => tool.function.name)).not.toContain(definition.tool.function.name)
    } finally { definition.integration = integration }
  })

  it("A001a coverage preserves genuine engine preflight without dispatching its handler", async () => {
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: [], engine: [restTool] } }
    expect(await preflightToolCall("rest", { note: "complete" }, context)).toEqual({ kind: "ready" })
    expect(await executeTool("rest", { note: "complete" }, context)).toEqual({ kind: "rejected_before_handler", text: "rejected: rest is owned by the engine" })
  })

  it("A001a coverage accepts an absent parameter schema through the existing empty-schema contract", async () => {
    const { definition, handler } = addProbe()
    delete definition.tool.function.parameters
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: [definition], engine: [] } }
    expect(await executeTool(definition.tool.function.name, {}, context)).toEqual({ kind: "handler_succeeded", text: "handler ran" })
    expect(handler).toHaveBeenCalledOnce()
  })

  it.each(["profile", "advertisement"])("A001a coverage rejects allowed decisions with changed %s before execution", async (change) => {
    const { definition, handler } = addProbe()
    const context: ToolContext = {
      ...MCP_CONTEXT, toolSelection: { ordinary: [definition], engine: [] },
      relationshipAuthorization: {
        profileId: "fixture-owner", authorizedContextScopes: [],
        advertisedToolNames: change === "advertisement" ? [] : [definition.tool.function.name],
        authorizeTool: async () => ({ allowed: true, profileId: change === "profile" ? "changed" : "fixture-owner", receiptId: "fixture" }),
      },
    }
    expect(await executeTool(definition.tool.function.name, { value: "safe" }, context)).toMatchObject({
      kind: "rejected_before_handler", text: "relationship authorization required: current relationship selection changed",
    })
    expect(handler).not.toHaveBeenCalled()
  })

  it("A001a coverage rejects ownerless MCP dispatch even without a relationship wrapper", async () => {
    const view = makeMcpView([{ server: "shared", tools: [{ name: "status", description: "Status", inputSchema: {} }] }])
    const context = { signin: async () => undefined, toolSelection: { ordinary: mcpToolsAsDefinitions(view), engine: [] } }
    expect(await executeTool("shared_status", {}, context)).toMatchObject({ kind: "rejected_before_handler", text: "rejected: MCP requires an explicit owner" })
    expect(view.manager.callTool).not.toHaveBeenCalled()
  })

  it("A001a coverage preserves string preflight failures and typed pre-effect executor rejection", async () => {
    const { definition, handler } = addProbe()
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: [definition], engine: [] } }
    expect(await executeTool(definition.tool.function.name, { value: "safe" }, { ...context, selectCurrentTools: () => { throw "opaque selection failure" } })).toMatchObject({
      kind: "rejected_before_handler", text: "rejected: opaque selection failure", error: "opaque selection failure",
    })
    const rejected = new McpCallRejectedError("client replaced before invocation")
    const executor = vi.fn(async () => { throw rejected })
    expect(await executeTool(definition.tool.function.name, { value: "safe" }, context, executor)).toMatchObject({
      kind: "rejected_before_handler", text: rejected.message, error: rejected,
    })
    expect(executor).toHaveBeenCalledOnce()
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    ["edit_file", "+1 -1 lines in unknown"], ["read_file", "path=unknown"], ["write_file", "path=unknown"],
    ["glob", "pattern=?"], ["grep", "pattern=?"], ["shell", "$ ? (exit 0)"], ["coding_spawn", "unknown -> spawned"],
  ])("A001a coverage retains a bounded summary when %s arguments are absent", (name, expected) => {
    expect(buildToolResultSummary(name, {}, "", true)).toBe(expected)
  })

  it.each([undefined, new Set<string>(), new Set(["reasoning-effort"])])(
    "retains owner send_message and admits exactly the approved additions subject to provider capability: %j",
    (provider) => {
      const context = relationshipContext("sanctuary-owner", OWNER_ADDITIONS)
      const names = schemas(context, undefined, provider).map((tool) => tool.function.name)
      const expected = [...new Set([...registry.profiles["sanctuary-owner"].toolNames, ...OWNER_ADDITIONS])]
        .filter((name) => name !== "rest")
        .filter((name) => provider?.has("reasoning-effort") || name !== "set_reasoning_effort")

      expect(names.toSorted()).toEqual(expected.toSorted())
      expect(names).toContain("send_message")
      expect(new Set(names).size).toBe(names.length)
    },
  )

  it.each(["sanctuary-household", "sanctuary-event"])(
    "keeps the exact %s ceiling when its advertised array is poisoned with owner and MCP names",
    (profileId) => {
      const view = makeMcpView([{ server: "shared", tools: [{ name: "status", description: "Status", inputSchema: {} }] }])
      const context = relationshipContext(profileId, [...OWNER_ADDITIONS, "shared_status"])
      const names = schemas(context, view, new Set(["reasoning-effort"])).map((tool) => tool.function.name)

      expect(names.toSorted()).toEqual(registry.profiles[profileId].toolNames.toSorted())
      for (const name of [...OWNER_ADDITIONS, "shared_status"]) expect(names).not.toContain(name)
      expect(view.manager.callTool).not.toHaveBeenCalled()
    },
  )

  it("admits one exact owner MCP name but never a wildcard or an unlisted tool", () => {
    const view = makeMcpView([{
      server: "shared",
      tools: [
        { name: "status", description: "Status", inputSchema: {} },
        { name: "other", description: "Other", inputSchema: {} },
      ],
    }])
    const context = relationshipContext("sanctuary-owner", ["shared_status", "shared_*"])
    const names = schemas(context, view).map((tool) => tool.function.name)
    expect(names).toContain("shared_status")
    expect(names).not.toContain("shared_other")
    expect(names).not.toContain("shared_*")
  })

  it.each([
    [{ server: "read_file", tools: [{ name: "read_file", description: "Collision", inputSchema: {} }] }],
    [
      { server: "a", tools: [{ name: "b_c", description: "First", inputSchema: {} }] },
      { server: "a_b", tools: [{ name: "c", description: "Second", inputSchema: {} }] },
    ],
    [{ server: "settle", tools: [{ name: "settle", description: "Engine collision", inputSchema: {} }] }],
  ].map((groups) => ({ groups })))("rejects surfaced name collisions before returning schemas: %j", ({ groups }) => {
    const view = makeMcpView(groups)
    expect(() => getToolsForChannel(getChannelCapabilities("cli"), undefined, undefined, undefined, view))
      .toThrow(/collision|duplicate|ambiguous/)
    expect(view.manager.callTool).not.toHaveBeenCalled()
  })

  it("rejects duplicate native definitions rather than choosing one", () => {
    const { definition } = addProbe()
    const duplicate = { ...definition }
    baseToolDefinitions.push(duplicate)
    temporaryDefinitions.push(duplicate)
    expect(() => getToolsForChannel()).toThrow(/duplicate|collision|ambiguous/)
  })

  it("dispatches from A's retained MCP definitions after B advertises the same surfaced name", async () => {
    const group = [{ server: "shared", tools: [{ name: "status", description: "Status", inputSchema: {} }] }]
    const a = makeMcpView(group, { content: [{ type: "text", text: "A result" }] })
    const bOwner = { agentName: "other-agent", agentRoot: "/mock/other.ouro" }
    const b = makeMcpView(group, { content: [{ type: "text", text: "B result" }] }, undefined, bOwner)
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: mcpToolsAsDefinitions(a), engine: [] } }
    getToolsForChannel(undefined, undefined, undefined, undefined, a)
    getToolsForChannel(undefined, undefined, undefined, undefined, b)

    expect(await execTool("shared_status", {}, context)).toBe("A result")
    expect(a.manager.callTool).toHaveBeenCalledWith(expect.objectContaining(MCP_OWNER), {}, MCP_OWNER)
    expect(b.manager.callTool).not.toHaveBeenCalled()
  })

  it("does not dispatch a prior turn's MCP name when the new turn has no MCP selection", async () => {
    const view = makeMcpView([{ server: "shared", tools: [{ name: "status", description: "Status", inputSchema: {} }] }])
    getToolsForChannel(undefined, undefined, undefined, undefined, view)
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: [], engine: [] } }

    expect(await execTool("shared_status", {}, context)).toMatch(/unknown|rejected|not selected/)
    expect(view.manager.callTool).not.toHaveBeenCalled()
  })

  it.each([
    { state: "remote_error", kind: "handler_failed", text: "operation succeeded", isError: true },
    { state: "transport_error", kind: "handler_indeterminate", text: "transport closed after write", isError: false },
    { state: "error_wording", kind: "handler_succeeded", text: "[mcp error] is only returned content", isError: false },
  ])("preserves typed MCP effect truth without classifying result wording: $state", async ({ state, kind, text, isError }) => {
    const result = { content: [{ type: "text", text }], isError }
    const failure = state === "transport_error" ? new Error(text) : undefined
    const view = makeMcpView([{ server: "shared", tools: [{ name: "status", description: "Status", inputSchema: {} }] }], result, failure)
    const context = { ...MCP_CONTEXT, toolSelection: { ordinary: mcpToolsAsDefinitions(view), engine: [] } }

    const outcome = await executeTool("shared_status", {}, context)
    expect(outcome.kind).toBe(kind)
    expect(outcome.text).toContain(text)
    expect(view.manager.callTool).toHaveBeenCalledOnce()
    expect(await execTool("shared_status", {}, context)).toContain(text)
  })

  it.each(["schema", "handler"] as const)("rejects a native %s changed after selection", async (change) => {
    const { definition, handler } = addProbe()
    const selected = { ...definition, tool: structuredClone(definition.tool) }
    const replacement = vi.fn(async () => "replacement ran")
    if (change === "schema") definition.tool.function.description = "Changed meaning"
    else definition.handler = replacement
    const context = {
      ...MCP_CONTEXT,
      toolSelection: { ordinary: [selected], engine: [] },
      selectCurrentTools: () => ({ ordinary: [definition], engine: [] }),
    }

    expect(await execTool(definition.tool.function.name, { value: "safe" }, context)).toMatch(/rejected|changed|stale/)
    expect(handler).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
  })

  it("rejects a tool removed from the current provider selection after advertisement", async () => {
    const { definition, handler } = addProbe()
    const context = {
      ...MCP_CONTEXT,
      toolSelection: { ordinary: [definition], engine: [] },
      selectCurrentTools: () => ({ ordinary: [], engine: [] }),
    }
    expect(await execTool(definition.tool.function.name, { value: "safe" }, context)).toMatch(/rejected|not selected|unavailable/)
    expect(handler).not.toHaveBeenCalled()
  })

  it.each([
    { agentName: undefined, agentRoot: MCP_OWNER.agentRoot },
    { agentName: MCP_OWNER.agentName, agentRoot: undefined },
    { agentName: undefined, agentRoot: undefined },
    { agentName: "", agentRoot: MCP_OWNER.agentRoot },
    { agentName: MCP_OWNER.agentName, agentRoot: "relative/root" },
  ])("refuses incomplete relationship ownership before either handler: %j", async (owner) => {
    const { definition, handler } = addProbe()
    const customHandler = vi.fn(async () => "custom handler ran")
    const authorizeTool = vi.fn(async () => ({ allowed: true as const, receiptId: "owned" }))
    const context = {
      ...MCP_CONTEXT, ...owner,
      toolSelection: { ordinary: [definition], engine: [] },
      relationshipAuthorization: {
        profileId: "fixture-owner", authorizedContextScopes: [],
        advertisedToolNames: [definition.tool.function.name], authorizeTool,
      },
    }
    const result = await executeTool(definition.tool.function.name, { value: "safe" }, context, customHandler)
    expect(result).toMatchObject({ kind: "rejected_before_handler", text: expect.stringMatching(/explicit owner/i) })
    expect(authorizeTool).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(customHandler).not.toHaveBeenCalled()
  })

  it.each([{ value: true }, { value: 7 }, {}, { value: "safe", extra: "forbidden" }])(
    "validates the selected native schema at ordinary dispatch: %j",
    async (args) => {
      const { definition, handler } = addProbe()
      const context = { ...MCP_CONTEXT, toolSelection: { ordinary: [definition], engine: [] } }
      const result = await Reflect.apply(execTool, undefined, [definition.tool.function.name, args, context])
      expect(result).toMatch(/invalid|rejected/)
      expect(handler).not.toHaveBeenCalled()
    },
  )
})
