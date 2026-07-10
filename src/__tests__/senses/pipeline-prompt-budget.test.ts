import { describe, expect, it, vi } from "vitest"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

function system(content: string): ChatCompletionMessageParam {
  return { role: "system", content }
}

function user(content: string): ChatCompletionMessageParam {
  return { role: "user", content }
}

function assistant(content: string): ChatCompletionMessageParam {
  return { role: "assistant", content }
}

describe("pipeline-shaped prompt budgeting", () => {
  it("trims lower-priority orientation, memory, diagnostics, and older history while keeping current user and compact context refs", async () => {
    const { applyPromptBudget } = await import("../../mind/prompt-budget")
    const messages: ChatCompletionMessageParam[] = [
      system("system prompt\n\n## from my kept record\n" + "kept note prose ".repeat(80)),
      user("old session question " + "old ".repeat(80)),
      assistant("old answer " + "old ".repeat(80)),
      system([
        "Untrusted bluebubbles context for this same thread.",
        "[bbmsg:chatabc:script] 2026-07-09T10:00:00.000Z Slugger: RSVP Update -- Ari & Rachel " + "guest ".repeat(90),
      ].join("\n")),
      system("## diagnostics\n" + "doctor detail ".repeat(100)),
      system("## habit receipt\nreceipt rsvp_2026_07_09 " + "receipt detail ".repeat(70)),
      user("who is pending?"),
    ]

    const result = applyPromptBudget({
      messages,
      provider: "minimax",
      model: "MiniMax-M2.7",
      contextWindowTokens: 160,
    })

    const rendered = JSON.stringify(result.messages)
    expect(rendered).toContain("system prompt")
    expect(rendered).toContain("who is pending?")
    expect(rendered).toContain("bbmsg:chatabc:script")
    expect(rendered).not.toContain("old session question")
    expect(rendered).not.toContain("doctor detail doctor detail")
    expect(rendered).not.toContain("receipt detail receipt detail")
    expect(result.stats.truncations.map((entry) => entry.source)).toEqual(expect.arrayContaining([
      "older-session-history",
      "diagnostics",
      "habit-receipt",
      "sense-context-packet",
    ]))
  })
})
