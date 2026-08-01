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
    expect(isChatStyleChannel("bluebubbles")).toBe(true)
    expect(isChatStyleChannel("voice")).toBe(true)
    expect(isChatStyleChannel("inner")).toBe(false)
    expect(isChatStyleChannel("mcp")).toBe(false)
    expect(isChatStyleChannel("mail")).toBe(false)
    expect(isChatStyleChannel("anything-else")).toBe(false)
  })

  it("activeTools includes speakTool for channel='cli' and excludes for channel='inner'", async () => {
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

  it("restricts reaction feedback to one provider invocation and the exact registered read-only tool IDs", async () => {
    let providerTools: Array<{ function: { name: string } }> = []
    mockCreate.mockImplementation((request: any) => {
      providerTools = request.tools
      return makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_reaction_settle",
            function: {
              name: "settle",
              arguments: '{"answer":"thanks for the feedback","intent":"complete"}',
            },
          },
        ]),
      ])
    })

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("unexpected")
    const drainSteeringFollowUps = vi.fn(() => [{
      text: "resume the old RSVP task",
      effect: "set_no_handoff" as const,
    }])
    const callbacks = makeCallbacks()

    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
        tools: [{
          type: "function",
          function: {
            name: "send_message",
            description: "must never leak into restricted feedback",
            parameters: { type: "object", properties: {} },
          },
        }],
        execTool,
        drainSteeringFollowUps,
        toolContext: { signin: async () => undefined },
      } as any,
    )

    const { settleTool, observeTool } = await import("../../repertoire/tools")
    const { baseToolDefinitions } = await import("../../repertoire/tools-base")
    const orientationGetTool = baseToolDefinitions.find(
      (definition) => definition.tool.function.name === "orientation_get",
    )?.tool
    expect(orientationGetTool).toBeDefined()
    expect(providerTools).toHaveLength(3)
    expect(new Set(providerTools.map((tool) => tool.function.name))).toEqual(new Set([
      "settle",
      "observe",
      "orientation_get",
    ]))
    const providerToolsById = new Map(providerTools.map((tool) => [tool.function.name, tool]))
    expect(providerToolsById.get("settle")).toEqual(settleTool)
    expect(providerToolsById.get("observe")).toEqual(observeTool)
    expect(providerToolsById.get("orientation_get")).toEqual(orientationGetTool)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(drainSteeringFollowUps).not.toHaveBeenCalled()
    expect(execTool).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      outcome: "settled",
      completion: { answer: "thanks for the feedback", intent: "complete" },
    })
  })

  it("accepts observe as the other successful restricted-feedback terminal", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_reaction_observe",
          function: {
            name: "observe",
            arguments: '{"reason":"feedback acknowledged silently"}',
          },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("unexpected")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
        execTool,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onToolEnd).toHaveBeenCalledWith(
      "observe",
      "reason=feedback acknowledged silently",
      true,
    )
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "observed" })
  })

  it("accepts a blocked settle as a delivered restricted terminal without continuing", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_reaction_blocked",
          function: {
            name: "settle",
            arguments: '{"answer":"I cannot resolve that safely.","intent":"blocked"}',
          },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("I cannot resolve that safely.")
    expect(result).toMatchObject({
      outcome: "blocked",
      completion: { answer: "I cannot resolve that safely.", intent: "blocked" },
    })
  })

  it("accepts restricted observe without an optional reason", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_reaction_observe_no_reason",
          function: { name: "observe", arguments: "{}" },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      makeCallbacks(),
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ outcome: "observed" })
  })

  it("executes an allowlisted orientation read but never starts a second restricted-feedback inference", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_reaction_orientation",
            function: { name: "orientation_get", arguments: "{}" },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_forbidden_second_turn",
            function: {
              name: "settle",
              arguments: '{"answer":"second inference must not run","intent":"complete"}',
            },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const orientationFrame = {
      schemaVersion: 1 as const,
      channel: "bluebubbles",
      currentUserSpeech: [],
      priorAssistantReferents: [],
      signals: ["reaction_signal" as const],
      actionPolicy: { mode: "normal" as const },
    }
    const execTool = vi.fn().mockResolvedValue(JSON.stringify(orientationFrame))
    const callbacks = makeCallbacks()

    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
        execTool,
        orientationFrame,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledWith("orientation_get", {}, expect.objectContaining({ orientationFrame }))
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("fails a restricted reaction closed when the provider emits an unregistered tool", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_forbidden_send",
            function: {
              name: "send_message",
              arguments: '{"friendId":"self","content":"resume RSVP"}',
            },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_forbidden_recovery",
            function: {
              name: "settle",
              arguments: '{"answer":"recovered","intent":"complete"}',
            },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("sent")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
        execTool,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onTextChunk).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("fails malformed settle arguments closed without a corrective provider turn", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_malformed_settle",
            function: { name: "settle", arguments: '{"answer":' },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_forbidden_settle_retry",
            function: {
              name: "settle",
              arguments: '{"answer":"retry must not run","intent":"complete"}',
            },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("settle", expect.any(String), false)
    expect(callbacks.onClearText).toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it.each([
    ["missing answer", '{"intent":"complete"}'],
    ["continuation intent", '{"answer":"keep going","intent":"direct_reply"}'],
    ["unknown intent", '{"answer":"must not leak","intent":"resume_work"}'],
    ["non-string intent", '{"answer":"must not leak","intent":7}'],
  ])("fails restricted settle closed for %s", async (_label, argumentsText) => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_invalid_settle_shape",
          function: { name: "settle", arguments: argumentsText },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("settle", expect.any(String), false)
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it.each([
    ["array", "[]"],
    ["null", "null"],
    ["string", '"not an argument object"'],
    ["object with numeric reason", '{"reason":7}'],
    ["object with null reason", '{"reason":null}'],
  ])("fails restricted observe closed for a JSON %s argument payload", async (_label, argumentsText) => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_invalid_observe_shape",
          function: { name: "observe", arguments: argumentsText },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolStart).not.toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("rejects a mixed restricted tool batch atomically before any tool executes", async () => {
    mockCreate
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_mixed_settle",
            function: {
              name: "settle",
              arguments: '{"answer":"must be retracted","intent":"complete"}',
            },
          },
          {
            index: 1,
            id: "call_mixed_send",
            function: {
              name: "send_message",
              arguments: '{"friendId":"self","content":"resume RSVP"}',
            },
          },
        ]),
      ]))
      .mockReturnValueOnce(makeStream([
        makeChunk(undefined, [
          {
            index: 0,
            id: "call_forbidden_mixed_recovery",
            function: {
              name: "observe",
              arguments: '{"reason":"recovery must not run"}',
            },
          },
        ]),
      ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockResolvedValue("sent")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
        execTool,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).not.toHaveBeenCalled()
    expect(callbacks.onClearText).toHaveBeenCalled()
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("fails closed when the allowlisted orientation read itself rejects", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_reaction_orientation_error",
          function: { name: "orientation_get", arguments: "{}" },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const execTool = vi.fn().mockRejectedValue(new Error("orientation unavailable"))
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true, execTool } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(execTool).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("orientation_get", "", false)
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("uses the registered orientation handler when no execution override exists", async () => {
    mockCreate.mockReturnValue(makeStream([
      makeChunk(undefined, [
        {
          index: 0,
          id: "call_reaction_orientation_registered",
          function: { name: "orientation_get", arguments: "{}" },
        },
      ]),
    ]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari questioned an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      { restrictedReactionFeedback: true } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("orientation_get", "", true)
    expect(result).toMatchObject({ outcome: "errored" })
  })

  it("does not retry a failed restricted-feedback provider invocation", async () => {
    vi.useFakeTimers()
    try {
      const providerError = Object.assign(new Error("rate limited"), { status: 429 })
      mockCreate.mockRejectedValue(providerError)

      const { runAgent } = await import("../../heart/core")
      const callbacks = makeCallbacks()
      const pending = runAgent(
        [{ role: "user", content: "Ari questioned an agent-authored message." }],
        callbacks,
        "bluebubbles",
        undefined,
        {
          restrictedReactionFeedback: true,
          toolChoiceRequired: true,
        } as any,
      )

      await vi.runAllTimersAsync()
      const result = await pending

      expect(mockCreate).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({
        outcome: "errored",
        error: providerError,
        errorClassification: "rate-limit",
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it("retracts text-only restricted feedback and terminates without a corrective second call", async () => {
    mockCreate.mockReturnValue(makeStream([makeChunk("unsettled provider prose")]))

    const { runAgent } = await import("../../heart/core")
    const callbacks = makeCallbacks()
    const result = await runAgent(
      [{ role: "user", content: "Ari disliked an agent-authored message." }],
      callbacks,
      "bluebubbles",
      undefined,
      {
        restrictedReactionFeedback: true,
        toolChoiceRequired: true,
      } as any,
    )

    expect(mockCreate).toHaveBeenCalledTimes(1)
    expect(callbacks.onClearText).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ outcome: "errored" })
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
      onClearText: () => { visibleText.length = 0 },
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
              parameters: { type: "object", properties: {}, additionalProperties: false },
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
})
