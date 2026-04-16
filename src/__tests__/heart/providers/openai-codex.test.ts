import { beforeEach, describe, expect, it, vi } from "vitest"

function defaultReadFileSync(filePath: any, _encoding?: any): string {
  const p = String(filePath)
  if (p.endsWith("SOUL.md")) return "mock soul"
  if (p.endsWith("IDENTITY.md")) return "mock identity"
  if (p.endsWith("LORE.md")) return "mock lore"
  if (p.endsWith("FRIENDS.md")) return "mock friends"
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

vi.mock("../../../heart/daemon/socket-client", () => ({
  DEFAULT_DAEMON_SOCKET_PATH: "/tmp/ouroboros-test-mock.sock",
  sendDaemonCommand: vi.fn().mockResolvedValue({ ok: true }),
  checkDaemonSocketAlive: vi.fn().mockResolvedValue(false),
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

vi.mock("../../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "openai-codex",
    humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
    agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
  })),
  DEFAULT_AGENT_CONTEXT: { maxTokens: 80000, contextMargin: 20 },
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

const mockOpenAICtor = vi.fn()
const mockResponsesCreate = vi.fn()

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: (...args: any[]) => mockResponsesCreate(...args) }
    constructor(opts?: any) { mockOpenAICtor(opts) }
  }
  return { default: MockOpenAI, AzureOpenAI: MockOpenAI }
})

const mockStreamResponsesApi = vi.fn()
const mockToResponsesInput = vi.fn().mockReturnValue({ instructions: "sys", input: [] })
const mockToResponsesTools = vi.fn().mockReturnValue([])

vi.mock("../../../heart/streaming", () => ({
  streamResponsesApi: (...args: any[]) => mockStreamResponsesApi(...args),
  toResponsesInput: (...args: any[]) => mockToResponsesInput(...args),
  toResponsesTools: (...args: any[]) => mockToResponsesTools(...args),
}))

function buildToken(accountId: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.signature`
}

async function setupConfig(token = buildToken("acct-test-123")) {
  const config = await import("../../../heart/config")
  config.resetConfigCache()
  config.patchRuntimeConfig({
    providers: {
      "openai-codex": {
        oauthAccessToken: token,
      },
    },
  })
}

describe("createOpenAICodexProviderRuntime", () => {
  beforeEach(async () => {
    vi.resetModules()
    mockOpenAICtor.mockReset()
    mockResponsesCreate.mockReset()
    mockStreamResponsesApi.mockReset()
    mockToResponsesInput.mockReset().mockReturnValue({ instructions: "sys", input: [] })
    mockToResponsesTools.mockReset().mockReturnValue([])
    const config = await import("../../../heart/config")
    config.resetConfigCache()
  })

  it("ping uses the Codex streaming Responses payload instead of a bare responses.create request", async () => {
    await setupConfig()
    mockStreamResponsesApi.mockResolvedValue({ content: "pong", toolCalls: [], outputItems: [] })

    const { createOpenAICodexProviderRuntime } = await import("../../../heart/providers/openai-codex")
    const runtime = createOpenAICodexProviderRuntime("gpt-5.4")

    await runtime.ping()

    expect(mockOpenAICtor).toHaveBeenCalledWith(expect.objectContaining({
      baseURL: "https://chatgpt.com/backend-api/codex",
      defaultHeaders: expect.objectContaining({
        "OpenAI-Beta": "responses=experimental",
        originator: "ouroboros",
      }),
    }))
    expect(mockStreamResponsesApi).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        model: "gpt-5.4",
        input: [{ role: "user", content: "ping" }],
        instructions: "",
        tools: [],
        reasoning: { effort: "medium", summary: "detailed" },
        stream: true,
        store: false,
        include: ["reasoning.encrypted_content"],
      }),
      expect.objectContaining({
        onModelStart: expect.any(Function),
        onModelStreamStart: expect.any(Function),
        onTextChunk: expect.any(Function),
        onReasoningChunk: expect.any(Function),
        onToolStart: expect.any(Function),
        onToolEnd: expect.any(Function),
        onError: expect.any(Function),
      }),
      undefined,
    )
    expect(mockResponsesCreate).not.toHaveBeenCalled()
  })
})
