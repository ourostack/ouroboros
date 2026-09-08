import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const target = String(filePath)
  if (target.endsWith("SOUL.md")) return "mock soul"
  if (target.endsWith("IDENTITY.md")) return "mock identity"
  if (target.endsWith("LORE.md")) return "mock lore"
  if (target.endsWith("FRIENDS.md")) return "mock friends"
  if (target.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

// Hard-mock the daemon socket client so this test never connects to the real
// /tmp/ouroboros-daemon.sock. Tests that don't mock this leak inner.wake commands
// for the literal "testagent" name into whatever real daemon happens to be running.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })),
  DEFAULT_AGENT_CONTEXT: {
    maxTokens: 80000,
    contextMargin: 20,
  },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockCreate = vi.fn()
const mockResponsesCreate = vi.fn()
vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockCreate,
      },
    }
    responses = {
      create: mockResponsesCreate,
    }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic {
    messages = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return { default: MockAnthropic }
})

const mockInjectNoteSearchContext = vi.fn().mockResolvedValue(undefined)
vi.mock("../../mind/note-search", () => ({
  injectNoteSearchContext: (...args: any[]) => mockInjectNoteSearchContext(...args),
}))

import * as fs from "fs"
import * as identity from "../../heart/identity"
import type { ChannelCallbacks, ProviderRuntime, RunAgentOptions } from "../../heart/core"
import type { TurnResult } from "../../heart/streaming"

async function setupMinimax() {
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
  })
  const config = await import("../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
}

function makeStream(chunks: any[]) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) {
        yield chunk
      }
    },
  }
}

function makeChunk(content?: string, toolCalls?: any[]) {
  const delta: any = {}
  if (content !== undefined) delta.content = content
  if (toolCalls !== undefined) delta.tool_calls = toolCalls
  return { choices: [{ delta }] }
}

function makeCallbacks(overrides: Partial<ChannelCallbacks> = {}): ChannelCallbacks {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onError: vi.fn(),
    onClearText: vi.fn(),
    ...overrides,
  }
}

function expectProviderOnlyRejection(messages: unknown[], callId: string, fragment: string): void {
  const canonicalCallIds = (messages as ChatCompletionMessageParam[]).flatMap((message) => message.role === "assistant"
    ? message.tool_calls?.map((call) => call.id) ?? []
    : message.role === "tool" ? [message.tool_call_id] : [])
  expect(canonicalCallIds).not.toContain(callId)
  const outbound = JSON.stringify(mockCreate.mock.calls.slice(1).map(([request]) => request.messages))
  expect(outbound).toContain(callId)
  expect(outbound).toContain(fragment)
}

describe("runAgent tool loop guard", () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockImplementation(defaultReadFileSync)
    mockCreate.mockReset()
    mockResponsesCreate.mockReset()
    await setupMinimax()
  })

  it("isChatStyleChannel returns true for live conversational channels, false otherwise", async () => {
    const { isChatStyleChannel } = await import("../../heart/core")
    expect(isChatStyleChannel("cli")).toBe(true)
    expect(isChatStyleChannel("teams")).toBe(true)
    expect(isChatStyleChannel("bluebubbles")).toBe(false)
    expect(isChatStyleChannel("voice")).toBe(true)
    expect(isChatStyleChannel("telegram")).toBe(true)
    expect(isChatStyleChannel("inner")).toBe(false)
    expect(isChatStyleChannel("mcp")).toBe(false)
    expect(isChatStyleChannel("mail")).toBe(false)
    expect(isChatStyleChannel("anything-else")).toBe(false)
  })

  it("activeTools includes speakTool for CLI and excludes it from BlueBubbles and inner", async () => {
    // Capture the tools passed to the provider in two runs
    let capturedToolsByCall: Array<Array<{ function: { name: string } }>> = []
    mockCreate.mockImplementation((req: any) => {
      capturedToolsByCall.push(req.tools as any)
      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_settle",
            function: { name: "settle", arguments: '{"answer":"done"}' },
          },
        ]),
      ])
    })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("ok")

    // CLI channel: speak should be included
    await runAgent([{ role: "system", content: "test" }], makeCallbacks(), "cli", undefined, {
      toolChoiceRequired: true,
      execTool,
      toolContext: { signin: async () => undefined },
    })
    const cliToolNames = capturedToolsByCall[0]?.map((t) => t.function.name) ?? []
    expect(cliToolNames).toContain("speak")
    expect(cliToolNames).toContain("settle")

    capturedToolsByCall = []
    mockCreate.mockImplementation((req: any) => {
      capturedToolsByCall.push(req.tools as any)
      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_settle_bb",
            function: { name: "settle", arguments: '{"answer":"done"}' },
          },
        ]),
      ])
    })

    await runAgent([{ role: "system", content: "test" }], makeCallbacks(), "bluebubbles", undefined, {
      toolChoiceRequired: true,
      execTool,
      toolContext: { signin: async () => undefined },
    })
    const blueBubblesToolNames = capturedToolsByCall[0]?.map((t) => t.function.name) ?? []
    expect(blueBubblesToolNames).not.toContain("speak")
    expect(blueBubblesToolNames).toContain("settle")

    // Reset capture; mock now needs another stream for the inner run
    capturedToolsByCall = []
    mockCreate.mockImplementation((req: any) => {
      capturedToolsByCall.push(req.tools as any)
      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_rest",
            function: { name: "rest", arguments: "{}" },
          },
        ]),
      ])
    })

    await runAgent([{ role: "system", content: "test" }], makeCallbacks(), "inner", undefined, {
      toolChoiceRequired: true,
      execTool,
      toolContext: { signin: async () => undefined },
    })
    const innerToolNames = capturedToolsByCall[0]?.map((t) => t.function.name) ?? []
    expect(innerToolNames).not.toContain("speak")
    expect(innerToolNames).not.toContain("settle")
    expect(innerToolNames).toContain("rest")
  })

  it("hard tool exclusion advertises no tools and rejects fabricated tool calls", async () => {
    const capturedTools: any[][] = []
    const capturedToolChoices: unknown[] = []
    mockCreate
      .mockImplementationOnce((request: any) => {
        capturedTools.push(request.tools)
        capturedToolChoices.push(request.tool_choice)
        return makeStream([
          makeChunk(undefined, [{
            index: 0,
            id: "fabricated-ponder",
            function: { name: "ponder", arguments: '{"prompt":"mutate"}' },
          }]),
        ])
      })
      .mockImplementationOnce((request: any) => {
        capturedTools.push(request.tools)
        capturedToolChoices.push(request.tool_choice)
        return makeStream([makeChunk('{"disposition":"hold"}')])
      })
    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn()

    const result = await runAgent(
      [{ role: "user", content: "observe only" }],
      makeCallbacks(),
      "mcp",
      undefined,
      {
        tools: [],
        hardDisableTools: true,
        execTool,
        toolContext: { signin: async () => undefined },
      },
    )

    expect(capturedTools).toEqual([[], []])
    expect(capturedToolChoices).toEqual([undefined, undefined])
    expect(execTool).not.toHaveBeenCalled()
    expect(result.outcome).not.toBe("errored")
  })

  it("advertises exactly send_message and rest for the Sanctuary health private profile", async () => {
    let names: string[] = []
    mockCreate.mockImplementation((request: any) => {
      names = request.tools.map((tool: any) => tool.function.name)
      return makeStream([makeChunk(undefined, [{
        index: 0,
        id: "call_health_rest",
        function: { name: "rest", arguments: JSON.stringify({ status: "HEARTBEAT_OK" }) },
      }])])
    })
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent([{ role: "user", content: "summarize the health event" }], makeCallbacks(), "inner", undefined, {
      toolProfile: "sanctuary-health-private",
      tools: [{
        type: "function",
        function: {
          name: "send_message",
          description: "send the health alert",
          parameters: {
            type: "object",
            properties: { friendId: { type: "string" }, channel: { type: "string" }, content: { type: "string" } },
            required: ["friendId", "channel", "content"],
            additionalProperties: false,
          },
        },
      }],
      execTool: vi.fn(),
      toolContext: { signin: async () => undefined },
    } as any)

    expect(names).toEqual(["send_message", "rest"])
    expect(result.outcome).toBe("rested")
  })

  it.each([
    ["an outward channel", "telegram", ["send_message"]],
    ["no send_message definition", "inner", []],
    ["an extra definition", "inner", ["send_message", "read_file"]],
    ["duplicate send_message definitions", "inner", ["send_message", "send_message"]],
  ])("rejects the Sanctuary health private profile with %s", async (_label, channel, names) => {
    const tools = names.map((name) => ({
      type: "function" as const,
      function: {
        name,
        description: `synthetic ${name}`,
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }))
    const { runAgent } = await import("../../heart/core")

    await expect(runAgent(
      [{ role: "user", content: "summarize the health event" }],
      makeCallbacks(),
      channel,
      undefined,
      {
        toolProfile: "sanctuary-health-private",
        tools,
        execTool: vi.fn(),
        toolContext: { signin: async () => undefined },
      } as any,
    )).rejects.toThrow("sanctuary-health-private requires inner channel with exactly one canonical send_message definition")
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it("gates private settle on held work, then accepts it after the queue is cleared", async () => {
    const delegatedOrigins = [{ delegationId: "held-1" }]
    mockCreate
      .mockReturnValueOnce(makeStream([makeChunk("premature", [{
        index: 0,
        id: "call_private_settle_gated",
        function: { name: "settle", arguments: JSON.stringify({ answer: "not yet", intent: "complete" }) },
      }])]))
      .mockImplementationOnce(() => {
        delegatedOrigins.splice(0)
        return makeStream([makeChunk(undefined, [{
          index: 0,
          id: "call_private_settle_accepted",
          function: { name: "settle", arguments: JSON.stringify({ answer: "now complete", intent: "complete" }) },
        }])])
      })
    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "user", content: "finish held work" }]
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent(messages, callbacks, "inner", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "settle",
          description: "synthetic private settle",
          parameters: {
            type: "object",
            properties: {
              answer: { type: "string" },
              intent: { type: "string", enum: ["complete", "blocked", "direct_reply"] },
            },
            required: ["answer"],
            additionalProperties: false,
          },
        },
      }],
      toolContext: { signin: async () => undefined, delegatedOrigins } as any,
    })

    expect(result.outcome).toBe("settled")
    expect(callbacks.onToolEnd).toHaveBeenNthCalledWith(1, "settle", expect.any(String), false)
    expect(callbacks.onToolEnd).toHaveBeenNthCalledWith(2, "settle", expect.any(String), true)
    expect(callbacks.onClearText).toHaveBeenCalled()
    expectProviderOnlyRejection(messages, "call_private_settle_gated", "unsurfaced items")
    expect(messages).toContainEqual({ role: "tool", tool_call_id: "call_private_settle_accepted", content: "(settled)" })
  })

  it("stops at the eighth accepted provider response before executing its tool call", async () => {
    let response = 0
    mockCreate.mockImplementation(() => {
      response += 1
      return makeStream([makeChunk(undefined, [{
        index: 0,
        id: `call_iteration_${response}`,
        function: { name: "read_file", arguments: JSON.stringify({ path: `/tmp/${response}` }) },
      }])])
    })
    const execTool = vi.fn().mockResolvedValue("read")
    const callbacks = makeCallbacks()
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent([{ role: "user", content: "keep reading" }], callbacks, "cli", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "read_file",
          description: "read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      }],
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(mockCreate).toHaveBeenCalledTimes(8)
    expect(execTool).toHaveBeenCalledTimes(7)
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "provider iteration limit exhausted at response 8 before tool execution",
    }), "terminal")
    expect(result.outcome).toBe("errored")
  })

  it("executes one 32-lease disposition batch after 24 investigations and rests on response seven", async () => {
    const responseCallCounts = [5, 5, 5, 5, 4]
    let response = 0
    mockCreate.mockImplementation(() => {
      response += 1
      if (response <= responseCallCounts.length) {
        const count = responseCallCounts[response - 1]!
        return makeStream([makeChunk(undefined, Array.from({ length: count }, (_, index) => {
          const ordinal = responseCallCounts.slice(0, response - 1).reduce((sum, value) => sum + value, 0) + index
          return {
            index,
            id: `call_investigate_${ordinal}`,
            function: { name: "investigate", arguments: JSON.stringify({ target: `service-${ordinal}` }) },
          }
        }))])
      }
      if (response === 6) {
        return makeStream([makeChunk(undefined, [{
          index: 0,
          id: "call_disposition_batch",
          function: { name: "external_event_disposition", arguments: JSON.stringify({ batch: Array.from({ length: 32 }, (_, index) => ({ recordPath: `/events/${index}.json` })) }) },
        }])])
      }
      return makeStream([makeChunk(undefined, [{ index: 0, id: "call_rest", function: { name: "rest", arguments: "{}" } }])])
    })
    const execTool = vi.fn(async (name: string, args: Record<string, unknown>) => name === "external_event_disposition"
      ? JSON.stringify({ results: (args.batch as unknown[]).map((_, index) => ({ index, ok: true })) })
      : "investigated")
    const callbacks = makeCallbacks()
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent([{ role: "user", content: "investigate and disposition the batch" }], callbacks, "inner", undefined, {
      tools: [
        { type: "function", function: { name: "investigate", description: "investigate", parameters: { type: "object", properties: { target: { type: "string" } }, required: ["target"], additionalProperties: false } } },
        { type: "function", function: { name: "external_event_disposition", description: "dispose", parameters: { type: "object", properties: { batch: { type: "array", maxItems: 32, items: { type: "object", properties: { recordPath: { type: "string" } }, required: ["recordPath"], additionalProperties: false } } }, required: ["batch"], additionalProperties: false } } },
      ],
      execTool,
      toolContext: { signin: async () => undefined },
    } as any)

    expect(mockCreate).toHaveBeenCalledTimes(7)
    expect(execTool).toHaveBeenCalledTimes(25)
    expect(execTool).toHaveBeenLastCalledWith("external_event_disposition", expect.objectContaining({ batch: expect.any(Array) }), expect.anything())
    expect((execTool.mock.calls.at(-1)?.[1] as any).batch).toHaveLength(32)
    expect(result.outcome).toBe("rested")
    expect(callbacks.onError).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("provider iteration limit") }), expect.anything())
  })

  it("rejects a fabricated tool call outside the active Telegram profile before any handler runs", async () => {
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: "call_fabricated_shell",
      function: { name: "shell", arguments: JSON.stringify({ command: "docker restart calibre-web" }) },
    }])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: "call_settle_after_rejection",
      function: { name: "settle", arguments: JSON.stringify({ answer: "rejected" }) },
    }])]))
    const execTool = vi.fn().mockResolvedValue("must not execute")
    const messages: any[] = [{ role: "user", content: "restart it" }]
    const { runAgent } = await import("../../heart/core")

    await runAgent(messages, makeCallbacks(), "telegram", undefined, {
      tools: [],
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(execTool).not.toHaveBeenCalled()
    expectProviderOnlyRejection(messages, "call_fabricated_shell", "was not advertised")
  })

  it("reports excluded and valid calls from the production Telegram batch boundary", async () => {
    const { resolveToolDefinition } = await import("../../repertoire/tools")
    const sanctuaryNames = new Set(["unraid_list_containers", "unraid_get_container_logs", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system", "unraid_restart_container"])
    const tools = [...sanctuaryNames].map((name) => resolveToolDefinition(name)!.tool)
    const excluded = ["shell", "read_file", "edit_file", "vault_get", "mcp_call", "exec", "credential_get"]
    const execTool = vi.fn(async (name: string) => name === "unraid_get_system" ? JSON.stringify({ ok: true }) : "unexpected")
    const boundaryReceipts: unknown[] = []
    const { runAgent } = await import("../../heart/core")
    for (const [index, name] of excluded.entries()) {
      mockCreate.mockReset()
      mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: `excluded-${index}`, function: { name, arguments: "{}" } }])]))
      mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: `settle-${index}`, function: { name: "settle", arguments: JSON.stringify({ answer: "rejected" }) } }])]))
      await runAgent([{ role: "user", content: "probe the exact Sanctuary boundary" }], makeCallbacks(), "telegram", undefined, {
        tools, execTool, toolContext: { signin: async () => undefined },
        toolBoundaryObserver: (receipt: unknown) => boundaryReceipts.push(receipt),
      } as any)
    }
    mockCreate.mockReset()
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: "valid-system", function: { name: "unraid_get_system", arguments: "{}" } }])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: "final-settle", function: { name: "settle", arguments: JSON.stringify({ answer: "complete" }) } }])]))
    await runAgent([{ role: "user", content: "run a valid Sanctuary read" }], makeCallbacks(), "telegram", undefined, {
      tools, execTool, toolContext: { signin: async () => undefined },
      toolBoundaryObserver: (receipt: unknown) => boundaryReceipts.push(receipt),
    } as any)

    expect(execTool).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith("unraid_get_system", {}, expect.anything())
    expect(boundaryReceipts).toEqual([
      ...excluded.map((name) => expect.objectContaining({ name, reason: "profile_excluded", invoked: false, sideEffect: false })),
      expect.objectContaining({ name: "unraid_get_system", reason: "dispatched", invoked: true, sideEffect: false }),
    ])
  })

  it("dispatches the valid Sanctuary control through the production repertoire executor", async () => {
    const { resolveToolDefinition } = await import("../../repertoire/tools")
    const systemTool = resolveToolDefinition("unraid_get_system")!.tool
    const getSystem = vi.fn().mockResolvedValue({ ok: true, data: { serverName: "Sanctuary" } })
    const boundaryReceipts: unknown[] = []
    mockCreate.mockReset()
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: "valid-system-production", function: { name: "unraid_get_system", arguments: "{}" } }])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{ index: 0, id: "settle-production", function: { name: "settle", arguments: JSON.stringify({ answer: "complete" }) } }])]))
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent([{ role: "user", content: "run the production control" }], makeCallbacks(), "telegram", undefined, {
      tools: [systemTool],
      toolContext: { signin: async () => undefined, sanctuary: { getSystem } } as any,
      toolBoundaryObserver: (receipt: unknown) => boundaryReceipts.push(receipt),
    })

    expect(result.outcome).toBe("settled")
    expect(getSystem).toHaveBeenCalledOnce()
    expect(boundaryReceipts).toContainEqual(expect.objectContaining({
      name: "unraid_get_system", reason: "dispatched", globallyResolvable: true, invoked: true, sideEffect: false,
    }))
  })

  it("reports the generated assistant/tool tail independently of prompt-budget prefix replacement", async () => {
    mockCreate.mockImplementation(() => makeStream([
      makeChunk(undefined, [{
        index: 0,
        id: "call_generated_tail",
        function: { name: "settle", arguments: '{"answer":"visible answer","intent":"complete"}' },
      }]),
    ]))
    const captureGeneratedMessages = vi.fn()
    const messages: any[] = [
      { role: "system", content: "old system" },
      { role: "user", content: "x".repeat(400_000) },
      { role: "assistant", content: "old assistant history" },
      { role: "user", content: "current request" },
    ]

    const { runAgent } = await import("../../heart/core")
    await runAgent(messages, makeCallbacks(), "bluebubbles", undefined, {
      toolChoiceRequired: true,
      execTool: vi.fn().mockResolvedValue("ok"),
      toolContext: { signin: async () => undefined },
      captureGeneratedMessages,
    })

    expect(captureGeneratedMessages).toHaveBeenCalledTimes(1)
    expect(captureGeneratedMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        role: "assistant",
        tool_calls: [expect.objectContaining({ id: "call_generated_tail" })],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_generated_tail",
        content: "(delivered)",
      }),
    ])
    expect(JSON.stringify(captureGeneratedMessages.mock.calls[0]?.[0])).not.toContain("old assistant history")
    expect(JSON.stringify(captureGeneratedMessages.mock.calls[0]?.[0])).not.toContain("current request")
  })

  it("retains the same required evidence through tool-loop and no-tool retry payloads", async () => {
    const providerPayloads: any[][] = []
    mockCreate
      .mockImplementationOnce((request: any) => {
        providerPayloads.push(request.messages)
        return makeStream([makeChunk("<think>thinking without a required tool</think>")])
      })
      .mockImplementationOnce((request: any) => {
        providerPayloads.push(request.messages)
        return makeStream([
          makeChunk(undefined, [{
            index: 0,
            id: "call_required_probe",
            function: { name: "query_session", arguments: "{}" },
          }]),
        ])
      })
      .mockImplementationOnce((request: any) => {
        providerPayloads.push(request.messages)
        return makeStream([
          makeChunk(undefined, [{
            index: 0,
            id: "call_required_settle",
            function: { name: "settle", arguments: '{"answer":"oriented","intent":"complete"}' },
          }]),
        ])
      })
    const predecessor = Object.freeze({ role: "system" as const, content: "verified predecessor marker" })
    const current = Object.freeze({ role: "user" as const, content: "current request marker" })

    const { runAgent } = await import("../../heart/core")
    await runAgent(
      [{ role: "system", content: "old prompt" }, predecessor, current],
      makeCallbacks(),
      "mcp",
      undefined,
      {
        toolChoiceRequired: true,
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
        execTool: vi.fn().mockResolvedValue("session evidence"),
        toolContext: { signin: async () => undefined },
      },
    )

    expect(providerPayloads).toHaveLength(3)
    for (const payload of providerPayloads) {
      expect(payload.filter((message) => message === predecessor)).toHaveLength(1)
      expect(payload.filter((message) => message === current)).toHaveLength(1)
      expect(JSON.stringify(payload).match(/verified predecessor marker/g)).toHaveLength(1)
    }
  })

  it("retains the same required evidence when a steering follow-up is appended", async () => {
    let providerPayload: unknown[] = []
    mockCreate.mockImplementationOnce((request: { messages: unknown[] }) => {
      providerPayload = [...request.messages]
      return makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_steered_settle",
          function: { name: "settle", arguments: '{"answer":"oriented","intent":"complete"}' },
        }]),
      ])
    })
    const predecessor = Object.freeze({ role: "system" as const, content: "verified predecessor steering marker" })
    const current = Object.freeze({ role: "user" as const, content: "current steering request" })
    const drainSteeringFollowUps = vi.fn()
      .mockReturnValueOnce([{ text: "one newer clarification" }])
      .mockReturnValue([])

    const { runAgent } = await import("../../heart/core")
    await runAgent(
      [{ role: "system", content: "old prompt" }, predecessor, current],
      makeCallbacks(),
      "mcp",
      undefined,
      {
        toolChoiceRequired: true,
        requiredPromptEvidence: {
          currentUserMessage: current,
          verifiedPredecessorMessage: predecessor,
        },
        drainSteeringFollowUps,
        toolContext: { signin: async () => undefined },
      },
    )

    expect(providerPayload.filter((message) => message === predecessor)).toHaveLength(1)
    expect(providerPayload.filter((message) => message === current)).toHaveLength(1)
    expect(JSON.stringify(providerPayload)).toContain("one newer clarification")
  })

  it("blocks repeated no-progress polling and lets the model recover with settle", async () => {
    let callCount = 0
    mockCreate.mockImplementation(() => {
      callCount += 1
      if (callCount <= 4) {
        return makeStream([
          makeChunk(undefined, [
            {
              index: 0,
              id: `call_${callCount}`,
              function: {
                name: "coding_status",
                arguments: '{"sessionId":"coding-001"}',
              },
            },
          ]),
        ])
      }

      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_final",
            function: {
              name: "settle",
              arguments: '{"answer":"using the current coding status"}',
            },
          },
        ]),
      ])
    })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("status: running")
    const callbacks = makeCallbacks()
    const messages: any[] = [{ role: "system", content: "test" }]

    const result = await runAgent(messages, callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      execTool,
      toolContext: {
        signin: async () => undefined,
      },
    })

    expect(execTool).toHaveBeenCalledTimes(3)
    expect(execTool).toHaveBeenNthCalledWith(1, "coding_status", { sessionId: "coding-001" }, expect.anything())
    expect(result.completion).toEqual({
      answer: "using the current coding status",
      intent: "complete",
    })
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("using the current coding status")

    expect(JSON.stringify(messages)).not.toContain("loop guard:")
    expect(JSON.stringify(mockCreate.mock.calls.slice(1).map(([request]) => request.messages))).toContain("stop polling")
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("coding_status", "sessionId=coding-001", false)
  })

  it("releases final-only commentary for an admissible ordinary tool batch", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk("checking the current status"),
        makeChunk(undefined, [{
          index: 0,
          id: "call_status",
          function: { name: "coding_status", arguments: '{"sessionId":"coding-001"}' },
        }]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_final",
          function: { name: "settle", arguments: '{"answer":"status checked"}' },
        }]),
      ]))

    const visibleText: string[] = []
    const callbacks = makeCallbacks({
      settleOutputMode: "final_only",
      onTextChunk: vi.fn((text: string) => { visibleText.push(text) }),
    })
    const { runAgent } = await import("../../heart/core")
    const result = await runAgent(
      [{ role: "user", content: "check it" }],
      callbacks,
      "cli",
      undefined,
      {
        toolChoiceRequired: true,
        execTool: vi.fn().mockResolvedValue("status: running"),
        toolContext: { signin: async () => undefined },
      },
    )

    expect(visibleText).toEqual(["checking the current status", "status checked"])
    expect(result).toMatchObject({
      outcome: "settled",
      completion: { answer: "status checked", intent: "complete" },
    })
  })

  it("does not execute ordinary tools when final-only commentary commit fails", async () => {
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("checking the current status"),
      makeChunk(undefined, [{
        index: 0,
        id: "call_status",
        function: { name: "coding_status", arguments: '{"sessionId":"coding-001"}' },
      }]),
    ]))

    const execTool = vi.fn().mockResolvedValue("status: running")
    const callbacks = makeCallbacks({
      settleOutputMode: "final_only",
      onTextChunk: vi.fn(() => { throw new Error("outward commit failed") }),
    })
    const { runAgent } = await import("../../heart/core")
    const result = await runAgent(
      [{ role: "user", content: "check it" }],
      callbacks,
      "cli",
      undefined,
      {
        toolChoiceRequired: true,
        execTool,
        toolContext: { signin: async () => undefined },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "outward commit failed" }),
      "terminal",
    )
    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: "outward commit failed" },
    })
  })

  it("passes a run-level orientation frame into tool execution even without an existing tool context", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_orientation",
            function: {
              name: "orientation_get",
              arguments: "{}",
            },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_final",
            function: {
              name: "settle",
              arguments: '{"answer":"checked orientation"}',
            },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const orientationFrame = {
      schemaVersion: 1 as const,
      channel: "bluebubbles",
      currentUserSpeech: ["same"],
      priorAssistantReferents: [],
      signals: ["terse_referent" as const],
      actionPolicy: {
        mode: "correction_hold" as const,
        reason: "Current user speech appears referent-dependent; inspect orientation before mutating durable state.",
        blockedMutationKinds: ["durable_state_write", "external_side_effect"],
      },
    }
    const execTool = vi.fn().mockResolvedValue(JSON.stringify(orientationFrame))
    const callbacks = makeCallbacks()

    const result = await runAgent([{ role: "user", content: "same" }], callbacks, undefined, undefined, {
      toolChoiceRequired: true,
      execTool,
      orientationFrame,
    })

    expect(execTool).toHaveBeenCalledWith("orientation_get", {}, expect.objectContaining({ orientationFrame }))
    expect(result.completion).toMatchObject({ answer: "checked orientation" })
  })

  it("derives the authoritative current trigger for direct channel callers that bypass the shared pipeline", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_final",
          function: {
            name: "settle",
            arguments: '{"answer":"handled the current request"}',
          },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const messages: any[] = [
      { role: "assistant", content: "1. stale option\n2. another stale option" },
      { role: "user", content: "stop the synthetic recurring report" },
    ]

    await runAgent(messages, callbacks, "cli", undefined, {
      toolChoiceRequired: true,
      skipKeptNotes: true,
    })

    const system = String(messages[0]?.content ?? "")
    expect(system.match(/^## Current trigger \(authoritative\)$/gm)).toHaveLength(1)
    expect(system).toContain("current user speech:\n- stop the synthetic recurring report")
  })

  it("delivers an accepted non-streamed settle through callbacks when no output buffer exists", async () => {
    const appendToolOutput = vi.fn()
    vi.doMock("../../heart/providers/minimax", () => ({
      createMinimaxProviderRuntime: () => ({
        id: "minimax",
        model: "test-model",
        client: {},
        capabilities: new Set(),
        resetTurnState: vi.fn(),
        appendToolOutput,
        streamTurn: vi.fn().mockResolvedValue({
          content: "",
          toolCalls: [{
            id: "call_non_streamed_settle",
            name: "settle",
            arguments: '{"answer":"delivered after validation","intent":"complete"}',
          }],
          outputItems: [],
          settleStreamed: false,
        }),
        ping: vi.fn(),
        classifyError: vi.fn(() => "unknown"),
      }),
    }))

    try {
      const { runAgent } = await import("../../heart/core")
      const callbacks = makeCallbacks()
      const result = await runAgent(
        [{ role: "user", content: "finish this turn" }],
        callbacks,
        "cli",
        undefined,
        { toolChoiceRequired: true, skipKeptNotes: true },
      )

      expect(callbacks.onTextChunk).toHaveBeenCalledWith("delivered after validation")
      expect(appendToolOutput).toHaveBeenCalledWith("call_non_streamed_settle", "(delivered)")
      expect(result).toMatchObject({
        outcome: "settled",
        completion: { answer: "delivered after validation", intent: "complete" },
      })
    } finally {
      vi.doUnmock("../../heart/providers/minimax")
    }
  })

  it.each([
    ["incomplete", '{"answer":"partial', "incomplete_settle_arguments"],
    ["invalid", String.raw`{"answer":"partial\x"}`, "invalid_settle_arguments"],
  ])("fails ordinary %s settle finalization without another provider turn", async (_label, argumentsText, errorCode) => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_invalid_finalization",
          function: { name: "settle", arguments: argumentsText },
        }]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_forbidden_retry",
          function: { name: "settle", arguments: '{"answer":"must not run"}' },
        }]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks({
      settleOutputMode: "final_only",
    } as any)
    const result = await runAgent(
      [{ role: "user", content: "finish once" }],
      callbacks,
      "cli",
      undefined,
      { toolChoiceRequired: true, skipKeptNotes: true },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: "errored",
      error: { message: errorCode },
    })
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: errorCode }),
      "terminal",
    )
  })

  it("does not retry a provider turn when final-only callback commit throws", async () => {
    vi.useFakeTimers()
    try {
      mockCreate.mockReturnValue(makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_callback_failure",
          function: { name: "settle", arguments: '{"answer":"done"}' },
        }]),
      ]))
      const callbackFailure = new Error("callback failed")
      const outward: string[] = []
      const callbacks = makeCallbacks({
        settleOutputMode: "final_only",
        onTextChunk: vi.fn((text: string) => {
          if (text) throw callbackFailure
          outward.push(text)
        }),
      } as any)
      const { runAgent } = await import("../../heart/core")
      const pending = runAgent(
        [{ role: "user", content: "finish once" }],
        callbacks,
        "cli",
        undefined,
        { toolChoiceRequired: true, skipKeptNotes: true },
      )
      await vi.runAllTimersAsync()
      const result = await pending

      expect(mockCreate).toHaveBeenCalledTimes(1)
      expect(outward).toEqual([])
      expect(result).toMatchObject({
        outcome: "errored",
        error: { message: "settle finalization callback failed: callback failed" },
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("binds the exact current capture locator into the provider-facing habit cancellation schema", async () => {
    let evidenceSchema: Record<string, unknown> | undefined
    mockCreate.mockImplementation((request: any) => {
      const tool = request.tools.find((entry: any) => entry.function.name === "habit_cancel")
      evidenceSchema = tool?.function.parameters.properties.evidence
      return makeStream([
        makeChunk(undefined, [{
          index: 0,
          id: "call_final",
          function: { name: "settle", arguments: '{"answer":"oriented"}' },
        }]),
      ])
    })

    const { runAgent } = await import("../../heart/core")
    const captureKeyHash = "c".repeat(64)
    await runAgent([{ role: "user", content: "Please end this report." }], makeCallbacks(), "bluebubbles", undefined, {
      toolChoiceRequired: true,
      toolContext: {
        signin: async () => undefined,
        agentRoot: "/tmp/synthetic-agent.ouro",
        currentIngressEvidence: {
          schemaVersion: 1,
          provider: "bluebubbles",
          captureKeyHash,
        },
      },
    })

    expect(evidenceSchema).toMatchObject({
      enum: [`capture:${captureKeyHash}`],
    })
  })

  it("executes a sole terminal-projection cancellation once, clears buffered prose, and returns its receipt verbatim", async () => {
    const terminalToolName = "synthetic_terminal_projection"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic metadata-driven terminal projection",
          parameters: {
            type: "object",
            properties: { habit: { type: "string" }, evidence: { type: "string" } },
            required: ["habit", "evidence"],
            additionalProperties: false,
          },
        },
      },
      handler: async () => "unused",
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: true,
      },
    })
    const acknowledgement = "Cancelled habit \"rsvp-demo\" from confirmed requester \"Casey\". No concurrent send crossed the transport boundary."
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk("model-authored prose that must be cleared"),
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_habit_cancel",
            function: {
              name: terminalToolName,
              arguments: `{"habit":"rsvp-demo","evidence":"capture:${"a".repeat(64)}"}`,
            },
          },
        ]),
      ]))
      .mockImplementationOnce(() => {
        throw new Error("provider must not be called after terminal projection")
      })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue(acknowledgement)
    const visibleText: string[] = []
    const onTextChunk = vi.fn((text: string) => { visibleText.push(text) })
    const onToolResult = vi.fn()
    const callbacks = makeCallbacks({
      onTextChunk,
      onClearText: vi.fn(() => { visibleText.length = 0 }),
      onToolResult,
    })
    const result = await runAgent(
      [{ role: "user", content: "Please end this report." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "cancel a habit from grounded ingress evidence",
            parameters: {
              type: "object",
              properties: { habit: { type: "string" }, evidence: { type: "string" } },
              required: ["habit", "evidence"],
              additionalProperties: false,
            },
          },
        }],
        execTool,
        toolContext: {
          signin: async () => undefined,
          agentRoot: "/tmp/synthetic-agent.ouro",
          currentIngressEvidence: {
            schemaVersion: 1,
            provider: "bluebubbles",
            captureKeyHash: "a".repeat(64),
          },
        },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith(
      terminalToolName,
      { habit: "rsvp-demo", evidence: `capture:${"a".repeat(64)}` },
      expect.objectContaining({
        agentRoot: "/tmp/synthetic-agent.ouro",
        currentIngressEvidence: expect.objectContaining({ captureKeyHash: "a".repeat(64) }),
      }),
    )
    expect(callbacks.onClearText).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolStart).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(terminalToolName, expect.any(String), true)
    expect(onTextChunk).toHaveBeenCalledTimes(2)
    expect(onTextChunk).toHaveBeenLastCalledWith(acknowledgement)
    expect(onToolResult).not.toHaveBeenCalled()
    expect(visibleText).toEqual([acknowledgement])
    expect(result).toMatchObject({
      outcome: "settled",
      completion: { answer: acknowledgement, intent: "complete" },
    })
  })

  it("does not expose preceding provider prose before a final-only terminal projection", async () => {
    const terminalToolName = "synthetic_final_only_terminal_projection"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic final-only terminal projection",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      handler: async () => "unused",
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: true,
      },
    })
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("untrusted provider narration"),
      makeChunk(undefined, [{
        index: 0,
        id: "call_final_only_terminal",
        function: { name: terminalToolName, arguments: "{}" },
      }]),
    ]))

    const acknowledgement = "Cancelled the habit from grounded evidence."
    const visibleText: string[] = []
    const callbacks = makeCallbacks({
      settleOutputMode: "final_only",
      onTextChunk: vi.fn((text: string) => { visibleText.push(text) }),
      // Models an irreversible callback owner: clear cannot retract writes.
      onClearText: vi.fn(),
    })
    const { runAgent } = await import("../../heart/core")
    const result = await runAgent(
      [{ role: "user", content: "cancel it" }],
      callbacks,
      "cli",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "synthetic final-only terminal projection",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        execTool: vi.fn().mockResolvedValue(acknowledgement),
        toolContext: { signin: async () => undefined },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(visibleText).toEqual([acknowledgement])
    expect(result).toMatchObject({
      outcome: "settled",
      completion: { answer: acknowledgement, intent: "complete" },
    })
  })

  it("fails a rejected terminal projection closed without asking the model to narrate success", async () => {
    const terminalToolName = "synthetic_terminal_projection_failure"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic metadata-driven terminal projection failure",
          parameters: {
            type: "object",
            properties: { habit: { type: "string" }, evidence: { type: "string" } },
            required: ["habit", "evidence"],
            additionalProperties: false,
          },
        },
      },
      handler: async () => "unused",
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: true,
      },
    })
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk("untrusted success prose"),
        makeChunk(undefined, [{
          index: 0,
          id: "call_terminal_failure",
          function: {
            name: terminalToolName,
            arguments: `{"habit":"rsvp-demo","evidence":"capture:${"a".repeat(64)}"}`,
          },
        }]),
      ]))
      .mockImplementationOnce(() => {
        throw new Error("provider must not be called after a terminal failure")
      })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockRejectedValue(new Error("durability unknown"))
    const visibleText: string[] = []
    const callbacks = makeCallbacks({
      onTextChunk: vi.fn((text: string) => { visibleText.push(text) }),
      onClearText: vi.fn(() => { visibleText.length = 0 }),
    })
    const result = await runAgent(
      [{ role: "user", content: "Please end this report." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "cancel a habit from grounded ingress evidence",
            parameters: {
              type: "object",
              properties: { habit: { type: "string" }, evidence: { type: "string" } },
              required: ["habit", "evidence"],
              additionalProperties: false,
            },
          },
        }],
        execTool,
        toolContext: { signin: async () => undefined },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(terminalToolName, expect.any(String), false)
    expect(visibleText).toEqual(["error: durability unknown"])
    expect(result).toMatchObject({
      outcome: "blocked",
      completion: { answer: "error: durability unknown", intent: "blocked" },
    })
  })

  it("rejects non-object terminal arguments before a default handler", async () => {
    const terminalToolName = "synthetic_terminal_projection_default_failure"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const handler = vi.fn(async () => Promise.reject("opaque terminal failure"))
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic terminal default-handler failure",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      handler,
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: false,
      },
    })
    mockCreate
      .mockReturnValueOnce(makeStream([makeChunk(undefined, [{
        index: 0,
        id: "call_terminal_default_failure",
        function: { name: terminalToolName, arguments: "[]" },
      }])]))
      .mockReturnValueOnce(makeStream([makeChunk(undefined, [{
        index: 0,
        id: "call_observe_after_terminal_rejection",
        function: { name: "observe", arguments: JSON.stringify({ reason: "rejected" }) },
      }])]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Please end this report." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "synthetic terminal default-handler failure",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        toolContext: { signin: async () => undefined },
      },
    )

    expect(handler).not.toHaveBeenCalled()
    expect(callbacks.onClearText).not.toHaveBeenCalled()
    expect(callbacks.onToolStart).not.toHaveBeenCalledWith(terminalToolName, expect.anything())
    expect(result.outcome).toBe("observed")
  })

  it("flushes ordinary buffered output and reports a string rejection from a terminal default handler", async () => {
    const terminalToolName = "synthetic_terminal_projection_string_failure"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const handler = vi.fn(async () => Promise.reject("opaque terminal failure"))
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic terminal string failure",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      handler,
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: false,
      },
    })
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("ordinary buffered prose"),
      makeChunk(undefined, [{
        index: 0,
        id: "call_terminal_string_failure",
        function: { name: terminalToolName, arguments: "{}" },
      }]),
    ]))
    const callbacks = makeCallbacks()
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent(
      [{ role: "user", content: "run it" }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "synthetic terminal string failure",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        toolContext: { signin: async () => undefined },
      },
    )

    expect(handler).toHaveBeenCalledTimes(1)
    expect(callbacks.onClearText).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(terminalToolName, expect.any(String), false)
    expect(callbacks.onTextChunk).toHaveBeenLastCalledWith("error: opaque terminal failure")
    expect(result).toMatchObject({
      outcome: "blocked",
      completion: { answer: "error: opaque terminal failure", intent: "blocked" },
    })
  })

  it("fails closed before terminal side effects when buffered-text clearing fails", async () => {
    const terminalToolName = "synthetic_terminal_projection_clear_failure"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic terminal clear failure",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      handler: async () => "unused",
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: true,
      },
    })
    mockCreate.mockReturnValueOnce(makeStream([
      makeChunk("buffered model prose"),
      makeChunk(undefined, [{
        index: 0,
        id: "call_terminal_clear_failure",
        function: { name: terminalToolName, arguments: "{}" },
      }]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("must not execute")
    const callbacks = makeCallbacks({
      onClearText: vi.fn(() => { throw new Error("synthetic clear failure") }),
    })
    const result = await runAgent(
      [{ role: "user", content: "Please end this report." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: terminalToolName,
            description: "synthetic terminal clear failure",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        }],
        execTool,
        toolContext: { signin: async () => undefined },
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "synthetic clear failure",
    }), "terminal")
    expect(result).toMatchObject({ outcome: "errored", error: expect.any(Error) })
  })

  it("A003 rejects a mixed terminal projection before every companion handler", async () => {
    const terminalToolName = "synthetic_terminal_projection"
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    baseToolDefinitions.push({
      tool: {
        type: "function",
        function: {
          name: terminalToolName,
          description: "synthetic metadata-driven terminal projection",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
      handler: async () => "unused",
      terminalProjection: {
        mode: "verbatim",
        requiresSoleCall: true,
        clearBufferedText: true,
      },
    })
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_mixed_cancel",
            function: {
              name: terminalToolName,
              arguments: `{"habit":"rsvp-demo","evidence":"capture:${"b".repeat(64)}"}`,
            },
          },
          {
            index: 1,
            id: "call_mixed_write",
            function: { name: "write_file", arguments: '{"path":"note.md","content":"side effect"}' },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_recovery_observe",
            function: { name: "observe", arguments: '{"reason":"mixed batch rejected"}' },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("side effect")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Please end this report." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        toolChoiceRequired: true,
        tools: [
          {
            type: "function",
            function: {
              name: terminalToolName,
              description: "cancel a habit",
              parameters: {
                type: "object",
                properties: { habit: { type: "string" }, evidence: { type: "string" } },
                required: ["habit", "evidence"],
                additionalProperties: false,
              },
            },
          },
          {
            type: "function",
            function: {
              name: "write_file",
              description: "write a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        execTool,
      },
    )

    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(execTool).not.toHaveBeenCalled()
    expect(execTool).not.toHaveBeenCalledWith(terminalToolName, expect.anything(), expect.anything())
    expect(result).toMatchObject({ outcome: "observed" })
  })

  it("rejects an entire malformed tool batch before any handler without an approval coordinator", async () => {
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [
      { index: 0, id: "call_valid_probe", function: { name: "probe", arguments: JSON.stringify({ value: "safe" }) } },
      { index: 1, id: "call_invalid_probe", function: { name: "probe", arguments: "{" } },
    ])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: "call_settle_after_invalid_batch",
      function: { name: "settle", arguments: JSON.stringify({ answer: "rejected", intent: "complete" }) },
    }])]))
    const execTool = vi.fn()
    const messages: any[] = [{ role: "user", content: "run both" }]
    const { runAgent } = await import("../../heart/core")

    const boundaryReceipts: unknown[] = []
    const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "probe",
          description: "test probe",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      }],
      execTool,
      toolContext: { signin: async () => undefined },
      toolBoundaryObserver: (receipt) => boundaryReceipts.push(receipt),
    })

    expect(result.outcome).toBe("settled")
    expect(execTool).not.toHaveBeenCalled()
    expectProviderOnlyRejection(messages, "call_valid_probe", "another call in this batch had invalid arguments")
    expect(boundaryReceipts).toEqual([
      expect.objectContaining({ name: "probe", reason: "invalid_arguments", invoked: false }),
      expect.objectContaining({ name: "probe", reason: "invalid_arguments", invoked: false }),
    ])
  })

  it("rejects duplicate provider tool-call ids before argument lookup or handlers", async () => {
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [
      { index: 0, id: "duplicate", function: { name: "probe", arguments: JSON.stringify({ value: "first" }) } },
      { index: 1, id: "duplicate", function: { name: "probe", arguments: JSON.stringify({ value: "second" }) } },
    ])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: "call_settle_after_duplicate",
      function: { name: "settle", arguments: JSON.stringify({ answer: "rejected", intent: "complete" }) },
    }])]))
    const execTool = vi.fn()
    const messages: any[] = [{ role: "user", content: "run probes" }]
    const { runAgent } = await import("../../heart/core")

    await runAgent(messages, makeCallbacks(), "cli", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "probe",
          description: "test probe",
          parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
      }],
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(execTool).not.toHaveBeenCalled()
    expectProviderOnlyRejection(messages, "duplicate", "duplicate tool call id")
    expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1)
    expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
  })

  it.each([
    ["observe", "bluebubbles", "{"] as const,
    ["rest", "inner", "null"] as const,
  ])("validates malformed terminal %s arguments before terminal handling", async (name, channel, rawArguments) => {
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: `call_invalid_${name}`,
      function: { name, arguments: rawArguments },
    }])]))
    mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [{
      index: 0,
      id: channel === "inner" ? "call_valid_rest" : "call_valid_observe",
      function: channel === "inner"
        ? { name: "rest", arguments: "{}" }
        : { name: "observe", arguments: JSON.stringify({ reason: "done" }) },
    }])]))
    const messages: any[] = [{ role: "user", content: "finish" }]
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent(messages, makeCallbacks(), channel, undefined, {
      toolContext: { signin: async () => undefined },
    })

    expectProviderOnlyRejection(messages, `call_invalid_${name}`, "invalid tool arguments")
    expect(result.outcome).toBe(channel === "inner" ? "rested" : "observed")
  })

  it("stops at eight accepted provider responses before resolving the eighth tool handler", async () => {
    let response = 0
    mockCreate.mockImplementation(() => {
      response += 1
      return makeStream([makeChunk(undefined, [{
        index: 0,
        id: `call_probe_${response}`,
        function: { name: "probe", arguments: JSON.stringify({ value: `iteration-${response}` }) },
      }])])
    })
    const execTool = vi.fn().mockResolvedValue("ok")
    const { runAgent } = await import("../../heart/core")

    const result = await runAgent([{ role: "user", content: "keep probing" }], makeCallbacks(), "cli", undefined, {
      tools: [{
        type: "function",
        function: {
          name: "probe",
          description: "test probe",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      }],
      execTool,
      toolContext: { signin: async () => undefined },
    })

    expect(mockCreate).toHaveBeenCalledTimes(8)
    expect(execTool).toHaveBeenCalledTimes(7)
    expect(execTool).not.toHaveBeenCalledWith("probe", { value: "iteration-8" }, expect.anything())
    expect(result).toMatchObject({ outcome: "errored", error: expect.objectContaining({ message: expect.stringContaining("8") }) })
  })

  describe("approval suspension boundary", () => {
    function streamedCall(name: string, rawArguments: string, id = `call_${name}`) {
      return makeStream([makeChunk(undefined, [{
        index: 0,
        id,
        function: { name, arguments: rawArguments },
      }])])
    }

    function settled(answer = "done") {
      return streamedCall("settle", JSON.stringify({ answer, intent: "complete" }), "call_settle_after_rejection")
    }

    it("carries the one live standing-policy classification into the exact dispatch without rereading it", async () => {
      const policy = {
        schemaVersion: 1,
        version: 1,
        desiredStates: {},
        routineActionGrants: {
          "unraid.restart:calibre-web": { action: "unraid.container.restart", targets: ["calibre-web"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated", issuer: "ari", authorizedAt: "2026-08-29T17:00:00.000Z", authorizingSessionEvent: "evt-1", version: 1 },
        },
        updatedAt: "2026-08-29T17:00:00.000Z",
      }
      vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith("steward.json"))
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json") ? JSON.stringify(policy) : defaultReadFileSync(filePath))
      const { resolveToolDefinition } = await import("../../repertoire/tools")
      const tool = resolveToolDefinition("unraid_restart_container")!.tool
      mockCreate.mockReturnValueOnce(streamedCall("unraid_restart_container", JSON.stringify({ container: "calibre-web" }), "call_routine_restart"))
      const controller = new AbortController()
      const execTool = vi.fn(async () => { controller.abort(); return JSON.stringify({ ok: true }) })
      const propose = vi.fn()
      const relationshipAuthorization = { authorizedContextScopes: [], advertisedToolNames: ["unraid_restart_container"], actor: { friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-2" }, authorizeTool: vi.fn(async () => ({ allowed: true as const, receiptId: "relationship-1", profileVersion: 7 })) }
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "restart calibre-web" }], makeCallbacks(), "cli", controller.signal, {
        tools: [tool], execTool, approvalCoordinator: { propose },
        toolContext: { signin: async () => undefined, agentRoot: "/mock/repo/testagent", relationshipAuthorization },
      } as any)

      expect(propose).not.toHaveBeenCalled()
      expect(result.outcome).not.toBe("errored")
      expect(mockCreate).toHaveBeenCalledOnce()
      expect(execTool).toHaveBeenCalledWith("unraid_restart_container", { container: "calibre-web" }, expect.objectContaining({ routineActionSelection: { key: "unraid.restart:calibre-web", target: "calibre-web", expectedPolicyVersion: 1 } }))
      expect(relationshipAuthorization.authorizeTool).toHaveBeenCalledOnce()
    })

    it("executes the exact family standing-policy restart without an approval coordinator", async () => {
      const policy = {
        schemaVersion: 1,
        version: 1,
        desiredStates: {},
        routineActionGrants: {
          "unraid.restart:calibre-web": { action: "unraid.container.restart", targets: ["calibre-web"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated", issuer: "ari", authorizedAt: "2026-08-29T17:00:00.000Z", authorizingSessionEvent: "evt-1", version: 1 },
        },
        updatedAt: "2026-08-29T17:00:00.000Z",
      }
      vi.mocked(fs.existsSync).mockImplementation((filePath) => String(filePath).endsWith("steward.json"))
      vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => String(filePath).endsWith("steward.json") ? JSON.stringify(policy) : defaultReadFileSync(filePath))
      const { resolveToolDefinition } = await import("../../repertoire/tools")
      const tool = resolveToolDefinition("unraid_restart_container")!.tool
      mockCreate.mockReturnValueOnce(streamedCall("unraid_restart_container", JSON.stringify({ container: "calibre-web" }), "call_routine_restart_without_coordinator"))
      const controller = new AbortController()
      const execTool = vi.fn(async () => { controller.abort(); return JSON.stringify({ ok: true }) })
      const relationshipAuthorization = { authorizedContextScopes: [], advertisedToolNames: ["unraid_restart_container"], actor: { friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-2" }, authorizeTool: vi.fn(async () => ({ allowed: true as const, receiptId: "relationship-1", profileVersion: 7 })) }
      const { runAgent } = await import("../../heart/core")

      await runAgent([{ role: "user", content: "restart calibre-web" }], makeCallbacks(), "inner", controller.signal, {
        tools: [tool], execTool,
        toolContext: { signin: async () => undefined, agentRoot: "/mock/repo/testagent", relationshipAuthorization },
      } as any)

      expect(execTool).toHaveBeenCalledWith("unraid_restart_container", { container: "calibre-web" }, expect.objectContaining({ routineActionSelection: { key: "unraid.restart:calibre-web", target: "calibre-web", expectedPolicyVersion: 1 } }))
      expect(relationshipAuthorization.authorizeTool).toHaveBeenCalledOnce()
    })

    it("fails a protected call closed before its handler when no approval coordinator exists", async () => {
      mockCreate.mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "docker restart calibre-web" }), "call_uncoordinated_restart"))
      mockCreate.mockReturnValueOnce(settled("protected call rejected"))
      const execTool = vi.fn()
      const messages: any[] = [{ role: "user", content: "restart calibre-web" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
      } as any)

      expect(result.outcome).toBe("settled")
      expect(execTool).not.toHaveBeenCalled()
      expectProviderOnlyRejection(messages, "call_uncoordinated_restart", "approval coordinator is unavailable")
    })

    it("suspends the exact Docker restart before the shell handler despite its low-risk profile", async () => {
      mockCreate.mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "docker restart calibre-web" }), "call_restart"))
      mockCreate.mockReturnValueOnce(settled("unexpected continuation"))
      const execTool = vi.fn().mockResolvedValue("should never execute")
      const propose = vi.fn().mockResolvedValue({
        approvalId: "11111111-1111-4111-8111-111111111111",
        checkpointDigest: "a".repeat(64),
        suspendedSessionRevision: "b".repeat(64),
      })
      const messages: any[] = [{ role: "user", content: "restart calibre-web" }]
      const toolContext = { signin: async () => undefined }
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext,
        approvalCoordinator: { propose },
      } as any)

      expect(result).toMatchObject({
        outcome: "suspended",
        suspension: { approvalId: "11111111-1111-4111-8111-111111111111", toolCallId: "call_restart" },
      })
      expect(execTool).not.toHaveBeenCalled()
      expect(propose).toHaveBeenCalledTimes(1)
      expect(propose).toHaveBeenCalledWith(expect.objectContaining({
        toolCall: expect.objectContaining({
          id: "call_restart",
          function: expect.objectContaining({ name: "shell" }),
        }),
        arguments: { command: "docker restart calibre-web" },
        preCallMessages: [{ role: "user", content: "restart calibre-web" }],
        liveToolContext: expect.objectContaining(toolContext),
      }))
    })

    it("keeps a terminal-answer correction out of an approval suspension checkpoint", async () => {
      const correction = "Use current evidence before proposing an action."
      mockCreate
        .mockReturnValueOnce(makeStream([makeChunk("Everything is already fine.")]))
        .mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "docker restart calibre-web" }), "call_restart_after_correction"))
      const propose = vi.fn().mockResolvedValue({
        approvalId: "11111111-1111-4111-8111-111111111111",
        checkpointDigest: "a".repeat(64),
        suspendedSessionRevision: "b".repeat(64),
      })
      const { resolveToolDefinition } = await import("../../repertoire/tools")
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "restart calibre-web" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "telegram", undefined, {
        tools: [resolveToolDefinition("shell")!.tool],
        execTool: vi.fn(),
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
        requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer.includes("already fine") ? correction : undefined },
      })

      expect(result.outcome).toBe("suspended")
      expect(propose).toHaveBeenCalledWith(expect.objectContaining({
        preCallMessages: [{ role: "user", content: "restart calibre-web" }],
      }))
      expect(JSON.stringify(propose.mock.calls)).not.toContain(correction)
      expect(JSON.stringify(messages)).not.toContain(correction)
    })

    it("freezes intervening assistant and tool messages when protection is reached later in the same loop", async () => {
      mockCreate.mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "printf ready" }), "call_prepare"))
      mockCreate.mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "docker restart calibre-web" }), "call_restart_after_prepare"))
      const execTool = vi.fn().mockResolvedValue("ready")
      const propose = vi.fn().mockResolvedValue({
        approvalId: "11111111-1111-4111-8111-111111111111",
        checkpointDigest: "a".repeat(64),
        suspendedSessionRevision: "b".repeat(64),
      })
      const { runAgent } = await import("../../heart/core")

      await runAgent([{ role: "user", content: "prepare then restart" }], makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(propose).toHaveBeenCalledWith(expect.objectContaining({
        preCallMessages: [
          { role: "user", content: "prepare then restart" },
          expect.objectContaining({ role: "assistant", tool_calls: [expect.objectContaining({ id: "call_prepare" })] }),
          { role: "tool", tool_call_id: "call_prepare", content: "ready" },
        ],
      }))
    })

    it.each([
      ["protected first", [
        { index: 0, id: "call_restart", function: { name: "shell", arguments: JSON.stringify({ command: "docker restart calibre-web" }) } },
        { index: 1, id: "call_read", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/status" }) } },
      ]],
      ["protected last", [
        { index: 0, id: "call_read", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/status" }) } },
        { index: 1, id: "call_restart", function: { name: "shell", arguments: JSON.stringify({ command: "docker restart calibre-web" }) } },
      ]],
      ["multiple protected", [
        { index: 0, id: "call_restart_a", function: { name: "shell", arguments: JSON.stringify({ command: "docker restart calibre-web" }) } },
        { index: 1, id: "call_restart_b", function: { name: "shell", arguments: JSON.stringify({ command: "docker restart other" }) } },
      ]],
    ])("rejects the whole %s batch before every handler", async (_label, calls) => {
      mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, calls)]))
      mockCreate.mockReturnValueOnce(settled("batch rejected"))
      const execTool = vi.fn().mockResolvedValue("should never execute")
      const propose = vi.fn()
      const messages: any[] = [{ role: "user", content: "mixed request" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(result.outcome).toBe("settled")
      expect(execTool).not.toHaveBeenCalled()
      expect(propose).not.toHaveBeenCalled()
      for (const entry of calls) expectProviderOnlyRejection(messages, entry.id, "approval-eligible tool must be the sole call")
    })

    it.each([
      ["malformed JSON", "{"],
      ["null", "null"],
      ["array", "[]"],
      ["string", JSON.stringify("restart")],
      ["number", "42"],
      ["boolean", "true"],
      ["missing required command", "{}"],
      ["wrong command type", JSON.stringify({ command: 42 })],
      ["prohibited extra property", JSON.stringify({ command: "docker restart calibre-web", surprise: true })],
    ])("rejects %s before proposal persistence or handler execution", async (_label, rawArguments) => {
      mockCreate.mockReset()
      mockCreate.mockReturnValueOnce(streamedCall("shell", rawArguments, "call_invalid_restart"))
      mockCreate.mockReturnValueOnce(settled("invalid arguments rejected"))
      const execTool = vi.fn().mockResolvedValue("should never execute")
      const propose = vi.fn()
      const messages: any[] = [{ role: "user", content: "restart it" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(result.outcome).toBe("settled")
      expect(propose).not.toHaveBeenCalled()
      expect(execTool).not.toHaveBeenCalled()
      expectProviderOnlyRejection(messages, "call_invalid_restart", "invalid tool arguments")
    })

    it.each([
      ["unadvertised tool", "not_advertised", [], JSON.stringify({ command: "docker restart calibre-web" }), "was not advertised"],
      ["invalid advertised schema", "shell", [{
        type: "function",
        function: {
          name: "shell",
          description: "invalid schema fixture",
          parameters: { type: "not-a-json-schema-type" },
        },
      }], JSON.stringify({ command: "docker restart calibre-web" }), "invalid tool arguments"],
    ])("fails closed for %s before proposal or execution", async (_label, name, tools, rawArguments, expectedFragment) => {
      mockCreate.mockReset()
      mockCreate.mockReturnValueOnce(streamedCall(name, rawArguments, "call_schema_drift"))
      mockCreate.mockReturnValueOnce(settled("schema rejected"))
      const execTool = vi.fn()
      const propose = vi.fn()
      const messages: any[] = [{ role: "user", content: "restart it" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        tools,
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(result.outcome).toBe("settled")
      expect(execTool).not.toHaveBeenCalled()
      expect(propose).not.toHaveBeenCalled()
      expectProviderOnlyRejection(messages, "call_schema_drift", expectedFragment)
    })

    it("rejects every valid companion when one call in the batch has invalid arguments", async () => {
      mockCreate.mockReset()
      mockCreate.mockReturnValueOnce(makeStream([makeChunk(undefined, [
        { index: 0, id: "call_invalid", function: { name: "shell", arguments: "{}" } },
        { index: 1, id: "call_valid", function: { name: "read_file", arguments: JSON.stringify({ path: "/tmp/status" }) } },
      ])]))
      mockCreate.mockReturnValueOnce(settled("batch rejected"))
      const execTool = vi.fn()
      const propose = vi.fn()
      const messages: any[] = [{ role: "user", content: "restart and inspect" }]
      const { runAgent } = await import("../../heart/core")

      await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(execTool).not.toHaveBeenCalled()
      expect(propose).not.toHaveBeenCalled()
      expectProviderOnlyRejection(messages, "call_valid", "another call in this batch had invalid arguments")
    })

    it("keeps genuinely non-protected low-risk shell calls unchanged", async () => {
      mockCreate.mockReturnValueOnce(streamedCall("shell", JSON.stringify({ command: "printf ok" }), "call_safe_shell"))
      mockCreate.mockReturnValueOnce(settled("safe call finished"))
      const execTool = vi.fn().mockResolvedValue("ok")
      const propose = vi.fn()
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "print ok" }], makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
        approvalCoordinator: { propose },
      } as any)

      expect(result.outcome).toBe("settled")
      expect(execTool).toHaveBeenCalledTimes(1)
      expect(execTool).toHaveBeenCalledWith("shell", { command: "printf ok" }, expect.anything())
      expect(propose).not.toHaveBeenCalled()
    })
  })

  describe("A003 attempt-local truth", () => {
    const probeTool = {
      type: "function" as const,
      function: { name: "probe", description: "bounded test read", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } },
    }
    const call = (name: string, id: string, args: unknown = { value: "safe" }) => ({ name, id, arguments: JSON.stringify(args) })
    const response = (content: string, toolCalls: TurnResult["toolCalls"] = []): TurnResult => ({ content, toolCalls, outputItems: [] })
    function runtimeFor(
      script: TurnResult[],
      canonical: ChatCompletionMessageParam[],
    ) {
      const views: ChatCompletionMessageParam[][] = []
      const callerViews: ChatCompletionMessageParam[][] = []
      const runtime: ProviderRuntime = {
        id: "minimax", model: "a003-fixture", client: {} as never, capabilities: new Set(),
        streamTurn: vi.fn(async (request) => {
          views.push(structuredClone(request.messages))
          callerViews.push(structuredClone(canonical))
          return script[views.length - 1] ?? response("accepted")
        }),
        resetTurnState: vi.fn(), appendToolOutput: vi.fn(), ping: vi.fn(), classifyError: () => "unknown",
      }
      return { runtime, views, callerViews }
    }

    it.each(["text", "settle"] as const)("keeps %s rejections in one scratch block, consumes each correction, and preserves identical human text", async (kind) => {
      const correction = "Use current evidence."
      const secondCorrection = "Use the newly returned evidence."
      const human = { role: "user" as const, content: correction }
      const messages: ChatCompletionMessageParam[] = [human]
      const rejected = (text: string, id: string) => kind === "text" ? response(text) : response("", [call("settle", id, { answer: text, intent: "complete" })])
      const { runtime, views, callerViews } = runtimeFor([
        rejected("draft-one", "rejected-1"), rejected("draft-two", "rejected-2"),
        response("accepted read", [call("probe", "accepted-read")]),
        response("", [call("settle", "accepted-final", { answer: "accepted final", intent: "complete" })]),
      ], messages)
      const persisted: ChatCompletionMessageParam[][] = []
      const captured = vi.fn()
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, makeCallbacks({ settleOutputMode: "final_only", onToolResult: (current) => persisted.push(structuredClone(current)) }), undefined, undefined, {
        tools: [probeTool], providerRuntimeOverride: runtime, execTool: vi.fn(async () => "receipt"),
        captureGeneratedMessages: captured,
        requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer === "draft-one" ? correction : answer === "draft-two" ? secondCorrection : undefined },
      })
      expect(result.outcome).toBe("settled")
      expect(callerViews[1]).toEqual([human])
      expect(callerViews[2]).toEqual([human])
      expect(views[1]?.filter((message) => message.role === "user").map((message) => message.content)).toEqual([correction, correction])
      expect(JSON.stringify(views[1])).toContain("draft-one")
      expect(JSON.stringify(views[2])).toContain("draft-two")
      expect(JSON.stringify(views[2])).not.toContain("draft-one")
      expect(views[2]?.filter((message) => message.role === "user").map((message) => message.content)).toEqual([correction, secondCorrection])
      expect(views[3]).toEqual(callerViews[3])
      expect(JSON.stringify([messages, captured.mock.calls, persisted])).not.toMatch(/draft-one|draft-two|newly returned/)
      expect(messages.filter((message) => message.role === "user")).toEqual([human])
      expect(captured).toHaveBeenCalledExactlyOnceWith(messages.slice(1))
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(2)
      expect(messages.filter((message) => message.role === "tool")).toHaveLength(2)
      expect(persisted).toHaveLength(1)
      const laterViews: ChatCompletionMessageParam[][] = []
      runtime.streamTurn = vi.fn(async (request) => { laterViews.push(structuredClone(request.messages)); return response("next accepted") })
      messages.push({ role: "user", content: "next human turn" })
      await runAgent(messages, makeCallbacks(), undefined, undefined, { providerRuntimeOverride: runtime })
      expect(JSON.stringify(laterViews)).not.toMatch(/draft-one|draft-two|newly returned/)
    })

    it.each(["text", "settle"] as const)("keeps missing-required-tool controls out of caller state before %s acceptance", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "read it" }]
      const { runtime, callerViews, views } = runtimeFor([
        kind === "text" ? response("unsupported draft") : response("", [call("settle", "bad", { answer: "unsupported draft" })]),
        response("", [call("probe", "read")]), response("accepted"),
      ], messages)
      const capture = vi.fn()
      const { runAgent } = await import("../../heart/core")
      await runAgent(messages, makeCallbacks(), undefined, undefined, {
        tools: [probeTool], execTool: vi.fn(async () => "real receipt"), providerRuntimeOverride: runtime, captureGeneratedMessages: capture,
        requiredToolCalls: { names: ["probe"], retryMessage: "Read before answering." },
      })
      expect(callerViews[1]).toEqual([{ role: "user", content: "read it" }])
      expect(views[1]?.at(-1)).toEqual({ role: "user", content: "Read before answering. Missing required tool calls: probe." })
      expect(JSON.stringify(views[1])).toContain("unsupported draft")
      expect(views[2]).toEqual(callerViews[2])
      expect(JSON.stringify([messages, capture.mock.calls])).not.toMatch(/unsupported draft|Missing required tool calls/)
    })

    it.each(["network-error", "rate-limit", "auth-failure", "overflow", "refresh-failure", "abort-sleep"] as const)("freezes attempt control/scratch across %s and provider replacement", async (kind) => {
      vi.useFakeTimers()
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "original" }]
      const views: ChatCompletionMessageParam[][] = []
      const callerViews: ChatCompletionMessageParam[][] = []
      const controller = new AbortController()
      const streamTurn: ProviderRuntime["streamTurn"] = vi.fn(async (request) => {
        views.push(structuredClone(request.messages))
        callerViews.push(structuredClone(messages))
        if (views.length === 1) return response("rejected draft")
        if (views.length === 2) throw Object.assign(new Error(kind === "overflow" ? "context_length_exceeded" : "operational retry"), { code: kind === "overflow" ? "context_length_exceeded" : "EAGAIN" })
        if (views.length === 3) return response("", [call("probe", "accepted-read")])
        return response("accepted")
      })
      const first = runtimeFor([], messages).runtime
      first.streamTurn = streamTurn
      first.classifyError = () => kind === "auth-failure" ? "auth-failure" : kind === "rate-limit" ? "rate-limit" : "network-error"
      if (kind === "auth-failure") first.id = "openai-codex"
      const replacement = { ...first, id: "minimax" as const, resetTurnState: vi.fn() }
      const refresh = vi.fn(async () => { if (kind === "refresh-failure") throw new Error("refresh failed"); return {} })
      vi.doMock("../../heart/provider-credentials", async () => ({
        ...await vi.importActual<typeof import("../../heart/provider-credentials")>("../../heart/provider-credentials"),
        refreshProviderCredentialPool: refresh,
      }))
      vi.doMock("../../heart/providers/openai-codex-token", () => ({ refreshOpenAICodexProviderCredentials: vi.fn(async () => ({ ok: false })) }))
      vi.doMock("../../heart/providers/minimax", () => ({ createMinimaxProviderRuntime: () => replacement }))
      try {
        const { runAgent } = await import("../../heart/core")
        const capture = vi.fn()
        const callbacks = makeCallbacks({ onError: (_error, severity) => { if (kind === "abort-sleep" && severity === "transient") setTimeout(() => controller.abort(), 100) } })
        const promise = runAgent(messages, callbacks, undefined, controller.signal, {
          tools: [probeTool], execTool: vi.fn(async () => "real receipt"), providerRuntimeOverride: first, captureGeneratedMessages: capture,
          requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer === "rejected draft" ? "attempt-only correction" : undefined },
        })
        await vi.advanceTimersByTimeAsync(2200)
        await vi.advanceTimersByTimeAsync(4200)
        await vi.advanceTimersByTimeAsync(100)
        const result = await promise
        expect(result.outcome).toBe(kind === "abort-sleep" ? "aborted" : "settled")
        expect(callerViews.every((view) => !JSON.stringify(view).match(/attempt-only correction|rejected draft/))).toBe(true)
        if (kind !== "abort-sleep") {
          expect(views[2]).toEqual(views[1])
          expect(views[1]?.at(-1)).toEqual({ role: "user", content: "attempt-only correction" })
          expect(JSON.stringify(views[1])).toContain("rejected draft")
          expect(views[3]).toEqual(callerViews[3])
        }
        expect(JSON.stringify([messages, capture.mock.calls])).not.toMatch(/attempt-only correction|rejected draft/)
        if (kind !== "overflow") expect(refresh).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
        vi.doUnmock("../../heart/provider-credentials")
        vi.doUnmock("../../heart/providers/minimax")
        vi.doUnmock("../../heart/providers/openai-codex-token")
      }
    })

    it.each(["ordinary request", "this exact request previously reached a tool that is advertised again now."])("keeps historical-effect retries local even when a real request equals control text: %s", async (request) => {
      const args = { path: "note.txt", content: "approved" }
      const messages: ChatCompletionMessageParam[] = [
        { role: "user", content: request },
        { role: "assistant", content: null, tool_calls: [{ type: "function", id: "previous-effect", function: { name: "write_file", arguments: JSON.stringify(args) } }] },
        { role: "tool", tool_call_id: "previous-effect", content: "error: write failed" },
        { role: "user", content: request },
      ]
      const before = structuredClone(messages)
      const { runtime, views, callerViews } = runtimeFor([response("rejected completion"), response("", [call("write_file", "retry-effect", args)]), response("accepted")], messages)
      const capture = vi.fn()
      const execTool = vi.fn(async () => "written")
      const { runAgent } = await import("../../heart/core")
      await runAgent(messages, makeCallbacks(), undefined, undefined, {
        providerRuntimeOverride: runtime, captureGeneratedMessages: capture, execTool,
        tools: [{ type: "function", function: { name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } }],
      })
      expect(execTool).toHaveBeenCalledExactlyOnceWith("write_file", args, undefined)
      expect(callerViews[1]).toEqual(before)
      expect(JSON.stringify(views[1])).toContain("rejected completion")
      expect(JSON.stringify(capture.mock.calls)).not.toContain("rejected completion")
      expect(messages.filter((message) => message.role === "user")).toEqual(before.filter((message) => message.role === "user"))
    })

    it("uses source rather than the correction-text blacklist for the latest real human request", async () => {
      const realCorrectionText = "no tool was called this turn. you must end every turn by calling settle with your answer (or ponder/observe). emit the tool call now."
      const messages: ChatCompletionMessageParam[] = [
        { role: "user", content: "Think privately and come back to me later." },
        { role: "assistant", content: "What next?" },
        { role: "user", content: realCorrectionText },
      ]
      const { runtime, views } = runtimeFor([response("The private pass is queued; I will come back to you.")], messages)
      const { runAgent } = await import("../../heart/core")
      await runAgent(messages, makeCallbacks(), undefined, undefined, { providerRuntimeOverride: runtime })
      expect(views).toHaveLength(1)
      expect(messages[2]?.content).toBe(realCorrectionText)
    })

    it.each([
      ["malformed", [call("probe", "safe"), { name: "probe", id: "invalid", arguments: "{" }]],
      ["unadvertised", [call("probe", "safe"), call("not_advertised", "invalid")]],
      ["sole-call", [call("probe", "safe"), call("observe", "invalid", {})]],
      ["required-dispatch", [call("probe", "safe"), call("probe", "invalid", { value: "blocked" })]],
    ] as const)("rejects the entire %s batch before any sibling, generated history, or persistence", async (kind, batch) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "test batch" }]
      const { runtime, callerViews, views } = runtimeFor([response("rejected prose", [...batch]), response("", [call("observe", "accepted", {})])], messages)
      const execTool = vi.fn(async () => "receipt")
      const propose = vi.fn()
      const persist = vi.fn()
      const capture = vi.fn()
      const callbacks = makeCallbacks({ onToolResult: persist, settleOutputMode: "final_only" })
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, callbacks, undefined, undefined, {
        tools: [probeTool], execTool, providerRuntimeOverride: runtime, captureGeneratedMessages: capture,
        approvalCoordinator: { propose },
        requiredToolCalls: { names: [], retryMessage: "unused", validateToolCallBeforeDispatch: (_name, args) => kind === "required-dispatch" && args.value === "blocked" ? "dependency missing" : undefined },
      })
      expect(result.outcome).toBe("observed")
      expect(execTool).not.toHaveBeenCalled()
      expect(propose).not.toHaveBeenCalled()
      expect(persist).not.toHaveBeenCalled()
      expect(callerViews[1]).toEqual([{ role: "user", content: "test batch" }])
      expect(JSON.stringify(views[1])).toContain("rejected prose")
      expect(JSON.stringify([messages, capture.mock.calls])).not.toMatch(/rejected prose|invalid|dependency missing|"safe"/)
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1)
      expect(messages.filter((message) => message.role === "tool")).toEqual([{ role: "tool", tool_call_id: "accepted", content: "(silenced)" }])
    })

    it.each(["success", "failure"] as const)("promotes accepted tool/result exactly once after handler %s", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "read once" }]
      const { runtime } = runtimeFor([response("accepted", [call("probe", "real-effect")]), response("final")], messages)
      const capture = vi.fn()
      const persisted: ChatCompletionMessageParam[][] = []
      const execTool = vi.fn(async () => { if (kind === "failure") throw new Error("real execution failed"); return "real receipt" })
      const { runAgent } = await import("../../heart/core")
      await runAgent(messages, makeCallbacks({ onToolResult: (current) => persisted.push(structuredClone(current)) }), undefined, undefined, {
        tools: [probeTool], execTool, providerRuntimeOverride: runtime, captureGeneratedMessages: capture,
      })
      expect(execTool).toHaveBeenCalledOnce()
      expect(messages.filter((message) => message.role === "tool")).toEqual([{
        role: "tool", tool_call_id: "real-effect", content: kind === "success" ? "real receipt" : "error: Error: real execution failed",
      }])
      expect(capture).toHaveBeenCalledExactlyOnceWith(messages.slice(1))
      expect(persisted).toHaveLength(1)
      expect(persisted[0]).toEqual(messages.slice(0, 3))
    })

    it.each(["terminal-error", "abort", "overflow"] as const)("retains the accepted execution receipt through later provider %s", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "perform the read" }]
      const { runtime } = runtimeFor([response("accepted read", [call("probe", "completed-read")]), response("accepted final")], messages)
      const stream = runtime.streamTurn
      const controller = new AbortController()
      let attempts = 0
      runtime.streamTurn = vi.fn(async (request) => {
        if (++attempts === 2) {
          if (kind === "terminal-error") return { ...response("invalid terminal"), settleFinalization: { ok: false, errorCode: "invalid_settle_arguments" } }
          if (kind === "abort") controller.abort()
          throw Object.assign(new Error(kind), kind === "overflow" ? { code: "context_length_exceeded" } : {})
        }
        return stream(request)
      })
      const capture = vi.fn()
      const persisted: ChatCompletionMessageParam[][] = []
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, makeCallbacks({ onToolResult: (current) => persisted.push(structuredClone(current)) }), undefined, controller.signal, {
        tools: [probeTool], providerRuntimeOverride: runtime, execTool: vi.fn(async () => "verified execution receipt"), captureGeneratedMessages: capture,
      })
      expect(result.outcome).toBe(kind === "terminal-error" ? "errored" : kind === "abort" ? "aborted" : "settled")
      expect(persisted).toHaveLength(1)
      const generated = capture.mock.calls[0]![0] as ChatCompletionMessageParam[]
      expect(generated.filter((message) => message.role === "tool")).toEqual([{ role: "tool", tool_call_id: "completed-read", content: "verified execution receipt" }])
      expect(generated.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls?.map((entry) => entry.id) ?? [])).toEqual(["completed-read"])
      if (kind !== "overflow") expect(messages).toContainEqual({ role: "tool", tool_call_id: "completed-read", content: "verified execution receipt" })
    })

    it.each(["dependent-validation", "tool-end-observer"] as const)("promotes a completed handler receipt before %s can fail", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "perform the read" }]
      const { runtime } = runtimeFor([response("accepted read", [call("probe", "completed-before-hook")])], messages)
      const receipt = '{"ok":true,"receipt":"completed"}'
      const capture = vi.fn()
      const callbacks = makeCallbacks()
      if (kind === "tool-end-observer") callbacks.onToolEnd = () => { throw new Error("observer failed") }
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, callbacks, undefined, undefined, {
        tools: [probeTool], providerRuntimeOverride: runtime, execTool: vi.fn(async () => receipt), captureGeneratedMessages: capture,
        ...(kind === "dependent-validation" ? { requiredToolCalls: { names: ["probe"], retryMessage: "read", requireSuccessfulResults: true, validateRequiredToolResult: () => true, requiredToolCallsAfterResult: () => ["not-advertised"] } } : {}),
      })
      expect(result.outcome).toBe("errored")
      const expected = { role: "tool", tool_call_id: "completed-before-hook", content: receipt }
      expect(messages.filter((message) => message.role === "tool")).toEqual([expected])
      expect(capture.mock.calls[0]![0].filter((message: ChatCompletionMessageParam) => message.role === "tool")).toEqual([expected])
    })

    it.each(["outer-thinking", "inner-thinking", "private-return"] as const)("does not promote %s scratch or its synthetic nudge", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: kind === "private-return" ? "Think about this privately and come back to me later." : "actual request" }]
      const rejected = kind === "private-return" ? "The private pass is queued; I will come back to you." : "<think>rejected scratch</think>"
      const { runtime, views, callerViews } = runtimeFor([response(rejected), response("", [call(kind === "inner-thinking" ? "rest" : "observe", "accepted", {})])], messages)
      const captured = vi.fn()
      const { runAgent } = await import("../../heart/core")
      await runAgent(messages, makeCallbacks(), kind === "inner-thinking" ? "inner" : undefined, undefined, { providerRuntimeOverride: runtime, captureGeneratedMessages: captured })
      expect(views).toHaveLength(2)
      expect(callerViews[1]?.filter((message) => message.role !== "system")).toEqual([expect.objectContaining({ role: "user", content: messages.find((message) => message.role === "user")!.content })])
      expect(views[1]?.at(-1)?.role).toBe("user")
      expect(JSON.stringify([messages, captured.mock.calls])).not.toContain(rejected)
      expect(messages.filter((message) => message.role === "user")).toHaveLength(1)
    })

    it("rejects a private-return settle acknowledgement before accepting a truthful blocked answer", async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "Think privately and come back to me later." }]
      const { runtime, callerViews, views } = runtimeFor([
        response("", [call("settle", "private-rejected", { answer: "The private pass is queued; I will come back to you.", intent: "complete" })]),
        response("", [call("settle", "blocked-accepted", { answer: "I could not start that work.", intent: "blocked" })]),
      ], messages)
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, makeCallbacks({ settleOutputMode: "final_only" }), undefined, undefined, { providerRuntimeOverride: runtime })
      expect(result.outcome).toBe("blocked")
      expect(callerViews[1]).toEqual([messages[0]])
      expect(JSON.stringify(views[1])).toContain("private-rejected")
      expect(JSON.stringify(messages)).not.toContain("private-rejected")
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(1)
    })

    it("discards all rejected reasoning and controls when private-return retries become a deterministic blocked answer", async () => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "Think privately and come back to me later." }]
      const { runtime, callerViews } = runtimeFor([1, 2, 3].map((index) => response(`<think>REJECTED_REASONING_${index}</think>The private pass is queued; I will come back to you.`)), messages)
      const capture = vi.fn()
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, makeCallbacks(), undefined, undefined, { providerRuntimeOverride: runtime, captureGeneratedMessages: capture })
      expect(result.outcome).toBe("blocked")
      expect(callerViews).toHaveLength(3)
      expect(callerViews.every((view) => view.length === 1)).toBe(true)
      expect(JSON.stringify([messages, capture.mock.calls])).not.toMatch(/REJECTED_REASONING|no ponder packet|Emit the ponder/)
      expect(messages).toHaveLength(2)
      expect(capture).toHaveBeenCalledExactlyOnceWith([messages[1]])
    })

    it.each(["abort", "superseded", "throw", "exhaustion", "reset"] as const)("discards attempt controls/scratch on %s", async (kind) => {
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "original" }]
      const { runtime, callerViews } = runtimeFor(Array.from({ length: 8 }, () => response("rejected draft")), messages)
      const controller = new AbortController()
      const boundaryViews: ChatCompletionMessageParam[][] = []
      let boundaries = 0
      const options: RunAgentOptions = {
        providerRuntimeOverride: runtime,
        requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: () => "private correction" },
        drainSteeringFollowUps: () => {
          boundaryViews.push(structuredClone(messages))
          if (++boundaries === 2) {
            if (kind === "abort") controller.abort()
            if (kind === "superseded") return [{ text: "stop", effect: "clear_and_supersede" }]
            if (kind === "throw") throw new Error("boundary failed")
            if (kind === "reset") { messages.splice(0, messages.length, { role: "user", content: "reset by caller" }); controller.abort() }
          }
          return []
        },
      }
      const { runAgent } = await import("../../heart/core")
      const run = runAgent(messages, makeCallbacks(), undefined, controller.signal, options)
      if (kind === "throw") await expect(run).rejects.toThrow("boundary failed")
      else expect((await run).outcome).toBe(kind === "superseded" ? "superseded" : kind === "exhaustion" ? "errored" : "aborted")
      expect(JSON.stringify(messages)).not.toMatch(/private correction|rejected draft/)
      expect(callerViews.every((view) => !JSON.stringify(view).includes("private correction"))).toBe(true)
      expect(JSON.stringify(boundaryViews)).not.toMatch(/private correction|rejected draft/)
    })

    it.each(["accepted", "proposal-error"] as const)("promotes an approval suspension only after %s preparation", async (kind) => {
      const { resolveToolDefinition } = await import("../../repertoire/tools")
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "restart calibre-web" }]
      const { runtime } = runtimeFor([response("accepted proposal", [call("shell", "protected", { command: "docker restart calibre-web" })])], messages)
      const seenDuringProposal: ChatCompletionMessageParam[][] = []
      const propose = vi.fn(async () => {
        seenDuringProposal.push(structuredClone(messages))
        if (kind === "proposal-error") throw new Error("proposal failed")
        return { approvalId: "11111111-1111-4111-8111-111111111111", checkpointDigest: "a".repeat(64), suspendedSessionRevision: "b".repeat(64) }
      })
      const captured = vi.fn()
      const execTool = vi.fn()
      const { runAgent } = await import("../../heart/core")
      const result = await runAgent(messages, makeCallbacks(), undefined, undefined, {
        tools: [resolveToolDefinition("shell")!.tool], providerRuntimeOverride: runtime,
        toolContext: { signin: async () => undefined }, approvalCoordinator: { propose }, execTool, captureGeneratedMessages: captured,
      })
      expect(result.outcome).toBe(kind === "accepted" ? "suspended" : "errored")
      expect(propose).toHaveBeenCalledOnce()
      expect(execTool).not.toHaveBeenCalled()
      expect(seenDuringProposal).toEqual([[{ role: "user", content: "restart calibre-web" }]])
      expect(messages.filter((message) => message.role === "assistant")).toHaveLength(kind === "accepted" ? 1 : 0)
      expect(captured).toHaveBeenCalledExactlyOnceWith(messages.slice(1))
    })
  })

  describe("required tool calls", () => {
    const readTool = (name: string, requireScope = false) => ({
      type: "function" as const,
      function: {
        name,
        description: `read ${name}`,
        parameters: requireScope
          ? { type: "object", properties: { scope: { type: "string" } }, required: ["scope"], additionalProperties: false }
          : { type: "object", properties: {}, additionalProperties: false },
      },
    })
    const streamed = (name: string, args: Record<string, string>, id: string) => makeStream([makeChunk(undefined, [{
      index: 0,
      id,
      function: { name, arguments: JSON.stringify(args) },
    }])])

    it("blocks dependent handlers before evidence and waits for every same-name mutation", async () => {
      const careTool = {
        type: "function" as const,
        function: {
          name: "care_manage",
          description: "manage care",
          parameters: {
            type: "object",
            properties: { action: { type: "string" }, id: { type: "string" }, expectedUpdatedAt: { type: "string" } },
            required: ["action", "id", "expectedUpdatedAt"],
            additionalProperties: false,
          },
        },
      }
      mockCreate
        .mockReturnValueOnce(makeStream([makeChunk(undefined, [
          { index: 0, id: "early-care", function: { name: "care_manage", arguments: JSON.stringify({ action: "resolve", id: "care-a", expectedUpdatedAt: "v1" }) } },
          { index: 1, id: "notifications", function: { name: "unraid_get_notifications", arguments: "{}" } },
        ])]))
        .mockReturnValueOnce(streamed("unraid_get_notifications", {}, "notifications-admissible"))
        .mockReturnValueOnce(makeStream([makeChunk(undefined, [
          { index: 0, id: "care-a", function: { name: "care_manage", arguments: JSON.stringify({ action: "resolve", id: "care-a", expectedUpdatedAt: "v1" }) } },
          { index: 1, id: "care-b", function: { name: "care_manage", arguments: JSON.stringify({ action: "resolve", id: "care-b", expectedUpdatedAt: "v2" }) } },
        ])]))
        .mockReturnValueOnce(streamed("settle", { answer: "Both recovered incidents are resolved.", intent: "complete" }, "settle-after-dependent"))
      const execTool = vi.fn(async (name: string, args: Record<string, string>) => name === "unraid_get_notifications"
        ? JSON.stringify({ ok: true, data: { unacknowledged: [] } })
        : JSON.stringify({ id: args.id, status: "resolved" }))
      const resolved = new Set<string>()
      let verifierComplete = false
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "current status" }], makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_notifications"), careTool],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_notifications"],
          retryMessage: "Complete current evidence and dependent Care repairs.",
          requireSuccessfulResults: true,
          validateToolCallBeforeDispatch: (name: string) => name === "care_manage" && !verifierComplete ? "Read notifications before mutating Care." : undefined,
          requiredToolCallsAfterResult: (name: string, _args: Record<string, string>, toolResult: string) => {
            if (name !== "unraid_get_notifications" || !JSON.parse(toolResult).ok) return []
            verifierComplete = true
            return ["care_manage"]
          },
          validateRequiredToolResult: (name: string, result: string, args: Record<string, string>) => {
            if (name === "unraid_get_notifications") return JSON.parse(result).ok === true
            const parsed = JSON.parse(result)
            if (parsed.status === "resolved" && parsed.id === args.id && ["care-a", "care-b"].includes(args.id)) resolved.add(args.id)
            return resolved.size === 2
          },
        },
      } as any)

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: "Both recovered incidents are resolved." } })
      expect(execTool.mock.calls.map(([name, args]) => [name, args.id ?? null])).toEqual([
        ["unraid_get_notifications", null],
        ["care_manage", "care-a"],
        ["care_manage", "care-b"],
      ])
      expect(mockCreate).toHaveBeenCalledTimes(4)
    })

    it("runs dependency rejection before approval classification and reports the blocked boundary", async () => {
      const { resolveToolDefinition } = await import("../../repertoire/tools")
      const shellTool = resolveToolDefinition("shell")!.tool
      mockCreate
        .mockReturnValueOnce(streamed("shell", { command: "shutdown now" }, "guarded-protected-call"))
        .mockReturnValueOnce(streamed("settle", { answer: "blocked safely", intent: "complete" }, "settle-after-guard"))
      const propose = vi.fn()
      const execTool = vi.fn()
      const boundaries: unknown[] = []
      const { runAgent } = await import("../../heart/core")

      await runAgent([{ role: "user", content: "run protected action" }], makeCallbacks(), "cli", undefined, {
        tools: [shellTool], execTool, toolContext: { signin: async () => undefined }, approvalCoordinator: { propose },
        toolBoundaryObserver: (receipt: unknown) => boundaries.push(receipt),
        requiredToolCalls: {
          names: [], retryMessage: "Dependency guard active.",
          validateToolCallBeforeDispatch: (name: string) => name === "shell" ? "Evidence is not complete." : undefined,
        },
      } as any)

      expect(propose).not.toHaveBeenCalled()
      expect(execTool).not.toHaveBeenCalled()
      expect(boundaries).toContainEqual(expect.objectContaining({ name: "shell", reason: "dependency_rejected", invoked: false, sideEffect: false }))
    })

    it("fails closed when an initially required tool is not advertised", async () => {
      const { runAgent } = await import("../../heart/core")
      await expect(runAgent([{ role: "user", content: "status" }], makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_system")], execTool: vi.fn(), toolContext: { signin: async () => undefined },
        requiredToolCalls: { names: ["unraid_get_notifications"], retryMessage: "Read notifications." },
      })).rejects.toThrow(/required tool is not advertised.*unraid_get_notifications/iu)
      expect(mockCreate).not.toHaveBeenCalled()
    })

    it("fails closed when validated evidence adds an unadvertised dependent tool", async () => {
      mockCreate.mockReturnValueOnce(streamed("unraid_get_notifications", {}, "notifications-before-missing-dependent"))
      const execTool = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }))
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "status" }], makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_notifications")], execTool, toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_notifications"], retryMessage: "Read and repair.", requireSuccessfulResults: true,
          validateRequiredToolResult: () => true,
          requiredToolCallsAfterResult: () => ["care_manage"],
        },
      })

      expect(execTool).toHaveBeenCalledTimes(1)
      expect(result.outcome).toBe("errored")
      expect(result.error?.message).toMatch(/dependent required tool is not advertised.*care_manage/iu)
    })

    it("does not duplicate a dependent name that is already required", async () => {
      mockCreate
        .mockReturnValueOnce(streamed("unraid_get_notifications", {}, "notifications-self-dependent"))
        .mockReturnValueOnce(streamed("settle", { answer: "verified", intent: "complete" }, "settle-self-dependent"))
      const execTool = vi.fn().mockResolvedValue(JSON.stringify({ ok: true }))
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "status" }], makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_notifications")], execTool, toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_notifications"], retryMessage: "Read notifications.", requireSuccessfulResults: true,
          validateRequiredToolResult: () => true,
          requiredToolCallsAfterResult: () => ["unraid_get_notifications"],
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: "verified" } })
      expect(execTool).toHaveBeenCalledTimes(1)
    })

    it("does not expand dependent mutations after a required read handler throws", async () => {
      mockCreate
        .mockReturnValueOnce(streamed("unraid_get_notifications", {}, "notifications-throws-before-dependent"))
        .mockReturnValueOnce(streamed("unraid_get_notifications", {}, "notifications-recovers-before-dependent"))
        .mockReturnValueOnce(streamed("settle", { answer: "verified", intent: "complete" }, "settle-after-recovered-read"))
      const execTool = vi.fn()
        .mockRejectedValueOnce(new Error("transport failed"))
        .mockResolvedValueOnce(JSON.stringify({ ok: true }))
      const afterResult = vi.fn().mockReturnValue([])
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "status" }], makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_notifications")], execTool, toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_notifications"], retryMessage: "Read notifications.", requireSuccessfulResults: true,
          validateRequiredToolResult: () => true,
          requiredToolCallsAfterResult: afterResult,
        },
      })

      expect(result.outcome).toBe("settled")
      expect(afterResult).toHaveBeenCalledTimes(1)
      expect(afterResult).toHaveBeenCalledWith("unraid_get_notifications", {}, JSON.stringify({ ok: true }))
    })

    it("rejects early settlement until both exact storage reads dispatch, then preserves the agent's grounded answer", async () => {
      const finalAnswer = "Media is the largest measured share at 12 TiB. Unmanic has historically saved 5.04 TiB and has one item queued; Jellyfin found one unusually large older-codec item. I recommend one sample encode before acting, because the evidence does not support a future-savings estimate yet."
      mockCreate
        .mockReturnValueOnce(streamed("settle", { answer: "Should I run the media read, or would you rather inspect it in QDirStat from a shell?", intent: "blocked" }, "settle-before-reads"))
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-read"))
        .mockReturnValueOnce(streamed("settle", { answer: "Storage is full; shall I run another check?", intent: "blocked" }, "settle-before-media"))
        .mockReturnValueOnce(streamed("sanctuary_get_media_optimization", {}, "media-read"))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-grounded"))
      const execTool = vi.fn(async (name: string) => name === "unraid_get_storage"
        ? JSON.stringify({ ok: true, data: { largestCandidates: [{ name: "media", usedBytes: 12 * 1024 ** 4 }] } })
        : JSON.stringify({ ok: true, data: { unmanic: { history: { totalSavedBytes: 5.04 * 1024 ** 4 }, pending: { total: 1 } }, inventory: { largest: [{ likelySpaceOpportunity: true, videoCodec: "h264" }] }, estimate: { reclaimableBytes: null } } }))
      const callbacks = makeCallbacks()
      const messages: any[] = [{ role: "user", content: "What's using all the space, and can we make it smaller?" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: [readTool("unraid_get_storage"), readTool("sanctuary_get_media_optimization")],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_storage", "sanctuary_get_media_optimization"],
          retryMessage: "Run the missing safe storage reads before settling.",
        },
      } as any)

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer, intent: "complete" } })
      expect(execTool.mock.calls.map(([name]) => name)).toEqual(["unraid_get_storage", "sanctuary_get_media_optimization"])
      expect(callbacks.onTextChunk).toHaveBeenLastCalledWith(finalAnswer)
      expect(messages).not.toContainEqual(expect.objectContaining({ tool_call_id: "settle-before-reads" }))
      expect(messages).not.toContainEqual(expect.objectContaining({ tool_call_id: "settle-before-media" }))
      expect(JSON.stringify(messages)).not.toMatch(/Should I run the media read|Storage is full/)
      expect(finalAnswer).toMatch(/largest measured share.*Unmanic.*Jellyfin.*sample encode/is)
      expect(finalAnswer).not.toMatch(/future savings (?:are|of)|QDirStat|shell|should I|shall I/is)
    })

    it("counts a dispatched failure but never an argument-rejected required call", async () => {
      mockCreate
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "invalid-storage"))
        .mockReturnValueOnce(streamed("sanctuary_get_media_optimization", {}, "failed-media"))
        .mockReturnValueOnce(streamed("settle", { answer: "not yet", intent: "blocked" }, "settle-missing-storage"))
        .mockReturnValueOnce(streamed("unraid_get_storage", { scope: "shares" }, "valid-storage"))
        .mockReturnValueOnce(streamed("settle", { answer: "The media evidence read failed, so I can report the largest share but cannot estimate savings.", intent: "blocked" }, "settle-after-failure"))
      const execTool = vi.fn(async (name: string) => {
        if (name === "sanctuary_get_media_optimization") throw new Error("Jellyfin unavailable")
        return JSON.stringify({ ok: true })
      })
      const messages: any[] = [{ role: "user", content: "diagnose storage and shrink it" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "telegram", undefined, {
        tools: [readTool("unraid_get_storage", true), readTool("sanctuary_get_media_optimization")],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_storage", "sanctuary_get_media_optimization"],
          retryMessage: "Run the missing reads.",
        },
      } as any)

      expect(execTool.mock.calls.map(([name]) => name)).toEqual(["sanctuary_get_media_optimization", "unraid_get_storage"])
      expectProviderOnlyRejection(messages, "invalid-storage", "invalid tool arguments")
      expect(messages).not.toContainEqual(expect.objectContaining({ tool_call_id: "settle-missing-storage" }))
      expect(result).toMatchObject({ outcome: "blocked", completion: { intent: "blocked" } })
    })

    it("rejects a stale whole-Sanctuary answer until all four current reads dispatch in one out-of-order batch", async () => {
      const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"]
      const dispatchedNames = ["unraid_list_containers", "query_cares", "unraid_get_system", "query_active_work"]
      const staleAnswer = "Docker is at 100%. I also see 134 private-runtime dead-letter events on the old policy lane. Which status slice should I inspect?"
      const finalAnswer = "Active: checking the download path. Waiting on you: account top-up. Snoozed: the download-credit reminder until Friday at 10. Quiet by preference: Books is off. Healthy: Sanctuary is up, storage is currently 95% used, and everything else I checked is running. Other known issues: none in the current evidence."
      mockCreate
        .mockReturnValueOnce(streamed("settle", { answer: staleAnswer, intent: "blocked" }, "settle-before-current-reads"))
        .mockReturnValueOnce(makeStream([makeChunk(undefined, dispatchedNames.map((name, index) => ({
          index,
          id: `current-read-${index}`,
          function: { name, arguments: "{}" },
        })))]))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-current-summary"))
      const evidence = new Map<string, string>([
        ["query_active_work", JSON.stringify({ active: ["checking the download path"], waitingOnAri: ["account top-up"] })],
        ["query_cares", JSON.stringify({ snoozed: [{ subject: "download credit", wakeAt: "Friday at 10" }], preferences: [{ subject: "Books", state: "intentionally_off" }] })],
        ["unraid_get_system", JSON.stringify({ serverName: "Sanctuary", arrayState: "STARTED", usedPercent: 95 })],
        ["unraid_list_containers", JSON.stringify({ running: ["Plex", "Home Assistant"], intentionallyOff: ["Books"] })],
      ])
      const execTool = vi.fn(async (name: string) => evidence.get(name) ?? "unexpected")
      const callbacks = makeCallbacks({ settleOutputMode: "final_only" })
      const messages: any[] = [{ role: "user", content: "What's going on with Sanctuary?" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: requiredNames.map((name) => readTool(name)),
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: requiredNames,
          retryMessage: "Read current active work, cares, system health, and service state before answering.",
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer, intent: "complete" } })
      expect(execTool.mock.calls.map(([name]) => name)).toEqual(dispatchedNames)
      expect(messages).not.toContainEqual(expect.objectContaining({ tool_call_id: "settle-before-current-reads" }))
      expect(JSON.stringify(messages)).not.toContain(staleAnswer)
      expect(callbacks.onTextChunk).toHaveBeenCalledTimes(1)
      expect(callbacks.onTextChunk).toHaveBeenCalledWith(finalAnswer)
      expect(finalAnswer).toMatch(/Active:.*Waiting on you:.*Snoozed:.*Quiet by preference:.*Healthy:.*Other known issues:/is)
      expect(finalAnswer).toContain("95%")
      expect(finalAnswer).not.toMatch(/100%|134|daemon|dead-letter|policy lane|private-runtime|SABnzbd|Sonarr|Radarr|Deluge|choose/is)
    })

    it("rejects a text-only final until every required read dispatches", async () => {
      const requiredNames = ["query_active_work", "query_cares", "unraid_get_system", "unraid_list_containers"]
      const finalAnswer = "Active: checking downloads. Waiting on you: nothing. Snoozed: nothing. Quiet by preference: Books. Healthy: Sanctuary and Jellyfin. Other known issues: none."
      mockCreate
        .mockReturnValueOnce(streamed("query_cares", {}, "cares-read"))
        .mockReturnValueOnce(makeStream([makeChunk("**Sanctuary status** Docker is at 100%.")]))
        .mockReturnValueOnce(makeStream([makeChunk(undefined, ["query_active_work", "unraid_get_system", "unraid_list_containers"].map((name, index) => ({
          index,
          id: `remaining-read-${index}`,
          function: { name, arguments: "{}" },
        })))]))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-current-summary"))
      const execTool = vi.fn(async (name: string) => JSON.stringify({ ok: true, name }))
      const callbacks = makeCallbacks({ settleOutputMode: "final_only" })
      const messages: any[] = [{ role: "user", content: "What's going on with Sanctuary?" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: requiredNames.map((name) => readTool(name)),
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: requiredNames,
          retryMessage: "Read current active work, cares, system health, and service state before answering.",
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer, intent: "complete" } })
      expect(execTool.mock.calls.map(([name]) => name)).toEqual(["query_cares", "query_active_work", "unraid_get_system", "unraid_list_containers"])
      expect(messages).not.toContainEqual(expect.objectContaining({
        role: "user",
        content: expect.stringMatching(/current active work.*query_active_work.*unraid_get_system.*unraid_list_containers/is),
      }))
      expect(callbacks.onClearText).toHaveBeenCalled()
      expect(callbacks.onTextChunk).toHaveBeenCalledTimes(1)
      expect(callbacks.onTextChunk).toHaveBeenCalledWith(finalAnswer)
      expect(callbacks.onTextChunk).not.toHaveBeenCalledWith(expect.stringContaining("100%"))
      expect(JSON.stringify(messages)).not.toContain("**Sanctuary status** Docker is at 100%.")
    })

    it("emits ordinary tool prose, rejects a bad terminal answer, and accepts the grounded text-only retry", async () => {
      const draft = "Yes, I can see titles like The Pitt."
      const rejected = "The bounded catalog read worked. What would you like me to do?"
      const finalAnswer = "Yes—the shelf is visible again. I can currently see 11,870 movies and episodes."
      mockCreate
        .mockReturnValueOnce(makeStream([makeChunk(draft, [{ index: 0, id: "catalog-read", function: { name: "sanctuary_search_media_catalog", arguments: "{}" } }])]))
        .mockReturnValueOnce(makeStream([makeChunk(rejected)]))
        .mockReturnValueOnce(makeStream([makeChunk(finalAnswer)]))
      const catalogResult = JSON.stringify({ ok: true, data: { totalItems: 11_870, matchedItems: 1, items: [{ untrustedTitle: "Moonstruck" }] } })
      const execTool = vi.fn().mockResolvedValue(catalogResult)
      const callbacks = makeCallbacks({ settleOutputMode: "retractable_buffer" })
      const messages: any[] = [{ role: "user", content: "Can you see the library now?" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: [readTool("sanctuary_search_media_catalog")],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["sanctuary_search_media_catalog"],
          retryMessage: "Read the current shelf, answer directly, and stop.",
          requireSuccessfulResults: true,
          validateRequiredToolResult: (_name, output) => JSON.parse(output).ok === true,
          validateTerminalAnswer: (answer) => answer === finalAnswer ? undefined : "Use household language, answer once, and stop.",
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: undefined })
      expect(execTool).toHaveBeenCalledExactlyOnceWith("sanctuary_search_media_catalog", {}, expect.anything())
      expect(callbacks.onTextChunk).toHaveBeenCalledWith(draft)
      expect(callbacks.onTextChunk).toHaveBeenLastCalledWith(finalAnswer)
      expect(callbacks.onClearText).toHaveBeenCalled()
      expect(JSON.stringify(messages)).toContain(draft)
      expect(messages).toContainEqual(expect.objectContaining({ role: "tool", content: catalogResult }))
      expect(JSON.stringify(messages)).toContain(finalAnswer)
      expect(JSON.stringify(messages)).not.toContain(rejected)
      expect(messages).not.toContainEqual(expect.objectContaining({ role: "user", content: "Use household language, answer once, and stop." }))
    })

    it("requires successful current reads and rejects unsupported Docker-image assertions without persisting them", async () => {
      const staleAnswer = "Docker image disk is at 100%."
      const finalAnswer = "Sanctuary is running. Docker image utilization still needs a fresh authoritative check."
      mockCreate
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-failed-envelope"))
        .mockReturnValueOnce(streamed("settle", { answer: staleAnswer, intent: "blocked" }, "settle-after-failed-envelope"))
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-throws"))
        .mockReturnValueOnce(streamed("settle", { answer: staleAnswer, intent: "blocked" }, "settle-after-throw"))
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-current"))
        .mockReturnValueOnce(streamed("settle", { answer: staleAnswer, intent: "complete" }, "settle-unsupported-claim"))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-current"))
      let readAttempt = 0
      const execTool = vi.fn(async () => {
        readAttempt += 1
        if (readAttempt === 1) return JSON.stringify({ ok: false, error: { code: "offline" } })
        if (readAttempt === 2) throw new Error("storage transport failed")
        return JSON.stringify({ ok: true, data: { array: { usedPercent: 74 } } })
      })
      const messages: any[] = [{ role: "user", content: "What's going on with Sanctuary?" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks({ settleOutputMode: "final_only" }), "telegram", undefined, {
        tools: [readTool("unraid_get_storage")],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_storage"],
          retryMessage: "Read current storage before answering.",
          requireSuccessfulResults: true,
          validateRequiredToolResult: (_name, output) => JSON.parse(output).ok === true,
          validateTerminalAnswer: (answer) => /docker image disk is at 100%/iu.test(answer) ? "No current tool supports that Docker image claim; report it only as needing a fresh check." : undefined,
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer, intent: "complete" } })
      expect(execTool).toHaveBeenCalledTimes(3)
      expect(JSON.stringify(messages)).not.toContain(staleAnswer)
      expect(messages).not.toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("No current tool supports that Docker image claim") }))
    })

    it("retries explicit read failures and rejects unsupported text-only answers after a successful default-validated read", async () => {
      const staleAnswer = "Docker image disk is at 100%."
      const finalAnswer = "Sanctuary is running. Docker image utilization still needs a fresh authoritative check."
      mockCreate
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-error"))
        .mockReturnValueOnce(streamed("unraid_get_storage", {}, "storage-current"))
        .mockReturnValueOnce(makeStream([makeChunk(staleAnswer)]))
        .mockReturnValueOnce(makeStream([makeChunk("")]))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-current"))
      const execTool = vi.fn()
        .mockResolvedValueOnce("error: storage offline")
        .mockResolvedValueOnce("current storage read")
      const messages: any[] = [{ role: "user", content: "What's going on with Sanctuary?" }]
      const callbacks = makeCallbacks({ settleOutputMode: "final_only" })
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: [readTool("unraid_get_storage")],
        execTool,
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["unraid_get_storage"],
          retryMessage: "Read current storage before answering.",
          requireSuccessfulResults: true,
          validateTerminalAnswer: (answer) => answer === staleAnswer || answer === "" ? "No current tool supports that Docker image claim; report it only as needing a fresh check." : undefined,
        },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer, intent: "complete" } })
      expect(execTool).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(messages)).not.toContain(staleAnswer)
      expect(messages).not.toContainEqual(expect.objectContaining({ role: "user", content: expect.stringContaining("No current tool supports that Docker image claim") }))
      expect(callbacks.onClearText).toHaveBeenCalled()
    })

    it("snapshots each correction before resetting a stateful provider", async () => {
      const snapshots: ChatCompletionMessageParam[][] = []
      const requests: ChatCompletionMessageParam[][] = []
      const responses = [
        { content: "Docker image is full.", toolCalls: [], outputItems: [] },
        { content: "", toolCalls: [{ id: "settle-current", name: "settle", arguments: JSON.stringify({ answer: "Docker image utilization needs a fresh check.", intent: "complete" }) }], outputItems: [], settleStreamed: false },
      ]
      const streamTurn = vi.fn(async (request: { messages: ChatCompletionMessageParam[] }) => {
        requests.push(structuredClone(request.messages))
        return responses[requests.length - 1]
      })
      vi.doMock("../../heart/providers/minimax", () => ({
        createMinimaxProviderRuntime: () => ({
          id: "minimax", model: "stateful-test", client: {}, capabilities: new Set(), streamTurn,
          appendToolOutput: vi.fn(), resetTurnState: vi.fn((current: ChatCompletionMessageParam[]) => snapshots.push(structuredClone(current))),
          ping: vi.fn(), classifyError: vi.fn(() => "unknown"),
        }),
      }))
      try {
        const { runAgent } = await import("../../heart/core")
        const correction = "No current tool measures Docker image state."
        const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "status" }]
        const result = await runAgent(messages, makeCallbacks(), "telegram", undefined, {
          requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer.includes("full") ? correction : undefined },
        })

        expect(result).toMatchObject({ outcome: "settled", completion: { answer: "Docker image utilization needs a fresh check." } })
        expect(snapshots.some((snapshot) => snapshot.at(-1)?.content === correction)).toBe(true)
        expect(JSON.stringify(snapshots.at(-1))).not.toContain(correction)
        expect(requests[1]?.at(-1)).toEqual({ role: "user", content: correction })
        expect(messages).not.toContainEqual({ role: "user", content: correction })
      } finally {
        vi.doUnmock("../../heart/providers/minimax")
      }
    })

    it("removes a correction after prompt budgeting clones the provider history", async () => {
      const correction = `Use current evidence. ${"x".repeat(300_000)}`
      const responses = [
        { content: "Docker image is full.", toolCalls: [], outputItems: [] },
        { content: "", toolCalls: [{ id: "settle-current", name: "settle", arguments: JSON.stringify({ answer: "Docker image utilization needs a fresh check.", intent: "complete" }) }], outputItems: [], settleStreamed: false },
      ]
      const streamTurn = vi.fn(async () => responses[streamTurn.mock.calls.length - 1])
      vi.doMock("../../heart/providers/minimax", () => ({
        createMinimaxProviderRuntime: () => ({
          id: "minimax", model: "stateful-test", client: {}, capabilities: new Set(), streamTurn,
          appendToolOutput: vi.fn(), resetTurnState: vi.fn(), ping: vi.fn(), classifyError: vi.fn(() => "unknown"),
        }),
      }))
      try {
        const { runAgent } = await import("../../heart/core")
        const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "status" }]
        const result = await runAgent(messages, makeCallbacks(), "telegram", undefined, {
          requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer.includes("full") ? correction : undefined },
        })

        expect(result.outcome).toBe("settled")
        expect(streamTurn).toHaveBeenCalledTimes(2)
        expect(messages.some((message) => message.role === "user" && message.content === correction)).toBe(false)
      } finally {
        vi.doUnmock("../../heart/providers/minimax")
      }
    })

    it("keeps a correction out of incremental tool-result persistence", async () => {
      const correction = "Use current evidence."
      const finalAnswer = "The current system read is healthy."
      mockCreate
        .mockReturnValueOnce(makeStream([makeChunk("The system is definitely broken.")]))
        .mockReturnValueOnce(streamed("unraid_get_system", {}, "system-read-after-correction"))
        .mockReturnValueOnce(streamed("settle", { answer: finalAnswer, intent: "complete" }, "settle-after-correction"))
      const persisted: ChatCompletionMessageParam[][] = []
      const { postTurnTrim } = await import("../../mind/context")
      const callbacks = makeCallbacks({
        onToolResult: (turnMessages: ChatCompletionMessageParam[]) => {
          persisted.push(structuredClone(postTurnTrim(turnMessages).currentMessages))
        },
      })
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "status" }]
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, callbacks, "telegram", undefined, {
        tools: [readTool("unraid_get_system")],
        execTool: vi.fn().mockResolvedValue(JSON.stringify({ ok: true })),
        toolContext: { signin: async () => undefined },
        requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: (answer) => answer.includes("broken") ? correction : undefined },
      })

      expect(result).toMatchObject({ outcome: "settled", completion: { answer: finalAnswer } })
      expect(persisted).toHaveLength(1)
      expect(JSON.stringify(persisted)).not.toContain(correction)
      expect(JSON.stringify(messages)).not.toContain(correction)
    })

    it("removes a correction when a later loop-boundary callback throws", async () => {
      mockCreate.mockReturnValueOnce(makeStream([makeChunk("Docker image is full.")]))
      const correction = "Use current evidence."
      const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "status" }]
      const drainSteeringFollowUps = vi.fn()
        .mockReturnValueOnce([])
        .mockImplementationOnce(() => { throw new Error("steering callback failed") })
      const { runAgent } = await import("../../heart/core")

      await expect(runAgent(messages, makeCallbacks(), "telegram", undefined, {
        drainSteeringFollowUps,
        requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: () => correction },
      })).rejects.toThrow("steering callback failed")
      expect(messages).not.toContainEqual({ role: "user", content: correction })
    })

    it("caps repeated terminal-answer validation failures at eight provider responses", async () => {
      const streamTurn = vi.fn(async () => ({ content: "Docker image is full.", toolCalls: [], outputItems: [] }))
      vi.doMock("../../heart/providers/minimax", () => ({
        createMinimaxProviderRuntime: () => ({
          id: "minimax", model: "stateful-test", client: {}, capabilities: new Set(), streamTurn,
          appendToolOutput: vi.fn(), resetTurnState: vi.fn(), ping: vi.fn(), classifyError: vi.fn(() => "unknown"),
        }),
      }))
      try {
        const { runAgent } = await import("../../heart/core")
        const callbacks = makeCallbacks()
        const messages: ChatCompletionMessageParam[] = [{ role: "user", content: "status" }]
        const result = await runAgent(messages, callbacks, "telegram", undefined, {
          requiredToolCalls: { names: [], retryMessage: "unused", validateTerminalAnswer: () => "Use current evidence." },
        })

        expect(streamTurn).toHaveBeenCalledTimes(8)
        expect(result.outcome).toBe("errored")
        expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({ message: "provider iteration limit exhausted at response 8 before required terminal answer validation completed" }), "terminal")
        expect(messages).toContainEqual({ role: "user", content: "status" })
        expect(messages).not.toContainEqual({ role: "user", content: "Use current evidence." })
      } finally {
        vi.doUnmock("../../heart/providers/minimax")
      }
    })

    it("fails closed at the provider iteration cap when required reads never dispatch", async () => {
      for (let response = 0; response < 8; response += 1) {
        mockCreate.mockReturnValueOnce(makeStream([makeChunk(`stale answer ${response + 1}`)]))
      }
      mockCreate.mockReturnValueOnce(makeStream([makeChunk("")]))
      const callbacks = makeCallbacks({ settleOutputMode: "final_only" })
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent([{ role: "user", content: "What's going on with Sanctuary?" }], callbacks, "telegram", undefined, {
        tools: [readTool("query_active_work")],
        execTool: vi.fn(),
        toolContext: { signin: async () => undefined },
        requiredToolCalls: {
          names: ["query_active_work"],
          retryMessage: "Read current work before answering.",
        },
      })

      expect(mockCreate).toHaveBeenCalledTimes(8)
      expect(callbacks.onError).toHaveBeenCalledWith(expect.objectContaining({
        message: "provider iteration limit exhausted at response 8 before required tool calls completed",
      }), "terminal")
      expect(callbacks.onTextChunk).not.toHaveBeenCalled()
      expect(callbacks.onClearText).toHaveBeenCalled()
      expect(result.outcome).toBe("errored")
    })
  })
})
