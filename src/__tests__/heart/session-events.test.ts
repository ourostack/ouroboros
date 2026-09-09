import { describe, expect, it, vi } from "vitest"
import type OpenAI from "openai"
import { a003Event, a003Marker, a003Pair, A003_AT } from "../fixtures/a003-session"
import type { SessionEvent } from "../../heart/session-events"

describe("A003 strict raw redaction authority", () => {
  async function api() {
    return await import("../../heart/session-events") as typeof import("../../heart/session-events") & {
      isExactRawSessionRedactionMarker(candidate: unknown, events: unknown[]): boolean
      selectEffectiveSessionEvents(events: SessionEvent[]): SessionEvent[]
    }
  }

  it("accepts only the exact raw migration pair and leaves both raw values intact", async () => {
    const { target, marker, envelope } = a003Pair()
    const before = structuredClone(envelope)
    const { isExactRawSessionRedactionMarker, selectEffectiveSessionEvents, parseSessionEnvelope } = await api()
    expect(isExactRawSessionRedactionMarker(marker, envelope.events)).toBe(true)
    expect(selectEffectiveSessionEvents(envelope.events).map((event) => event.id)).toEqual(["evt-000001", "evt-000002"])
    const parsed = parseSessionEnvelope(envelope)!
    expect(parsed.events).toEqual(before.events)
    expect(parsed.events).toContainEqual(target)
    expect(parsed.events).toContainEqual(marker)
    expect(envelope).toEqual(before)
  })

  it("refuses an otherwise exact marker that is absent from the raw document", async () => {
    const { marker, envelope } = a003Pair()
    const { isExactRawSessionRedactionMarker } = await api()
    expect(isExactRawSessionRedactionMarker(marker, envelope.events.slice(0, -1))).toBe(false)
  })

  const markerMutations: Array<[string, unknown]> = [
    ["id", ""], ["id", " "], ["id", 4], ["sequence", 0], ["sequence", -1], ["sequence", 2.5], ["sequence", "4"],
    ["role", "developer"], ["role", "user"], ["role", "assistant"], ["role", null],
    ["content", ""], ["content", "hidden payload"], ["content", []], ["name", ""], ["name", "migration"],
    ["toolCallId", ""], ["toolCalls", [{}]], ["toolCalls", null], ["attachments", ["secret"]], ["attachments", null],
    ["time.authoredAt", A003_AT], ["time.observedAt", A003_AT], ["time.recordedAt", ""],
    ["time.recordedAt", "not-a-time"], ["time.recordedAt", "2026-09-07"], ["time.recordedAt", 0],
    ["time.authoredAtSource", "local"], ["time.observedAtSource", "ingest"], ["time.recordedAtSource", "save"],
    ["time.authoredAtSource", null], ["time.observedAtSource", true], ["time.recordedAtSource", "MIGRATION"],
    ["relations.replyToEventId", "evt-000001"], ["relations.threadRootEventId", "evt-000001"],
    ["relations.references", ["evt-000001"]], ["relations.toolCallId", "call-x"],
    ["relations.supersedesEventId", "evt-000001"], ["relations.redactsEventId", "evt-000004"],
    ["relations.redactsEventId", "absent"], ["relations.redactsEventId", ""], ["relations.redactsEventId", 3],
    ["provenance.captureKind", "live"], ["provenance.captureKind", "synthetic"], ["provenance.captureKind", null],
    ["provenance.legacyVersion", null], ["provenance.legacyVersion", 1], ["provenance.legacyVersion", "2"],
    ["provenance.sourceMessageIndex", 3], ["provenance.sourceMessageIndex", "3"],
    ["extra", "unknown"], ["time.extra", true], ["relations.extra", true], ["provenance.extra", true],
  ]
  const originalMarker = a003Pair().marker
  for (const key of Object.keys(originalMarker)) markerMutations.push([key, undefined])
  for (const section of ["time", "relations", "provenance"] as const) {
    for (const key of Object.keys(originalMarker[section])) markerMutations.push([`${section}.${key}`, undefined])
  }

  function change(value: unknown, field: string, replacement: unknown): void {
    const keys = field.split(".")
    let owner = value as Record<string, unknown>
    for (const key of keys.slice(0, -1)) owner = owner[key] as Record<string, unknown>
    const key = keys.at(-1)!
    if (replacement === undefined) delete owner[key]
    else owner[key] = replacement
  }

  it.each(markerMutations)("refuses raw marker %s = %j without normalization granting authority", async (field, replacement) => {
    const { envelope, marker, target } = a003Pair()
    change(marker, field, replacement)
    const { isExactRawSessionRedactionMarker, parseSessionEnvelope, selectEffectiveSessionEvents } = await api()
    expect(isExactRawSessionRedactionMarker(marker, envelope.events)).toBe(false)
    const parsed = parseSessionEnvelope(envelope)!
    expect(selectEffectiveSessionEvents(parsed.events).some((event) => event.id === target.id)).toBe(true)
    expect(parsed.events.every((event) => event.relations.redactsEventId === null)).toBe(true)
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a003-marker-mutation-"))
    const file = path.join(root, "session.json")
    const bytes = JSON.stringify(envelope)
    fs.writeFileSync(file, bytes)
    try {
      const { loadSessionEnvelopeFile } = await api()
      const loaded = loadSessionEnvelopeFile(file)!
      expect(selectEffectiveSessionEvents(loaded.events).map((event) => event.id)).toEqual(["evt-000001", "evt-000002", target.id, typeof marker.id === "string" ? marker.id : "evt-000004"])
      expect(fs.readFileSync(file, "utf8")).toBe(bytes)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
  })

  const targetMutations: Array<[string, unknown]> = [
    ["content", "[just now] engine-only correction"], ["content", 99],
    ["role", "developer"], ["role", "assistant"], ["role", "tool"], ["role", null],
    ["id", ""], ["id", " "], ["sequence", 0], ["sequence", 4], ["sequence", "3"],
    ["toolCalls", [{ id: "call-x", function: { name: "final_answer", arguments: {} } }]],
    ["attachments", [1]], ["relations.references", [1]], ["relations.redactsEventId", "evt-000001"],
    ["time.recordedAt", "bad"], ["time.observedAt", false], ["time.observedAtSource", "invented"],
    ["provenance.captureKind", "invented"], ["provenance.sourceMessageIndex", "3"], ["extra", true],
    ["time.extra", true], ["relations.extra", true], ["provenance.extra", true],
  ]
  const originalTarget = a003Pair().target
  for (const key of Object.keys(originalTarget)) targetMutations.push([key, undefined])
  for (const section of ["time", "relations", "provenance"] as const) {
    for (const key of Object.keys(originalTarget[section])) targetMutations.push([`${section}.${key}`, undefined])
  }
  it.each(targetMutations)("refuses a non-lossless or invalid raw target %s = %j", async (field, replacement) => {
    const { target, marker, envelope } = a003Pair()
    change(target, field as string, replacement)
    const { isExactRawSessionRedactionMarker, selectEffectiveSessionEvents, parseSessionEnvelope } = await api()
    expect(isExactRawSessionRedactionMarker(marker, envelope.events)).toBe(false)
    const parsed = parseSessionEnvelope(envelope)!
    const targetId = typeof target.id === "string" ? target.id : "evt-000003"
    expect(parsed.events).toHaveLength(4)
    expect(selectEffectiveSessionEvents(parsed.events).map((event) => event.id)).toEqual(["evt-000001", "evt-000002", targetId, marker.id])
    expect(parsed.events.every((event) => event.relations.redactsEventId === null)).toBe(true)
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const nerves = await import("../../nerves/runtime")
    const warning = vi.spyOn(nerves, "emitNervesEvent")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a003-target-mutation-"))
    const file = path.join(root, "session.json")
    const bytes = JSON.stringify(envelope)
    fs.writeFileSync(file, bytes)
    try {
      const { loadSessionEnvelopeFile } = await api()
      const loaded = loadSessionEnvelopeFile(file)!
      expect(selectEffectiveSessionEvents(loaded.events).map((event) => event.id)).toEqual(["evt-000001", "evt-000002", targetId, marker.id])
      expect(fs.readFileSync(file, "utf8")).toBe(bytes)
      const warnings = warning.mock.calls.filter(([event]) => event.event === "session.redaction_marker_invalid")
      expect(warnings).toHaveLength(1)
      expect(JSON.stringify(warnings)).not.toContain("engine-only correction")
      expect(JSON.stringify(warnings).length).toBeLessThan(1024)
    } finally { warning.mockRestore(); fs.rmSync(root, { recursive: true, force: true }) }
  })

  it.each([null, false, 1, "marker", [], {}].map((candidate) => ({ candidate })))("refuses a scalar/null/array raw candidate $candidate", async ({ candidate }) => {
    const { envelope } = a003Pair()
    const { isExactRawSessionRedactionMarker } = await api()
    expect(isExactRawSessionRedactionMarker(candidate, envelope.events)).toBe(false)
    expect(isExactRawSessionRedactionMarker(envelope.events[3], [null, ...envelope.events])).toBe(false)
  })

  it.each(["later", "document-order", "duplicate-id", "duplicate-sequence", "conflicting-marker", "chained", "unrelated-duplicate", "missing"])(
    "refuses %s relations before deduplication or normalization",
    async (kind) => {
      const { target, marker, envelope } = a003Pair()
      if (kind === "later") { target.sequence = 5; envelope.events = [envelope.events[0]!, envelope.events[1]!, marker, target] }
      if (kind === "document-order") envelope.events = [envelope.events[0]!, envelope.events[1]!, marker, target]
      if (kind === "duplicate-id") envelope.events.push({ ...structuredClone(target), sequence: 5 })
      if (kind === "duplicate-sequence") envelope.events.push({ ...a003Event(5, "assistant", "duplicate"), sequence: target.sequence })
      if (kind === "conflicting-marker") envelope.events.push(a003Marker(target, 5))
      if (kind === "chained") target.relations.redactsEventId = envelope.events[0]!.id
      if (kind === "unrelated-duplicate") envelope.events.push({ ...a003Event(5, "user", "duplicate"), id: envelope.events[0]!.id })
      if (kind === "missing") envelope.events.splice(2, 1)
      const { isExactRawSessionRedactionMarker, parseSessionEnvelope, selectEffectiveSessionEvents } = await api()
      expect(isExactRawSessionRedactionMarker(marker, envelope.events)).toBe(false)
      const parsed = parseSessionEnvelope(envelope)!
      expect(parsed.events.every((event) => event.relations.redactsEventId === null)).toBe(true)
      expect(selectEffectiveSessionEvents(parsed.events)).toEqual(parsed.events)
      const ids = envelope.events.map((event) => event.id)
      expect(parsed.events.map((event) => ({ id: event.id, role: event.role, content: event.content }))).toEqual(envelope.events.filter((event, index) => ids.lastIndexOf(event.id) === index).map((event) => ({ id: event.id, role: event.role, content: event.content })))
    },
  )

  it.each([false, true])("loads a real raw file without writing its bytes (invalid=%s)", async (invalid) => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const nerves = await import("../../nerves/runtime")
    const warning = vi.spyOn(nerves, "emitNervesEvent")
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "a003-raw-load-"))
    const file = path.join(dir, "session.json")
    const { envelope, marker, target } = a003Pair()
    if (invalid) { marker.role = "user"; marker.content = "PRIVATE VALUE MUST NEVER BE LOGGED"; envelope.events.push(a003Marker(target, 5)) }
    const bytes = JSON.stringify(envelope, null, 2)
    fs.writeFileSync(file, bytes)
    try {
      const { loadSessionEnvelopeFile, selectEffectiveSessionEvents } = await api()
      const parsed = loadSessionEnvelopeFile(file)!
      expect(selectEffectiveSessionEvents(parsed.events).some((event) => event.id === target.id)).toBe(invalid)
      expect(fs.readFileSync(file, "utf8")).toBe(bytes)
      const warnings = warning.mock.calls.filter(([event]) => event.event === "session.redaction_marker_invalid")
      expect(warnings).toHaveLength(invalid ? 1 : 0)
      expect(JSON.stringify(warnings)).not.toContain("PRIVATE VALUE")
      expect(JSON.stringify(warnings).length).toBeLessThan(1024)
    } finally { warning.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }) }
  })

  it("aligns provider projection, timestamp view, chronology, and derived structured outputs", async () => {
    const { envelope, target, marker } = a003Pair()
    const answer = envelope.events[1]!
    answer.id = "evt-000003"; answer.sequence = 3
    target.id = "evt-000002"; target.sequence = 2
    marker.relations.redactsEventId = target.id
    envelope.events = [envelope.events[0]!, target, answer, marker]
    envelope.projection.eventIds = envelope.events.map((event) => event.id)
    answer.content = "Accepted choices:\n1. First\n2. Second"
    envelope.structuredOutputs = [{
      schemaVersion: 1, id: "forged", kind: "ordered_list", sourceEventId: target.id, recordedAt: A003_AT,
      heading: "forged correction", items: [{ label: "1", text: "secret one" }, { label: "2", text: "secret two" }],
    }]
    const m = await api()
    const parsed = m.parseSessionEnvelope(envelope)!
    expect(parsed.structuredOutputs?.map((output) => output.sourceEventId)).toEqual(["evt-000003"])
    expect(m.projectProviderMessages(parsed)).toEqual([
      { role: "user", content: "actual human" }, { role: "assistant", content: "Accepted choices:\n1. First\n2. Second" },
    ])
    expect(m.annotateMessageTimestamps(parsed, m.projectProviderMessages(parsed), Date.parse(A003_AT) + 120_000).map((message) => message.content)).toEqual([
      "[-2m] actual human", "[-2m] Accepted choices:\n1. First\n2. Second",
    ])
    expect(m.deriveSessionChronology(parsed.events)).toEqual({
      lastInboundAt: A003_AT, lastOutboundAt: A003_AT, lastActivityAt: A003_AT, unansweredInboundCount: 0,
    })
    expect(m.describeCurrentSessionTiming(parsed.events, Date.parse(A003_AT) + 120_000)).not.toContain("unanswered")
    expect(parsed.events).toContainEqual(target)
    expect(parsed.events).toContainEqual(marker)
    parsed.projection.eventIds = []
    expect(m.projectProviderMessages(parsed)).toHaveLength(2)
    expect(m.annotateMessageTimestamps(parsed, m.projectProviderMessages(parsed), Date.parse(A003_AT) + 120_000).map((message) => message.content)).toEqual(["[-2m] actual human", "[-2m] Accepted choices:\n1. First\n2. Second"])
    expect(m.appendSyntheticAssistantEvent(parsed, "1. Third\n2. Fourth", A003_AT).structuredOutputs?.map((output) => output.sourceEventId)).toEqual(["evt-000003", "evt-000005"])
  })

  it("retains exact pairs and realigns common-prefix IDs through trim, append, and two rebuilds", async () => {
    const { envelope, target, marker } = a003Pair()
    // Put the hidden user BEFORE the assistant inside the matched prefix.
    target.sequence = 2; target.id = "evt-000002"
    const answer = envelope.events[1]!
    answer.sequence = 3; answer.id = "evt-000003"
    marker.relations.redactsEventId = target.id
    envelope.events = [envelope.events[0]!, target, answer, marker]
    envelope.projection.eventIds = envelope.events.map((event) => event.id)
    const original = structuredClone([target, marker])
    const m = await api()
    const previous = m.projectProviderMessages(envelope)
    expect(previous.map((message) => message.content)).toEqual(["actual human", "accepted answer"])
    const current: OpenAI.ChatCompletionMessageParam[] = [...previous, { role: "user", content: "genuine next turn" }]
    const basis = { maxTokens: 12, contextMargin: 1, inputTokens: 100 }
    const first = m.buildCanonicalSessionEnvelope({ existing: envelope, previousMessages: previous, currentMessages: current, trimmedMessages: current, recordedAt: A003_AT, projectionBasis: basis })
    expect(first.envelope.projection.eventIds).toEqual(["evt-000001", "evt-000003", "evt-000005"])
    expect(first.envelope.events.find((event) => event.id === answer.id)?.content).toBe("accepted answer")
    const trimmed = m.buildCanonicalSessionEnvelope({ existing: first.envelope, previousMessages: current, currentMessages: current, trimmedMessages: current.slice(-1), recordedAt: A003_AT, projectionBasis: basis })
    expect(trimmed.envelope.events.filter((event) => [target.id, marker.id].includes(event.id))).toEqual(original)
    expect(trimmed.evictedEvents.some((event) => [target.id, marker.id].includes(event.id))).toBe(false)
    const loaded = m.parseSessionEnvelope(JSON.parse(JSON.stringify(trimmed.envelope)))!
    const projected = m.projectProviderMessages(loaded)
    const appended: OpenAI.ChatCompletionMessageParam[] = [...projected, { role: "assistant", content: "fresh answer" }]
    const rebuilt = m.buildCanonicalSessionEnvelope({ existing: loaded, previousMessages: projected, currentMessages: appended, trimmedMessages: appended, recordedAt: A003_AT, projectionBasis: basis }).envelope
    expect(rebuilt.events.filter((event) => [target.id, marker.id].includes(event.id))).toEqual(original)
    expect(m.projectProviderMessages(rebuilt)).toEqual(appended)
    expect(new Set(rebuilt.events.map((event) => event.id)).size).toBe(rebuilt.events.length)
    expect(rebuilt.projection.eventIds).toEqual(["evt-000005", "evt-000006"])
    expect(rebuilt.structuredOutputs).toEqual([])
  })

  it("A003 preserves raw audit anchors through real context save/load/trim/persist/append", async () => {
    const fs = await import("node:fs")
    const os = await import("node:os")
    const path = await import("node:path")
    const config = await import("../../heart/config")
    const budget = vi.spyOn(config, "getContextConfig").mockReturnValue({ maxTokens: 12, contextMargin: 20 })
    const persistence = await import("../../mind/context")
    const { envelope, target, marker } = a003Pair()
    const answer = envelope.events[1]!
    target.id = "evt-000002"; target.sequence = 2
    answer.id = "evt-000003"; answer.sequence = 3
    marker.relations.redactsEventId = target.id
    envelope.events = [envelope.events[0]!, target, answer, marker]
    envelope.projection.eventIds = envelope.events.map((event) => event.id)
    const anchors = structuredClone([target, marker])
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "a003-context-lifecycle-"))
    const file = path.join(root, "session.json")
    fs.writeFileSync(file, JSON.stringify(envelope, null, 2), { mode: 0o600 })
    try {
      const loaded = persistence.loadSession(file)!
      expect(loaded.messages.map((message) => message.content)).toEqual(["actual human", "accepted answer"])
      persistence.saveSession(file, [...loaded.messages, { role: "user", content: "real appended turn" }])
      const saved = persistence.loadSession(file)!
      expect(saved.projectionEventIds).toEqual(["evt-000001", "evt-000003", "evt-000005"])
      const messages: OpenAI.ChatCompletionMessageParam[] = [...saved.messages, { role: "assistant", content: "real appended answer" }]
      const usage = { input_tokens: 1000, output_tokens: 1, reasoning_tokens: 0, total_tokens: 1001 }
      persistence.postTurnPersist(file, persistence.postTurnTrim(messages, usage), usage)
      const trimmed = persistence.loadSession(file)!
      expect(trimmed.events.filter((event) => [target.id, marker.id].includes(event.id))).toEqual(anchors)
      persistence.saveSession(file, [...trimmed.messages, { role: "user", content: "fresh after trim" }])
      const rebuilt = persistence.loadSession(file)!
      expect(rebuilt.events.filter((event) => [target.id, marker.id].includes(event.id))).toEqual(anchors)
      expect(JSON.stringify(rebuilt.messages)).not.toContain("engine-only correction")
      expect(rebuilt.projectionEventIds).not.toContain(target.id)
      expect(rebuilt.projectionEventIds).not.toContain(marker.id)
      expect(new Set(rebuilt.events.map((event) => event.id)).size).toBe(rebuilt.events.length)
    } finally { budget.mockRestore(); fs.rmSync(root, { recursive: true, force: true }) }
  })
})

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

  it("persists assistant structured outputs in the canonical session envelope", async () => {
    const { buildCanonicalSessionEnvelope, parseSessionEnvelope } = await import("../../heart/session-events")
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "what are the gaps?" },
      {
        role: "assistant",
        content: "Gaps:\n1. Zurich to Basel\n2. Basel to Lugano\n3. Lugano to Milan\n4. La Villa to MXP",
      },
    ]

    const { envelope } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: messages,
      trimmedMessages: messages,
      recordedAt: "2026-05-19T16:20:00.000Z",
      lastUsage: null,
      state: null,
      projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
    })

    expect(envelope.structuredOutputs).toEqual([
      expect.objectContaining({
        id: "structured-evt-000002-1",
        sourceEventId: "evt-000002",
        heading: "Gaps:",
        items: [
          { label: "1", text: "Zurich to Basel" },
          { label: "2", text: "Basel to Lugano" },
          { label: "3", text: "Lugano to Milan" },
          { label: "4", text: "La Villa to MXP" },
        ],
      }),
    ])

    const parsed = parseSessionEnvelope(JSON.parse(JSON.stringify(envelope)))
    expect(parsed?.structuredOutputs).toEqual(envelope.structuredOutputs)
  })

  it("derives missing structured outputs during session reads without live extraction telemetry", async () => {
    const { registerGlobalLogSink } = await import("../../nerves")
    const { parseSessionEnvelope } = await import("../../heart/session-events")
    const extractedEvents: Array<{ event: string }> = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event === "heart.structured_output_extracted") {
        extractedEvents.push(entry)
      }
    })

    try {
      const parsedV2 = parseSessionEnvelope({
        version: 2,
        events: [{
          id: "evt-quiet-v2",
          sequence: 1,
          role: "assistant",
          content: "Backfilled choices:\n1. Keep old referents queryable\n2. Keep logs quiet",
          name: null,
          toolCallId: null,
          toolCalls: [],
          attachments: [],
          time: {
            authoredAt: null,
            authoredAtSource: "unknown",
            observedAt: null,
            observedAtSource: "unknown",
            recordedAt: "2026-05-19T17:00:00.000Z",
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
          eventIds: ["evt-quiet-v2"],
          trimmed: false,
          maxTokens: null,
          contextMargin: null,
          inputTokens: null,
          projectedAt: "2026-05-19T17:00:00.000Z",
        },
        lastUsage: null,
        state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
      }, {
        recordedAt: "2026-05-19T17:00:00.000Z",
        fileMtimeAt: "2026-05-19T17:00:00.000Z",
      })

      expect(parsedV2?.structuredOutputs).toEqual([
        expect.objectContaining({
          id: "structured-evt-quiet-v2-1",
          items: [
            { label: "1", text: "Keep old referents queryable" },
            { label: "2", text: "Keep logs quiet" },
          ],
        }),
      ])

      const migrated = parseSessionEnvelope({
        version: 1,
        messages: [
          {
            role: "assistant",
            content: "Legacy choices:\n1. Derive old referents\n2. Do not fake live activity",
          },
        ],
      }, {
        recordedAt: "2026-05-19T17:01:00.000Z",
        fileMtimeAt: "2026-05-19T17:01:00.000Z",
      })

      expect(migrated?.structuredOutputs).toEqual([
        expect.objectContaining({
          id: "structured-evt-000001-1",
          items: [
            { label: "1", text: "Derive old referents" },
            { label: "2", text: "Do not fake live activity" },
          ],
        }),
      ])
      expect(extractedEvents).toEqual([])
    } finally {
      unregister()
    }
  })

  it("keeps live structured-output extraction telemetry for canonical envelope builds", async () => {
    const { registerGlobalLogSink } = await import("../../nerves")
    const { buildCanonicalSessionEnvelope } = await import("../../heart/session-events")
    const extractedEvents: Array<{ event: string; meta: Record<string, unknown> }> = []
    const unregister = registerGlobalLogSink((entry) => {
      if (entry.event === "heart.structured_output_extracted") {
        extractedEvents.push(entry)
      }
    })

    try {
      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "user", content: "what changed?" },
        { role: "assistant", content: "Live choices:\n1. Emit the event\n2. Preserve diagnostic signal" },
      ]

      const { envelope } = buildCanonicalSessionEnvelope({
        existing: null,
        previousMessages: [],
        currentMessages: messages,
        trimmedMessages: messages,
        recordedAt: "2026-05-19T17:05:00.000Z",
        lastUsage: null,
        state: null,
        projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
      })

      expect(envelope.structuredOutputs).toHaveLength(1)
      expect(extractedEvents).toEqual([
        expect.objectContaining({
          event: "heart.structured_output_extracted",
          meta: {
            sourceEventId: "evt-000002",
            outputCount: 1,
            itemCount: 2,
          },
        }),
      ])
    } finally {
      unregister()
    }
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
        redactsEventId: null,
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

  it("carries transport reply binding into the canonical user event", async () => {
    const { buildCanonicalSessionEnvelope, getIngressRelations, stampIngressRelations } = await import("../../heart/session-events")
    const message: OpenAI.ChatCompletionMessageParam = { role: "user", content: "About that one…" }
    stampIngressRelations(message, { replyToEventId: "evt-000040", threadRootEventId: "evt-000001", references: ["telegram-artifact:abc", "request:req-1"] })
    expect(getIngressRelations(message)).toEqual({ replyToEventId: "evt-000040", threadRootEventId: "evt-000001", references: ["telegram-artifact:abc", "request:req-1"] })
    ;(message as any)._ingressRelations.references = "not-an-array"
    expect(getIngressRelations(message)?.references).toEqual([])
    ;(message as any)._ingressRelations.references = ["telegram-artifact:abc", "request:req-1"]
    const { envelope } = buildCanonicalSessionEnvelope({
      existing: null,
      previousMessages: [],
      currentMessages: [message],
      trimmedMessages: [message],
      recordedAt: "2026-08-29T18:00:00.000Z",
      lastUsage: null,
      state: null,
      projectionBasis: { maxTokens: null, contextMargin: null, inputTokens: null },
    })
    expect(envelope.events[0]?.relations).toMatchObject({ replyToEventId: "evt-000040", threadRootEventId: "evt-000001", references: ["telegram-artifact:abc", "request:req-1"] })
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

  describe("module surface", () => {
    it("does not export the removed full-history loader", async () => {
      const moduleExports = await import("../../heart/session-events") as Record<string, unknown>

      expect(moduleExports).not.toHaveProperty(`load${"Full"}EventHistory`)
      expect(moduleExports).not.toHaveProperty("appendEvictedToArchive")
    })
  })

  describe("integration: full session lifecycle with pruning", () => {
    it("builds envelope, changes system prompt, prunes, and replays the envelope projection only", async () => {
      const fs = await import("fs")
      const os = await import("os")
      const path = await import("path")
      const {
        buildCanonicalSessionEnvelope,
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

      // Phase 3: The session envelope remains a bounded projection only.
      fs.writeFileSync(sessPath, JSON.stringify(result2.envelope))
      expect(fs.existsSync(sessPath.replace(/\.json$/, ".archive.ndjson"))).toBe(false)

      // Phase 4: Replay now reads only the bounded envelope projection.
      const envelopeHistory = result2.envelope.events

      expect(envelopeHistory).toHaveLength(result2.envelope.events.length)
      expect(envelopeHistory.map((event) => event.id)).toEqual(result2.envelope.events.map((event) => event.id))
      // Events should be sorted by sequence
      for (let i = 1; i < envelopeHistory.length; i++) {
        expect(envelopeHistory[i]!.sequence).toBeGreaterThanOrEqual(envelopeHistory[i - 1]!.sequence)
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
