import { describe, expect, it } from "vitest"
import {
  extractVisibleTextFromAssistantToolCalls,
  extractStructuredOutputsFromEvents,
  extractStructuredOutputsFromText,
  normalizeStructuredOutputs,
} from "../../heart/structured-output"

describe("structured output registry", () => {
  it("extracts an assistant numbered list as ordered structured output", () => {
    const outputs = extractStructuredOutputsFromText(
      "I see four things:\n1. Zurich to Basel\n2) Basel to Lugano\n3. Lugano to Milan\n4. La Villa to MXP",
      {
        eventId: "evt-000010",
        recordedAt: "2026-05-19T16:12:41.000Z",
      },
    )

    expect(outputs).toEqual([
      {
        schemaVersion: 1,
        id: "structured-evt-000010-1",
        kind: "ordered_list",
        sourceEventId: "evt-000010",
        recordedAt: "2026-05-19T16:12:41.000Z",
        heading: "I see four things:",
        items: [
          { label: "1", text: "Zurich to Basel" },
          { label: "2", text: "Basel to Lugano" },
          { label: "3", text: "Lugano to Milan" },
          { label: "4", text: "La Villa to MXP" },
        ],
      },
    ])
  })

  it("ignores single numbered lines and non-assistant events to avoid noisy referents", () => {
    expect(extractStructuredOutputsFromText("1. A lonely line", {
      eventId: "evt-lonely",
      recordedAt: "2026-05-19T16:12:41.000Z",
    })).toEqual([])

    const outputs = extractStructuredOutputsFromEvents([
      {
        id: "evt-user",
        role: "user",
        content: "1. not my list\n2. still not my list",
        time: { recordedAt: "2026-05-19T16:12:41.000Z" },
      },
    ])

    expect(outputs).toEqual([])
  })

  it("extracts ordered lists from assistant event content arrays", () => {
    const outputs = extractStructuredOutputsFromEvents([
      {
        id: "evt-array",
        role: "assistant",
        content: [
          { type: "text", text: "Options:\n1. Small fix\n2. Stronger primitive" },
          { type: "image_url", image_url: { url: "attachment://ignore" } },
        ],
        time: { recordedAt: "2026-05-19T16:15:00.000Z" },
      },
    ])

    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      id: "structured-evt-array-1",
      sourceEventId: "evt-array",
      heading: "Options:",
      items: [
        { label: "1", text: "Small fix" },
        { label: "2", text: "Stronger primitive" },
      ],
    })
  })

  it("extracts user-visible lists from settle tool-call answers", () => {
    const outputs = extractStructuredOutputsFromEvents([
      {
        id: "evt-settle",
        role: "assistant",
        content: null,
        toolCalls: [
          {
            function: {
              name: "settle",
              arguments: JSON.stringify({
                answer: "I have four gaps:\n1. Zurich to Basel\n2. Basel to Lugano\n3. Lugano to Milan\n4. La Villa to MXP",
                intent: "complete",
              }),
            },
          },
        ],
        time: { recordedAt: "2026-05-19T16:20:00.000Z" },
      },
    ])

    expect(outputs).toEqual([
      expect.objectContaining({
        id: "structured-evt-settle-1",
        heading: "I have four gaps:",
        items: [
          { label: "1", text: "Zurich to Basel" },
          { label: "2", text: "Basel to Lugano" },
          { label: "3", text: "Lugano to Milan" },
          { label: "4", text: "La Villa to MXP" },
        ],
      }),
    ])
  })

  it("extracts user-visible text only from known delivery tool calls", () => {
    const visibleText = extractVisibleTextFromAssistantToolCalls([
      { function: { name: "settle", arguments: JSON.stringify({ answer: "settled answer" }) } },
      { function: { name: "speak", arguments: JSON.stringify({ message: "spoken answer" }) } },
      { function: { name: "surface", arguments: JSON.stringify({ content: "surfaced answer" }) } },
      { function: { name: "unknown", arguments: JSON.stringify({ answer: "hidden" }) } },
      { function: { name: "settle", arguments: JSON.stringify({ answer: "   " }) } },
      { function: { name: "settle", arguments: "{not json" } },
      { function: { name: "settle", arguments: JSON.stringify(["not", "object"]) } },
      { function: { name: "settle", arguments: undefined } },
    ])

    expect(visibleText).toBe("settled answer\nspoken answer\nsurfaced answer")
    expect(extractVisibleTextFromAssistantToolCalls(undefined)).toBe("")
  })

  it("normalizes persisted structured outputs and drops malformed entries", () => {
    const longText = "x".repeat(600)
    const longHeading = "h".repeat(180)
    const outputs = normalizeStructuredOutputs([
      {
        schemaVersion: 1,
        id: "structured-valid",
        kind: "ordered_list",
        sourceEventId: "evt-valid",
        recordedAt: "2026-05-19T16:20:00.000Z",
        heading: longHeading,
        items: [
          { label: " 1 ", text: ` ${longText} ` },
          { label: "2", text: "second" },
          "bad item",
          null,
          { label: 3, text: "numeric label" },
          { label: "4", text: 4 },
          { label: "", text: "no label" },
          { label: "3", text: "" },
        ],
      },
      {
        schemaVersion: 1,
        id: "structured-too-short",
        kind: "ordered_list",
        sourceEventId: "evt-short",
        recordedAt: "2026-05-19T16:20:00.000Z",
        items: [{ label: "1", text: "one" }],
      },
      {
        schemaVersion: 2,
        id: "structured-wrong-version",
        kind: "ordered_list",
        sourceEventId: "evt-wrong",
        recordedAt: "2026-05-19T16:20:00.000Z",
        items: [{ label: "1", text: "one" }, { label: "2", text: "two" }],
      },
      {
        schemaVersion: 1,
        id: "structured-no-items",
        kind: "ordered_list",
        sourceEventId: "evt-no-items",
        recordedAt: "2026-05-19T16:20:00.000Z",
        items: "not an array",
      },
      {
        schemaVersion: 1,
        id: "structured-blank-heading",
        kind: "ordered_list",
        sourceEventId: "evt-blank-heading",
        recordedAt: "2026-05-19T16:20:00.000Z",
        heading: "   ",
        items: [{ label: "1", text: "one" }, { label: "2", text: "two" }],
      },
      {
        schemaVersion: 1,
        id: "structured-non-string-heading",
        kind: "ordered_list",
        sourceEventId: "evt-non-string-heading",
        recordedAt: "2026-05-19T16:20:00.000Z",
        heading: 12,
        items: [{ label: "1", text: "one" }, { label: "2", text: "two" }],
      },
      null,
      "nope",
    ])

    expect(outputs).toHaveLength(3)
    expect(outputs[0]).toMatchObject({
      id: "structured-valid",
      heading: expect.any(String),
      items: [
        { label: "1", text: expect.any(String) },
        { label: "2", text: "second" },
      ],
    })
    expect(outputs[0]!.heading).toHaveLength(160)
    expect(outputs[0]!.items[0]!.text).toHaveLength(500)
    expect(outputs[1]).toEqual({
      schemaVersion: 1,
      id: "structured-blank-heading",
      kind: "ordered_list",
      sourceEventId: "evt-blank-heading",
      recordedAt: "2026-05-19T16:20:00.000Z",
      items: [{ label: "1", text: "one" }, { label: "2", text: "two" }],
    })
    expect(outputs[2]).toEqual({
      schemaVersion: 1,
      id: "structured-non-string-heading",
      kind: "ordered_list",
      sourceEventId: "evt-non-string-heading",
      recordedAt: "2026-05-19T16:20:00.000Z",
      items: [{ label: "1", text: "one" }, { label: "2", text: "two" }],
    })
    expect(normalizeStructuredOutputs({ id: "not-array" })).toEqual([])
  })

  it("splits, restarts, and clips ordered lists with broken numbering", () => {
    const outputs = extractStructuredOutputsFromText(
      [
        "0. not a list start",
        "Directions before first list:",
        "1. Alpha",
        "2. Beta",
        "interruption",
        "Later heading:",
        "1. " + "x".repeat(600),
        "3. skipped number",
        "1. Fresh start",
        "2. Fresh continuation",
      ].join("\n"),
      {
        eventId: "evt-broken",
        recordedAt: "2026-05-19T16:30:00.000Z",
      },
    )

    expect(outputs).toHaveLength(2)
    expect(outputs[0]).toMatchObject({
      id: "structured-evt-broken-1",
      heading: "Directions before first list:",
      items: [
        { label: "1", text: "Alpha" },
        { label: "2", text: "Beta" },
      ],
    })
    expect(outputs[1]).toMatchObject({
      id: "structured-evt-broken-2",
      heading: "3. skipped number",
      items: [
        { label: "1", text: "Fresh start" },
        { label: "2", text: "Fresh continuation" },
      ],
    })
  })

  it("keeps the prior heading when a list restarts at one", () => {
    const outputs = extractStructuredOutputsFromText(
      [
        "Restartable choices:",
        "1. abandoned start",
        "1. real first item",
        "2. real second item",
      ].join("\n"),
      {
        eventId: "evt-restart",
        recordedAt: "2026-05-19T16:32:00.000Z",
      },
    )

    expect(outputs).toEqual([
      expect.objectContaining({
        heading: "Restartable choices:",
        items: [
          { label: "1", text: "real first item" },
          { label: "2", text: "real second item" },
        ],
      }),
    ])
  })

  it("allows blank lines before and inside ordered lists", () => {
    const outputs = extractStructuredOutputsFromText(
      [
        "",
        "Choices:",
        "",
        "1. first",
        "",
        "2. second",
      ].join("\n"),
      {
        eventId: "evt-blank-lines",
        recordedAt: "2026-05-19T16:33:00.000Z",
      },
    )

    expect(outputs).toEqual([
      expect.objectContaining({
        heading: "Choices:",
        items: [
          { label: "1", text: "first" },
          { label: "2", text: "second" },
        ],
      }),
    ])
  })

  it("caps stored list items while preserving enough referent context", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `${index + 1}. item ${index + 1}`)
    const outputs = extractStructuredOutputsFromText(lines.join("\n"), {
      eventId: "evt-many",
      recordedAt: "2026-05-19T16:35:00.000Z",
    })

    expect(outputs).toHaveLength(1)
    expect(outputs[0]!.items).toHaveLength(25)
    expect(outputs[0]!.items.at(-1)).toEqual({ label: "25", text: "item 25" })
  })

  it("returns no structured outputs when assistant events have no visible text", () => {
    const outputs = extractStructuredOutputsFromEvents([
      {
        id: "evt-empty",
        role: "assistant",
        content: [
          { type: "input_image", image_url: { url: "attachment://ignored" } },
          "not an object",
          null,
        ],
        toolCalls: [
          { function: { name: "settle", arguments: JSON.stringify({ answer: "" }) } },
        ],
        time: { recordedAt: null },
      },
    ])

    expect(outputs).toEqual([])
  })

  it("uses the Unix epoch when assistant event time is absent", () => {
    const outputs = extractStructuredOutputsFromEvents([
      {
        id: "evt-no-time",
        role: "assistant",
        content: "Fallback time:\n1. First\n2. Second",
      },
    ])

    expect(outputs).toEqual([
      expect.objectContaining({
        sourceEventId: "evt-no-time",
        recordedAt: "1970-01-01T00:00:00.000Z",
      }),
    ])
  })
})
