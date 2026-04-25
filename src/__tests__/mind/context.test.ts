import { describe, it, expect, vi, beforeEach } from "vitest"
import type OpenAI from "openai"

// Mock fs for session persistence tests
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  existsSync: vi.fn(),
}))

// Mock config for postTurn tests
vi.mock("../../heart/config", () => ({
  getContextConfig: vi.fn().mockReturnValue({ maxTokens: 80000, contextMargin: 20 }),
}))

import * as fs from "fs"

// cachedBuildSystem and resetSystemPromptCache removed in Unit 1G
// (per-friend context makes 60s TTL cache incorrect)

describe("removed cache functions", () => {
  beforeEach(() => { vi.resetModules() })

  it("cachedBuildSystem no longer exists", async () => {
    const context = await import("../../mind/context")
    expect("cachedBuildSystem" in context).toBe(false)
  })

  it("resetSystemPromptCache no longer exists", async () => {
    const context = await import("../../mind/context")
    expect("resetSystemPromptCache" in context).toBe(false)
  })
})

describe("trimMessages", () => {
  beforeEach(() => { vi.resetModules() })

  // New signature: trimMessages(messages, maxTokens, contextMargin, actualTokenCount?)

  it("when actualTokenCount exceeds maxTokens, messages are trimmed", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old msg" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new msg" },
      { role: "assistant", content: "new reply" },
    ]
    // actualTokenCount=120000, maxTokens=80000, margin=20 -> trimTarget=64000
    // perMessageCost = 120000/5 = 24000
    // Need to drop until remaining <= 64000
    // Drop msg[1] (24000): 120000-24000 = 96000 > 64000
    // Drop msg[2] (24000): 96000-24000 = 72000 > 64000
    // Drop msg[3] (24000): 72000-24000 = 48000 <= 64000
    // Result: [sys, msg[4]] = 2 messages
    const result = trimMessages(msgs, 80000, 20, 120000)
    expect(result.length).toBe(2)
    expect(result[0].role).toBe("system")
    expect(result[1]).toBe(msgs[4])
  })

  it("when actualTokenCount is under maxTokens, no trimming occurs", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20, 50000)
    expect(result).toEqual(msgs)
    expect(result).not.toBe(msgs) // new array
  })

  it("system prompt (index 0) is always preserved", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "system prompt" },
      { role: "user", content: "big message" },
    ]
    // Force heavy trimming
    const result = trimMessages(msgs, 1000, 20, 50000)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("trims to target: maxTokens * (1 - contextMargin/100)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    // actualTokenCount=100, maxTokens=80, margin=25 -> trimTarget=60
    // perMessageCost=100/4=25
    // Drop msg[1] (25): 100-25=75 > 60
    // Drop msg[2] (25): 75-25=50 <= 60
    // Result: [sys, msg[3]] = 2 messages
    const result = trimMessages(msgs, 80, 25, 100)
    expect(result.length).toBe(2)
    expect(result[0].role).toBe("system")
    expect(result[1]).toBe(msgs[3])
  })

  it("when actualTokenCount is 0, no trimming occurs (cold start)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20, 0)
    expect(result).toEqual(msgs)
  })

  it("when actualTokenCount is undefined, no trimming occurs (cold start)", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const result = trimMessages(msgs, 80000, 20)
    expect(result).toEqual(msgs)
  })

  it("no trimming when message count is high but tokens are under maxTokens", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    for (let i = 0; i < 299; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "hi" })
    }
    expect(msgs.length).toBe(300)
    // Token count is under maxTokens — no trimming despite high message count
    const result = trimMessages(msgs, 80000, 20, 1000)
    expect(result.length).toBe(300)
    expect(result[0].role).toBe("system")
  })

  it("single message (system only) -- nothing to trim", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "hello" },
    ]
    const result = trimMessages(msgs, 80000, 20, 500)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("all messages would be trimmed -- only system remains", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
    ]
    // Extreme: actualTokenCount very high relative to maxTokens
    const result = trimMessages(msgs, 100, 20, 10000)
    expect(result.length).toBe(1)
    expect(result[0].role).toBe("system")
  })

  it("treats assistant tool_calls and following tool results as one trimmable block", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" },
          },
        ],
      } as any,
      { role: "tool", tool_call_id: "call_1", content: "ok" } as any,
      { role: "tool", tool_call_id: "call_1", content: "more" } as any,
      { role: "user", content: "latest intent" },
    ]

    const result = trimMessages(msgs, 100, 20, 500)
    expect(result[0].role).toBe("system")
    expect(result.length).toBe(1)
  })

  it("does not mutate input array", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "reply" },
    ]
    const originalLength = msgs.length
    trimMessages(msgs, 100, 20, 5000)
    expect(msgs.length).toBe(originalLength)
  })

  it("no trimming when actualTokenCount is undefined regardless of message count", async () => {
    const { trimMessages } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    for (let i = 0; i < 250; i++) {
      msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: "hi" })
    }
    expect(msgs.length).toBe(251)
    const result = trimMessages(msgs, 80000, 20)
    expect(result.length).toBe(251)
    expect(result[0].role).toBe("system")
  })
})

describe("saveSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("writes messages wrapped in versioned envelope", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    saveSession("/tmp/test-session.json", msgs)

    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp", { recursive: true })
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(written).toMatchObject({
      version: 2,
      projection: {
        eventIds: ["evt-000001", "evt-000002"],
        trimmed: false,
      },
      lastUsage: null,
      state: {
        mustResolveBeforeHandoff: false,
        lastFriendActivityAt: null,
      },
    })
    expect(written.events).toHaveLength(2)
    expect(written.events[0]).toMatchObject({ id: "evt-000001", role: "system", content: "sys" })
    expect(written.events[1]).toMatchObject({ id: "evt-000002", role: "user", content: "hi" })
  })

  it("creates parent directories recursively", async () => {
    const { saveSession } = await import("../../mind/context")
    saveSession("/a/b/c/session.json", [])

    expect(fs.mkdirSync).toHaveBeenCalledWith("/a/b/c", { recursive: true })
  })

  // --- Unit 3c: saveSession with lastUsage ---

  it("includes lastUsage in JSON envelope when provided", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
    saveSession("/tmp/session.json", msgs, usage)

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(written.lastUsage).toEqual(usage)
    expect(written.projection.inputTokens).toBe(100)
  })

  it("omits lastUsage from envelope when not provided", async () => {
    const { saveSession } = await import("../../mind/context")
    saveSession("/tmp/session.json", [])

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.lastUsage).toBeNull()
  })

  it("writes persisted continuity state when mustResolveBeforeHandoff is true", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, { mustResolveBeforeHandoff: true })

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(parsed.state).toEqual({
      mustResolveBeforeHandoff: true,
      lastFriendActivityAt: null,
    })
  })

  it("omits persisted continuity state when mustResolveBeforeHandoff is false", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, { mustResolveBeforeHandoff: false })

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(parsed.state).toEqual({
      mustResolveBeforeHandoff: false,
      lastFriendActivityAt: null,
    })
  })

  it("persists lastFriendActivityAt without forcing mustResolveBeforeHandoff", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, {
      lastFriendActivityAt: "2026-03-13T20:00:00.000Z",
    })

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(parsed.state).toEqual({
      mustResolveBeforeHandoff: false,
      lastFriendActivityAt: "2026-03-13T20:00:00.000Z",
    })
  })

  it("persists both mustResolveBeforeHandoff and lastFriendActivityAt together", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]

    ;(saveSession as any)("/tmp/session.json", msgs, undefined, {
      mustResolveBeforeHandoff: true,
      lastFriendActivityAt: "2026-03-13T20:00:00.000Z",
    })

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0]![1] as string)
    expect(parsed.state).toEqual({
      mustResolveBeforeHandoff: true,
      lastFriendActivityAt: "2026-03-13T20:00:00.000Z",
    })
  })

  it("repairs back-to-back assistant messages on save", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
    ]
    saveSession("/tmp/session.json", msgs)

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.events).toHaveLength(3)
    expect(parsed.events[2].content).toContain("first")
    expect(parsed.events[2].content).toContain("second")
  })

  it("appends onto an existing canonical envelope instead of rewriting ids from scratch", async () => {
    const { saveSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 2,
      events: [
        {
          id: "evt-000001",
          sequence: 1,
          role: "system",
          content: "sys",
          name: null,
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: "2026-04-09T17:20:00.000Z",
            authoredAtSource: "local",
            observedAt: "2026-04-09T17:20:00.000Z",
            observedAtSource: "local",
            recordedAt: "2026-04-09T17:20:00.000Z",
            recordedAtSource: "save",
          },
          relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
        },
        {
          id: "evt-000002",
          sequence: 2,
          role: "user",
          content: "hello",
          name: null,
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: null,
            authoredAtSource: "unknown",
            observedAt: "2026-04-09T17:21:00.000Z",
            observedAtSource: "ingest",
            recordedAt: "2026-04-09T17:21:00.000Z",
            recordedAtSource: "save",
          },
          relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
        },
      ],
      projection: {
        eventIds: ["evt-000001", "evt-000002"],
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: null,
        projectedAt: "2026-04-09T17:21:00.000Z",
      },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }))

    saveSession("/tmp/session.json", [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "new answer" },
    ])

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(parsed.events.map((event: any) => event.id)).toEqual(["evt-000001", "evt-000002", "evt-000003"])
    expect(parsed.projection.eventIds).toEqual(["evt-000001", "evt-000002", "evt-000003"])
  })

  it("emits auto-healed save repairs below warning level", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    const { saveSession } = await import("../../mind/context")
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "first" },
      { role: "assistant", content: "second" },
      { role: "tool", tool_call_id: "orphan-1", content: "stale result" },
    ]

    saveSession("/tmp/session.json", msgs)

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_invariant_violation",
      level: "info",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_invariant_repair",
      level: "info",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_orphan_tool_result_repair",
      level: "info",
    }))
    expect(emitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }))
  })

  it("strips orphaned tool results on save", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "done" },
      { role: "tool", tool_call_id: "orphan-1", content: "stale result" },
    ]

    saveSession("/tmp/session.json", msgs)

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.events).toHaveLength(3)
    expect(parsed.events.some((msg: any) => msg.role === "tool")).toBe(false)
  })

  it("preserves valid tool call/result pairs on save", async () => {
    const { saveSession } = await import("../../mind/context")
    const msgs: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call-1", content: "ok" },
    ]

    saveSession("/tmp/session.json", msgs)

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string
    const parsed = JSON.parse(written)
    expect(parsed.events).toHaveLength(4)
    expect(parsed.events[2].toolCalls?.[0]?.id).toBe("call-1")
    expect(parsed.events[3]).toMatchObject({ role: "tool", toolCallId: "call-1", content: "ok" })
  })
})

describe("loadSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
  })

  // --- Unit 3c: loadSession returns { messages, lastUsage } ---

  it("returns { messages, lastUsage } from valid session file", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }]
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, lastUsage: usage }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({ lastUsage: usage, state: undefined })
    expect(result!.messages[0]).toEqual({ role: "system", content: "sys" })
    expect(result!.messages[1]).toMatchObject({ role: "user", content: expect.stringContaining("hi") })
    expect(result!.events).toHaveLength(2)
  })

  it("does not inject relative-time annotations into live provider messages", async () => {
    const { loadSession } = await import("../../mind/context")
    const usage = { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 150 }
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        events: [
          {
            id: "evt-000001",
            sequence: 1,
            role: "user",
            content: "hello",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: null,
              authoredAtSource: "unknown",
              observedAt: "2026-04-24T03:00:00.000Z",
              observedAtSource: "ingest",
              recordedAt: "2026-04-24T03:00:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
          {
            id: "evt-000002",
            sequence: 2,
            role: "assistant",
            content: "hi back",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: "2026-04-24T03:01:00.000Z",
              authoredAtSource: "local",
              observedAt: "2026-04-24T03:01:00.000Z",
              observedAtSource: "local",
              recordedAt: "2026-04-24T03:01:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
        ],
        projection: {
          eventIds: ["evt-000001", "evt-000002"],
          trimmed: false,
          maxTokens: null,
          contextMargin: null,
          inputTokens: null,
          projectedAt: "2026-04-24T03:01:00.000Z",
        },
        lastUsage: usage,
        state: {
          mustResolveBeforeHandoff: false,
          lastFriendActivityAt: null,
        },
      }),
    )

    const result = loadSession("/tmp/session.json")
    expect(result).not.toBeNull()
    expect(result!.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi back" },
    ])
  })

  it("repairs projected sessions that contain duplicate system prompts", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 2,
        events: [
          {
            id: "evt-000001",
            sequence: 1,
            role: "system",
            content: "fresh system",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: "2026-04-24T03:00:00.000Z",
              authoredAtSource: "local",
              observedAt: "2026-04-24T03:00:00.000Z",
              observedAtSource: "local",
              recordedAt: "2026-04-24T03:00:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
          {
            id: "evt-000002",
            sequence: 2,
            role: "user",
            content: "hello",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: null,
              authoredAtSource: "unknown",
              observedAt: "2026-04-24T03:01:00.000Z",
              observedAtSource: "ingest",
              recordedAt: "2026-04-24T03:01:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
          {
            id: "evt-000003",
            sequence: 3,
            role: "assistant",
            content: "hi back",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: "2026-04-24T03:02:00.000Z",
              authoredAtSource: "local",
              observedAt: "2026-04-24T03:02:00.000Z",
              observedAtSource: "local",
              recordedAt: "2026-04-24T03:02:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
          {
            id: "evt-000004",
            sequence: 4,
            role: "system",
            content: "stale system",
            name: null,
            toolCallId: null,
            toolCalls: [],
            attachments: [],
            time: {
              authoredAt: "2026-04-24T03:03:00.000Z",
              authoredAtSource: "local",
              observedAt: "2026-04-24T03:03:00.000Z",
              observedAtSource: "local",
              recordedAt: "2026-04-24T03:03:00.000Z",
              recordedAtSource: "save",
            },
            relations: {
              replyToEventId: null,
              threadRootEventId: null,
              references: [],
              toolCallId: null,
              supersedesEventId: null,
              redactsEventId: null,
            },
            provenance: {
              captureKind: "live",
              legacyVersion: null,
              sourceMessageIndex: null,
            },
          },
        ],
        projection: {
          eventIds: ["evt-000001", "evt-000002", "evt-000003", "evt-000004"],
          trimmed: false,
          maxTokens: null,
          contextMargin: null,
          inputTokens: null,
          projectedAt: "2026-04-24T03:03:00.000Z",
        },
        lastUsage: null,
        state: {
          mustResolveBeforeHandoff: false,
          lastFriendActivityAt: null,
        },
      }),
    )

    const result = loadSession("/tmp/session.json")
    expect(result).not.toBeNull()
    expect(result!.messages).toEqual([
      { role: "system", content: "fresh system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi back" },
    ])
  })

  it("returns canonical events alongside projected messages when loading a legacy v1 file", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
        ],
      }),
    )

    const result = loadSession("/tmp/session.json")
    expect(result).not.toBeNull()
    expect(result!.events).toHaveLength(3)
    expect(result!.events[1]).toMatchObject({
      id: "evt-000002",
      role: "user",
      time: expect.objectContaining({
        authoredAt: null,
        observedAt: null,
        recordedAt: expect.any(String),
      }),
    })
    expect(result!.messages[0]).toEqual({ role: "system", content: "sys" })
    expect(result!.messages[1]).toMatchObject({ role: "user", content: expect.stringContaining("hello") })
    expect(result!.messages[2]).toMatchObject({ role: "assistant", content: expect.stringContaining("hi") })
  })

  it("returns lastUsage: undefined when not present in saved file", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({ lastUsage: undefined, state: undefined })
    expect(result!.messages).toEqual([{ role: "system", content: "sys" }])
    expect(result!.events).toHaveLength(1)
  })

  it("returns persisted continuity state when the saved envelope has a boolean mustResolveBeforeHandoff", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, state: { mustResolveBeforeHandoff: true } }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({ messages: msgs, lastUsage: undefined, state: { mustResolveBeforeHandoff: true } })
  })

  it("ignores malformed optional continuity state instead of rejecting the session", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, messages: msgs, state: { mustResolveBeforeHandoff: "yes please" } }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({ messages: msgs, lastUsage: undefined, state: undefined })
  })

  it("returns persisted lastFriendActivityAt without requiring mustResolveBeforeHandoff", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: msgs,
        state: { lastFriendActivityAt: "2026-03-13T20:00:00.000Z" },
      }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({
      messages: msgs,
      lastUsage: undefined,
      state: { lastFriendActivityAt: "2026-03-13T20:00:00.000Z" },
    })
  })

  it("ignores malformed lastFriendActivityAt while preserving valid mustResolveBeforeHandoff", async () => {
    const { loadSession } = await import("../../mind/context")
    const msgs = [{ role: "system", content: "sys" }]
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: msgs,
        state: {
          mustResolveBeforeHandoff: true,
          lastFriendActivityAt: 123,
        },
      }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).toMatchObject({
      messages: msgs,
      lastUsage: undefined,
      state: { mustResolveBeforeHandoff: true },
    })
  })

  it("returns null when file is missing (ENOENT)", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      const err: any = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })
    expect(loadSession("/tmp/missing.json")).toBeNull()
  })

  it("returns null when file contains invalid JSON", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue("not valid json{{{")
    expect(loadSession("/tmp/corrupt.json")).toBeNull()
  })

  it("returns null when version is unrecognized", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ version: 99, messages: [] }),
    )
    expect(loadSession("/tmp/future.json")).toBeNull()
  })

  it("returns null on other read errors", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw new Error("EPERM")
    })
    expect(loadSession("/tmp/noperm.json")).toBeNull()
  })

  it("returns null when projecting a loaded envelope throws unexpectedly", async () => {
    vi.resetModules()
    vi.doMock("../../heart/session-events", async () => {
      const actual = await vi.importActual<typeof import("../../heart/session-events")>("../../heart/session-events")
      return {
        ...actual,
        loadSessionEnvelopeFile: vi.fn(() => ({
          version: 2 as const,
          events: [],
          projection: {
            eventIds: [],
            trimmed: false,
            maxTokens: null,
            contextMargin: null,
            inputTokens: null,
            projectedAt: null,
          },
          lastUsage: null,
          state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
        })),
        projectProviderMessages: vi.fn(() => {
          throw new Error("projection exploded")
        }),
      }
    })

    try {
      const { loadSession } = await import("../../mind/context")
      expect(loadSession("/tmp/project-bad.json")).toBeNull()
    } finally {
      vi.doUnmock("../../heart/session-events")
      vi.resetModules()
    }
  })

  it("repairs back-to-back assistant messages on load", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second" },
        ],
      }),
    )
    const result = loadSession("/tmp/session.json")
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(3)
    expect((result!.messages[2] as any).content).toContain("first")
    expect((result!.messages[2] as any).content).toContain("second")
  })

  it("emits auto-healed load repairs below warning level", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "first" },
          { role: "assistant", content: "second" },
          { role: "tool", tool_call_id: "orphan-1", content: "stale result" },
        ],
      }),
    )
    const { loadSession } = await import("../../mind/context")

    loadSession("/tmp/session.json")

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_invariant_violation",
      level: "info",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_invariant_repair",
      level: "info",
    }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "mind.session_orphan_tool_result_repair",
      level: "info",
    }))
    expect(emitNervesEvent).not.toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }))
  })

  it("strips orphaned tool results on load", async () => {
    const { loadSession } = await import("../../mind/context")
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hi" },
          { role: "assistant", content: "done" },
          { role: "tool", tool_call_id: "orphan-1", content: "stale result" },
          { role: "user", content: "next" },
        ],
      }),
    )

    const result = loadSession("/tmp/session.json")

    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(4)
    expect(result!.messages.some((msg: any) => msg.role === "tool")).toBe(false)
  })
})

describe("deleteSession", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.unlinkSync).mockReset()
  })

  it("removes the session file", async () => {
    const { deleteSession } = await import("../../mind/context")
    deleteSession("/tmp/session.json")
    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/session.json")
  })

  it("is a no-op when file is missing (ENOENT)", async () => {
    const { deleteSession } = await import("../../mind/context")
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err: any = new Error("ENOENT")
      err.code = "ENOENT"
      throw err
    })
    expect(() => deleteSession("/tmp/missing.json")).not.toThrow()
  })

  it("re-throws non-ENOENT errors", async () => {
    const { deleteSession } = await import("../../mind/context")
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      const err: any = new Error("EPERM")
      err.code = "EPERM"
      throw err
    })
    expect(() => deleteSession("/tmp/noperm.json")).toThrow("EPERM")
  })
})

// --- Unit 3e: postTurn function ---

describe("postTurn", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("trims messages when usage.input_tokens exceeds maxTokens and saves with lastUsage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new" },
      { role: "assistant", content: "new reply" },
    ]
    const usage = { input_tokens: 120000, output_tokens: 50, reasoning_tokens: 10, total_tokens: 120050 }
    postTurn(messages, "/tmp/sess.json", usage)

    // Messages should be trimmed (120000 > 80000)
    expect(messages.length).toBeLessThan(5)
    expect(messages[0].role).toBe("system")
    // Session should be saved with lastUsage
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.lastUsage).toEqual(usage)
  })

  it("does not trim when usage is undefined (cold start) but still saves session", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    postTurn(messages, "/tmp/sess.json")

    expect(messages.length).toBe(2)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("does not trim when usage.input_tokens is under maxTokens, saves with lastUsage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const usage = { input_tokens: 50000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 50010 }
    postTurn(messages, "/tmp/sess.json", usage)

    expect(messages.length).toBe(2)
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.lastUsage).toEqual(usage)
  })

  it("mutates messages array in place (splice, not copy)", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 100, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "a" },
      { role: "assistant", content: "b" },
      { role: "user", content: "c" },
    ]
    const originalRef = messages
    const usage = { input_tokens: 10000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 10010 }
    postTurn(messages, "/tmp/sess.json", usage)

    // Same reference, mutated in place
    expect(messages).toBe(originalRef)
    expect(messages.length).toBeLessThan(4)
    expect(messages[0].role).toBe("system")
  })

  it("saves with (possibly trimmed) messages and usage", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]
    const usage = { input_tokens: 50000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 50010 }
    postTurn(messages, "/tmp/sess.json", usage)

    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.version).toBe(2)
    expect(written.projection.eventIds).toHaveLength(messages.length)
    expect(written.lastUsage).toEqual(usage)
  })

  it("handles empty messages array (only system prompt)", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }
    postTurn(messages, "/tmp/sess.json", usage)

    expect(messages.length).toBe(1)
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("runs extract-before-trim hook with pre-trim messages so dropped context can be captured", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 100, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "keep this: old note that will be trimmed" },
      { role: "assistant", content: "old reply" },
      { role: "user", content: "new message" },
    ]
    const usage = { input_tokens: 10000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 10010 }

    let hookCalled = false
    let sawOldMessage = false

    ;(postTurn as any)(
      messages,
      "/tmp/sess.json",
      usage,
      {
        beforeTrim: (preTrimMessages: any[]) => {
          hookCalled = true
          sawOldMessage = preTrimMessages.some((m) =>
            typeof m.content === "string" && m.content.includes("old note that will be trimmed"),
          )
        },
      },
    )

    expect(hookCalled).toBe(true)
    expect(sawOldMessage).toBe(true)
    expect(messages.some((m) => typeof m.content === "string" && m.content.includes("old note that will be trimmed"))).toBe(false)
  })

  it("continues saving session when extract-before-trim hook throws", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }

    expect(() =>
      (postTurn as any)(
        messages,
        "/tmp/sess.json",
        usage,
        {
          beforeTrim: () => {
            throw new Error("hook failed")
          },
        },
      ),
    ).not.toThrow()
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("continues saving session when extract-before-trim hook throws non-Error values", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const usage = { input_tokens: 1000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 1010 }

    expect(() =>
      (postTurn as any)(
        messages,
        "/tmp/sess.json",
        usage,
        {
          beforeTrim: () => {
            throw "hook failed as string"
          },
        },
      ),
    ).not.toThrow()
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1)
  })

  it("reuses existing canonical event ids when postTurn writes an updated session", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 2,
      events: [
        {
          id: "evt-000001",
          sequence: 1,
          role: "system",
          content: "sys",
          name: null,
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: "2026-04-09T17:20:00.000Z",
            authoredAtSource: "local",
            observedAt: "2026-04-09T17:20:00.000Z",
            observedAtSource: "local",
            recordedAt: "2026-04-09T17:20:00.000Z",
            recordedAtSource: "save",
          },
          relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
        },
        {
          id: "evt-000002",
          sequence: 2,
          role: "user",
          content: "hello",
          name: null,
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: null,
            authoredAtSource: "unknown",
            observedAt: "2026-04-09T17:21:00.000Z",
            observedAtSource: "ingest",
            recordedAt: "2026-04-09T17:21:00.000Z",
            recordedAtSource: "save",
          },
          relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
        },
      ],
      projection: {
        eventIds: ["evt-000001", "evt-000002"],
        trimmed: false,
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: null,
        projectedAt: "2026-04-09T17:21:00.000Z",
      },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }))

    const { postTurn } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "new answer" },
    ]
    const usage = { input_tokens: 50000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 50010 }

    postTurn(messages, "/tmp/sess.json", usage)

    const parsed = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(parsed.events.map((event: any) => event.id)).toEqual(["evt-000001", "evt-000002", "evt-000003"])
    expect(parsed.projection.eventIds).toEqual(["evt-000001", "evt-000002", "evt-000003"])
  })
})

// --- postTurnPersist return value ---

describe("postTurnPersist return value", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("returns SessionEvent[] from the envelope it built", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]
    const usage = { input_tokens: 5000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 5010 }
    const prepared = postTurnTrim(messages, usage)
    const result = postTurnPersist("/tmp/sess.json", prepared, usage)

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    // Events should match what was written to disk
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(result).toEqual(written.events)
  })

  it("returns non-empty events array for a turn with messages", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { postTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "test input" },
      { role: "assistant", content: "test reply" },
    ]
    const prepared = postTurnTrim(messages)
    const result = postTurnPersist("/tmp/sess.json", prepared)

    expect(result.length).toBeGreaterThan(0)
    // Each event should have an id and role
    for (const event of result) {
      expect(event).toHaveProperty("id")
      expect(event).toHaveProperty("role")
    }
  })
})

// --- deferPostTurnPersist return value ---

describe("deferPostTurnPersist return value", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
  })

  it("resolves with SessionEvent[] on success", async () => {
    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { deferPostTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]
    const usage = { input_tokens: 5000, output_tokens: 10, reasoning_tokens: 0, total_tokens: 5010 }
    const prepared = postTurnTrim(messages, usage)
    const result = await deferPostTurnPersist("/tmp/sess.json", prepared, usage)

    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
    // Events should match what was written to disk
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(result).toEqual(written.events)
  })

  it("resolves with empty array when postTurnPersist throws", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    // Mock writeFileSync to throw on the persist write
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("disk failure")
    })

    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { deferPostTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const prepared = postTurnTrim(messages)
    const result = await deferPostTurnPersist("/tmp/sess.json", prepared)

    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual([])
    // Should have logged the error
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "mind.deferred_persist_error" }),
    )
  })

  it("resolves with empty array when postTurnPersist throws a non-Error value", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    // Mock writeFileSync to throw a string (non-Error)
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw "string error"  // eslint-disable-line no-throw-literal
    })

    const { getContextConfig } = await import("../../heart/config")
    vi.mocked(getContextConfig).mockReturnValue({ maxTokens: 80000, contextMargin: 20 })

    const { deferPostTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]
    const prepared = postTurnTrim(messages)
    const result = await deferPostTurnPersist("/tmp/sess.json", prepared)

    expect(result).toEqual([])
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "mind.deferred_persist_error",
        meta: { error: "string error" },
      }),
    )
  })
})

describe("deferPostTurnPersist concurrency", () => {
  // Real corruption was found in slugger.ouro/state/sessions where two BB
  // webhooks for the same chat racing through deferPostTurnPersist each loaded
  // the envelope, both computed the same `events.length + 1` next sequence,
  // and wrote events with colliding ids ("evt-000130" appearing 3x). The
  // serialization queue must prevent that even when both calls fire on the
  // same tick for the same sessPath.
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    vi.mocked(fs.mkdirSync).mockReset()
    vi.mocked(fs.existsSync).mockReset()
  })

  it("serializes concurrent deferPostTurnPersist calls for the same sessPath, leaving no duplicate ids", async () => {
    const sessPath = "/tmp/concurrent-session.json"
    // Mock fs as an in-memory store so the second call sees the first call's writes.
    let onDisk: string | null = null
    vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
      if (p === sessPath && onDisk !== null) return onDisk as any
      throw new Error("ENOENT")
    })
    vi.mocked(fs.writeFileSync).mockImplementation((p: any, contents: any) => {
      if (p === sessPath) onDisk = contents as string
    })

    const { deferPostTurnPersist, postTurnTrim } = await import("../../mind/context")

    const turnOne: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ]
    const turnTwo: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
      { role: "user", content: "second turn" },
      { role: "assistant", content: "second answer" },
    ]
    const preparedOne = postTurnTrim(turnOne)
    const preparedTwo = postTurnTrim(turnTwo)

    // Fire both at once, same sessPath, no awaits between.
    const [eventsOne, eventsTwo] = await Promise.all([
      deferPostTurnPersist(sessPath, preparedOne),
      deferPostTurnPersist(sessPath, preparedTwo),
    ])

    // Both calls return event arrays with no internal duplicates.
    const idsOne = eventsOne.map((e) => e.id)
    const idsTwo = eventsTwo.map((e) => e.id)
    expect(new Set(idsOne).size).toBe(idsOne.length)
    expect(new Set(idsTwo).size).toBe(idsTwo.length)

    // The final on-disk envelope has no duplicate ids either.
    expect(onDisk).not.toBeNull()
    const written = JSON.parse(onDisk!) as { events: { id: string }[] }
    const writtenIds = written.events.map((e) => e.id)
    expect(new Set(writtenIds).size).toBe(writtenIds.length)
  })

  it("does not deadlock subsequent calls when one persist throws", async () => {
    const sessPath = "/tmp/deadlock-session.json"
    let writeCalls = 0
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT") })
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      writeCalls += 1
      if (writeCalls === 1) throw new Error("disk failure on first call")
    })

    const { deferPostTurnPersist, postTurnTrim } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u" },
      { role: "assistant", content: "a" },
    ]
    const prepared = postTurnTrim(messages)
    const failing = deferPostTurnPersist(sessPath, prepared)
    const recovering = deferPostTurnPersist(sessPath, prepared)

    const [first, second] = await Promise.all([failing, recovering])
    // First throws -> empty array. Second runs and returns real events.
    expect(first).toEqual([])
    expect(second.length).toBeGreaterThan(0)
    expect(writeCalls).toBe(2)
  })
})

describe("mind observability instrumentation", () => {
  it("trimMessages emits mind step lifecycle events", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    const { trimMessages } = await import("../../mind/context")
    trimMessages(
      [
        { role: "system", content: "sys" } as any,
        { role: "user", content: "hello" } as any,
      ],
      100,
      20,
      200,
    )

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.step_start" }))
    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "mind.step_end" }))
  })
})

describe("validateSessionMessages", () => {
  beforeEach(() => { vi.resetModules() })

  it("returns no violations for valid user/assistant sequence", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "how?" },
      { role: "assistant", content: "fine" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })

  it("returns no violations for assistant with tool calls followed by tool results then user", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "check" },
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function" as const, function: { name: "foo", arguments: "{}" } }] },
      { role: "tool", content: "result", tool_call_id: "t1" },
      { role: "assistant", content: "done" },
      { role: "user", content: "ok" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })

  it("detects back-to-back assistant messages", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "hello again" },
    ]
    const violations = validateSessionMessages(messages)
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toContain("back-to-back assistant")
  })

  it("returns empty for empty message array", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    expect(validateSessionMessages([])).toEqual([])
  })

  it("returns empty for system-only messages", async () => {
    const { validateSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
    ]
    expect(validateSessionMessages(messages)).toEqual([])
  })
})

describe("repairSessionMessages", () => {
  beforeEach(() => { vi.resetModules() })

  it("merges back-to-back assistant messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "hello again" },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired.length).toBe(3)
    expect(repaired[2].role).toBe("assistant")
    expect((repaired[2] as any).content).toContain("hello")
    expect((repaired[2] as any).content).toContain("hello again")
  })

  it("returns unchanged for valid messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired).toEqual(messages)
  })

  it("handles non-string content in back-to-back assistant messages", async () => {
    const { repairSessionMessages } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
      { role: "assistant", content: null },
      { role: "assistant", content: undefined },
    ]
    const repaired = repairSessionMessages(messages)
    expect(repaired).toHaveLength(3)
    // Both non-string contents should fall back to ""
    expect((repaired[2] as any).content).toBe("\n\n")
  })
})

describe("appendSyntheticAssistantMessage", () => {
  it("appends an assistant message to an existing session file", async () => {
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(fs.writeFileSync).mockReset()
    const { appendSyntheticAssistantMessage } = await import("../../mind/context")
    const sessionData = JSON.stringify({
      version: 1,
      messages: [
        { role: "system", content: "test" },
        { role: "user", content: "hello" },
      ],
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(sessionData)
    const result = appendSyntheticAssistantMessage("/mock/session.json", "my reflection")
    expect(result).toBe(true)
    const written = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string)
    expect(written.events).toHaveLength(3)
    // Content should be raw delivered text — no [surfaced from inner dialog] prefix.
    // Provenance is tracked via captureKind: "synthetic", not content prefixes.
    expect(written.events[2]).toMatchObject({ role: "assistant", content: "my reflection" })
    expect(written.events[2].content).not.toContain("[surfaced from inner dialog]")
  })

  it("returns false for non-existent file", async () => {
    const { appendSyntheticAssistantMessage } = await import("../../mind/context")
    vi.mocked(fs.existsSync).mockReturnValue(false)
    expect(appendSyntheticAssistantMessage("/mock/missing.json", "test")).toBe(false)
  })

  it("returns false for invalid session version", async () => {
    const { appendSyntheticAssistantMessage } = await import("../../mind/context")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ version: 2, messages: [] }))
    expect(appendSyntheticAssistantMessage("/mock/bad.json", "test")).toBe(false)
  })

  it("returns false for unparseable JSON", async () => {
    const { appendSyntheticAssistantMessage } = await import("../../mind/context")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("bad json") })
    expect(appendSyntheticAssistantMessage("/mock/bad.json", "test")).toBe(false)
  })

  it("returns false when rewriting the session file throws unexpectedly", async () => {
    const { appendSyntheticAssistantMessage } = await import("../../mind/context")
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      version: 1,
      messages: [{ role: "user", content: "hello" }],
    }))
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("disk full")
    })
    expect(appendSyntheticAssistantMessage("/mock/write-fails.json", "test")).toBe(false)
  })
})

describe("migrateToolNames", () => {
  it("rewrites old tool names in assistant tool_calls", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      { role: "system", content: "you are helpful" },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "final_answer", arguments: '{"answer":"hi"}' } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "(delivered)" },
      {
        role: "assistant",
        tool_calls: [{ id: "tc2", type: "function", function: { name: "go_inward", arguments: '{"topic":"think"}' } }],
      },
      { role: "tool", tool_call_id: "tc2", content: "(going inward)" },
      {
        role: "assistant",
        tool_calls: [{ id: "tc3", type: "function", function: { name: "no_response", arguments: '{}' } }],
      },
      { role: "tool", tool_call_id: "tc3", content: "(observing)" },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[2] as any).tool_calls[0].function.name).toBe("settle")
    expect((migrated[4] as any).tool_calls[0].function.name).toBe("ponder")
    expect((migrated[6] as any).tool_calls[0].function.name).toBe("observe")
  })

  it("leaves current tool names unchanged", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "function", function: { name: "settle", arguments: '{"answer":"hi"}' } }],
      },
      { role: "tool", tool_call_id: "tc1", content: "(delivered)" },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[0] as any).tool_calls[0].function.name).toBe("settle")
  })

  it("returns messages unchanged when no renames needed", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]
    const migrated = migrateToolNames(messages)
    expect(migrated).toEqual(messages)
  })

  it("handles messages with no tool_calls", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      { role: "assistant", content: "just text" },
      { role: "assistant", tool_calls: [] },
    ]
    const migrated = migrateToolNames(messages)
    expect(migrated).toEqual([
      { role: "assistant", content: "just text" },
      { role: "assistant", content: null, tool_calls: [] },
    ])
  })

  it("skips non-function tool calls (e.g. custom type)", async () => {
    const { migrateToolNames } = await import("../../mind/context")
    const messages: any[] = [
      {
        role: "assistant",
        tool_calls: [{ id: "tc1", type: "custom", custom: { name: "final_answer" } }],
      },
    ]
    const migrated = migrateToolNames(messages)
    expect((migrated[0] as any).tool_calls[0].type).toBe("custom")
  })
})
