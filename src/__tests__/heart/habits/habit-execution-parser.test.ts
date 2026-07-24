import { describe, expect, it } from "vitest"

import { parseHabitFile, renderHabitFile } from "../../../heart/habits/habit-parser"

function habit(frontmatter: string, body = "Run the configured work."): string {
  return `---\n${frontmatter}\n---\n\n${body}`
}

describe("generic habit execution frontmatter", () => {
  it("preserves an explicit nested adapter-owned configuration and generic policy", () => {
    const parsed = parseHabitFile(habit([
      "title: Inventory refresh",
      "status: active",
      "execution:",
      "  version: 1",
      "  adapter: mcp-tool",
      "  config:",
      "    executorId: inventory-refresh",
      "    input:",
      "      filters:",
      "        states:",
      "          - ready",
      "          - pending",
      "      includeDetails: true",
      "  policy:",
      "    maxOccurrenceAttempts: 5",
      "    unknownSlotFence: habit",
    ].join("\n")), "/bundles/agent.ouro/habits/inventory-refresh.md")

    expect(parsed.execution).toEqual({
      version: 1,
      adapter: "mcp-tool",
      config: {
        executorId: "inventory-refresh",
        input: {
          filters: { states: ["ready", "pending"] },
          includeDetails: true,
        },
      },
      policy: { maxOccurrenceAttempts: 5, unknownSlotFence: "habit" },
    })
  })

  it("synthesizes the implicit agent-turn envelope only in memory", () => {
    const source = habit("title: Ordinary habit")
    const parsed = parseHabitFile(source, "/bundles/agent.ouro/habits/ordinary.md")

    expect(parsed.execution).toEqual({
      version: 1,
      adapter: "agent-turn",
      config: {},
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
    })
    expect(source).not.toContain("execution:")
  })

  it("defaults only omitted generic policy fields", () => {
    const parsed = parseHabitFile(habit([
      "title: Partial policy",
      "execution:",
      "  version: 1",
      "  adapter: custom-adapter",
      "  config:",
      "    nested:",
      "      answer: 42",
      "  policy:",
      "    unknownSlotFence: habit",
    ].join("\n")), "/bundles/agent.ouro/habits/partial-policy.md")

    expect(parsed.execution).toEqual({
      version: 1,
      adapter: "custom-adapter",
      config: { nested: { answer: 42 } },
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "habit" },
    })
  })

  it.each([
    ["unsupported version", "version: 2\n  adapter: agent-turn\n  config: {}", /version/i],
    ["invalid adapter id", "version: 1\n  adapter: Agent_Turn\n  config: {}", /adapter/i],
    ["missing config", "version: 1\n  adapter: agent-turn", /config/i],
    ["array config", "version: 1\n  adapter: agent-turn\n  config: []", /config/i],
    ["zero attempts", "version: 1\n  adapter: agent-turn\n  config: {}\n  policy:\n    maxOccurrenceAttempts: 0", /maxOccurrenceAttempts/i],
    ["too many attempts", "version: 1\n  adapter: agent-turn\n  config: {}\n  policy:\n    maxOccurrenceAttempts: 11", /maxOccurrenceAttempts/i],
    ["fractional attempts", "version: 1\n  adapter: agent-turn\n  config: {}\n  policy:\n    maxOccurrenceAttempts: 1.5", /maxOccurrenceAttempts/i],
    ["invalid fence", "version: 1\n  adapter: agent-turn\n  config: {}\n  policy:\n    unknownSlotFence: global", /unknownSlotFence/i],
    ["unknown envelope key", "version: 1\n  adapter: agent-turn\n  config: {}\n  command: nope", /unknown|key|field/i],
    ["unknown policy key", "version: 1\n  adapter: agent-turn\n  config: {}\n  policy:\n    timeout: 10", /unknown|key|field/i],
  ])("rejects %s", (_label, execution, expected) => {
    expect(() => parseHabitFile(habit(`title: Invalid\nexecution:\n  ${execution}`), "/bundles/agent.ouro/habits/invalid.md")).toThrow(expected)
  })

  it("rejects duplicate keys", () => {
    expect(() => parseHabitFile(habit("title: First\ntitle: Second"), "/bundles/agent.ouro/habits/duplicate.md")).toThrow(/duplicate/i)
  })

  it("rejects aliases", () => {
    expect(() => parseHabitFile(habit([
      "title: Alias",
      "base: &base",
      "  value: one",
      "copy: *base",
    ].join("\n")), "/bundles/agent.ouro/habits/alias.md")).toThrow(/alias/i)
  })

  it("rejects explicit tags", () => {
    expect(() => parseHabitFile(habit("title: !!str Tagged"), "/bundles/agent.ouro/habits/tag.md")).toThrow(/tag/i)
  })

  it("rejects merge keys", () => {
    expect(() => parseHabitFile(habit([
      "title: Merge",
      "execution:",
      "  version: 1",
      "  adapter: agent-turn",
      "  config:",
      "    <<: { injected: true }",
    ].join("\n")), "/bundles/agent.ouro/habits/merge.md")).toThrow(/merge/i)
  })

  it("rejects non-string map keys", () => {
    expect(() => parseHabitFile(habit([
      "title: Non-string key",
      "execution:",
      "  version: 1",
      "  adapter: agent-turn",
      "  config:",
      "    7: value",
    ].join("\n")), "/bundles/agent.ouro/habits/non-string-key.md")).toThrow(/string.*key/i)
  })

  it("renders deterministic two-space nested YAML while preserving body bytes", () => {
    const body = "Line one.\n\n  indented body line\n"
    const rendered = renderHabitFile({
      title: "Nested",
      execution: {
        version: 1,
        adapter: "mcp-tool",
        config: {
          executorId: "inventory-refresh",
          input: { states: ["ready", "pending"] },
        },
        policy: { maxOccurrenceAttempts: 5, unknownSlotFence: "habit" },
      },
    }, body)

    expect(rendered).toBe([
      "---",
      "title: Nested",
      "execution:",
      "  version: 1",
      "  adapter: mcp-tool",
      "  config:",
      "    executorId: inventory-refresh",
      "    input:",
      "      states:",
      "        - ready",
      "        - pending",
      "  policy:",
      "    maxOccurrenceAttempts: 5",
      "    unknownSlotFence: habit",
      "---",
      "",
      body,
    ].join("\n"))
    expect(rendered.slice(rendered.indexOf("---\n\n") + 5)).toBe(body)
  })

  it("keeps ordinary habit fields compatible with the strict YAML parser", () => {
    const parsed = parseHabitFile(habit([
      "title: Ordinary",
      "cadence: 30m",
      "status: paused",
      "tools: [read_file, web_fetch]",
      "continuity:",
      "  mode: stateful",
    ].join("\n"), "Ordinary body."), "/bundles/agent.ouro/habits/ordinary.md")

    expect(parsed).toMatchObject({
      name: "ordinary",
      title: "Ordinary",
      cadence: "30m",
      status: "paused",
      tools: ["read_file", "web_fetch"],
      continuity: { mode: "stateful" },
      body: "Ordinary body.",
    })
  })
})
