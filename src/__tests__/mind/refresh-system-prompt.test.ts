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
  getRepoRoot: vi.fn(() => "/mock/repo"),
  loadAgentConfig: vi.fn(() => ({
    provider: "anthropic",
    humanFacing: { provider: "anthropic", model: "mock-model" },
    agentFacing: { provider: "anthropic", model: "mock-model" },
    context: { maxTokens: 80000, contextMargin: 20 },
    phrases: { thinking: [], tool: [], followup: [] },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
}))

vi.mock("../../heart/daemon/runtime-mode", () => ({
  detectRuntimeMode: vi.fn(() => "dev"),
}))

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: vi.fn(() => "mock-provider"),
}))

vi.mock("../../repertoire/tools", () => ({
  getToolsForChannel: vi.fn(() => []),
  observeTool: { type: "function", function: { name: "observe", description: "stay silent" } },
  ponderTool: { type: "function", function: { name: "ponder", description: "think privately" } },
  restTool: { type: "function", function: { name: "rest", description: "end inner turn" } },
  settleTool: { type: "function", function: { name: "settle", description: "respond" } },
  surfaceToolDef: { type: "function", function: { name: "surface", description: "surface outward" } },
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
  channelToFacing: vi.fn(() => "human"),
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

  it("accepts continuity-aware build options without breaking prompt refresh", async () => {
    const { refreshSystemPrompt } = await import("../../mind/prompt-refresh")

    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: "system", content: "old" },
    ]

    await refreshSystemPrompt(messages, "cli", {
      toolChoiceRequired: true,
      currentObligation: "debug the onboarding interruption",
      mustResolveBeforeHandoff: true,
      hasQueuedFollowUp: true,
    } as any)

    expect(messages[0].role).toBe("system")
    expect((messages[0] as any).content).toContain("tool_choice")
  })
})
