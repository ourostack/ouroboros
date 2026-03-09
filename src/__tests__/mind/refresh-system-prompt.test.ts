import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
  statSync: vi.fn(),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent-root"),
  getAgentName: vi.fn(() => "testagent"),
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
}))

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: vi.fn(() => "mock-provider"),
}))

vi.mock("../../repertoire/tools", () => ({
  getToolsForChannel: vi.fn(() => []),
  finalAnswerTool: { type: "function", function: { name: "final_answer", description: "respond" } },
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(() => []),
}))

vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: vi.fn(() => ({ compact: "" })),
  }),
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../mind/friends/channel", () => ({
  getChannelCapabilities: vi.fn(() => ({
    channel: "cli",
    supportsMarkdown: true,
    supportsStreaming: true,
    supportsRichCards: false,
  })),
}))

vi.mock("../../mind/first-impressions", () => ({
  getFirstImpressions: vi.fn(() => null),
}))

import * as fs from "fs"
import type OpenAI from "openai"

beforeEach(() => {
  vi.resetModules()
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
    const p = String(filePath)
    if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.20" })
    return ""
  })
})

describe("refreshSystemPrompt", () => {
  it("replaces messages[0] with fresh system prompt when messages[0] is system", async () => {
    const { refreshSystemPrompt } = await import("../../mind/prompt-refresh")

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "old system prompt" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]

    await refreshSystemPrompt(messages, "cli")

    expect(messages).toHaveLength(3)
    expect(messages[0].role).toBe("system")
    expect((messages[0] as any).content).not.toBe("old system prompt")
    expect((messages[0] as any).content).toContain("testagent")
  })

  it("prepends system message when messages[0] is not system", async () => {
    const { refreshSystemPrompt } = await import("../../mind/prompt-refresh")

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
    ]

    await refreshSystemPrompt(messages, "cli")

    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe("system")
  })

  it("passes context and options through to buildSystem", async () => {
    const { refreshSystemPrompt } = await import("../../mind/prompt-refresh")

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "old" },
    ]

    await refreshSystemPrompt(messages, "cli", { toolChoiceRequired: true })

    expect(messages[0].role).toBe("system")
    // With toolChoiceRequired, the prompt should contain tool behavior section
    expect((messages[0] as any).content).toContain("tool_choice")
  })
})
