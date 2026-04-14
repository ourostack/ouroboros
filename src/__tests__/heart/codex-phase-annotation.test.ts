import { describe, it, expect, vi, beforeEach } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "engine",
    event: "engine.test_run",
    message: testName,
    meta: { test: true },
  })
}

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("package.json")) return JSON.stringify({ name: "other" })
  return ""
}

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(defaultReadFileSync),
  writeFileSync: vi.fn(),
  readdirSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Hard-mock the daemon socket client. The runtime guard in socket-client.ts
// already prevents real socket calls under vitest (by detecting process.argv),
// but the explicit mock lets tests that care assert on call counts and avoids
// the per-file allowlist in test-isolation.contract.test.ts.
vi.mock("../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({ execSync: vi.fn(), spawnSync: vi.fn() }))
vi.mock("../../repertoire/skills", () => ({ listSkills: vi.fn(), loadSkill: vi.fn() }))

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

vi.mock("openai", () => {
  class MockOpenAI { chat = { completions: { create: vi.fn() } }; responses = { create: vi.fn() }; constructor() {} }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

vi.mock("@anthropic-ai/sdk", () => {
  class MockAnthropic { messages = { create: vi.fn() }; constructor() {} }
  return { default: MockAnthropic }
})

describe("Codex phase annotation", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("toResponsesInput restores phase field on assistant items when present", async () => {
    emitTestEvent("toResponsesInput restores phase")
    const { toResponsesInput } = await import("../../heart/streaming")
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "thinking about it...",
        phase: "commentary",
      },
      { role: "user" as const, content: "ok" },
      {
        role: "assistant" as const,
        content: "here is my answer",
        phase: "settle",
      },
    ]
    const result = toResponsesInput(messages as any)
    const assistantItems = result.input.filter((item: any) => item.role === "assistant")
    expect(assistantItems).toHaveLength(2)
    expect(assistantItems[0].phase).toBe("commentary")
    expect(assistantItems[1].phase).toBe("settle")
  })

  it("toResponsesInput omits phase when not present on message", async () => {
    emitTestEvent("toResponsesInput omits phase when absent")
    const { toResponsesInput } = await import("../../heart/streaming")
    const messages = [
      { role: "user" as const, content: "hi" },
      { role: "assistant" as const, content: "hello" },
    ]
    const result = toResponsesInput(messages as any)
    const assistantItems = result.input.filter((item: any) => item.role === "assistant")
    expect(assistantItems).toHaveLength(1)
    expect(assistantItems[0].phase).toBeUndefined()
  })

  it("phase is harmless for non-Codex providers (toAnthropicMessages ignores it)", async () => {
    emitTestEvent("phase harmless for Anthropic")
    const { toAnthropicMessages } = await import("../../heart/providers/anthropic")
    const messages = [
      { role: "user" as const, content: "hi" },
      {
        role: "assistant" as const,
        content: "hello",
        phase: "commentary",
      },
    ]
    const result = toAnthropicMessages(messages as any)
    const assistantMsg = result.messages.find((m: any) => m.role === "assistant") as any
    // Phase should not appear in Anthropic output
    expect(assistantMsg.content[0].type).toBe("text")
    expect(assistantMsg.phase).toBeUndefined()
  })
})
