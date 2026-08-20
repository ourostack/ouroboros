import { beforeEach, describe, expect, it, vi } from "vitest"

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
import type { ChannelCallbacks } from "../../heart/core"

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
    expect(messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_private_settle_gated",
      content: expect.stringContaining("unsurfaced items"),
    }))
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
    expect(messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_fabricated_shell",
      content: expect.stringContaining("was not advertised"),
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

    const toolMessages = messages.filter((message: any) => message.role === "tool")
    const loopGuardMessage = toolMessages.find((message: any) =>
      typeof message.content === "string" && message.content.startsWith("loop guard:")
    )
    expect(loopGuardMessage?.content).toContain("stop polling")
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

  it("rejects a mixed terminal projection without changing ordinary companion-tool behavior", async () => {
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
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith(
      "write_file",
      { path: "note.md", content: "side effect" },
      expect.anything(),
    )
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
    })

    expect(result.outcome).toBe("settled")
    expect(execTool).not.toHaveBeenCalled()
    expect(messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: "call_valid_probe",
      content: expect.stringContaining("another call in this batch had invalid arguments"),
    }))
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
    expect(messages.filter((message) => message.role === "tool" && message.tool_call_id === "duplicate"))
      .toHaveLength(2)
    expect(JSON.stringify(messages)).toContain("duplicate tool call id")
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

    expect(messages).toContainEqual(expect.objectContaining({
      role: "tool",
      tool_call_id: `call_invalid_${name}`,
      content: expect.stringContaining("invalid tool arguments"),
    }))
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
      const { runAgent } = await import("../../heart/core")

      const result = await runAgent(messages, makeCallbacks(), "cli", undefined, {
        execTool,
        toolContext: { signin: async () => undefined },
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
      }))
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
      const rejectedResults = messages.filter((message) => message.role === "tool" && String(message.content).includes("approval-eligible tool must be the sole call"))
      expect(rejectedResults).toHaveLength(2)
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
      expect(messages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_invalid_restart",
        content: expect.stringContaining("invalid tool arguments"),
      }))
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
      expect(messages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_schema_drift",
        content: expect.stringContaining(expectedFragment),
      }))
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
      expect(messages).toContainEqual(expect.objectContaining({
        role: "tool",
        tool_call_id: "call_valid",
        content: expect.stringContaining("another call in this batch had invalid arguments"),
      }))
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
})
