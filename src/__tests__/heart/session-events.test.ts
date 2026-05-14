import { describe, expect, it } from "vitest"
import type OpenAI from "openai"

describe("session events", () => {
  const markerFor = (maxChars: number, originalLength: number) =>
    `[truncated — event content exceeded ${maxChars} chars; original length ${originalLength} chars]`

  const expectedTruncatedContent = (content: string, maxChars: number) => {
    const marker = markerFor(maxChars, content.length)
    const remainingBudget = Math.max(0, maxChars - marker.length)
    const headLength = Math.ceil(remainingBudget * 0.75)
    const tailLength = remainingBudget - headLength
    return `${content.slice(0, headLength)}${marker}${tailLength > 0 ? content.slice(-tailLength) : ""}`
  }

  describe("truncateLargeEventContent", () => {
    it("leaves under-cap strings unchanged and reports the original length", async () => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }
      const input = "small event content"

      expect(truncateLargeEventContent(input, 100)).toEqual({
        content: input,
        truncated: false,
        originalLength: input.length,
      })
    })

    it("truncates over-cap strings with the rendered marker and preserved head/tail samples", async () => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }
      const maxChars = 100
      const input = `${"H".repeat(80)}${"M".repeat(80)}${"T".repeat(80)}`

      expect(truncateLargeEventContent(input, maxChars)).toEqual({
        content: expectedTruncatedContent(input, maxChars),
        truncated: true,
        originalLength: input.length,
      })
    })

    it.each([
      { label: "object", content: { nested: "value" } },
      { label: "array", content: [{ type: "text", text: "value" }] },
      { label: "null", content: null },
      { label: "undefined", content: undefined },
    ])("leaves non-string $label content unchanged", async ({ content }) => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }

      expect(truncateLargeEventContent(content, 10)).toEqual({
        content,
        truncated: false,
        originalLength: 0,
      })
    })

    it("returns only the marker when the cap is zero", async () => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }
      const input = "anything"

      expect(truncateLargeEventContent(input, 0)).toEqual({
        content: markerFor(0, input.length),
        truncated: true,
        originalLength: input.length,
      })
    })

    it("leaves exactly-at-cap strings unchanged", async () => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }
      const input = "x".repeat(25)

      expect(truncateLargeEventContent(input, input.length)).toEqual({
        content: input,
        truncated: false,
        originalLength: input.length,
      })
    })

    it("truncates strings that are one byte over the cap", async () => {
      const { truncateLargeEventContent } = await import("../../heart/session-events") as unknown as {
        truncateLargeEventContent: (content: unknown, maxChars: number) => { content: unknown; truncated: boolean; originalLength: number }
      }
      const maxChars = 80
      const input = "x".repeat(maxChars + 1)

      expect(truncateLargeEventContent(input, maxChars)).toEqual({
        content: expectedTruncatedContent(input, maxChars),
        truncated: true,
        originalLength: input.length,
      })
    })
  })

  it("caps oversized event content at 256 KB by default for every session role without changing non-content fields", async () => {
    const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")
    const maxChars = 256 * 1024
    const oversized = `${"H".repeat(200_000)}${"M".repeat(80_000)}${"T".repeat(20_000)}`
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: oversized, name: "system-name" },
      { role: "user", content: oversized, name: "user-name" },
      {
        role: "assistant",
        content: oversized,
        name: "assistant-name",
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_session", arguments: "{\"needle\":\"blue\"}" },
          },
        ],
      },
      { role: "tool", content: oversized, tool_call_id: "call-1" },
    ] as OpenAI.ChatCompletionMessageParam[]

    const { envelope } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: messages,
      trimmedMessages: messages,
      recordedAt: "2026-05-13T20:00:00.000Z",
      lastUsage: null,
      state: null,
      projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
    })

    expect(envelope.events.map((event) => event.role)).toEqual(["system", "user", "assistant", "tool"])
    for (const event of envelope.events) {
      expect(typeof event.content).toBe("string")
      expect((event.content as string).length).toBeLessThanOrEqual(maxChars)
      expect(event.content).toContain(markerFor(maxChars, oversized.length))
      expect(event.content).toMatch(/^H+/)
      expect(event.content).toMatch(/T+$/)
      expect(event.attachments).toEqual([])
    }
    expect(envelope.events[0]).toMatchObject({ name: "system-name", toolCalls: [], toolCallId: null })
    expect(envelope.events[1]).toMatchObject({ name: "user-name", toolCalls: [], toolCallId: null })
    expect(envelope.events[2]).toMatchObject({
      name: "assistant-name",
      toolCallId: null,
      toolCalls: [
        {
          id: "call-1",
          type: "function",
          function: { name: "query_session", arguments: "{\"needle\":\"blue\"}" },
        },
      ],
    })
    expect(envelope.events[3]).toMatchObject({
      name: null,
      toolCallId: "call-1",
      toolCalls: [],
      relations: { toolCallId: "call-1" },
    })
  })

  it("preserves non-string event content arrays through the envelope path while capping oversized strings", async () => {
    const { buildCanonicalSessionEnvelope, EVENT_CONTENT_MAX_CHARS } = await import("../../heart/session-events")
    const contentParts = [
      { type: "text", text: "keep this structured content" },
      { type: "image_url", image_url: { url: "attachment://image-1" } },
    ]
    const oversized = "x".repeat(EVENT_CONTENT_MAX_CHARS + 1)
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: contentParts },
      { role: "assistant", content: oversized },
    ] as OpenAI.ChatCompletionMessageParam[]

    const { envelope } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: messages,
      trimmedMessages: messages,
      recordedAt: "2026-05-13T20:01:00.000Z",
      lastUsage: null,
      state: null,
      projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
    })

    expect(envelope.events[0]?.content).toEqual(contentParts)
    expect(envelope.events[1]?.content).toContain(markerFor(EVENT_CONTENT_MAX_CHARS, oversized.length))
    expect(String(envelope.events[1]?.content).length).toBeLessThanOrEqual(EVENT_CONTENT_MAX_CHARS)
  })

  it("migrates a legacy v1 session envelope into canonical events with explicit metadata", async () => {
    const { migrateLegacySessionEnvelope } = await import("../../heart/session-events")

    const migrated = migrateLegacySessionEnvelope(
      {
        version: 1,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "hello there" },
          { role: "assistant", content: "hi back" },
        ],
        state: { lastFriendActivityAt: "2026-04-09T17:20:00.000Z", mustResolveBeforeHandoff: false },
      },
      {
        recordedAt: "2026-04-09T17:21:00.000Z",
        fileMtimeAt: "2026-04-09T17:21:00.000Z",
      },
    )

    expect(migrated).not.toBeNull()
    expect(migrated!.version).toBe(2)
    expect(migrated!.events).toHaveLength(3)
    expect(migrated!.projection.eventIds).toEqual(["evt-000001", "evt-000002", "evt-000003"])
    expect(migrated!.events[1]).toMatchObject({
      id: "evt-000002",
      sequence: 2,
      role: "user",
      provenance: {
        captureKind: "migration",
        legacyVersion: 1,
        sourceMessageIndex: 1,
      },
      time: {
        authoredAt: null,
        observedAt: null,
        recordedAt: "2026-04-09T17:21:00.000Z",
      },
      relations: {
        replyToEventId: null,
        threadRootEventId: null,
        references: [],
        toolCallId: null,
        supersedesEventId: null,
        redactsEventId: null,
      },
    })
  })

  it("preserves full history on disk while projecting only the trimmed provider window", async () => {
    const {
      buildCanonicalSessionEnvelope,
      projectProviderMessages,
    } = await import("../../heart/session-events")

    const previousMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ]
    const currentMessages: OpenAI.ChatCompletionMessageParam[] = [
      ...previousMessages,
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]
    const trimmedMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "latest question" },
      { role: "assistant", content: "latest answer" },
    ]

    const { envelope } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: previousMessages,
      trimmedMessages: previousMessages,
      recordedAt: "2026-04-09T17:30:00.000Z",
      lastUsage: null,
      state: undefined,
      projectionBasis: {
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: null,
      },
    })

    const { envelope: updated } = buildCanonicalSessionEnvelope({
      existing: envelope,
      previousMessages,
      currentMessages,
      trimmedMessages,
      recordedAt: "2026-04-09T17:31:00.000Z",
      lastUsage: null,
      state: undefined,
      projectionBasis: {
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: 120000,
      },
    })

    // Pruned envelope only contains projected events
    expect(updated.events).toHaveLength(3)
    expect(updated.projection.eventIds).toEqual(["evt-000001", "evt-000004", "evt-000005"])
    expect(projectProviderMessages(updated)).toEqual(trimmedMessages)
  })

  it("describes current session timing with reply cadence and unanswered inbound count", async () => {
    const { describeCurrentSessionTiming } = await import("../../heart/session-events")

    const timing = describeCurrentSessionTiming([
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
          observedAt: "2026-04-09T10:00:00.000Z",
          observedAtSource: "ingest",
          recordedAt: "2026-04-09T10:00:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
      {
        id: "evt-000002",
        sequence: 2,
        role: "assistant",
        content: "hi",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: {
          authoredAt: "2026-04-09T10:20:00.000Z",
          authoredAtSource: "local",
          observedAt: "2026-04-09T10:20:00.000Z",
          observedAtSource: "local",
          recordedAt: "2026-04-09T10:20:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
      {
        id: "evt-000003",
        sequence: 3,
        role: "user",
        content: "one",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: {
          authoredAt: null,
          authoredAtSource: "unknown",
          observedAt: "2026-04-09T10:40:00.000Z",
          observedAtSource: "ingest",
          recordedAt: "2026-04-09T10:40:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
      {
        id: "evt-000004",
        sequence: 4,
        role: "user",
        content: "two",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: {
          authoredAt: null,
          authoredAtSource: "unknown",
          observedAt: "2026-04-09T10:50:00.000Z",
          observedAtSource: "ingest",
          recordedAt: "2026-04-09T10:50:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
    ], Date.parse("2026-04-09T11:00:00.000Z"))

    expect(timing).toContain("last inbound 10m ago")
    expect(timing).toContain("i last replied 40m ago")
    expect(timing).toContain("2 unanswered inbound messages")
  })

  it("formats longer timing spans in hours and days", async () => {
    const { describeCurrentSessionTiming } = await import("../../heart/session-events")

    const timing = describeCurrentSessionTiming([
      {
        id: "evt-000001",
        sequence: 1,
        role: "assistant",
        content: "older reply",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: {
          authoredAt: "2026-04-07T09:00:00.000Z",
          authoredAtSource: "local",
          observedAt: "2026-04-07T09:00:00.000Z",
          observedAtSource: "local",
          recordedAt: "2026-04-07T09:00:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
      {
        id: "evt-000002",
        sequence: 2,
        role: "user",
        content: "newer question",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: {
          authoredAt: null,
          authoredAtSource: "unknown",
          observedAt: "2026-04-09T09:00:00.000Z",
          observedAtSource: "ingest",
          recordedAt: "2026-04-09T09:00:00.000Z",
          recordedAtSource: "save",
        },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      },
    ], Date.parse("2026-04-09T11:00:00.000Z"))

    expect(timing).toContain("last inbound 2h ago")
    expect(timing).toContain("i last replied 2d ago")
  })

  it("accepts versionless legacy envelopes and filters attachment arrays in v2 envelopes", async () => {
    const { parseSessionEnvelope } = await import("../../heart/session-events")

    const migrated = parseSessionEnvelope({
      messages: [
        { role: "user", content: "hello" },
      ],
      state: { lastFriendActivityAt: "2026-04-09T17:20:00.000Z" },
    }, {
      recordedAt: "2026-04-09T17:21:00.000Z",
      fileMtimeAt: "2026-04-09T17:21:00.000Z",
    })

    expect(migrated?.version).toBe(2)
    expect(migrated?.events[0]?.provenance.captureKind).toBe("migration")

    const parsed = parseSessionEnvelope({
      version: 2,
      events: [{
        id: "evt-000001",
        sequence: 1,
        role: "user",
        content: "hello",
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: ["attachment:one", 42, "attachment:two"],
        time: {
          authoredAt: null,
          authoredAtSource: "unknown",
          observedAt: "2026-04-09T17:21:00.000Z",
          observedAtSource: "ingest",
          recordedAt: "2026-04-09T17:21:00.000Z",
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
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      }],
      projection: {
        eventIds: ["evt-000001"],
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: null,
        projectedAt: "2026-04-09T17:21:00.000Z",
      },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    })

    expect(parsed?.events[0]?.attachments).toEqual(["attachment:one", "attachment:two"])
  })

  it("strips synthetic relative-time prefixes from parsed user and assistant events", async () => {
    const { parseSessionEnvelope, projectProviderMessages } = await import("../../heart/session-events")

    const parsed = parseSessionEnvelope({
      version: 2,
      events: [
        {
          id: "evt-000001",
          sequence: 1,
          role: "user",
          content: "[just now] [-34m] hello",
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
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
        },
        {
          id: "evt-000002",
          sequence: 2,
          role: "assistant",
          content: "[just now] reply",
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
          provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
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
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }, {
      recordedAt: "2026-04-24T03:01:00.000Z",
      fileMtimeAt: "2026-04-24T03:01:00.000Z",
    })

    expect(parsed?.events[0]?.content).toBe("hello")
    expect(parsed?.events[1]?.content).toBe("reply")
    expect(projectProviderMessages(parsed!)).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "reply" },
    ])
  })

  it("drops malformed lastUsage payloads instead of preserving partial numeric garbage", async () => {
    const { parseSessionEnvelope } = await import("../../heart/session-events")

    const parsed = parseSessionEnvelope({
      version: 2,
      events: [],
      projection: {
        eventIds: [],
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: null,
        projectedAt: null,
      },
      lastUsage: {
        input_tokens: 10,
        output_tokens: "11",
        reasoning_tokens: 12,
        total_tokens: 33,
      },
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }, {
      recordedAt: "2026-04-09T17:21:00.000Z",
      fileMtimeAt: "2026-04-09T17:21:00.000Z",
    })

    expect(parsed?.lastUsage).toBeNull()
  })

  it("migrates deprecated tool-call names in the canonical session helper", async () => {
    const { migrateToolNames } = await import("../../heart/session-events")

    const migrated = migrateToolNames([
      {
        role: "assistant",
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "final_answer", arguments: "{}" } },
          { id: "tc2", type: "custom", custom: { name: "leave-me-alone" } },
        ],
      } as any,
    ])

    expect((migrated[0] as any).tool_calls[0]).toEqual({
      id: "tc1",
      type: "function",
      function: { name: "settle", arguments: "{}" },
    })
    expect((migrated[0] as any).tool_calls[1].type).toBe("custom")
  })

  it("normalizes provider messages across developer, assistant, tool, and user fallbacks", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      {
        role: "developer",
        content: [{ type: "text", text: "sys via developer" }],
        name: "sysname",
      } as any,
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from parts" }],
        name: "helper",
        tool_calls: [
          { function: { arguments: { ok: true } } },
          { id: "tc-custom", type: "custom", function: { name: "kept-custom", arguments: "{}" } },
        ],
      } as any,
      {
        role: "tool",
        content: [{ type: "text", text: "tool output" }],
      } as any,
      {
        role: "user",
        content: null,
        name: "Ari",
      } as any,
    ])

    expect(sanitized).toEqual([
      {
        role: "system",
        content: "sys via developer",
        name: "sysname",
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from parts" }],
        name: "helper",
        tool_calls: [
          {
            id: "",
            type: "function",
            function: { name: "unknown", arguments: "{\"ok\":true}" },
          },
          {
            id: "tc-custom",
            type: "custom",
            function: { name: "kept-custom", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        content: "",
        tool_call_id: "",
      },
      {
        role: "tool",
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
        tool_call_id: "tc-custom",
      },
      {
        role: "user",
        content: "",
        name: "Ari",
      },
    ])
  })

  it("canonicalizes duplicate system prompts down to one leading system message", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "system", content: "stale system" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ])
  })

  it("injects synthetic tool results for assistant tool calls missing their outputs", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      { role: "user", content: "next" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
      },
      { role: "user", content: "next" },
    ])
  })

  it("stops synthetic tool-result backfill at the next assistant message", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      { role: "assistant", content: "moving on" },
      { role: "tool", tool_call_id: "call-1", content: "late result" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call-1",
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
      },
      { role: "assistant", content: "moving on" },
      { role: "tool", tool_call_id: "call-1", content: "late result" },
    ])
  })

  it("stops collecting tool results once a later assistant message begins a new turn", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "query_session", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
      { role: "assistant", content: "starting a fresh thought" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "query_session", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
      {
        role: "tool",
        tool_call_id: "call-2",
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
      },
      { role: "assistant", content: "starting a fresh thought" },
    ])
  })

  it("stops collecting tool results once a later user message begins a new turn", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "query_session", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
      { role: "user", content: "new question" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
          {
            id: "call-2",
            type: "function",
            function: { name: "query_session", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
      {
        role: "tool",
        tool_call_id: "call-2",
        content: "error: this tool call's result was lost — the previous turn ended before the tool finished (provider rejection, daemon interrupt, or the tool itself errored). if the work needs to be done, retry the tool call now.",
      },
      { role: "user", content: "new question" },
    ])
  })

  it("keeps collecting tool results across non-turn messages that are neither assistant nor user", async () => {
    const { sanitizeProviderMessages } = await import("../../heart/session-events")

    const sanitized = sanitizeProviderMessages([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      { role: "system", content: "mid-stream metadata" },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
    ] as any)

    expect(sanitized).toEqual([
      { role: "system", content: "fresh system" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call-1",
            type: "function",
            function: { name: "query_active_work", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-1", content: "active work" },
    ])
  })

  it("handles migrateToolNames guard paths before canonical normalization", async () => {
    const { migrateToolNames } = await import("../../heart/session-events")

    const migrated = migrateToolNames([
      null,
      {
        role: "assistant",
        tool_calls: [
          null,
          { type: "function", function: { arguments: { nested: true } } },
          { id: "tc-rename", type: "function", function: { name: "final_answer", arguments: "{}" } },
        ],
      } as any,
    ] as any)

    expect((migrated[0] as any).tool_calls).toEqual([
      {
        id: "",
        type: "function",
        function: { name: "unknown", arguments: "{\"nested\":true}" },
      },
      {
        id: "tc-rename",
        type: "function",
        function: { name: "settle", arguments: "{}" },
      },
    ])
  })

  it("parses canonical v2 envelopes with both explicit metadata and fallback defaults", async () => {
    const {
      migrateLegacySessionEnvelope,
      parseSessionEnvelope,
    } = await import("../../heart/session-events")

    expect(migrateLegacySessionEnvelope(null, {
      recordedAt: "2026-04-09T17:21:00.000Z",
      fileMtimeAt: null,
    })).toBeNull()
    expect(parseSessionEnvelope(null)).toBeNull()

    const legacy = migrateLegacySessionEnvelope({
      messages: [{ role: "user", content: "legacy" }],
      state: {},
    }, {
      recordedAt: "2026-04-09T17:21:00.000Z",
      fileMtimeAt: null,
    })
    expect(legacy?.projection.projectedAt).toBe("2026-04-09T17:21:00.000Z")

    const parsed = parseSessionEnvelope({
      version: 2,
      events: [
        {
          id: "evt-explicit",
          sequence: 7,
          role: "assistant",
          content: "kept",
          name: "named-assistant",
          toolCallId: "tc-explicit",
          toolCalls: [{ id: "call-1", type: "function", function: { name: "settle", arguments: "{}" } }],
          attachments: ["attachment-1", 4],
          time: {
            authoredAt: "2026-04-09T17:00:00.000Z",
            authoredAtSource: "local",
            observedAt: "2026-04-09T17:00:01.000Z",
            observedAtSource: "local",
            recordedAt: "2026-04-09T17:00:02.000Z",
            recordedAtSource: "save",
          },
          relations: {
            replyToEventId: "evt-prev",
            threadRootEventId: "evt-root",
            references: ["evt-ref", 3],
            toolCallId: "tool-ref",
            supersedesEventId: "evt-old",
            redactsEventId: "evt-redact",
          },
          provenance: {
            captureKind: "synthetic",
            legacyVersion: 1,
            sourceMessageIndex: 2,
          },
        },
        {
          role: "developer",
          content: { bad: true },
          name: 42,
          toolCallId: 99,
          toolCalls: [{ function: { arguments: { weird: true } } }],
          attachments: null,
          time: {
            authoredAt: 1,
            authoredAtSource: 2,
            observedAt: 3,
            observedAtSource: 4,
            recordedAt: 5,
            recordedAtSource: 6,
          },
          relations: {
            replyToEventId: 1,
            threadRootEventId: 2,
            references: null,
            toolCallId: 4,
            supersedesEventId: 5,
            redactsEventId: 6,
          },
          provenance: {
            captureKind: 7,
            legacyVersion: "bad",
            sourceMessageIndex: "bad",
          },
        },
      ],
      projection: {
        eventIds: ["evt-explicit", 2],
        trimmed: true,
        maxTokens: 8000,
        contextMargin: 15,
        inputTokens: "bad",
        projectedAt: 9,
      },
      lastUsage: null,
      state: {},
    }, {
      recordedAt: "2026-04-09T17:30:00.000Z",
    })

    expect(parsed).not.toBeNull()
    expect(parsed!.events[0]).toMatchObject({
      id: "evt-explicit",
      sequence: 7,
      attachments: ["attachment-1"],
      relations: {
        replyToEventId: "evt-prev",
        threadRootEventId: "evt-root",
        references: ["evt-ref"],
        toolCallId: "tool-ref",
        supersedesEventId: "evt-old",
        redactsEventId: "evt-redact",
      },
      provenance: {
        captureKind: "synthetic",
        legacyVersion: 1,
        sourceMessageIndex: 2,
      },
    })
    expect(parsed!.events[1]).toMatchObject({
      id: "evt-000002",
      sequence: 2,
      role: "system",
      content: null,
      name: null,
      toolCallId: null,
      toolCalls: [
        {
          id: "",
          type: "function",
          function: { name: "unknown", arguments: "{\"weird\":true}" },
        },
      ],
      attachments: [],
      time: {
        authoredAt: null,
        authoredAtSource: "unknown",
        observedAt: null,
        observedAtSource: "unknown",
        recordedAt: "2026-04-09T17:30:00.000Z",
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
    })
    expect(parsed!.projection).toEqual({
      eventIds: ["evt-explicit"],
      trimmed: true,
      maxTokens: 8000,
      contextMargin: 15,
      inputTokens: null,
      projectedAt: null,
    })

    const projectionFallback = parseSessionEnvelope({
      version: 2,
      events: [
        {
          id: "evt-projection",
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
            observedAt: null,
            observedAtSource: "unknown",
            recordedAt: "2026-04-09T17:30:00.000Z",
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
        eventIds: null,
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: 12,
        projectedAt: "2026-04-09T17:31:00.000Z",
      },
      lastUsage: null,
      state: {},
    }, {
      recordedAt: "2026-04-09T17:30:00.000Z",
    })

    expect(projectionFallback?.projection).toEqual({
      eventIds: [],
      trimmed: false,
      maxTokens: null,
      contextMargin: null,
      inputTokens: 12,
      projectedAt: "2026-04-09T17:31:00.000Z",
    })
  })

  it("preserves history while reprojecting from the first changed message", async () => {
    const { buildCanonicalSessionEnvelope, projectProviderMessages } = await import("../../heart/session-events")

    const previousMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old question" },
      { role: "assistant", content: "old answer" },
    ]
    const currentMessages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "revised question" },
      { role: "assistant", content: "revised answer" },
    ]

    const { envelope: existing } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: previousMessages,
      trimmedMessages: previousMessages,
      recordedAt: "2026-04-09T17:40:00.000Z",
      lastUsage: null,
      state: undefined,
      projectionBasis: {
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: null,
      },
    })

    const { envelope: updated } = buildCanonicalSessionEnvelope({
      existing,
      previousMessages,
      currentMessages,
      trimmedMessages: currentMessages,
      recordedAt: "2026-04-09T17:41:00.000Z",
      lastUsage: null,
      state: undefined,
      projectionBasis: {
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: 90000,
      },
    })

    // Pruned envelope only contains projected events (old events 2,3 evicted)
    expect(updated.events).toHaveLength(3)
    expect(updated.projection.eventIds).toEqual(["evt-000001", "evt-000004", "evt-000005"])
    expect(projectProviderMessages(updated)).toEqual(currentMessages)
  })

  it("projects canonical tool and user fallback content back to provider messages", async () => {
    const { projectProviderMessages } = await import("../../heart/session-events")

    const projected = projectProviderMessages({
      version: 2,
      events: [
        {
          id: "evt-tool",
          sequence: 1,
          role: "tool",
          content: [{ type: "text", text: "tool part" }],
          name: null,
          toolCallId: "tc-1",
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: null,
            authoredAtSource: "unknown",
            observedAt: null,
            observedAtSource: "unknown",
            recordedAt: "2026-04-09T17:50:00.000Z",
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
          id: "evt-user",
          sequence: 2,
          role: "user",
          content: null,
          name: "Ari",
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: null,
            authoredAtSource: "unknown",
            observedAt: "2026-04-09T17:51:00.000Z",
            observedAtSource: "ingest",
            recordedAt: "2026-04-09T17:51:00.000Z",
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
        eventIds: ["evt-tool", "evt-user"],
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: null,
        projectedAt: null,
      },
      lastUsage: null,
      state: {
        mustResolveBeforeHandoff: false,
        lastFriendActivityAt: null,
      },
    })

    expect(projected).toEqual([
      {
        role: "tool",
        content: "tool part",
        tool_call_id: "tc-1",
      },
      {
        role: "user",
        content: "",
        name: "Ari",
      },
    ])
  })

  it("projects every event when a canonical envelope has an empty projection id list", async () => {
    const { projectProviderMessages } = await import("../../heart/session-events")

    const projected = projectProviderMessages({
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
        eventIds: [],
        trimmed: false,
        maxTokens: null,
        contextMargin: null,
        inputTokens: null,
        projectedAt: "2026-04-09T17:21:00.000Z",
      },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    })

    expect(projected).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ])
  })

  it("annotates user and assistant messages with relative time offsets", async () => {
    const { annotateMessageTimestamps } = await import("../../heart/session-events")
    const nowMs = Date.parse("2026-04-09T18:00:00.000Z")
    const mkEvt = (id: string, seq: number, role: "system" | "user" | "assistant", content: string | null, observedAt: string, authoredAt: string | null = null) => ({
      id, sequence: seq, role, content, name: null, toolCallId: null, toolCalls: [] as any[], attachments: [] as string[],
      time: { authoredAt, authoredAtSource: (authoredAt ? "local" : "unknown") as any, observedAt, observedAtSource: "ingest" as const, recordedAt: observedAt, recordedAtSource: "save" as const },
      relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null },
      provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null },
    })
    const mkEnv = (events: any[]) => ({
      version: 2 as const, events,
      projection: { eventIds: [] as string[], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
      lastUsage: null, state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    })
    // Minutes + just-now
    expect(annotateMessageTimestamps(mkEnv([
      mkEvt("s", 1, "system", "sys", "2026-04-09T17:00:00.000Z", "2026-04-09T17:00:00.000Z"),
      mkEvt("u1", 2, "user", "five min", "2026-04-09T17:55:00.000Z"),
      mkEvt("a1", 3, "assistant", "reply", "2026-04-09T17:55:30.000Z", "2026-04-09T17:55:30.000Z"),
      mkEvt("u2", 4, "user", "recent", "2026-04-09T17:59:50.000Z"),
    ]), [
      { role: "system" as const, content: "sys" },
      { role: "user" as const, content: "five min" },
      { role: "assistant" as const, content: "reply" },
      { role: "user" as const, content: "recent" },
    ], nowMs)).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "[-5m] five min" },
      { role: "assistant", content: "[-4m] reply" },
      { role: "user", content: "[just now] recent" },
    ])
    // Hours
    expect(annotateMessageTimestamps(
      mkEnv([mkEvt("u", 1, "user", "old", "2026-04-09T15:00:00.000Z")]),
      [{ role: "user" as const, content: "old" }], nowMs,
    )).toEqual([{ role: "user", content: "[-3h] old" }])
    // Days
    expect(annotateMessageTimestamps(
      mkEnv([mkEvt("u", 1, "user", "ancient", "2026-04-07T18:00:00.000Z")]),
      [{ role: "user" as const, content: "ancient" }], nowMs,
    )).toEqual([{ role: "user", content: "[-2d] ancient" }])
    // Future => no annotation
    expect(annotateMessageTimestamps(
      mkEnv([mkEvt("u", 1, "user", "future", "2026-04-09T19:00:00.000Z")]),
      [{ role: "user" as const, content: "future" }], nowMs,
    )).toEqual([{ role: "user", content: "future" }])
    // Empty content => no annotation
    expect(annotateMessageTimestamps(
      mkEnv([mkEvt("u", 1, "user", null, "2026-04-09T17:50:00.000Z")]),
      [{ role: "user" as const, content: "" }], nowMs,
    )).toEqual([{ role: "user", content: "" }])
    // More messages than events => extras pass through
    const annotated = annotateMessageTimestamps(
      mkEnv([mkEvt("u", 1, "user", "msg", "2026-04-09T17:50:00.000Z")]),
      [{ role: "user" as const, content: "msg" }, { role: "user" as const, content: "extra" }], nowMs,
    )
    expect(annotated[0]).toEqual({ role: "user", content: "[-10m] msg" })
    expect(annotated[1]).toEqual({ role: "user", content: "extra" })
  })

    it("reuses existing event ids when rebuilding from an envelope with an empty projection", async () => {
    const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

    const existing = {
      version: 2 as const,
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
          content: "old question",
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
        eventIds: [],
        trimmed: false,
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: null,
        projectedAt: "2026-04-09T17:21:00.000Z",
      },
      lastUsage: null,
      state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
    }

    const { envelope: updated } = buildCanonicalSessionEnvelope({
      existing,
      previousMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "old question" },
      ],
      currentMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "new answer" },
      ],
      trimmedMessages: [
        { role: "system", content: "sys" },
        { role: "user", content: "old question" },
        { role: "assistant", content: "new answer" },
      ],
      recordedAt: "2026-04-09T17:30:00.000Z",
      lastUsage: null,
      state: undefined,
      projectionBasis: {
        maxTokens: 80000,
        contextMargin: 20,
        inputTokens: null,
      },
    })

    expect(updated.projection.eventIds).toEqual(["evt-000001", "evt-000002", "evt-000003"])
  })

  describe("ingress timestamps", () => {
    it("stampIngressTime sets and getIngressTime reads back an ISO timestamp", async () => {
      const { stampIngressTime, getIngressTime } = await import("../../heart/session-events")
      const msg = { role: "user" as const, content: "hello" }
      stampIngressTime(msg)
      const result = getIngressTime(msg)
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })

    it("getIngressTime returns null for unstamped message", async () => {
      const { getIngressTime } = await import("../../heart/session-events")
      const msg = { role: "user" as const, content: "hello" }
      expect(getIngressTime(msg)).toBeNull()
    })

    it("user message with _ingressAt uses it as observedAt in buildCanonicalSessionEnvelope", async () => {
      const { buildCanonicalSessionEnvelope, getIngressTime, stampIngressTime } = await import("../../heart/session-events")
      const ingressTime = "2026-04-01T10:00:00.000Z"
      const batchTime = "2026-04-01T10:05:00.000Z"
      const userMsg: OpenAI.ChatCompletionMessageParam = { role: "user", content: "test" }
      ;(userMsg as Record<string, unknown>)._ingressAt = ingressTime

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [userMsg],
        trimmedMessages: [userMsg],
        recordedAt: batchTime,
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const userEvent = envelope.events.find((e) => e.role === "user")!
      expect(userEvent.time.observedAt).toBe(ingressTime)
      expect(userEvent.time.recordedAt).toBe(batchTime)
      expect(userEvent.time.observedAtSource).toBe("ingest")
    })

    it("user message without _ingressAt falls back to recordedAt for observedAt", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")
      const batchTime = "2026-04-01T10:05:00.000Z"
      const userMsg: OpenAI.ChatCompletionMessageParam = { role: "user", content: "test" }

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [userMsg],
        trimmedMessages: [userMsg],
        recordedAt: batchTime,
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const userEvent = envelope.events.find((e) => e.role === "user")!
      expect(userEvent.time.observedAt).toBe(batchTime)
    })

    it("assistant message ignores _ingressAt", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")
      const ingressTime = "2026-04-01T10:00:00.000Z"
      const batchTime = "2026-04-01T10:05:00.000Z"
      const assistantMsg: OpenAI.ChatCompletionMessageParam = { role: "assistant", content: "reply" }
      ;(assistantMsg as Record<string, unknown>)._ingressAt = ingressTime

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [{ role: "user", content: "hi" }, assistantMsg],
        trimmedMessages: [{ role: "user", content: "hi" }, assistantMsg],
        recordedAt: batchTime,
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const assistantEvent = envelope.events.find((e) => e.role === "assistant")!
      expect(assistantEvent.time.observedAt).toBe(batchTime)
      expect(assistantEvent.time.authoredAt).toBe(batchTime)
    })

    it("two user messages with different ingress times in one batch produce distinct observedAt", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")
      const batchTime = "2026-04-01T10:05:00.000Z"
      const msg1: OpenAI.ChatCompletionMessageParam = { role: "user", content: "first" }
      const msg2: OpenAI.ChatCompletionMessageParam = { role: "user", content: "second" }
      ;(msg1 as Record<string, unknown>)._ingressAt = "2026-04-01T10:00:00.000Z"
      ;(msg2 as Record<string, unknown>)._ingressAt = "2026-04-01T10:02:00.000Z"

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [msg1, { role: "assistant", content: "ack" }, msg2],
        trimmedMessages: [msg1, { role: "assistant", content: "ack" }, msg2],
        recordedAt: batchTime,
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const userEvents = envelope.events.filter((e) => e.role === "user")
      expect(userEvents).toHaveLength(2)
      expect(userEvents[0]!.time.observedAt).toBe("2026-04-01T10:00:00.000Z")
      expect(userEvents[1]!.time.observedAt).toBe("2026-04-01T10:02:00.000Z")
      expect(userEvents[0]!.time.recordedAt).toBe(batchTime)
      expect(userEvents[1]!.time.recordedAt).toBe(batchTime)
    })

    it("annotateMessageTimestamps uses per-message observedAt for user events", async () => {
      const { buildCanonicalSessionEnvelope, annotateMessageTimestamps, projectProviderMessages } = await import("../../heart/session-events")
      const msg1: OpenAI.ChatCompletionMessageParam = { role: "user", content: "first" }
      ;(msg1 as Record<string, unknown>)._ingressAt = "2026-04-01T10:00:00.000Z"
      const batchTime = "2026-04-01T10:05:00.000Z"

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [msg1, { role: "assistant", content: "reply" }],
        trimmedMessages: [msg1, { role: "assistant", content: "reply" }],
        recordedAt: batchTime,
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const projected = projectProviderMessages(envelope)
      // nowMs = 10 minutes after the ingress time
      const nowMs = Date.parse("2026-04-01T10:10:00.000Z")
      const annotated = annotateMessageTimestamps(envelope, projected, nowMs)
      // User message should show 10m (from ingress time), not 5m (from batch time)
      expect((annotated[0] as any).content).toMatch(/\[-10m\]/)
    })
  })

  describe("findCommonPrefixLength skips system messages", () => {
    it("BUG PROOF: changing system prompt causes all messages to be re-created as new events", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      // Turn 1: build initial envelope
      const previousMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system prompt v1 with weather=sunny" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: previousMessages,
        trimmedMessages: previousMessages,
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(existing.events).toHaveLength(3)

      // Turn 2: system prompt changes (weather update), same user/assistant messages, plus new turn
      const currentMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system prompt v2 with weather=rainy" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
        { role: "user", content: "what's new?" },
        { role: "assistant", content: "not much" },
      ]

      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing,
        previousMessages,
        currentMessages,
        trimmedMessages: currentMessages,
        recordedAt: "2026-04-13T10:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // With the bug: prefix match returns 0 because system content differs,
      // so ALL 5 messages are created as new events (3 existing + 5 new = 8 total)
      // With the fix: prefix match skips system messages, matches user+assistant,
      // creates new events only for: 1 changed system + 2 genuinely new messages = 3 new
      // Pruned envelope: 6 total events created, 5 projected (old sys_v1 event evicted)
      expect(updated.events).toHaveLength(5)
    })

    it("matches non-system messages correctly when system prompt changes between turns", async () => {
      const { buildCanonicalSessionEnvelope, projectProviderMessages } = await import("../../heart/session-events")

      // Turn 1
      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system v1" },
        { role: "user", content: "question A" },
        { role: "assistant", content: "answer A" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Turn 2: different system prompt, same conversation + new messages
      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system v2 different" },
        { role: "user", content: "question A" },
        { role: "assistant", content: "answer A" },
        { role: "user", content: "question B" },
        { role: "assistant", content: "answer B" },
      ]

      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages: turn2Messages,
        recordedAt: "2026-04-13T10:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Pruned envelope: 5 projected events (old sys_v1 event evicted)
      expect(updated.events).toHaveLength(5)
      // Reused events first (qA, aA), then new events (sys_v2, qB, aB)
      expect(updated.events[0]!.content).toBe("question A")
      expect(updated.events[1]!.content).toBe("answer A")
      expect(updated.events[2]!.role).toBe("system")
      expect(updated.events[3]!.content).toBe("question B")
      expect(updated.events[4]!.content).toBe("answer B")

      // Projection should include the new system event + reused non-system + new non-system
      const projected = projectProviderMessages(updated)
      expect(projected).toHaveLength(5)
    })

    it("handles no system messages in either array", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "more" },
      ]
      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages: turn2Messages,
        recordedAt: "2026-04-13T10:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(updated.events).toHaveLength(3) // 2 existing + 1 new
    })

    it("handles multiple system messages scattered in the array", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system 1 v1" },
        { role: "user", content: "hello" },
        { role: "system", content: "system 2 v1" },
        { role: "assistant", content: "hi" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Same non-system messages, different system prompts
      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "system 1 v2" },
        { role: "user", content: "hello" },
        { role: "system", content: "system 2 v2" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "new question" },
      ]
      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages: turn2Messages,
        recordedAt: "2026-04-13T10:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Pruned envelope: 5 projected events (old sys1_v1 and sys2_v1 evicted)
      expect(updated.events).toHaveLength(5)
    })

    it("handles all system messages with no other roles", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "only system v1" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "only system v2" },
      ]
      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages: turn2Messages,
        recordedAt: "2026-04-13T10:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // No non-system messages to match, system changed. Pruned: only new sys event projected.
      expect(updated.events).toHaveLength(1)
    })

    it("handles empty arrays", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const { envelope: updated } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: [],
        trimmedMessages: [],
        recordedAt: "2026-04-13T10:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(updated.events).toHaveLength(0)
    })
  })

  describe("buildCanonicalSessionEnvelope returns evicted events", () => {
    it("returns events not in projection as evicted", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      // Build initial envelope with 5 messages
      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "q2" },
        { role: "assistant", content: "a2" },
      ]
      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T11:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Turn 2: add new messages, but trimmed window excludes old messages
      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        ...turn1Messages,
        { role: "user", content: "q3" },
        { role: "assistant", content: "a3" },
      ]
      const trimmedMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q3" },
        { role: "assistant", content: "a3" },
      ]

      const result = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages,
        recordedAt: "2026-04-13T11:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Evicted events are those not in the projection
      expect(result.evictedEvents.length).toBeGreaterThan(0)
      // The pruned envelope should only contain projected events
      expect(result.envelope.events.length).toBeLessThan(7)
      // Evicted + remaining should account for all events
      const allEventIds = new Set([
        ...result.envelope.events.map((e: any) => e.id),
        ...result.evictedEvents.map((e: any) => e.id),
      ])
      expect(allEventIds.size).toBe(result.envelope.events.length + result.evictedEvents.length)
    })

    it("returns empty evictedEvents when all events are in projection", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ]

      const result = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: messages,
        trimmedMessages: messages,
        recordedAt: "2026-04-13T11:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(result.evictedEvents).toEqual([])
      expect(result.envelope.events).toHaveLength(3)
    })

    it("first-prune migration: large existing envelope with no prior pruning returns all non-projected as evicted", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      // Build a large existing envelope
      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
      ]
      for (let i = 0; i < 10; i++) {
        turn1Messages.push({ role: "user", content: `q${i}` })
        turn1Messages.push({ role: "assistant", content: `a${i}` })
      }

      const { envelope: existing } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T11:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Turn 2: same messages but trimmed to last 2 turns
      const trimmedMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q9" },
        { role: "assistant", content: "a9" },
      ]

      const result = buildCanonicalSessionEnvelope({
        existing,
        previousMessages: turn1Messages,
        currentMessages: turn1Messages,
        trimmedMessages,
        recordedAt: "2026-04-13T11:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Most events should be evicted (only sys + q9 + a9 in projection)
      expect(result.evictedEvents.length).toBe(18) // 20 non-system events minus 2 in projection
      expect(result.envelope.events).toHaveLength(3) // only projected events remain
    })

    it("handles no existing envelope", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "sys" },
        { role: "user", content: "q1" },
        { role: "assistant", content: "a1" },
      ]

      const result = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: messages,
        trimmedMessages: [{ role: "system", content: "sys" }],
        recordedAt: "2026-04-13T11:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Two events evicted (user and assistant not in trimmed)
      expect(result.evictedEvents).toHaveLength(2)
      expect(result.envelope.events).toHaveLength(1) // only system
    })
  })

  describe("appendEvictedToArchive", () => {
    it("writes evicted events as NDJSON lines to archive file", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { appendEvictedToArchive } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")

      const evictedEvents = [
        { id: "evt-000001", sequence: 1, role: "user" as const, content: "hello", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "unknown" as const, observedAt: "2026-04-13T10:00:00.000Z", observedAtSource: "ingest" as const, recordedAt: "2026-04-13T10:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } },
        { id: "evt-000002", sequence: 2, role: "assistant" as const, content: "hi", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: "2026-04-13T10:01:00.000Z", authoredAtSource: "local" as const, observedAt: "2026-04-13T10:01:00.000Z", observedAtSource: "local" as const, recordedAt: "2026-04-13T10:01:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } },
      ]

      appendEvictedToArchive(sessPath, evictedEvents)

      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")
      const content = fs.readFileSync(archivePath, "utf-8")
      const lines = content.trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).id).toBe("evt-000001")
      expect(JSON.parse(lines[1]!).id).toBe("evt-000002")

      // Cleanup
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })

    it("appends to existing archive file without overwriting", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { appendEvictedToArchive } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      const event1 = { id: "evt-000001", sequence: 1, role: "user" as const, content: "first", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "unknown" as const, observedAt: "2026-04-13T10:00:00.000Z", observedAtSource: "ingest" as const, recordedAt: "2026-04-13T10:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } }
      const event2 = { id: "evt-000002", sequence: 2, role: "user" as const, content: "second", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "unknown" as const, observedAt: "2026-04-13T10:01:00.000Z", observedAtSource: "ingest" as const, recordedAt: "2026-04-13T10:01:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } }

      appendEvictedToArchive(sessPath, [event1])
      appendEvictedToArchive(sessPath, [event2])

      const content = fs.readFileSync(archivePath, "utf-8")
      const lines = content.trim().split("\n")
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[0]!).id).toBe("evt-000001")
      expect(JSON.parse(lines[1]!).id).toBe("evt-000002")

      // Cleanup
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })

    it("does not write when evictedEvents is empty", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { appendEvictedToArchive } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      appendEvictedToArchive(sessPath, [])

      expect(fs.existsSync(archivePath)).toBe(false)

      // Cleanup
      fs.rmdirSync(tmpDir)
    })

    it("does not crash when archive write fails", async () => {
      const fs = await import("fs")
      const { appendEvictedToArchive } = await import("../../heart/session-events")

      // Use an invalid path that will cause appendFileSync to fail
      const badPath = "/nonexistent/deeply/nested/dialog.json"
      const event = { id: "evt-000001", sequence: 1, role: "user" as const, content: "test", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "unknown" as const, observedAt: "2026-04-13T10:00:00.000Z", observedAtSource: "ingest" as const, recordedAt: "2026-04-13T10:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } }

      // Should not throw
      expect(() => appendEvictedToArchive(badPath, [event])).not.toThrow()
    })

  })

  describe("loadFullEventHistory", () => {
    const mkEvent = (id: string, seq: number, role: "system" | "user" | "assistant", content: string) => ({
      id, sequence: seq, role, content, name: null, toolCallId: null, toolCalls: [] as any[], attachments: [] as string[],
      time: { authoredAt: null, authoredAtSource: "unknown" as const, observedAt: "2026-04-13T10:00:00.000Z", observedAtSource: "ingest" as const, recordedAt: "2026-04-13T10:00:00.000Z", recordedAtSource: "save" as const },
      relations: { replyToEventId: null, threadRootEventId: null, references: [] as string[], toolCallId: null, supersedesEventId: null, redactsEventId: null },
      provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null },
    })

    it("returns only envelope events when no archive file exists", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { loadFullEventHistory } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const envelope = {
        version: 2 as const,
        events: [mkEvent("evt-000003", 3, "user", "current")],
        projection: { eventIds: ["evt-000003"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }
      fs.writeFileSync(sessPath, JSON.stringify(envelope))

      const events = loadFullEventHistory(sessPath)
      expect(events).toHaveLength(1)
      expect(events[0]!.id).toBe("evt-000003")

      // Cleanup
      fs.unlinkSync(sessPath)
      fs.rmdirSync(tmpDir)
    })

    it("merges envelope events with archive events sorted by sequence", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { loadFullEventHistory } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      // Envelope with current events
      const envelope = {
        version: 2 as const,
        events: [mkEvent("evt-000003", 3, "user", "current")],
        projection: { eventIds: ["evt-000003"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }
      fs.writeFileSync(sessPath, JSON.stringify(envelope))

      // Archive with older events
      const archiveEvents = [
        mkEvent("evt-000001", 1, "user", "first"),
        mkEvent("evt-000002", 2, "assistant", "second"),
      ]
      fs.writeFileSync(archivePath, archiveEvents.map((e) => JSON.stringify(e)).join("\n") + "\n")

      const events = loadFullEventHistory(sessPath)
      expect(events).toHaveLength(3)
      expect(events[0]!.id).toBe("evt-000001")
      expect(events[1]!.id).toBe("evt-000002")
      expect(events[2]!.id).toBe("evt-000003")

      // Cleanup
      fs.unlinkSync(sessPath)
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })

    it("deduplicates events by id", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { loadFullEventHistory } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      const sharedEvent = mkEvent("evt-000001", 1, "user", "shared")
      const envelope = {
        version: 2 as const,
        events: [sharedEvent],
        projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }
      fs.writeFileSync(sessPath, JSON.stringify(envelope))
      fs.writeFileSync(archivePath, JSON.stringify(sharedEvent) + "\n")

      const events = loadFullEventHistory(sessPath)
      expect(events).toHaveLength(1) // deduplicated

      // Cleanup
      fs.unlinkSync(sessPath)
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })

    it("keeps the live envelope event when an archived event id collides", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { loadFullEventHistory, extractEventText } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      const envelopeEvent = mkEvent("evt-000001", 1, "user", "current envelope copy")
      const archivedEvent = mkEvent("evt-000001", 1, "user", "stale archived copy")
      const envelope = {
        version: 2 as const,
        events: [envelopeEvent],
        projection: { eventIds: ["evt-000001"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }
      fs.writeFileSync(sessPath, JSON.stringify(envelope))
      fs.writeFileSync(archivePath, JSON.stringify(archivedEvent) + "\n")

      const events = loadFullEventHistory(sessPath)
      expect(events).toHaveLength(1)
      expect(extractEventText(events[0]!)).toBe("current envelope copy")

      fs.unlinkSync(sessPath)
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })

    it("skips corrupted NDJSON lines gracefully", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const { loadFullEventHistory } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-test-"))
      const sessPath = path.join(tmpDir, "dialog.json")
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")

      const envelope = {
        version: 2 as const,
        events: [mkEvent("evt-000002", 2, "user", "current")],
        projection: { eventIds: ["evt-000002"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: null },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }
      fs.writeFileSync(sessPath, JSON.stringify(envelope))

      // Archive with one valid line, one corrupted, and blank lines
      const validEvent = mkEvent("evt-000001", 1, "user", "archived")
      fs.writeFileSync(archivePath, [
        JSON.stringify(validEvent),
        "this is not valid json{{{",
        "",
        "",
      ].join("\n"))

      const events = loadFullEventHistory(sessPath)
      expect(events).toHaveLength(2) // valid archived + envelope event
      expect(events[0]!.id).toBe("evt-000001")
      expect(events[1]!.id).toBe("evt-000002")

      // Cleanup
      fs.unlinkSync(sessPath)
      fs.unlinkSync(archivePath)
      fs.rmdirSync(tmpDir)
    })
  })

  describe("integration: full session lifecycle with pruning and archive", () => {
    it("builds envelope, changes system prompt, prunes, archives, and reconstructs full history", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const {
        buildCanonicalSessionEnvelope,
        appendEvictedToArchive,
        loadFullEventHistory,
        projectProviderMessages,
      } = await import("../../heart/session-events")

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sess-integ-"))
      const sessPath = path.join(tmpDir, "dialog.json")

      // Phase 1: Build initial envelope with system + 10 user/assistant turns
      const turn1Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "You are a helpful assistant. Weather: sunny. Time: morning." },
      ]
      for (let i = 0; i < 10; i++) {
        turn1Messages.push({ role: "user", content: `question ${i}` })
        turn1Messages.push({ role: "assistant", content: `answer ${i}` })
      }

      const result1 = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: turn1Messages,
        trimmedMessages: turn1Messages,
        recordedAt: "2026-04-13T12:00:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(result1.envelope.events).toHaveLength(21) // 1 sys + 20 user/assistant
      expect(result1.evictedEvents).toHaveLength(0)
      fs.writeFileSync(sessPath, JSON.stringify(result1.envelope))

      // Phase 2: System prompt changes, add 2 new messages, trim to keep only last 2 turns
      const turn2Messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "You are a helpful assistant. Weather: rainy. Time: afternoon." },
        ...turn1Messages.slice(1), // all non-system from turn 1
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ]
      const trimmedMessages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: "You are a helpful assistant. Weather: rainy. Time: afternoon." },
        { role: "user", content: "new question" },
        { role: "assistant", content: "new answer" },
      ]

      const result2 = buildCanonicalSessionEnvelope({
        existing: result1.envelope,
        previousMessages: turn1Messages,
        currentMessages: turn2Messages,
        trimmedMessages,
        recordedAt: "2026-04-13T12:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      // Key assertions: only 2 new events created (not 22 as the bug would cause)
      // Total events created = 21 original + 1 new system + 2 new messages = 24
      // But only 3 in projection (sys_v2, new_q, new_a)
      expect(result2.envelope.events.length).toBeLessThanOrEqual(3) // only projected events
      expect(result2.evictedEvents.length).toBeGreaterThan(0) // old events evicted

      // Phase 3: Archive evicted events
      appendEvictedToArchive(sessPath, result2.evictedEvents)
      fs.writeFileSync(sessPath, JSON.stringify(result2.envelope))

      // Phase 4: Reconstruct full history
      const fullHistory = loadFullEventHistory(sessPath)

      // Full history should have all unique events from both archive and envelope
      expect(fullHistory.length).toBeGreaterThan(3) // more than just the projected events
      // Events should be sorted by sequence
      for (let i = 1; i < fullHistory.length; i++) {
        expect(fullHistory[i]!.sequence).toBeGreaterThanOrEqual(fullHistory[i - 1]!.sequence)
      }

      // Phase 5: Verify projection works correctly
      const projected = projectProviderMessages(result2.envelope)
      expect(projected).toHaveLength(3) // sys + new_q + new_a
      expect((projected[0] as any).content).toContain("rainy") // new system content
      expect((projected[1] as any).content).toBe("new question")
      expect((projected[2] as any).content).toBe("new answer")

      // Cleanup
      const archivePath = sessPath.replace(/\.json$/, ".archive.ndjson")
      try { fs.unlinkSync(sessPath) } catch { /* */ }
      try { fs.unlinkSync(archivePath) } catch { /* */ }
      try { fs.rmdirSync(tmpDir) } catch { /* */ }
    })
  })

  describe("duplicate-event-id self-healing", () => {
    // Real corruption found in slugger.ouro/state/sessions: concurrent writers
    // each loaded the envelope, both computed the same `events.length + 1`
    // sequence, and wrote events with colliding ids. parseSessionEnvelope
    // must collapse those to a single per-id entry, last-occurrence-wins, so
    // the next save heals the file and downstream replay does not see the
    // same outbound message twice.
    it("collapses duplicate event ids on parse, keeping the last occurrence", async () => {
      const { parseSessionEnvelope } = await import("../../heart/session-events")
      const stamp = "2026-04-25T07:00:00.000Z"
      const baseEvent = (id: string, content: string, role: string = "assistant") => ({
        id,
        sequence: parseInt(id.replace("evt-", ""), 10),
        role,
        content,
        name: null,
        toolCallId: null,
        toolCalls: [],
        attachments: [],
        time: { authoredAt: null, authoredAtSource: "local", observedAt: null, observedAtSource: "local", recordedAt: stamp, recordedAtSource: "save" },
        relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null },
        provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
      })
      const parsed = parseSessionEnvelope({
        version: 2,
        events: [
          baseEvent("evt-000130", "first version of evt-130"),
          baseEvent("evt-000131", "evt-131 only copy"),
          baseEvent("evt-000130", "second version of evt-130"),
          baseEvent("evt-000132", "evt-132 only copy"),
          baseEvent("evt-000130", "third version of evt-130"),
        ],
        projection: { eventIds: [], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: stamp },
      })

      expect(parsed).not.toBeNull()
      const ids = parsed!.events.map((e) => e.id)
      expect(ids).toEqual(["evt-000131", "evt-000132", "evt-000130"])
      const evt130 = parsed!.events.find((e) => e.id === "evt-000130")
      // last-occurrence-wins: the third version is the survivor
      expect((evt130!.content as { type: string; text: string }[])?.[0]?.text ?? evt130!.content).toContain("third version")
    })

    it("buildCanonicalSessionEnvelope assigns the next sequence as max(existing)+1, not events.length+1", async () => {
      const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")

      // Existing envelope after self-heal: 3 events with sequences 1, 2, 130.
      // The naive `events.length + 1` would produce sequence 4 (collision once
      // we hit existing sequence 4 in the future). The robust max(...)+1 must
      // produce 131 instead.
      const existing = {
        version: 2 as const,
        events: [
          { id: "evt-000001", sequence: 1, role: "user" as const, content: "u1", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "local" as const, observedAt: null, observedAtSource: "local" as const, recordedAt: "2026-04-25T00:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } },
          { id: "evt-000002", sequence: 2, role: "assistant" as const, content: "a1", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "local" as const, observedAt: null, observedAtSource: "local" as const, recordedAt: "2026-04-25T00:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } },
          { id: "evt-000130", sequence: 130, role: "assistant" as const, content: "a-late", name: null, toolCallId: null, toolCalls: [], attachments: [], time: { authoredAt: null, authoredAtSource: "local" as const, observedAt: null, observedAtSource: "local" as const, recordedAt: "2026-04-25T00:00:00.000Z", recordedAtSource: "save" as const }, relations: { replyToEventId: null, threadRootEventId: null, references: [], toolCallId: null, supersedesEventId: null, redactsEventId: null }, provenance: { captureKind: "live" as const, legacyVersion: null, sourceMessageIndex: null } },
        ],
        projection: { eventIds: ["evt-000001", "evt-000002", "evt-000130"], trimmed: false, maxTokens: null, contextMargin: null, inputTokens: null, projectedAt: "2026-04-25T00:00:00.000Z" },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }

      const previousMessages = [
        { role: "user" as const, content: "u1" },
        { role: "assistant" as const, content: "a1" },
        { role: "assistant" as const, content: "a-late" },
      ] as OpenAI.ChatCompletionMessageParam[]

      const currentMessages: OpenAI.ChatCompletionMessageParam[] = [
        ...previousMessages,
        { role: "user", content: "u-fresh" },
      ]

      const result = buildCanonicalSessionEnvelope({
        existing,
        previousMessages,
        currentMessages,
        trimmedMessages: currentMessages,
        recordedAt: "2026-04-25T00:01:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      const newEvent = result.envelope.events.find((e) => (e.content as { type: string; text: string }[])?.[0]?.text === "u-fresh" || e.content === "u-fresh")
      expect(newEvent).toBeDefined()
      expect(newEvent!.sequence).toBe(131)
      expect(newEvent!.id).toBe("evt-000131")
    })
  })

  describe("inline-reasoning replay repair (MiniMax 2013 fix)", () => {
    // The bug Slugger surfaced: MiniMax-M2.7 emits assistant messages with
    // inline <think>...</think> content AND tool_calls. Replaying that
    // combination triggers MiniMax error 2013 ("tool result's tool id not
    // found") and stalls the session — every subsequent turn fails.
    //
    // The fix has two halves:
    // (a) Strip the <think> blocks from the assistant content so replays
    //     are valid.
    // (b) The synthetic tool-result message is an EXPLANATORY one (not the
    //     generic "interrupted") so the agent has full awareness of what
    //     happened and what to do — strip-and-stay-silent would be bad AX.
    it("strips inline <think> blocks from assistant messages with tool_calls and surfaces an explanatory tool-result", async () => {
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "what's up?" },
        {
          role: "assistant",
          content: "<think>doing some reasoning that the provider can't replay</think>",
          tool_calls: [{ id: "call_xyz", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"ok\"}" } }],
        },
        // Note: NO matching tool result for call_xyz — repairToolCallSequences will synthesize one.
        { role: "user", content: "next message" },
      ])

      const assistant = sanitized.find((m) => m.role === "assistant") as any
      expect(assistant).toBeDefined()
      // <think> stripped from persisted content (or content set to null if the
      // strip leaves nothing).
      const content = assistant.content
      const contentText = typeof content === "string" ? content : ""
      expect(contentText).not.toContain("<think>")
      expect(contentText).not.toContain("</think>")
      // The tool_call survives (so the API replay reconstructs correctly).
      expect(assistant.tool_calls).toHaveLength(1)
      expect(assistant.tool_calls[0].id).toBe("call_xyz")

      // The synthesized tool-result is the EXPLANATORY one (not the generic
      // "result was lost" — that one is for tool calls whose parent didn't
      // have stripped reasoning).
      const synthetic = sanitized.find((m) => m.role === "tool" && (m as any).tool_call_id === "call_xyz") as any
      expect(synthetic).toBeDefined()
      expect(synthetic.content).toContain("inline `<think>")
      expect(synthetic.content).toContain("MiniMax")
      expect(synthetic.content).toContain("retry the tool call")
    })

    it("keeps the generic 'result was lost' message for orphaned tool_calls whose parent did NOT have stripped reasoning", async () => {
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "no inline reasoning here, just plain content",
          tool_calls: [{ id: "call_plain", type: "function" as const, function: { name: "read_file", arguments: "{}" } }],
        },
        // Orphan: no matching tool result.
        { role: "user", content: "next" },
      ])
      const synthetic = sanitized.find((m) => m.role === "tool" && (m as any).tool_call_id === "call_plain") as any
      expect(synthetic).toBeDefined()
      expect(synthetic.content).toContain("result was lost")
      expect(synthetic.content).not.toContain("inline `<think>")
    })

    it("handles an unclosed <think> tag (open without close) by dropping everything from <think> onward", async () => {
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "early text<think>started thinking but stream was cut",
          tool_calls: [{ id: "call_truncated", type: "function" as const, function: { name: "settle", arguments: "{}" } }],
        },
        { role: "user", content: "next" },
      ])
      const assistant = sanitized.find((m) => m.role === "assistant") as any
      const content = typeof assistant.content === "string" ? assistant.content : ""
      // Everything from <think> to end of string is dropped; the early text survives.
      expect(content).toBe("early text")
      expect(content).not.toContain("<think>")
    })

    it("removes a tool result that appears BEFORE its matching assistant tool_call (position-aware orphan check)", async () => {
      // Real bug observed in slugger.ouro/state/sessions/.../mcp/c11a7ba8-...:
      // After session pruning, a synthetic tool result lived at seq 86
      // referencing call_function_utqogadgqp5h_1, but the assistant message
      // that defines that tool_call_id was at seq 88 — AFTER the tool result.
      // The previous orphan check used a global Set so this looked valid,
      // but MiniMax rejected with error 2013 because tool results must
      // follow their matching assistant.
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "early" },
        // Tool result referencing a tool_call_id that doesn't exist YET
        // in the conversation
        { role: "tool", content: "stale or misplaced result", tool_call_id: "call_xyz_1" } as any,
        { role: "user", content: "middle" },
        // The assistant that defines call_xyz_1 — appears AFTER the tool result above
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_xyz_1", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"ok\",\"intent\":\"complete\"}" } }],
        },
        // Valid following tool result for the assistant
        { role: "tool", content: "(delivered)", tool_call_id: "call_xyz_1" } as any,
      ])

      // The misplaced tool result before the assistant is removed
      const toolMsgs = sanitized.filter((m) => m.role === "tool") as any[]
      expect(toolMsgs.find((m) => m.content === "stale or misplaced result")).toBeUndefined()

      // The valid one (after the assistant) survives
      expect(toolMsgs.find((m) => m.content === "(delivered)")).toBeDefined()

      // The order is sane: assistant comes before its tool result
      const assistantIdx = sanitized.findIndex((m) => m.role === "assistant" && (m as any).tool_calls)
      const validToolIdx = sanitized.findIndex((m) => m.role === "tool" && (m as any).content === "(delivered)")
      expect(assistantIdx).toBeLessThan(validToolIdx)
    })

    it("end-to-end: a Slugger-shaped poisoned session produces a valid replay shape after sanitize", async () => {
      // Reproduces the exact pattern observed in
      // ~/AgentBundles/slugger.ouro/state/sessions/.../mcp/c11a7ba8-...json:
      // assistant with <think>...</think> + settle tool_call, no matching
      // tool_result, then a stack of new user messages. After sanitize, the
      // shape MiniMax sees should be: clean assistant (no think tags), the
      // tool_call survives, an explanatory tool-result is inserted, and the
      // user messages follow normally — no replay violation.
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "earlier user message" },
        {
          role: "assistant",
          content: "<think>thinking through the answer</think>",
          tool_calls: [{ id: "call_function_utqogadgqp5h_1", type: "function" as const, function: { name: "settle", arguments: "{\"answer\":\"the actual answer slugger wanted to deliver\",\"intent\":\"direct_reply\"}" } }],
        },
        // No tool_result for call_function_utqogadgqp5h_1 — the original
        // session was saved before the result was written
        { role: "user", content: "follow-up message 1" },
        { role: "user", content: "follow-up message 2" },
        { role: "user", content: "follow-up message 3 (now what?)" },
      ])

      // Find the assistant — it should NOT have <think> tags anymore
      const assistant = sanitized.find((m) => m.role === "assistant") as any
      expect(typeof assistant.content === "string" ? assistant.content : "").not.toContain("<think>")

      // The tool_call survives so the API can match the tool_result
      expect(assistant.tool_calls).toHaveLength(1)
      expect(assistant.tool_calls[0].id).toBe("call_function_utqogadgqp5h_1")

      // A synthetic tool-result was inserted with the explanatory message
      const toolResult = sanitized.find((m) => m.role === "tool" && (m as any).tool_call_id === "call_function_utqogadgqp5h_1") as any
      expect(toolResult).toBeDefined()
      expect(toolResult.content).toContain("MiniMax")
      expect(toolResult.content).toContain("retry the tool call")

      // The user messages follow normally
      const userMsgs = sanitized.filter((m) => m.role === "user").map((m) => m.content)
      expect(userMsgs).toContain("earlier user message")
      expect(userMsgs).toContain("follow-up message 1")
      expect(userMsgs).toContain("follow-up message 2")
      expect(userMsgs).toContain("follow-up message 3 (now what?)")

      // The order is correct: assistant before its synthetic tool-result,
      // and follow-up users come after the tool-result.
      const assistantIdx = sanitized.findIndex((m) => m.role === "assistant")
      const toolResultIdx = sanitized.findIndex((m) => m.role === "tool")
      const firstFollowUpIdx = sanitized.findIndex((m) => m.role === "user" && m.content === "follow-up message 1")
      expect(assistantIdx).toBeLessThan(toolResultIdx)
      expect(toolResultIdx).toBeLessThan(firstFollowUpIdx)
    })

    it("leaves an assistant message with <think> but no tool_calls untouched (think tags are fine on their own)", async () => {
      const { sanitizeProviderMessages } = await import("../../heart/session-events")
      const sanitized = sanitizeProviderMessages([
        { role: "user", content: "hi" },
        { role: "assistant", content: "<think>just thinking</think>final answer here" },
      ])
      const assistant = sanitized.find((m) => m.role === "assistant") as any
      // No tool_calls means no replay-rejection risk; we don't strip.
      expect(assistant.content).toContain("<think>")
    })
  })
})
