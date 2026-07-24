import { describe, expect, it } from "vitest"

import {
  parseHabitExecutionEnvelope,
  parseHabitFrontmatterYaml,
} from "../../../heart/habits/habit-execution"
import {
  parseHabitFile,
  parseHabitFrontmatter,
} from "../../../heart/habits/habit-parser"
import { parseRsvpAwareHabitFile } from "../../../rsvp/habit-parser"

describe("generic habit execution verification", () => {
  it("accepts an empty YAML document and rejects a scalar document", () => {
    expect(parseHabitFrontmatterYaml("")).toEqual({})
    expect(() => parseHabitFrontmatterYaml("ordinary scalar")).toThrow(/must be a map/i)
  })

  it("defaults an entirely omitted execution policy", () => {
    expect(parseHabitExecutionEnvelope({
      version: 1,
      adapter: "agent-turn",
      config: {},
    })).toEqual({
      version: 1,
      adapter: "agent-turn",
      config: {},
      policy: { maxOccurrenceAttempts: 3, unknownSlotFence: "none" },
    })
  })

  it("exposes frontmatter only when a complete frontmatter block exists", () => {
    expect(parseHabitFrontmatter("Body only.")).toBeNull()
    expect(parseHabitFrontmatter("---\ntitle: Complete\n---\n\nBody.")).toEqual({ title: "Complete" })
  })

  it("preserves quoted legacy bracket-list compatibility", () => {
    const populated = parseHabitFile([
      "---",
      "title: Quoted lists",
      'tools: "[read_file, web_fetch]"',
      "surface:",
      '  extra: "[teammate, family]"',
      "---",
      "",
      "Body.",
    ].join("\n"), "/bundles/agent.ouro/habits/quoted-lists.md")
    const empty = parseHabitFile([
      "---",
      "title: Empty quoted lists",
      'tools: "[ ]"',
      "surface:",
      '  extra: "[ ]"',
      "---",
      "",
      "Body.",
    ].join("\n"), "/bundles/agent.ouro/habits/empty-quoted-lists.md")
    const unterminated = parseHabitFile([
      "---",
      "title: Unterminated quoted lists",
      'tools: "[read_file"',
      "surface:",
      '  extra: "[teammate"',
      "---",
      "",
      "Body.",
    ].join("\n"), "/bundles/agent.ouro/habits/unterminated-quoted-lists.md")

    expect(populated.tools).toEqual(["read_file", "web_fetch"])
    expect(populated.surface.extra).toEqual(["teammate", "family"])
    expect(empty.tools).toEqual([])
    expect(empty.surface.extra).toEqual([])
    expect(unterminated.tools).toBeUndefined()
    expect(unterminated.surface.extra).toEqual([])
  })

  it("keeps the temporary personal adapter inert without personal metadata", () => {
    const plain = parseRsvpAwareHabitFile("Body only.", "/bundles/agent.ouro/habits/plain.md")
    const unterminated = parseRsvpAwareHabitFile("---\ntitle: Incomplete", "/bundles/agent.ouro/habits/incomplete.md")
    const generic = parseRsvpAwareHabitFile("---\ntitle: Generic\n---\n\nBody.", "/bundles/agent.ouro/habits/generic.md")

    expect(plain).not.toHaveProperty("rsvp")
    expect(unterminated).not.toHaveProperty("rsvp")
    expect(generic).not.toHaveProperty("rsvp")
  })
})
