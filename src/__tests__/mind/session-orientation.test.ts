import { beforeEach, describe, expect, it, vi } from "vitest"
import type OpenAI from "openai"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("buildSessionOrientation", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("captures the latest goal, constraints, recent activity, and files in play", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: "keep tests green. do not change the architecture. focus on src/mind/context.ts",
        },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"src/mind/context.ts\"}" },
            },
          ],
        } as OpenAI.ChatCompletionAssistantMessageParam,
        { role: "tool", tool_call_id: "call-1", content: "file contents" } as any,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-2",
              type: "function",
              function: { name: "edit_file", arguments: "{\"path\":\"src/mind/context.ts\"}" },
            },
          ],
        } as OpenAI.ChatCompletionAssistantMessageParam,
        { role: "tool", tool_call_id: "call-2", content: "patched" } as any,
        {
          role: "user",
          content: "make the prompt more direct without adding config or changing the architecture",
        },
      ],
      undefined,
      { now: "2026-03-21T09:00:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T09:00:00.000Z",
      goal: "make the prompt more direct without adding config or changing the architecture",
      constraints: expect.arrayContaining([
        "keep tests green",
        "do not change the architecture",
        "focus on src/mind/context.ts",
        "make the prompt more direct without adding config or changing the architecture",
      ]),
      progress: [
        "read_file src/mind/context.ts",
        "edit_file src/mind/context.ts",
      ],
      readFiles: ["src/mind/context.ts"],
      modifiedFiles: ["src/mind/context.ts"],
    })
  })

  it("merges durable orientation details from earlier turns without duplicating them", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "prefer concise answers. keep the harness simple." },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-3",
              type: "function",
              function: { name: "write_file", arguments: "{\"path\":\"src/mind/prompt.ts\"}" },
            },
          ],
        } as OpenAI.ChatCompletionAssistantMessageParam,
      ],
      {
        updatedAt: "2026-03-21T08:00:00.000Z",
        goal: "stabilize session orientation",
        constraints: ["keep the harness simple"],
        progress: ["read_file src/mind/context.ts"],
        readFiles: ["src/mind/context.ts"],
        modifiedFiles: [],
      },
      { now: "2026-03-21T09:30:00.000Z" },
    )

    expect(orientation.goal).toBe("prefer concise answers. keep the harness simple.")
    expect(orientation.constraints).toEqual([
      "keep the harness simple",
      "prefer concise answers",
    ])
    expect(orientation.progress).toEqual([
      "read_file src/mind/context.ts",
      "write_file src/mind/prompt.ts",
    ])
    expect(orientation.readFiles).toEqual(["src/mind/context.ts"])
    expect(orientation.modifiedFiles).toEqual(["src/mind/prompt.ts"])
  })

  it("returns undefined when there is no user or tool signal to preserve", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation([
      { role: "system", content: "sys" },
      { role: "assistant", content: "hello" },
    ])

    expect(orientation).toBeUndefined()
  })

  it("handles rich user content and tool calls that only expose commands or malformed args", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            { type: "text", text: "keep answers grounded." },
            { type: "image_url", image_url: { url: "https://example.com/reference.png" } },
          ],
        } as any,
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-4",
              type: "function",
              function: { name: "exec_command", arguments: "{\"cmd\":\"git status --short\"}" },
            },
            {
              id: "call-5",
              type: "function",
              function: { name: "save_friend_note", arguments: "{not-json" },
            },
          ],
        } as OpenAI.ChatCompletionAssistantMessageParam,
      ],
      undefined,
      { now: "2026-03-21T10:00:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T10:00:00.000Z",
      goal: "keep answers grounded.",
      constraints: ["keep answers grounded"],
      progress: [
        "exec_command git status --short",
        "save_friend_note",
      ],
      readFiles: [],
      modifiedFiles: [],
    })
  })

  it("falls back to bare tool names when parsed tool args are arrays and ignores non-function tool calls", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "keep things grounded" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-array",
              type: "function",
              function: { name: "query_session", arguments: "[]" },
            },
            {
              id: "call-non-function",
              type: "custom_tool",
            },
            {
              id: "call-no-function",
              type: "function",
            },
          ],
        } as any,
      ],
      undefined,
      { now: "2026-03-21T10:15:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T10:15:00.000Z",
      goal: "keep things grounded",
      constraints: ["keep things grounded"],
      progress: ["query_session"],
      readFiles: [],
      modifiedFiles: [],
    })
  })

  it("clips long user goals so orientation stays compact without losing the task center", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")
    const longGoal = "keep the executive assistant grounded and useful ".repeat(10).trim()

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        { role: "user", content: longGoal },
      ],
      undefined,
      { now: "2026-03-21T10:30:00.000Z" },
    )

    expect(orientation?.goal).toMatch(/…$/)
    expect(orientation?.goal?.length).toBeLessThanOrEqual(240)
    expect(orientation?.constraints).toHaveLength(1)
    expect(orientation?.constraints[0]).toMatch(/…$/)
  })

  it("preserves progress and file activity even before a user goal is explicit", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call-6",
              type: "function",
              function: { name: "read_file", arguments: "{\"path\":\"src/mind/context.ts\"}" },
            },
          ],
        } as OpenAI.ChatCompletionAssistantMessageParam,
      ],
      undefined,
      { now: "2026-03-21T10:45:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T10:45:00.000Z",
      constraints: [],
      progress: ["read_file src/mind/context.ts"],
      readFiles: ["src/mind/context.ts"],
      modifiedFiles: [],
    })
  })

  it("falls back past blank latest user content to the most recent real goal", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        { role: "user", content: "earlier concrete goal" },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://example.com/reference.png" } },
          ],
        } as any,
      ],
      {
        updatedAt: "2026-03-21T10:00:00.000Z",
        goal: "persisted fallback goal",
        constraints: [],
        progress: [],
        readFiles: [],
        modifiedFiles: [],
      },
      { now: "2026-03-21T10:50:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T10:50:00.000Z",
      goal: "earlier concrete goal",
      constraints: [],
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })
  })

  it("ignores non-array latest user content while preserving the last real user goal and null-text filtering", async () => {
    const { buildSessionOrientation } = await import("../../mind/session-orientation")

    const orientation = buildSessionOrientation(
      [
        { role: "system", content: "sys" },
        {
          role: "user",
          content: [
            42,
            { type: "text", text: null },
            { type: "text", text: "keep the assistant grounded" },
          ],
        } as any,
        {
          role: "user",
          content: { type: "text", text: "this should not become the goal" },
        } as any,
      ],
      {
        updatedAt: "2026-03-21T10:00:00.000Z",
        goal: "persisted fallback goal",
        constraints: [],
        progress: [],
        readFiles: [],
        modifiedFiles: [],
      },
      { now: "2026-03-21T10:55:00.000Z" },
    )

    expect(orientation).toEqual({
      updatedAt: "2026-03-21T10:55:00.000Z",
      goal: "keep the assistant grounded",
      constraints: ["keep the assistant grounded"],
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })
  })
})

describe("normalizeSessionOrientation", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("restores persisted orientation fields and trims/dedupes them", async () => {
    const { normalizeSessionOrientation } = await import("../../mind/session-orientation")

    expect(normalizeSessionOrientation({
      updatedAt: "2026-03-21T11:00:00.000Z",
      goal: "  keep the agent useful  ",
      constraints: ["keep it simple", "keep it simple", "", 7],
      progress: ["read_file src/mind/context.ts", "read_file src/mind/context.ts", "  "],
      readFiles: ["src/mind/context.ts", "src/mind/context.ts", "", 9],
      modifiedFiles: ["src/mind/prompt.ts", "src/mind/prompt.ts", "", false],
    })).toEqual({
      updatedAt: "2026-03-21T11:00:00.000Z",
      goal: "keep the agent useful",
      constraints: ["keep it simple"],
      progress: ["read_file src/mind/context.ts"],
      readFiles: ["src/mind/context.ts"],
      modifiedFiles: ["src/mind/prompt.ts"],
    })
  })

  it("drops blank goals and tolerates missing array fields", async () => {
    const { normalizeSessionOrientation } = await import("../../mind/session-orientation")

    expect(normalizeSessionOrientation({
      updatedAt: "2026-03-21T11:15:00.000Z",
      goal: "   ",
      constraints: ["keep it simple"],
      progress: "not-an-array",
      readFiles: null,
      modifiedFiles: false,
    })).toEqual({
      updatedAt: "2026-03-21T11:15:00.000Z",
      constraints: ["keep it simple"],
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })
  })

  it("treats non-array constraints as empty while preserving other normalized fields", async () => {
    const { normalizeSessionOrientation } = await import("../../mind/session-orientation")

    expect(normalizeSessionOrientation({
      updatedAt: "2026-03-21T11:20:00.000Z",
      goal: "stay grounded",
      constraints: "not-an-array",
      progress: ["query_session"],
      readFiles: [],
      modifiedFiles: [],
    })).toEqual({
      updatedAt: "2026-03-21T11:20:00.000Z",
      goal: "stay grounded",
      constraints: [],
      progress: ["query_session"],
      readFiles: [],
      modifiedFiles: [],
    })
  })

  it("caps normalized lists at the configured maximum to keep orientation compact", async () => {
    const { normalizeSessionOrientation } = await import("../../mind/session-orientation")

    expect(normalizeSessionOrientation({
      updatedAt: "2026-03-21T11:25:00.000Z",
      goal: "stay grounded",
      constraints: Array.from({ length: 10 }, (_, index) => `constraint-${index + 1}`),
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })).toEqual({
      updatedAt: "2026-03-21T11:25:00.000Z",
      goal: "stay grounded",
      constraints: [
        "constraint-1",
        "constraint-2",
        "constraint-3",
        "constraint-4",
        "constraint-5",
        "constraint-6",
        "constraint-7",
        "constraint-8",
      ],
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })
  })
})

describe("renderSessionOrientation", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("renders a compact session orientation section", async () => {
    const { renderSessionOrientation } = await import("../../mind/session-orientation")

    const rendered = renderSessionOrientation({
      updatedAt: "2026-03-21T09:00:00.000Z",
      goal: "tighten the harness backbone",
      constraints: ["keep it simple"],
      progress: ["edit_file src/mind/prompt.ts"],
      readFiles: ["src/mind/context.ts"],
      modifiedFiles: ["src/mind/prompt.ts"],
    })

    expect(rendered).toContain("## session orientation")
    expect(rendered).toContain("goal: tighten the harness backbone")
    expect(rendered).toContain("- keep it simple")
    expect(rendered).toContain("- edit_file src/mind/prompt.ts")
    expect(rendered).toContain("- src/mind/context.ts")
    expect(rendered).toContain("- src/mind/prompt.ts")
  })

  it("returns an empty string when nothing meaningful is present", async () => {
    const { renderSessionOrientation } = await import("../../mind/session-orientation")

    expect(renderSessionOrientation(undefined)).toBe("")
    expect(renderSessionOrientation({
      updatedAt: "2026-03-21T09:00:00.000Z",
      constraints: [],
      progress: [],
      readFiles: [],
      modifiedFiles: [],
    })).toBe("")
  })
})
