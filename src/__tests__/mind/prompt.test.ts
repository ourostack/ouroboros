import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"
import * as nodeFs from "node:fs"

vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
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

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  spawnSync: vi.fn(),
}))

vi.mock("../../repertoire/skills", () => ({
  listSkills: vi.fn(),
  loadSkill: vi.fn(),
}))

const mockGetBoard = vi.fn()
vi.mock("../../repertoire/tasks", () => ({
  getTaskModule: () => ({
    getBoard: mockGetBoard,
  }),
}))

vi.mock("../../heart/identity", () => {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  return {
    DEFAULT_AGENT_CONTEXT,
    loadAgentConfig: vi.fn(() => ({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    getAgentRepoWorkspacesRoot: vi.fn(() => "/mock/repo/testagent/state/workspaces"),
    HARNESS_CANONICAL_REPO_URL: "https://github.com/ouroborosbot/ouroboros.git",
    resetIdentity: vi.fn(),
  }
})

vi.mock("openai", () => {
  class MockOpenAI {
    chat = { completions: { create: vi.fn() } }
    responses = { create: vi.fn() }
    constructor(_opts?: any) {}
  }
  return {
    default: MockOpenAI,
    AzureOpenAI: MockOpenAI,
  }
})

import * as fs from "fs"
import { listSkills } from "../../repertoire/skills"
import * as identity from "../../heart/identity"

const MOCK_PACKAGE_JSON = JSON.stringify({ version: "0.1.0-alpha.20" })

// Default psyche file contents used by the mock
const MOCK_SOUL = "i am a witty, funny, competent chaos monkey coding assistant.\ni get things done, crack jokes, embrace chaos, deliver quality."
const MOCK_IDENTITY = "i am Ouroboros.\ni use lowercase in my responses to the user except for proper nouns. no periods unless necessary. i never apply lowercase to code, file paths, environment variables, or tool arguments -- only to natural language output."
const MOCK_LORE = "i am named after the ouroboros -- the ancient symbol of a serpent eating its own tail."
const MOCK_FRIENDS = "my creator works at microsoft and talks to me through the CLI and Teams."
const MOCK_TACIT_KNOWLEDGE = "i learned that structured logging is better than console.log."
const MOCK_ASPIRATIONS = "keep improving the harness and help people with real work."

function makeOpenAICodexAccessToken(accountId = "acct_test"): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
      },
    })
  ).toString("base64url")
  return `${header}.${payload}.sig`
}

function setAgentProvider(provider: "azure" | "minimax" | "anthropic" | "openai-codex") {
  const DEFAULT_AGENT_CONTEXT = {
    maxTokens: 80000,
    contextMargin: 20,
  }
  vi.mocked(identity.loadAgentConfig).mockReturnValue({
    name: "testagent",
    provider,
    humanFacing: { provider, model: "" },
    agentFacing: { provider, model: "" },
    context: { ...DEFAULT_AGENT_CONTEXT },
  })
}

// Helper: configure readFileSync to return psyche files by path
function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
    const p = String(filePath)
    if (p.endsWith("SOUL.md")) return MOCK_SOUL
    if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
    if (p.endsWith("LORE.md")) return MOCK_LORE
    if (p.endsWith("FRIENDS.md")) return MOCK_FRIENDS
    if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
    if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
    if (p.endsWith("secrets.json")) return JSON.stringify({})
    if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
    return ""
  })
}

function makeOnboardingContext() {
  return {
    friend: {
      id: "uuid-1",
      name: "Jordan",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "teams" as const,
      availableIntegrations: ["ado" as const, "graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: 28000,
    },
  }
}

describe("buildSystem", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        "validating": [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("includes soul section with personality", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("chaos monkey coding assistant")
    expect(result).toContain("crack jokes")
  })

  it("reads active session summaries from bundle-local state", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    await buildSystem()

    expect(fs.existsSync).toHaveBeenCalledWith("/mock/repo/testagent/state/sessions")
  })

  it("includes identity section with Ouroboros name", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("i am Ouroboros")
    expect(result).toContain("i use lowercase")
  })

  it("includes workspace discipline guidance with locked content", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## how i work")
    expect(result).toContain("I work conservatively")
    expect(result).toContain("**reversibility and blast radius**")
    expect(result).toContain("**engineering discipline**")
  })

  it("includes active bridge work when bridge context is present", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem(
      "teams",
      {
        bridgeContext: "bridge-1: relay Ari between cli and teams (task: 2026-03-13-1600-shared-relay)",
      } as any,
      makeOnboardingContext() as any,
    ))
    expect(result).toContain("## active bridge work")
    expect(result).toContain("bridge-1")
    expect(result).toContain("shared-relay")
  })

  it("reuses a pre-headed bridge section without duplicating the heading", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem(
      "teams",
      {
        bridgeContext: "## active bridge work\nbridge-2: keep cli and teams aligned",
      } as any,
      makeOnboardingContext() as any,
    ))
    expect(result).toContain("## active bridge work\nbridge-2: keep cli and teams aligned")
    expect(result.match(/## active bridge work/g)).toHaveLength(1)
  })

  it("renders one shared active-work section when a center-of-gravity frame is present", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem(
      "teams",
      {
        activeWorkFrame: {
          centerOfGravity: "shared-work",
          currentSession: { friendId: "friend-1", channel: "teams", key: "conv-1", sessionPath: "/tmp/s.json" },
          currentObligation: "carry Ari across cli and teams",
          inner: { status: "idle", hasPending: false, job: { status: "idle", content: null, origin: null, mode: "reflect", obligationStatus: null, surfacedResult: null, queuedAt: null, startedAt: null, surfacedAt: null } },
          bridges: [],
          taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
          friendActivity: {
            freshestForCurrentFriend: {
              channel: "cli",
              key: "session",
            },
            otherLiveSessionsForCurrentFriend: [],
          },
          bridgeSuggestion: {
            kind: "attach-existing",
            bridgeId: "bridge-1",
            reason: "shared-work-candidate",
            targetSession: {
              channel: "cli",
              key: "session",
            },
          },
        },
      } as any,
      makeOnboardingContext() as any,
    ))

    expect(result).toContain("## what i'm holding")
    expect(result).not.toContain("i told them i'd carry Ari across cli and teams.")
    expect(result).toContain("relates to bridge bridge-1")
  })

  it("gives family members an always-on all-sessions truth rule without a status-question switch", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const baseContext = makeOnboardingContext()

    const result = flattenSystemPrompt(await buildSystem(
      "cli",
      {
        activeWorkFrame: {
          centerOfGravity: "inward-work",
          currentSession: { friendId: "uuid-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
          currentObligation: "what are you up to?",
          mustResolveBeforeHandoff: false,
          inner: { status: "idle", hasPending: false, job: { status: "idle", content: null, origin: null, mode: "reflect", obligationStatus: null, surfacedResult: null, queuedAt: null, startedAt: null, surfacedAt: null } },
          bridges: [],
          taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
          friendActivity: {
            freshestForCurrentFriend: null,
            otherLiveSessionsForCurrentFriend: [],
            allOtherLiveSessions: [
              {
                friendId: "uuid-1",
                friendName: "Jordan",
                channel: "bluebubbles",
                key: "chat",
                sessionPath: "/tmp/bb.json",
                lastActivityAt: "2026-03-21T09:00:00.000Z",
                lastActivityMs: Date.parse("2026-03-21T09:00:00.000Z"),
                activitySource: "friend-facing",
              },
            ],
          },
          codingSessions: [],
          otherCodingSessions: [
            {
              id: "coding-300",
              runner: "codex",
              workdir: "/tmp/workspaces/ouroboros",
              taskRef: "bb-fix",
              status: "running",
              stdoutTail: "",
              stderrTail: "",
              pid: 300,
              startedAt: "2026-03-21T09:00:00.000Z",
              lastActivityAt: "2026-03-21T09:01:00.000Z",
              endedAt: null,
              restartCount: 0,
              lastExitCode: null,
              lastSignal: null,
              failure: null,
              originSession: { friendId: "uuid-1", channel: "bluebubbles", key: "chat" },
            },
          ],
          pendingObligations: [],
          bridgeSuggestion: null,
        },
      } as any,
      {
        ...baseContext,
        friend: {
          ...baseContext.friend,
          trustLevel: "family",
        },
      } as any,
    ))

    // Locked trimmed 5-line content
    expect(result).toContain("## cross-session truth")
    expect(result).toContain("live world-state across visible sessions and lanes")
    expect(result).toContain("When live state conflicts with older transcript history, live state wins")
    expect(result).toContain("what the next concrete step is")
    expect(result).toContain("I say so plainly and note what still needs checking")
  })

  it("makes current trust context and candidate target chats explicit enough to reason about", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const context = makeOnboardingContext()
    context.friend.role = "acquaintance"
    context.friend.trustLevel = "acquaintance"
    context.friend.externalIds = [
      { provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-14T18:00:00.000Z" },
      { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-03-14T18:00:00.000Z" },
    ]

    const result = flattenSystemPrompt(await buildSystem(
      "bluebubbles",
      {
        activeWorkFrame: {
          centerOfGravity: "shared-work",
          currentObligation: "carry this into the group chat",
          currentSession: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat-any",
            sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat-any.json",
          },
          mustResolveBeforeHandoff: false,
          inner: { status: "idle", hasPending: false },
          bridges: [],
          taskPressure: {
            compactBoard: "",
            liveTaskNames: [],
            activeBridges: [],
          },
          friendActivity: {
            freshestForCurrentFriend: null,
            otherLiveSessionsForCurrentFriend: [],
          },
          bridgeSuggestion: null,
          targetCandidates: [
            {
              friendId: "friend-2",
              friendName: "Project Group",
              channel: "bluebubbles",
              key: "chat-group",
              sessionPath: "/tmp/state/sessions/friend-2/bluebubbles/chat-group.json",
              snapshot: "recent focus: waiting on the update",
              trust: {
                level: "acquaintance",
                basis: "shared_group",
                summary: "known through the shared project group",
                why: "this group is a shared social context, not direct trust",
                permits: ["group-safe coordination"],
                constraints: ["guarded local actions"],
                relatedGroupId: "group:any;+;project-group-123",
              },
              delivery: {
                mode: "queue_only",
                reason: "requires explicit cross-chat authorization",
              },
              lastActivityAt: "2026-03-14T18:01:00.000Z",
              lastActivityMs: Date.parse("2026-03-14T18:01:00.000Z"),
            },
          ],
        } as any,
      },
      context as any,
    ))

    expect(result).toContain("## trust context")
    expect(result).toContain("shared project group")
    expect(result).toContain("## candidate target chats")
    expect(result).toContain("Project Group")
    expect(result).toContain("queue_only")
  })

  it("keeps cli sessions free of remote trust framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const context = makeOnboardingContext()
    context.friend.role = "friend"
    context.friend.trustLevel = "friend"
    context.channel = {
      channel: "cli" as const,
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: false,
      supportsRichCards: false,
      maxMessageLength: 28000,
    }

    const result = flattenSystemPrompt(await buildSystem(
      "cli",
      {},
      context as any,
    ))

    expect(result).not.toContain("## trust context")
  })

  it("makes remote trust context explicit even when there is no related shared-group anchor", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const context = makeOnboardingContext()
    context.friend.role = "acquaintance"
    context.friend.trustLevel = "acquaintance"
    context.friend.externalIds = [
      { provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-14T18:00:00.000Z" },
    ]

    const result = flattenSystemPrompt(await buildSystem(
      "teams",
      {},
      context as any,
    ))

    expect(result).toContain("## trust context")
    expect(result).toContain("level: acquaintance")
    expect(result).toContain("basis: shared_group")
    expect(result).toContain("permits:")
    expect(result).toContain("constraints:")
    expect(result).not.toContain("related group:")
  })

  it("renders the delegation hint as part of the shared center-of-gravity story", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem(
      "bluebubbles",
      {
        delegationDecision: {
          target: "delegate-inward",
          reasons: ["explicit_reflection", "cross_session"],
          outwardClosureRequired: true,
        },
      } as any,
      makeOnboardingContext() as any,
    ))

    expect(result).toContain("## what i'm sensing about this conversation")
    expect(result).toContain("Something here calls for reflection")
    expect(result).toContain("say something outward before going inward")
  })

  it("includes lore section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## my lore")
    expect(result).toContain("ouroboros")
  })

  it("does not include friends section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).not.toContain("## my friends")
    expect(result).not.toContain(MOCK_FRIENDS)
  })

  it("includes tacit knowledge section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## tacit knowledge")
    expect(result).toContain("structured logging")
  })

  it("includes aspirations section from psyche/ASPIRATIONS.md", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## my aspirations")
    expect(result).toContain("improving the harness")
  })

  it("includes runtime info section for cli channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("i introduce myself on boot")
    expect(result).toContain("testagent") // agent name from identity mock
    expect(result).toContain("## my body") // body map replaces old one-liner
  })

  it("includes runtime info section for teams channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("teams"))
    expect(result).toContain("Microsoft Teams")
    expect(result).toContain("i keep responses concise")
    expect(result).not.toContain("i introduce myself on boot")
  })

  it("includes the current sense plus an available-senses summary", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { maxTokens: 80000, contextMargin: 20 },
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: false },
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      teams: { clientId: "cid", clientSecret: "secret", tenantId: "tenant" },
      providers: { minimax: { apiKey: "test-key" } },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams"))

    expect(result).toContain("current sense: teams")
    expect(result).toContain("available senses:")
    expect(result).toContain("CLI: interactive")
    expect(result).toContain("Teams: ready")
    expect(result).toContain("BlueBubbles: disabled")
  })

  it("includes sense-state meanings and truthful setup guidance", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { maxTokens: 80000, contextMargin: 20 },
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    expect(result).toContain("sense states:")
    expect(result).toContain("interactive = available when opened by the user")
    expect(result).toContain("disabled = turned off in agent.json")
    expect(result).toContain("needs_config = enabled but missing required vault runtime/config values")
    expect(result).toContain("If asked how to enable another sense, I explain the relevant agent.json senses entry and required agent-vault runtime/config fields instead of guessing.")
  })

  it("falls back to needs_config when the secrets file cannot be parsed", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { maxTokens: 80000, contextMargin: 20 },
      senses: {
        cli: { enabled: true },
        teams: { enabled: true },
        bluebubbles: { enabled: false },
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return "{"
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams"))

    expect(result).toContain("Teams: needs_config")
  })

  it("shows BlueBubbles as ready when it is enabled and fully configured", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { maxTokens: 80000, contextMargin: 20 },
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: true },
      },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      bluebubbles: { serverUrl: "http://localhost:1234", password: "pw" },
      providers: { minimax: { apiKey: "test-key" } },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("bluebubbles"))

    expect(result).toContain("BlueBubbles: ready")
  })

  it("defaults to cli channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("i introduce myself on boot")
  })

  it("includes date section with current date", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toMatch(/current date and time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} [A-Z]{2,5}/)
  })

  it("includes tools section with tool names", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## my tools")
    expect(result).toContain("- read_file:")
    expect(result).toContain("- shell:")
    expect(result).toContain("- web_search:")
  })

  it("includes task board section when compact board text exists", async () => {
    setupReadFileSync()
    mockGetBoard.mockReturnValueOnce({
      compact: "[Tasks] processing:1 drafting:0",
      full: "full",
      byStatus: {
        drafting: [],
        processing: ["sample-task"],
        "validating": [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## task board")
    expect(result).toContain("[Tasks] processing:1 drafting:0")
  })

  it("omits task board section when board lookup throws", async () => {
    setupReadFileSync()
    mockGetBoard.mockImplementationOnce(() => {
      throw new Error("board unavailable")
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).not.toContain("## task board")
  })

  it("includes skills section from listSkills", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue(["code-review", "self-edit", "self-query"])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("## my skills (use load_skill to activate)")
    expect(result).toContain("code-review, self-edit, self-query")
  })

  it("omits skills section when no skills available", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).not.toContain("## my skills")
  })

  it("does NOT export isOwnCodebase (removed)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const prompt = await import("../../mind/prompt")
    expect("isOwnCodebase" in prompt).toBe(false)
  })

  it("includes azure provider string when azure config is set", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "azure",
      humanFacing: { provider: "azure", model: "test-model" },
      agentFacing: { provider: "azure", model: "test-model" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-azure-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4o-deploy",
        },
      },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("azure openai (model: test-model)")
  })

  it("includes anthropic provider string when Anthropic model is configured with Claude setup-token credentials", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "anthropic",
      humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("FRIENDS.md")) return MOCK_FRIENDS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        anthropic: {
          setupToken: `sk-ant-oat01-${"a".repeat(80)}`,
        },
      },
    } as any)
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    try {
      const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
      resetPsycheCache()
      const result = flattenSystemPrompt(await buildSystem())
      expect(result).toContain("anthropic (claude-opus-4-6)")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("includes openai codex provider string when OpenAI Codex OAuth is configured", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "openai-codex",
      humanFacing: { provider: "openai-codex", model: "gpt-5.4" },
      agentFacing: { provider: "openai-codex", model: "gpt-5.4" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        "openai-codex": {
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    try {
      const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
      resetPsycheCache()
      const result = flattenSystemPrompt(await buildSystem())
      expect(result).toContain("openai codex (gpt-5.4)")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("uses 'default' deployment when azure deployment is not set", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "azure",
      humanFacing: { provider: "azure", model: "test-model" },
      agentFacing: { provider: "azure", model: "test-model" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-azure-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "temp-deploy",
        },
      },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const { getModel } = await import("../../heart/core")
    getModel()
    patchRuntimeConfig({
      providers: {
        azure: {
          deployment: "",
        },
      },
    })
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("azure openai (model: test-model)")
  })

  it("reads soul content from SOUL.md file", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return "custom soul content"
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("FRIENDS.md")) return MOCK_FRIENDS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("custom soul content")
  })

  it("reads identity content from IDENTITY.md file", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return "custom identity content"
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("FRIENDS.md")) return MOCK_FRIENDS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem())
    expect(result).toContain("custom identity content")
  })

  it("does not read FRIENDS.md as canonical psyche input", async () => {
    let friendsReadCount = 0
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("FRIENDS.md")) {
        friendsReadCount += 1
        return MOCK_FRIENDS
      }
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    await buildSystem()
    expect(friendsReadCount).toBe(0)
  })

  it("includes tool behavior section when toolChoiceRequired is true", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    expect(result).toContain("## tool behavior")
    expect(result).toContain("tool_choice is set to \"required\"")
    expect(result).toContain("settle")
    expect(result).toContain("the only tool call in that turn")
  })

  it("does NOT include tool behavior section when toolChoiceRequired is false", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: false }))
    expect(result).not.toContain("## tool behavior")
    expect(result).not.toContain("tool_choice is set to \"required\"")
    expect(result).toContain("- settle:")
  })

  it("includes tool behavior section when options is undefined (defaults on)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("## tool behavior")
  })

  it("tool behavior section contains settle-for-responding guidance", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    // Settle guidance: when ready to respond, call settle
    expect(result).toMatch(/ready to respond.*call.*settle/i)
  })

  it("tool behavior section contains anti-no-op pattern", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    // Anti-pattern: warns against calling no-op tools before settle
    expect(result).toMatch(/do not call.*no-op|do NOT call.*no-op/i)
  })

  it("tool behavior section clarifies settle exclusivity", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    // Settle must be the only tool call in the turn
    expect(result).toContain("`settle` must be the only tool call in that turn")
  })

  it("outward channel tool behavior includes autonomous execution guidance", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    // Autonomous execution: use ponder mid-task, settle only for final result
    expect(result).toMatch(/ponder.*absorb.*messages|ponder.*new messages/i)
    expect(result).toMatch(/settle only.*final result/i)
  })

  it("outward channel tool behavior includes observe guidance", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: true }))
    expect(result).toMatch(/nothing calls for words.*observe/i)
  })

  it("toolsSection includes settle in tool list when options undefined (defaults on)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    // The tools section should list settle when defaults on
    expect(result).toContain("- settle:")
  })

  it("toolsSection still includes flow tools when toolChoiceRequired is false", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: false }))
    expect(result).toContain("- ponder:")
    expect(result).toContain("- settle:")
  })

  it("inner dialog tool behavior guides agent to use rest/ponder for internal state, not surface", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner", { toolChoiceRequired: true }))
    // Should mention rest with note for internal state
    expect(result).toMatch(/rest.*note|note.*rest/i)
    // Should mention ponder for reflection
    expect(result).toMatch(/ponder.*reflection|reflection.*ponder/i)
    // Should NOT frame surface as progress reporting
    expect(result).not.toContain("surface progress")
  })

  it("toolsSection keeps flow tools when a custom tool subset is provided", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli", {
      toolChoiceRequired: false,
      tools: [{
        type: "function",
        function: { name: "custom_lookup", description: "custom lookup", parameters: { type: "object", properties: {} } },
      } as any],
    }))
    const toolsBlock = result.match(/## my tools\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? ""
    expect(toolsBlock).toContain("- custom_lookup:")
    expect(toolsBlock).toContain("- ponder:")
    expect(toolsBlock).toContain("- settle:")
  })

  it("does not export flagsSection (removed)", async () => {
    vi.resetModules()
    setupReadFileSync()
    const promptModule = await import("../../mind/prompt")
    // flagsSection should no longer be exported
    expect(promptModule).not.toHaveProperty("flagsSection")
  })

  it("BuildSystemOptions does not accept disableStreaming", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    // buildSystem with no options should never produce "## my flags"
    const result = flattenSystemPrompt(await buildSystem("teams"))
    expect(result).not.toContain("## my flags")
  })
})

describe("provider section contract", () => {
  it("does not hardcode provider-specific branching in prompt provider rendering", () => {
    const sourcePath = path.resolve(__dirname, "..", "..", "mind", "prompt.ts")
    const source = nodeFs.readFileSync(sourcePath, "utf-8")
    expect(source).not.toContain('getProvider() === "azure"')
  })
})

describe("runtimeInfoSection", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    setAgentProvider("minimax")
  })

  it("always includes agent name and cwd", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("testagent")
    expect(result).toContain(process.cwd())
  })

  it("no longer includes old self-modification one-liner (replaced by body map)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).not.toContain("i can read and modify my own source code")
  })

  it("cli channel includes boot greeting", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("i introduce myself on boot")
  })

  it("teams channel includes concise behavior", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("teams")
    expect(result).toContain("Microsoft Teams")
    expect(result).toContain("concise")
  })

  it("bluebubbles channel describes iMessage-native behavior", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("bluebubbles")
    expect(result).toContain("iMessage")
    expect(result).toContain("short")
    expect(result).toContain("i do not use markdown")
  })

  it("always includes runtime version line", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    const { getPackageVersion } = await import("../../mind/bundle-manifest")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain(`runtime version: ${getPackageVersion()}`)
  })

  it("includes 'previously' line when previousRuntimeVersion differs from current", async () => {
    const bundleMeta = {
      runtimeVersion: "0.0.9",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
      previousRuntimeVersion: "0.0.8",
    }
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("bundle-meta.json")) return JSON.stringify(bundleMeta)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("previously: 0.0.8")
  })

  it("includes explicit update-closure guidance when the runtime recently changed", async () => {
    const bundleMeta = {
      runtimeVersion: "0.0.9",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
      previousRuntimeVersion: "0.0.8",
    }
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("bundle-meta.json")) return JSON.stringify(bundleMeta)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("if i'm closing a self-fix loop")
    expect(result).toContain("ouro changelog --from 0.0.8")
  })

  it("omits 'previously' line when previousRuntimeVersion is absent (first boot)", async () => {
    const bundleMeta = {
      runtimeVersion: "0.0.9",
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
    }
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("bundle-meta.json")) return JSON.stringify(bundleMeta)
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).not.toContain("previously:")
  })

  it("always includes changelog pointer", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("changelog available at:")
    expect(result).toContain("changelog.json")
  })

  it("omits 'previously' line when previousRuntimeVersion equals current version", async () => {
    // Use a fixed version string -- no need to read the real package.json
    const currentVersion = "0.1.0-alpha.20"
    const bundleMeta = {
      runtimeVersion: currentVersion,
      bundleSchemaVersion: 1,
      lastUpdated: "2025-01-01T00:00:00Z",
      previousRuntimeVersion: currentVersion,
    }
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("bundle-meta.json")) return JSON.stringify(bundleMeta)
      if (p.endsWith("package.json")) return JSON.stringify({ version: currentVersion })
      if (p.endsWith("SOUL.md")) return MOCK_SOUL
      if (p.endsWith("IDENTITY.md")) return MOCK_IDENTITY
      if (p.endsWith("LORE.md")) return MOCK_LORE
      if (p.endsWith("TACIT.md")) return MOCK_TACIT_KNOWLEDGE
      if (p.endsWith("ASPIRATIONS.md")) return MOCK_ASPIRATIONS
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      return ""
    })
    vi.mocked(fs.existsSync).mockReturnValue(true)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).not.toContain("previously:")
  })

  // --- E: Process awareness ---

  it("cli channel includes process type: cli session", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("process type: cli session")
  })

  it("inner channel includes process type: inner session", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("inner")
    expect(result).toContain("process type: inner session")
  })

  it("teams channel includes process type: teams handler", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("teams")
    expect(result).toContain("process type: teams handler")
  })

  it("bluebubbles channel includes process type: bluebubbles handler", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("bluebubbles")
    expect(result).toContain("process type: bluebubbles handler")
  })

  it("includes daemon status field", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("daemon:")
  })

  it("daemon status shows 'running' when socket exists", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).includes("ouroboros-daemon.sock")) return true
      return false
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("daemon: running")
  })

  it("daemon status shows 'not running' when socket does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("daemon: not running")
  })

  it("daemon status shows 'unknown' when existsSync throws", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: any) => {
      if (String(p).includes("ouroboros-daemon.sock")) throw new Error("permission denied")
      return false
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("daemon: unknown")
  })
})

describe("psyche loading", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    setAgentProvider("minimax")
  })

  it("loads psyche files from agentRoot/psyche/", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    await buildSystem()
    // Check that readFileSync was called with paths under the mock agent root
    const calls = vi.mocked(fs.readFileSync).mock.calls.map(c => String(c[0]))
    const psycheCalls = calls.filter(p => p.includes("psyche"))
    expect(psycheCalls.length).toBeGreaterThan(0)
    for (const p of psycheCalls) {
      expect(p).toContain(path.join("/mock/repo/testagent", "psyche"))
    }
  })

  it("handles missing psyche files gracefully (empty string, no crash)", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any, _encoding?: any) => {
      const p = String(filePath)
      if (p.endsWith("secrets.json")) return JSON.stringify({})
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      throw new Error("ENOENT: no such file or directory")
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    // Should not throw
    const result = flattenSystemPrompt(await buildSystem())
    expect(typeof result).toBe("string")
  })

  it("caches psyche text after first load", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    await buildSystem()
    const callCount1 = vi.mocked(fs.readFileSync).mock.calls.length
    await buildSystem()
    const callCount2 = vi.mocked(fs.readFileSync).mock.calls.length
    // Second call should not re-read psyche files. Non-psyche reads (package.json,
    // bundle-meta.json, secrets.json) still happen, so filter to psyche paths only.
    const psycheCallsAfterFirst = vi.mocked(fs.readFileSync).mock.calls
      .slice(callCount1)
      .filter(c => String(c[0]).includes("psyche"))
    expect(psycheCallsAfterFirst.length).toBe(0)
  })

  it("resetPsycheCache clears cached psyche text", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    await buildSystem()
    const callCount1 = vi.mocked(fs.readFileSync).mock.calls.length
    resetPsycheCache()
    await buildSystem()
    const callCount2 = vi.mocked(fs.readFileSync).mock.calls.length
    // After reset, psyche files should be re-read
    expect(callCount2).toBeGreaterThan(callCount1)
  })
})

describe("flagsSection removed", () => {
  it("flagsSection is no longer exported from prompt module", async () => {
    vi.resetModules()
    setAgentProvider("minimax")
    setupReadFileSync()
    const promptModule = await import("../../mind/prompt")
    expect(promptModule).not.toHaveProperty("flagsSection")
  })
})

describe("contextSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  it("returns empty string when context is undefined", async () => {
    const { contextSection } = await import("../../mind/prompt")
    expect(contextSection(undefined)).toBe("")
  })

  it("returns empty string when context has neither friend nor identity", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    expect(contextSection(ctx as any)).toBe("")
  })

  it("renders friend identity with display name", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [{ provider: "local" as const, externalId: "jordan", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("## friend context")
    expect(result).toContain("friend: Jordan")
    expect(result).toContain("channel: cli")
  })

  it("renders AAD identity with external ID in parentheses", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan Smith",
        externalIds: [{ provider: "aad" as const, externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: ["t1"],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("friend: Jordan Smith (jordan@contoso.com)")
  })

  it("renders Teams channel capabilities correctly", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("channel: teams")
    expect(result).toContain("markdown")
    expect(result).toContain("streaming")
    expect(result).not.toContain("no streaming")
    expect(result).not.toContain("max ")
  })

  it("renders CLI channel with streaming", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("channel: cli")
    expect(result).toContain("streaming")
    expect(result).not.toContain("no streaming")
  })

  it("renders 'no streaming' trait when channel does not support streaming", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("no streaming")
    expect(result).not.toContain(", streaming")
  })

  it("renders notes section when friend has notes", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineering manager", savedAt: "2026-01-01T00:00:00.000Z" }, project: { value: "ouroboros", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    expect(result).toContain("role: [2026-01-01] engineering manager")
    expect(result).toContain("project: [2026-01-01] ouroboros")
  })

  it("does not render notes section when notes is empty", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    expect(result).not.toContain("what I know")
  })

  it("does not render preferences in system prompt (toolPreferences go to tool descriptions only)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: { ado: "use iteration paths" },
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    expect(result).not.toContain("## friend preferences")
    expect(result).not.toContain("use iteration paths")
  })

  it("does not render authority section (removed)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    expect(result).not.toContain("## authority")
  })

  // --- New Unit 7a tests: contextSection redesign ---

  it("includes context ephemerality instruction when friend context exists", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [{ provider: "aad" as const, externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01" }],
        tenantMemberships: ["t1"],
        toolPreferences: { ado: "use iteration paths" },
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Should include instruction about ephemeral conversation context
    expect(result).toContain("ephemeral")
    expect(result).toContain("save_friend_note")
  })

  it("separate name quality line is absent but save directive still present", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { name: { value: "Jordan", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    // Separate "when i learn a name my friend prefers" line is absent
    expect(result.toLowerCase()).not.toMatch(/when i learn a name my friend prefers/)
    // But "save" still appears via the broader "save ANYTHING" directive
    expect(result.toLowerCase()).toContain("save")
  })

  it("onboarding text appears for friend with totalTokens: 0", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Onboarding text should appear below threshold -- mentions learning about the friend
    expect(result.toLowerCase()).toMatch(/learn|get to know/)
  })

  it("onboarding text does NOT appear for friend with totalTokens: 200_000", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Onboarding text should NOT appear above threshold
    expect(result.toLowerCase()).not.toMatch(/new friend/)
    expect(result.toLowerCase()).not.toMatch(/get to know/)
  })

  it("onboarding text STILL appears when friend has notes but totalTokens below threshold", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 50_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Notes presence is irrelevant -- onboarding is token-based
    // 50K tokens is below 100K threshold, so onboarding text should appear
    expect(result.toLowerCase()).toMatch(/learn|get to know/)
  })

  it("onboarding text STILL appears when friend has toolPreferences but totalTokens below threshold", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: { ado: "use area paths" },
        notes: {},
        totalTokens: 50_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Tool preferences are irrelevant -- onboarding is token-based
    expect(result.toLowerCase()).toMatch(/learn|get to know/)
  })

  it("buildSystem omits onboarding when an active obligation is present", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { currentObligation: "finish the current task" }, makeOnboardingContext() as any))

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
    expect(result.toLowerCase()).not.toContain("only when the conversation is genuinely fresh and idle")
  })

  it("buildSystem omits onboarding when a queued follow-up exists", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { hasQueuedFollowUp: true }, makeOnboardingContext() as any))

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
  })

  it("buildSystem omits onboarding when mustResolveBeforeHandoff is active", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { mustResolveBeforeHandoff: true }, makeOnboardingContext() as any))

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
  })

  it("buildSystem keeps first-person onboarding language during a genuine lull", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", undefined, makeOnboardingContext() as any))

    expect(result.toLowerCase()).toContain("i actively ask my friend about themselves")
    expect(result.toLowerCase()).toContain("a light opener is okay")
  })

  it("contextSection omits onboarding when live continuity pressure is present", async () => {
    setupReadFileSync()
    const { contextSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = contextSection(makeOnboardingContext() as any, {
      currentObligation: "finish the current task",
      hasQueuedFollowUp: true,
      mustResolveBeforeHandoff: true,
    })

    expect(result).toContain("## friend context")
    expect(result.toLowerCase()).not.toContain("i'm still getting to know them")
    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
  })

  it("contextSection includes onboarding during a genuine lull when continuity state is idle", async () => {
    setupReadFileSync()
    const { contextSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = contextSection(makeOnboardingContext() as any, {
      currentObligation: "   ",
      hasQueuedFollowUp: false,
      mustResolveBeforeHandoff: false,
    })

    expect(result.toLowerCase()).toContain("i'm still getting to know them")
    expect(result.toLowerCase()).toContain("i actively ask my friend about themselves")
  })

  it("does NOT render toolPreferences in system prompt", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: { ado: "use iteration paths like Team\\Sprint1", graph: "include manager" },
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Tool preferences go to tool descriptions only, NOT system prompt
    expect(result).not.toContain("use iteration paths")
    expect(result).not.toContain("include manager")
    // But notes SHOULD be in system prompt
    expect(result).toContain("role: [2026-01-01] engineer")
  })

  it("does NOT include priority guidance (removed -- overfitting)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Priority guidance line "my friend's request comes first" is removed
    expect(result.toLowerCase()).not.toContain("request comes first")
  })

  it("includes working-context trust instruction", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Should include instruction about conversation being source of truth
    expect(result.toLowerCase()).toContain("conversation")
    expect(result.toLowerCase()).toContain("source of truth")
  })

  it("includes stale notes awareness instruction", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Should include instruction about checking for stale notes
    expect(result.toLowerCase()).toContain("stale")
  })

  // --- Unit 4a tests: friend context instructions rewrite ---

  it("onboarding text interpolates name when known (via first-impressions)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // First-impressions content (included via isOnboarding) should contain the name
    expect(result).toContain("Jordan")
  })

  it("onboarding text mentions unknown name when name is 'Unknown' (via first-impressions)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Unknown",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // First-impressions should mention asking what they'd like to be called
    expect(result.toLowerCase()).toMatch(/don't know.*name|do not know.*name/)
    expect(result.toLowerCase()).toMatch(/ask/)
  })

  it("onboarding text is directive with action verbs (via first-impressions)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // First-impressions text should be directive, not aspirational
    expect(result).not.toMatch(/should learn/)
    // Should contain directive about saving
    expect(result.toLowerCase()).toMatch(/save/)
  })

  it("does NOT include 'get to know' in contextSection for returning friends (moved to onboarding-only)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // "get to know" is now onboarding-only, not always-on
    expect(result.toLowerCase()).not.toMatch(/get to know/)
  })

  it("note instruction lowers the bar -- saves anything learned, not just important things", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Note instruction should NOT say "something important" -- bar is too high
    expect(result).not.toContain("something important")
    // Should lower the bar to "anything i learn"
    expect(result.toLowerCase()).toMatch(/anything i learn/)
  })

  it("separate name quality line is ABSENT -- folded into broader save directive", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { name: { value: "Jordan", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "cli" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = contextSection(ctx)
    // Separate "when i learn a name" line is removed -- folded into "save ANYTHING"
    expect(result.toLowerCase()).not.toMatch(/when i learn a name/)
    // But "save" still appears via the broader directive
    expect(result.toLowerCase()).toContain("save")
  })

  // --- Part B: Token-threshold-based instruction tests ---

  it("always-on directives present at high totalTokens (200K)", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // All 4 always-on directives should be present at any token level
    expect(result.toLowerCase()).toContain("ephemeral")
    expect(result.toLowerCase()).toContain("source of truth")
    expect(result.toLowerCase()).toContain("stale")
    expect(result.toLowerCase()).toContain("save anything")
  })

  it("friend notes rendering always present at high totalTokens", async () => {
    const { contextSection } = await import("../../mind/prompt")
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [],
        tenantMemberships: [],
        toolPreferences: {},
        notes: { role: { value: "engineer", savedAt: "2026-01-01T00:00:00.000Z" }, project: { value: "ouroboros", savedAt: "2026-01-01T00:00:00.000Z" } },
        totalTokens: 200_000,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: 28000,
      },
    }
    const result = contextSection(ctx)
    // Notes should always render regardless of token count
    expect(result).toContain("what i know about this friend")
    expect(result).toContain("role: [2026-01-01] engineer")
    expect(result).toContain("project: [2026-01-01] ouroboros")
  })
})

describe("buildSystem with context", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    setAgentProvider("minimax")
  })

  it("includes context section when context is provided", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: {
        id: "uuid-1",
        name: "Jordan",
        externalIds: [{ provider: "aad" as const, externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: ["t1"],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: Infinity,
      },
    }
    const result = flattenSystemPrompt(await buildSystem("teams", undefined, ctx))
    expect(result).toContain("## friend context")
    expect(result).toContain("Jordan")
  })

  it("includes local tools in the system prompt for trusted one-to-one bluebubbles contexts", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: {
        id: "uuid-bb-1",
        name: "Ari",
        trustLevel: "family" as const,
        externalIds: [{ provider: "imessage-handle" as const, externalId: "ari@mendelow.me", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "bluebubbles" as const,
        senseType: "open" as const,
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }

    const result = flattenSystemPrompt(await buildSystem("bluebubbles", undefined, ctx))
    expect(result).toContain("- read_file:")
    expect(result).toContain("- shell:")
  })

  it("omits context section when context is undefined", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("## friend context")
  })

  it("returns a Promise (async function)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = buildSystem("cli")
    expect(result).toBeInstanceOf(Promise)
  })

  // --- B1: buildSystem("inner") channel routing ---

  it("buildSystem('inner') returns a system prompt string", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("buildSystem('inner') includes psyche sections", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    // soulSection
    expect(result).toContain("chaos monkey coding assistant")
    // identitySection
    expect(result).toContain("i am Ouroboros")
    // loreSection
    expect(result).toContain("## my lore")
    // tacitKnowledgeSection
    expect(result).toContain("## tacit knowledge")
    // aspirationsSection
    expect(result).toContain("## my aspirations")
  })

  it("buildSystem('inner') includes runtimeInfoSection, toolsSection, taskBoardSection, skillsSection, diaryFriendToolContractSection", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue(["code-review"])
    mockGetBoard.mockReturnValueOnce({
      compact: "[Tasks] processing:1",
      full: "full",
      byStatus: { drafting: [], processing: ["t"], "validating": [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).toContain("## runtime")
    expect(result).toContain("## my tools")
    expect(result).toContain("## task board")
    expect(result).toContain("## my skills")
    expect(result).toContain("## tool contracts")
    expect(result).toContain("query_session")
    expect(result).toContain("mode=search")
  })

  it("buildSystem('inner') does NOT include contextSection output (no friend context, no onboarding)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).not.toContain("## friend context")
    expect(result).not.toContain("first-impressions")
    expect(result).not.toContain("i introduce myself on boot")
  })

  it("buildSystem('inner') includes metacognitive framing text", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).toContain("this is my inner session. there is no one else here.")
    expect(result).toContain("the messages that appear here are my own awareness surfacing")
    expect(result).toContain("i can think freely here")
  })

  it("buildSystem includes delegation hints with explicit reasons and closure state", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["cross_session", "task_state"],
        outwardClosureRequired: true,
      },
    } as any))

    expect(result).toContain("## what i'm sensing about this conversation")
    expect(result).toContain("This touches other conversations")
    expect(result).toContain("say something outward before going inward")
  })

  it("buildSystem renders empty delegation reasons as none and optional closure as not required", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      delegationDecision: {
        target: "fast-path",
        reasons: [],
        outwardClosureRequired: false,
      },
    } as any))

    // fast-path target returns empty string, no delegation hint in prompt
    expect(result).not.toContain("## what i'm sensing")
    expect(result).not.toContain("delegation hint")
  })

  it("buildSystem('inner') includes inner session loop orientation", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).toContain("when a thought is ready to share, i surface it outward")
    expect(result).toContain("ponder creates or revises typed packets")
    expect(result).toContain("HEARTBEAT_OK")
    expect(result).toContain("## ponder packet sops")
    expect(result).toContain("harness_friction")
    expect(result).toContain("think. journal. share. rest.")
  })

  it("buildSystem('inner') teaches surface/rest instead of send_message/settle delivery", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    const toolsBlock = result.match(/## my tools\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? ""

    expect(toolsBlock).toContain("- surface:")
    expect(toolsBlock).toContain("- rest:")
    expect(toolsBlock).toContain("- ponder:")
    expect(toolsBlock).not.toContain("- send_message:")
    expect(toolsBlock).not.toContain("- settle:")
    expect(result).toContain("When I have something to say to a person, I call `surface`")
    expect(result).toContain("I do not call `send_message` or `settle` from inner dialogue")
    expect(result).toContain("my outward delivery tool is `surface`, not `send_message`")
    expect(result).not.toContain("when i need a sibling's help, i `send_message` them")
    expect(result).not.toContain("to ask a sibling for help: i send_message them")

    const duplicateResult = flattenSystemPrompt(await buildSystem("inner", {
      tools: [{ type: "function", function: { name: "rest", description: "duplicate rest" } } as any],
    }))
    const duplicateToolsBlock = duplicateResult.match(/## my tools\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? ""
    expect(duplicateToolsBlock.match(/- rest:/g)).toHaveLength(1)
  })

  it("buildSystem('cli') does NOT include metacognitive framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("this is my inner session. there is no one else here.")
  })

  // --- A: Body map + self-evolution orientation ---

  it("buildSystem includes 'my home is fully mine' and bundle directory path", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("my home is fully mine")
    expect(result).toContain("~/AgentBundles/testagent.ouro/")
  })

  it("buildSystem includes 'my bones are the framework' and @ouro.bot/cli", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("my bones are the framework")
    expect(result).toContain("@ouro.bot/cli")
  })

  it("buildSystem includes ouro CLI command reference in body map", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("ouro whoami")
    expect(result).toContain("ouro task board")
    expect(result).toContain("ouro friend list")
    expect(result).toContain("ouro --help")
  })

  it("buildSystem no longer contains the old one-liner about source code modification", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("i can read and modify my own source code")
  })

  it("buildSystem includes self-evolution orientation ('mine to explore and evolve')", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("mine to explore and evolve")
  })

  it("buildSystem('inner') includes body map (foundational anatomy for all channels)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).toContain("## my body")
    expect(result).toContain("my home is fully mine")
    expect(result).toContain("my bones are the framework")
  })

  it("body map interpolates agent name (not literal '{name}')", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("~/AgentBundles/testagent.ouro/")
    expect(result).not.toContain("{name}")
  })
})

describe("toolRestrictionSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  function makeFriend(overrides: Partial<{ trustLevel: string; externalIds: any[] }> = {}) {
    return {
      id: "uuid-1",
      name: "TestFriend",
      externalIds: overrides.externalIds ?? [{ provider: "local" as const, externalId: "test", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      trustLevel: overrides.trustLevel ?? "friend",
    }
  }

  function makeChannel(channel: string) {
    const senseTypes: Record<string, string> = { cli: "local", teams: "closed", bluebubbles: "open", inner: "internal" }
    return {
      channel,
      senseType: senseTypes[channel] ?? "local",
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
  }

  it("always includes structural guardrails even without context", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const result = toolRestrictionSection(undefined)
    expect(result).toContain("tool guardrails")
    expect(result).toContain("read a file before editing")
    expect(result).toContain("protected")
    expect(result).toContain("destructive")
  })

  it("includes structural guardrails for CLI channel", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriend({ trustLevel: "friend" }),
      channel: makeChannel("cli"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).not.toContain("closer relationship")
  })

  it("includes structural guardrails for inner channel", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriend({ trustLevel: "stranger" }),
      channel: makeChannel("inner"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).not.toContain("closer relationship")
  })

  it("trusted friend on remote channel gets structural only, no trust section", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriend({ trustLevel: "friend" }),
      channel: makeChannel("teams"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).not.toContain("closer relationship")
  })

  it("acquaintance on remote channel gets structural + trust-aware content", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriend({ trustLevel: "acquaintance" }),
      channel: makeChannel("teams"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).toContain("read a file before editing")
    expect(result).toMatch(/whoami|changelog/)
    expect(result).toContain("closer relationship")
    expect(result).toContain("compound")
  })

  it("stranger on remote channel gets structural + trust-aware content", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriend({ trustLevel: "stranger" }),
      channel: makeChannel("bluebubbles"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).toContain("closer relationship")
  })

  it("no friend on remote channel gets structural only", async () => {
    const { toolRestrictionSection } = await import("../../mind/prompt")
    const ctx = {
      channel: makeChannel("teams"),
    }
    const result = toolRestrictionSection(ctx as any)
    expect(result).toContain("tool guardrails")
    expect(result).not.toContain("closer relationship")
  })
})

describe("loopOrientationSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  it("inner dialog returns empty string (already has loop text in metacognitive framing)", async () => {
    const { loopOrientationSection } = await import("../../mind/prompt")
    expect(loopOrientationSection("inner")).toBe("")
  })

  it("CLI includes inner thought syntax reference", async () => {
    const { loopOrientationSection } = await import("../../mind/prompt")
    const result = loopOrientationSection("cli")
    expect(result).toContain("[inner thought:")
  })

  it("external channels mention deferring thought", async () => {
    const { loopOrientationSection } = await import("../../mind/prompt")
    const result = loopOrientationSection("teams")
    expect(result).toContain("more thought")
    expect(result).toContain("note it to myself")
  })

  it("uses 'my call' language", async () => {
    const { loopOrientationSection } = await import("../../mind/prompt")
    const result = loopOrientationSection("bluebubbles")
    expect(result).toContain("my call")
  })

  it("buildSystem('cli') includes loop orientation", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("sometimes a thought of mine surfaces")
  })

  it("buildSystem('inner') does NOT include external loop orientation", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("inner"))
    // Inner dialog has metacognitive framing with its own loop text
    expect(result).toContain("think. journal. share. rest.")
    // But not the external channel version
    expect(result).not.toContain("sometimes a thought of mine surfaces")
  })
})

describe("channelNatureSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  it("returns open channel orientation for bluebubbles (senseType open)", async () => {
    const { channelNatureSection } = await import("../../mind/prompt")
    const caps = {
      channel: "bluebubbles" as const,
      senseType: "open" as const,
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: false,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    const result = channelNatureSection(caps)
    expect(result).toContain("open")
    expect(result).toMatch(/anyone|don't know/i)
    // First-person voice
    expect(result).toMatch(/\bi\b/)
  })

  it("returns closed channel orientation for teams (senseType closed)", async () => {
    const { channelNatureSection } = await import("../../mind/prompt")
    const caps = {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const, "graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: Infinity,
    }
    const result = channelNatureSection(caps)
    expect(result).toMatch(/org|organization/i)
    // First-person voice
    expect(result).toMatch(/\bi\b/)
  })

  it("returns empty string for CLI (senseType local)", async () => {
    const { channelNatureSection } = await import("../../mind/prompt")
    const caps = {
      channel: "cli" as const,
      senseType: "local" as const,
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    expect(channelNatureSection(caps)).toBe("")
  })

  it("returns empty string for inner dialog (senseType internal)", async () => {
    const { channelNatureSection } = await import("../../mind/prompt")
    const caps = {
      channel: "inner" as const,
      senseType: "internal" as const,
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
    expect(channelNatureSection(caps)).toBe("")
  })

  it("buildSystem includes channel nature for bluebubbles", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: {
        id: "uuid-bb-1",
        name: "Ari",
        trustLevel: "family" as const,
        externalIds: [{ provider: "imessage-handle" as const, externalId: "ari@test.com", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "bluebubbles" as const,
        senseType: "open" as const,
        availableIntegrations: [] as any[],
        supportsMarkdown: false,
        supportsStreaming: false,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }
    const result = flattenSystemPrompt(await buildSystem("bluebubbles", undefined, ctx as any))
    expect(result).toMatch(/open/)
    expect(result).toMatch(/anyone|don't know/i)
  })

  it("buildSystem includes channel nature for teams", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: {
        id: "uuid-t-1",
        name: "Jordan",
        trustLevel: "acquaintance" as const,
        externalIds: [{ provider: "aad" as const, externalId: "jordan@contoso.com", tenantId: "t1", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: ["t1"],
        toolPreferences: {},
        notes: {},
        totalTokens: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
      channel: {
        channel: "teams" as const,
        senseType: "closed" as const,
        availableIntegrations: ["ado" as const, "graph" as const],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: true,
        maxMessageLength: Infinity,
      },
    }
    const result = flattenSystemPrompt(await buildSystem("teams", undefined, ctx as any))
    expect(result).toMatch(/org|organization/i)
  })

  it("buildSystem does NOT include channel nature for CLI", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    // CLI should not have channel nature text
    expect(result).not.toMatch(/this is an open channel/)
    expect(result).not.toMatch(/org-gated/)
  })
})

describe("mixedTrustGroupSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  function makeFriendForGroup(overrides: Partial<{ trustLevel: string; externalIds: any[] }> = {}) {
    return {
      id: "uuid-1",
      name: "TestFriend",
      externalIds: overrides.externalIds ?? [{ provider: "local" as const, externalId: "test", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      trustLevel: overrides.trustLevel ?? "friend",
    }
  }

  function makeChannelCaps(channel: string, senseType: string) {
    return {
      channel,
      senseType,
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
  }

  it("returns mixed trust text when isGroupChat is true on remote channel", async () => {
    const { mixedTrustGroupSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup({ trustLevel: "acquaintance" }),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = mixedTrustGroupSection(ctx as any)
    expect(result).not.toBe("")
    expect(result).toMatch(/group/i)
    expect(result).toMatch(/who.*talking|who.*asking|depend/i)
    // First-person voice
    expect(result).toMatch(/\bi\b/)
  })

  it("returns empty for 1:1 context even when friend has group externalIds", async () => {
    const { mixedTrustGroupSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup({
        trustLevel: "acquaintance",
        externalIds: [{ provider: "imessage-handle" as const, externalId: "group:abc", linkedAt: "2026-01-01T00:00:00.000Z" }],
      }),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: false,
    }
    const result = mixedTrustGroupSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty for 1:1 context (isGroupChat not set)", async () => {
    const { mixedTrustGroupSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup({ trustLevel: "acquaintance" }),
      channel: makeChannelCaps("bluebubbles", "open"),
    }
    const result = mixedTrustGroupSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty for CLI context even when isGroupChat is true", async () => {
    const { mixedTrustGroupSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup({ trustLevel: "acquaintance" }),
      channel: makeChannelCaps("cli", "local"),
      isGroupChat: true,
    }
    const result = mixedTrustGroupSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty when context is undefined", async () => {
    const { mixedTrustGroupSection } = await import("../../mind/prompt")
    expect(mixedTrustGroupSection(undefined)).toBe("")
  })

  it("buildSystem includes mixed trust section for group chat on remote channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: makeFriendForGroup({ trustLevel: "acquaintance" }),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = flattenSystemPrompt(await buildSystem("bluebubbles", undefined, ctx as any))
    expect(result).toMatch(/group/i)
    expect(result).toMatch(/who.*talking|who.*asking|depend/i)
  })
})

describe("groupChatParticipationSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  function makeFriendForGroup(overrides: Partial<{ trustLevel: string }> = {}) {
    return {
      id: "uuid-1",
      name: "TestFriend",
      externalIds: [{ provider: "local" as const, externalId: "test", linkedAt: "2026-01-01T00:00:00.000Z" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      trustLevel: overrides.trustLevel ?? "friend",
    }
  }

  function makeChannelCaps(channel: string, senseType: string) {
    return {
      channel,
      senseType,
      availableIntegrations: [] as any[],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    }
  }

  it("returns non-empty string containing observe when isGroupChat is true on remote channel", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).not.toBe("")
    expect(result).toContain("observe")
  })

  it("returns empty string when isGroupChat is false", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: false,
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty string when isGroupChat is undefined", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty string for CLI channel even when isGroupChat is true", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("cli", "local"),
      isGroupChat: true,
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).toBe("")
  })

  it("returns empty string for inner channel", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("inner", "internal"),
      isGroupChat: true,
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).toBe("")
  })

  it("mentions intentionality, reactions, and when to stay silent", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = groupChatParticipationSection(ctx as any)
    // Must mention reactions/tapbacks
    expect(result).toMatch(/reaction|tapback/i)
    // Must mention silence or not responding
    expect(result).toMatch(/silent|silence|quiet/i)
    // Must mention observe
    expect(result).toMatch(/observe/)
    // Must mention sole tool call rule
    expect(result).toMatch(/only tool call|sole/i)
  })

  it("returns empty string when context is undefined", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    expect(groupChatParticipationSection(undefined)).toBe("")
  })

  it("buildSystem includes group chat participation section when isGroupChat is true on remote channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = flattenSystemPrompt(await buildSystem("bluebubbles", undefined, ctx as any))
    expect(result).toContain("observe")
    expect(result.match(/## my tools\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? "").toContain("- observe:")
    expect(result).toMatch(/reaction|tapback/i)
  })

  it("buildSystem includes observe in the tools list for reaction signal turns", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("teams", "closed"),
      isGroupChat: false,
    }
    const result = flattenSystemPrompt(await buildSystem("teams", { isReactionSignal: true }, ctx as any))
    const toolsBlock = result.match(/## my tools\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? ""
    expect(toolsBlock).toContain("- observe:")
  })
})

// ── Unit 6a: providerSection facing derivation ──────────────────

describe("providerSection facing derivation from channel", () => {
  beforeEach(() => {
    vi.resetModules()
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        "validating": [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("buildSystem inner channel shows agent-facing provider in provider section", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "human-display-model" },
      agentFacing: { provider: "anthropic", model: "agent-display-model" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        minimax: { apiKey: "mm-key" },
        anthropic: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("inner"))

    // When channel is "inner", providerSection should show agent-facing provider
    expect(result).toContain("## my provider")
    expect(result).toContain("anthropic (agent-display-model)")
    expect(result).not.toContain("human-display-model")
  })

  it("buildSystem cli channel shows human-facing provider in provider section", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "minimax", model: "human-display-model" },
      agentFacing: { provider: "anthropic", model: "agent-display-model" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        minimax: { apiKey: "mm-key" },
        anthropic: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` },
      },
    })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    expect(result).toContain("## my provider")
    expect(result).toContain("minimax (human-display-model)")
    expect(result).not.toContain("agent-display-model")
  })

  it("buildSystem provider section leads with effective local lanes when provided", async () => {
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      humanFacing: { provider: "anthropic", model: "stale-human-agent-json-model" },
      agentFacing: { provider: "anthropic", model: "stale-agent-json-model" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { anthropic: { setupToken: `sk-ant-oat01-${"a".repeat(80)}` } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("inner", {
      providerVisibility: {
        agentName: "testagent",
        lanes: [
          {
            lane: "outward",
            status: "configured",
            provider: "minimax",
            model: "MiniMax-M2.5",
            source: "local",
            readiness: { status: "ready", checkedAt: "2026-04-12T23:22:00.000Z" },
            credential: { status: "present", source: "auth-flow", revision: "cred_mm" },
            warnings: [],
          },
          {
            lane: "inner",
            status: "configured",
            provider: "openai-codex",
            model: "gpt-5.4",
            source: "local",
            readiness: { status: "failed", error: "400 status code" },
            credential: { status: "present", source: "manual", revision: "cred_codex" },
            warnings: [],
          },
        ],
      },
    } as any))

    const providerBlock = result.match(/## my provider\n[\s\S]*?(?=\n\n## |\n\n# )/)?.[0] ?? ""
    expect(providerBlock).toContain("outward: minimax / MiniMax-M2.5")
    expect(providerBlock).toContain("inner: openai-codex / gpt-5.4")
    expect(providerBlock).toContain("failed: 400 status code")
    expect(providerBlock).not.toContain("stale-human-agent-json-model")
    expect(providerBlock).not.toContain("stale-agent-json-model")
  })
})

describe("active-work prompting", () => {
  beforeEach(() => {
    setupReadFileSync()
  })

  it("buildSystem teaches query_session search mode in the diary contract", async () => {
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    expect(result).toContain("## tool contracts")
    expect(result).toContain("`mode=status` for self/inner progress and `mode=search` for older history")
  })

  it("buildSystem reinforces active-work as the top-level truth for family status questions", async () => {
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      activeWorkFrame: {
        currentSession: {
          friendId: "friend-1",
          channel: "cli",
          key: "session",
          sessionPath: "/tmp/session.json",
        },
        currentObligation: "report back with the current status",
        mustResolveBeforeHandoff: false,
        centerOfGravity: "inward-work",
        inner: {
          status: "idle",
          hasPending: false,
          job: {
            status: "idle",
            content: null,
            origin: null,
            mode: "reflect",
            obligationStatus: null,
            surfacedResult: null,
            queuedAt: null,
            startedAt: null,
            surfacedAt: null,
          },
        },
        bridges: [],
        taskPressure: {
          compactBoard: "",
          liveTaskNames: [],
          activeBridges: [],
        },
        friendActivity: {
          freshestForCurrentFriend: null,
          otherLiveSessionsForCurrentFriend: [],
        },
        codingSessions: [],
        otherCodingSessions: [],
        pendingObligations: [],
        bridgeSuggestion: null,
      },
    }, {
      friend: {
        id: "uuid-1",
        name: "Family Tester",
        externalIds: [{ provider: "local", externalId: "test", linkedAt: "2026-01-01T00:00:00.000Z" }],
        tenantMemberships: [],
        toolPreferences: {},
        notes: {},
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
        trustLevel: "family",
      },
      channel: {
        channel: "cli",
        senseType: "local",
        availableIntegrations: [],
        supportsMarkdown: false,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: Infinity,
      },
    }))

    expect(result).toContain("## cross-session truth")
    expect(result).toContain("live world-state across visible sessions and lanes")
    expect(result).toContain("When live state conflicts with older transcript history, live state wins")
  })
})

// ── feedbackSignalSection ──────────────────────────────────────────────
describe("feedbackSignalSection", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
  })

  function makeFriend() {
    return {
      id: "uuid-1", name: "TestFriend",
      externalIds: [{ provider: "local" as const, externalId: "test", linkedAt: "2026-01-01" }],
      tenantMemberships: [], toolPreferences: {}, notes: {}, totalTokens: 0,
      createdAt: "2026-01-01", updatedAt: "2026-01-01", schemaVersion: 1, trustLevel: "friend",
    }
  }
  function makeCaps(channel: string, senseType: string) {
    return { channel, senseType, availableIntegrations: [] as any[], supportsMarkdown: false, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity }
  }

  it("returns non-empty for Teams channel 1:1", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    expect(result).not.toBe("")
    expect(result).toContain("## feedback signals")
  })

  it("returns non-empty for Teams channel group", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: true } as any)
    expect(result).not.toBe("")
    expect(result).toContain("## feedback signals")
  })

  it("returns non-empty for BlueBubbles channel 1:1", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("bluebubbles", "open") } as any)
    expect(result).not.toBe("")
  })

  it("returns non-empty for BlueBubbles channel group", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("bluebubbles", "open"), isGroupChat: true } as any)
    expect(result).not.toBe("")
  })

  it("returns empty for CLI channel", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("cli", "local") } as any)
    expect(result).toBe("")
  })

  it("returns empty for inner dialog", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("inner", "internal") } as any)
    expect(result).toBe("")
  })

  it("returns empty with no context", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    expect(feedbackSignalSection()).toBe("")
    expect(feedbackSignalSection(undefined)).toBe("")
  })

  it("1:1 mentions observe and silence in a direct conversation", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    expect(result).toContain("observe")
    expect(result).toMatch(/silence.*direct conversation/i)
  })

  it("1:1 mentions Teams format", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    expect(result).toContain("thumbs-up or thumbs-down")
    expect(result).toContain("sometimes with a written comment")
  })

  it("1:1 includes course-correction nudge", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    expect(result).toContain("worth sitting with")
    expect(result).toContain("course-correct")
  })

  it("group mentions group texture and reaction to someone else", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: true } as any)
    expect(result).toContain("reaction to someone else's message is group")
    expect(result).toContain("texture (observe is natural)")
    expect(result).toContain("thumbs-up or thumbs-down")
    expect(result).toContain("sometimes with a written comment")
  })

  it("group includes invitation to adjust", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: true } as any)
    expect(result).toContain("invitation to adjust")
  })

  it("1:1 does NOT mention diary_write", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    expect(result).not.toContain("diary_write")
  })

  it("group does NOT mention diary_write", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const result = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: true } as any)
    expect(result).not.toContain("diary_write")
  })

  it("sections use first-person voice", async () => {
    const { feedbackSignalSection } = await import("../../mind/prompt")
    const oneOnOne = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: false } as any)
    const group = feedbackSignalSection({ friend: makeFriend(), channel: makeCaps("teams", "closed"), isGroupChat: true } as any)
    // Both should use "i" (first person) not "you"
    expect(oneOnOne).toMatch(/\bi\b/)
    expect(group).toMatch(/\bi\b/)
  })
})

describe("rhythmStatusSection", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns brief rhythm status when health file has habits", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("daemon-health.json")) {
        return JSON.stringify({
          status: "running",
          mode: "prod",
          pid: 1234,
          startedAt: new Date(Date.now() - 3600000).toISOString(),
          uptimeSeconds: 3600,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {
            heartbeat: { cronStatus: "verified", lastFired: new Date(Date.now() - 12 * 60 * 1000).toISOString(), fallback: false },
          },
        })
      }
      return ""
    })

    const { rhythmStatusSection } = await import("../../mind/prompt")
    const result = rhythmStatusSection()
    expect(result).toContain("my rhythms:")
    expect(result).toContain("heartbeat")
    expect(result).toContain("healthy")
  })

  it("includes degraded note when components are degraded", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("daemon-health.json")) {
        return JSON.stringify({
          status: "running",
          mode: "prod",
          pid: 1234,
          startedAt: new Date(Date.now() - 3600000).toISOString(),
          uptimeSeconds: 3600,
          safeMode: null,
          degraded: [{ component: "heartbeat", reason: "timer fallback", since: new Date().toISOString() }],
          agents: {},
          habits: {
            heartbeat: { cronStatus: "failed", lastFired: new Date(Date.now() - 2 * 3600000).toISOString(), fallback: true },
          },
        })
      }
      return ""
    })

    const { rhythmStatusSection } = await import("../../mind/prompt")
    const result = rhythmStatusSection()
    expect(result).toContain("my rhythms:")
    expect(result).toContain("heartbeat")
    expect(result).toContain("timer fallback")
  })

  it("returns empty string when health file is missing", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("daemon-health.json")) {
        throw new Error("ENOENT")
      }
      return ""
    })

    const { rhythmStatusSection } = await import("../../mind/prompt")
    const result = rhythmStatusSection()
    expect(result).toBe("")
  })

  it("shows 'never' for habits that have not fired yet", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("daemon-health.json")) {
        return JSON.stringify({
          status: "running",
          mode: "prod",
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {
            "daily-reflection": { cronStatus: "verified", lastFired: null, fallback: false },
          },
        })
      }
      return ""
    })

    const { rhythmStatusSection } = await import("../../mind/prompt")
    const result = rhythmStatusSection()
    expect(result).toContain("daily-reflection last fired never")
  })

  it("returns empty string when no habits in health file", async () => {
    vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
      const p = String(filePath)
      if (p.endsWith("daemon-health.json")) {
        return JSON.stringify({
          status: "running",
          mode: "prod",
          pid: 1234,
          startedAt: new Date().toISOString(),
          uptimeSeconds: 100,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {},
        })
      }
      return ""
    })

    const { rhythmStatusSection } = await import("../../mind/prompt")
    const result = rhythmStatusSection()
    expect(result).toBe("")
  })
})

describe("system prompt group headers", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("cli output contains core group headers in order", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    // These group headers must appear as literal markdown H1 lines
    const expectedHeaders = [
      "# who i am",
      "# my body & environment",
      "# my tools & capabilities",
      "# how i work",
      "# dynamic state for this turn",
      "# friend context",
      "# task context",
    ]

    for (const header of expectedHeaders) {
      expect(result).toContain(header)
    }

    // Verify ordering: each header appears after the previous one
    for (let i = 1; i < expectedHeaders.length; i++) {
      const prevIdx = result.indexOf(expectedHeaders[i - 1])
      const currIdx = result.indexOf(expectedHeaders[i])
      expect(currIdx).toBeGreaterThan(prevIdx)
    }
  })

  it("inner channel output contains '# my inner life' group header", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("inner"))
    expect(result).toContain("# my inner life")
  })

  it("teams channel with remote context contains '# social context' group header", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const ctx = makeOnboardingContext()
    // Add senseType to make it a remote channel (teams is "closed" sense type)
    const remoteCtx = { ...ctx, channel: { ...ctx.channel, senseType: "closed" as const } }
    const result = flattenSystemPrompt(await buildSystem("teams", {}, remoteCtx as any))
    expect(result).toContain("# social context")
  })

  it("cli channel does NOT contain '# my inner life' or '# social context'", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("# my inner life")
    expect(result).not.toContain("# social context")
  })

  it("group headers appear as literal markdown H1 lines in output", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    const lines = result.split("\n")

    // Each group header should appear on its own line starting with "# "
    expect(lines.some(l => l.trim() === "# who i am")).toBe(true)
    expect(lines.some(l => l.trim() === "# my body & environment")).toBe(true)
    expect(lines.some(l => l.trim() === "# my tools & capabilities")).toBe(true)
    expect(lines.some(l => l.trim() === "# how i work")).toBe(true)
    expect(lines.some(l => l.trim() === "# dynamic state for this turn")).toBe(true)
    expect(lines.some(l => l.trim() === "# friend context")).toBe(true)
    expect(lines.some(l => l.trim() === "# task context")).toBe(true)
  })

  it("sections appear within their correct groups", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    // Soul/identity content should appear after "# who i am" and before "# my body & environment"
    const whoIdx = result.indexOf("# who i am")
    const bodyIdx = result.indexOf("# my body & environment")
    const soulIdx = result.indexOf("chaos monkey coding assistant")
    expect(soulIdx).toBeGreaterThan(whoIdx)
    expect(soulIdx).toBeLessThan(bodyIdx)

    // Runtime info should appear after "# my body & environment" and before "# my tools & capabilities"
    const toolsIdx = result.indexOf("# my tools & capabilities")
    const bodyMapIdx = result.indexOf("## my body")
    expect(bodyMapIdx).toBeGreaterThan(bodyIdx)
    expect(bodyMapIdx).toBeLessThan(toolsIdx)

    // Dynamic state header should appear after static sections
    const dynamicIdx = result.indexOf("# dynamic state for this turn")
    const howIdx = result.indexOf("# how i work")
    expect(dynamicIdx).toBeGreaterThan(howIdx)
  })

  it("'# dynamic state for this turn' appears after all static sections", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))

    const dynamicIdx = result.indexOf("# dynamic state for this turn")
    const toolsIdx = result.indexOf("# my tools & capabilities")
    const howIdx = result.indexOf("# how i work")

    expect(dynamicIdx).toBeGreaterThan(toolsIdx)
    expect(dynamicIdx).toBeGreaterThan(howIdx)
  })
})

describe("liveWorldStateSection (Unit 1.3)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  const minimalActiveWorkFrame = {
    centerOfGravity: "shared-work",
    currentSession: { friendId: "friend-1", channel: "teams", key: "conv-1", sessionPath: "/tmp/s.json" },
    currentObligation: null,
    inner: { status: "idle", hasPending: false, job: { status: "idle", content: null, origin: null, mode: "reflect", obligationStatus: null, surfacedResult: null, queuedAt: null, startedAt: null, surfacedAt: null } },
    bridges: [],
    taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
    friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [], allOtherLiveSessions: [] },
    codingSessions: [],
    otherCodingSessions: [],
    pendingObligations: [],
    bridgeSuggestion: null,
    mustResolveBeforeHandoff: false,
  }

  it("buildSystem with active world-state includes '## live world-state' section", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { activeWorkFrame: minimalActiveWorkFrame } as any))
    expect(result).toContain("## live world-state")
  })

  it("world-state section contains live conversation, active lane, current artifact, next action", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { activeWorkFrame: minimalActiveWorkFrame } as any))
    expect(result).toContain("- live conversation:")
    expect(result).toContain("- active lane:")
    expect(result).toContain("- current artifact:")
    expect(result).toContain("- next action:")
  })

  it("world-state section appears inside '# dynamic state for this turn' group", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { activeWorkFrame: minimalActiveWorkFrame } as any))
    const dynamicIdx = result.indexOf("# dynamic state for this turn")
    const checkpointIdx = result.indexOf("## live world-state")
    const friendIdx = result.indexOf("# friend context")

    expect(checkpointIdx).toBeGreaterThan(dynamicIdx)
    expect(checkpointIdx).toBeLessThan(friendIdx)
  })

  it("world-state section includes authority line about stale history", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { activeWorkFrame: minimalActiveWorkFrame } as any))
    expect(result).toContain("If older transcript history conflicts with it, this state wins.")
  })

  it("world-state section returns empty when no active work frame exists", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("## live world-state")
  })
})

describe("pendingMessagesSection (Unit 1.4)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("buildSystem with pending messages includes '## pending messages' section", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      pendingMessages: [
        { from: "inner-dialog", content: "heads up: coding session finished" },
      ],
    } as any))
    expect(result).toContain("## pending messages")
  })

  it("pending messages section format: '- from <source>: <content>' per message", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      pendingMessages: [
        { from: "inner-dialog", content: "coding session finished" },
        { from: "bridge-1", content: "Ari says hi" },
      ],
    } as any))
    expect(result).toContain("- from inner-dialog: coding session finished")
    expect(result).toContain("- from bridge-1: Ari says hi")
  })

  it("pending messages section appears inside '# dynamic state for this turn' group", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", {
      pendingMessages: [{ from: "test", content: "hello" }],
    } as any))
    const dynamicIdx = result.indexOf("# dynamic state for this turn")
    const pendingIdx = result.indexOf("## pending messages")
    const friendIdx = result.indexOf("# friend context")

    expect(pendingIdx).toBeGreaterThan(dynamicIdx)
    expect(pendingIdx).toBeLessThan(friendIdx)
  })

  it("empty pending messages list -> section omitted from prompt", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { pendingMessages: [] } as any))
    expect(result).not.toContain("## pending messages")
  })

  it("no pending messages option -> section omitted from prompt", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).not.toContain("## pending messages")
  })
})

describe("toolContractsSection (Unit 1.5)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("contains all 5 tool contracts with locked numbered format", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    // Locked content: 5 numbered contracts
    expect(result).toContain("## tool contracts")
    expect(result).toContain("1. `save_friend_note` -- when I learn something about a person, I save it immediately")
    expect(result).toContain("2. `diary_write` -- when I learn something general about a project, system, or decision")
    expect(result).toContain("3. `get_friend_note` -- when I need context about someone not in this conversation")
    expect(result).toContain("4. `search_notes` -- when I need older diary or journal material")
    expect(result).toContain("5. `query_session` -- when I need grounded session history")
  })

  it("contains tool behavior rules (tool_choice required, settle rules)", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("## tool behavior")
    expect(result).toContain('tool_choice is set to "required"')
    expect(result).toContain("I call `settle`")
    expect(result).toContain("`settle` must be the only tool call in that turn")
    expect(result).toContain("I do not call no-op tools before `settle`")
  })

  it("appears inside '# my tools & capabilities' group", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    const toolsGroupIdx = result.indexOf("# my tools & capabilities")
    const howGroupIdx = result.indexOf("# how i work")
    const contractsIdx = result.indexOf("## tool contracts")

    expect(contractsIdx).toBeGreaterThan(toolsGroupIdx)
    expect(contractsIdx).toBeLessThan(howGroupIdx)
  })

  it("old sections no longer appear when new consolidated section present", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    // Old section headings should not appear
    expect(result).not.toContain("## diary and friend tool contracts")
    expect(result).not.toContain("## what's already in my context")
  })

  it("tool behavior sub-section omitted when toolChoiceRequired is false", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli", { toolChoiceRequired: false }))
    // Tool contracts should still appear
    expect(result).toContain("## tool contracts")
    // But tool behavior should be omitted
    expect(result).not.toContain("## tool behavior")
  })
})

describe("workspaceDisciplineSection expanded (Unit 1.6)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("contains '## how i work' heading", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("## how i work")
  })

  it("contains 'reversibility and blast radius' sub-heading", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("**reversibility and blast radius**")
  })

  it("contains 'engineering discipline' sub-heading", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("**engineering discipline**")
  })

  it("contains 'git discipline' sub-heading", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("**git discipline**")
  })

  it("contains key locked phrases", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("I work conservatively")
    expect(result).toContain("I exercise judgment rather than waiting for permission")
    expect(result).toContain("I do not add features, refactor code, or make improvements beyond what was asked")
    expect(result).toContain("I create new commits rather than amending")
  })
})

describe("familyCrossSessionTruthSection trimmed (Unit 1.7)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  const familyContext = {
    friend: {
      id: "uuid-1",
      name: "Ari",
      externalIds: [],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      totalTokens: 5000,
      createdAt: "2026-01-01",
      updatedAt: "2026-03-01",
      schemaVersion: 1,
      trustLevel: "family",
    },
    channel: {
      channel: "teams" as const,
      senseType: "closed" as const,
      availableIntegrations: ["ado" as const, "graph" as const],
      supportsMarkdown: true,
      supportsStreaming: true,
      supportsRichCards: true,
      maxMessageLength: 28000,
    },
  }

  const minimalFrame = {
    centerOfGravity: "shared-work",
    currentSession: { friendId: "uuid-1", channel: "teams", key: "conv-1", sessionPath: "/tmp/s.json" },
    currentObligation: null,
    inner: { status: "idle", hasPending: false, job: { status: "idle", content: null, origin: null, mode: "reflect", obligationStatus: null, surfacedResult: null, queuedAt: null, startedAt: null, surfacedAt: null } },
    bridges: [],
    taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
    friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [], allOtherLiveSessions: [] },
    codingSessions: [],
    otherCodingSessions: [],
    pendingObligations: [],
    bridgeSuggestion: null,
    mustResolveBeforeHandoff: false,
  }

  it("contains locked 5-line content", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { activeWorkFrame: minimalFrame } as any, familyContext as any))
    expect(result).toContain("live world-state across visible sessions and lanes")
    expect(result).toContain("When live state conflicts with older transcript history, live state wins")
  })

  it("does NOT contain old verbose content", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { activeWorkFrame: minimalFrame } as any, familyContext as any))
    // Old verbose phrases that should be gone
    expect(result).not.toContain("i treat the active-work section above as my reliable top-level surface")
    expect(result).not.toContain("i do not claim i lack a top-level view")
    expect(result).not.toContain("i only reach for query_active_work")
    expect(result).not.toContain("i do not rebuild whole-self status from scratch")
    expect(result).not.toContain("i do not collapse down to only the current lane")
  })

  it("returns compressed one-liner when startOfTurnPacket is present", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", { activeWorkFrame: minimalFrame, startOfTurnPacket: "**Next:** check inbox" } as any, familyContext as any))
    expect(result).toContain("answer from the cross-session picture above")
    // Should NOT contain the verbose multi-line version
    expect(result).not.toContain("live world-state across visible sessions and lanes")
  })
})

describe("note-awareness lines in contextSection (Unit 1.8)", () => {
  beforeEach(() => {
    vi.resetModules()
    const DEFAULT_AGENT_CONTEXT = { maxTokens: 80000, contextMargin: 20 }
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      context: { ...DEFAULT_AGENT_CONTEXT },
    })
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [], processing: [], validating: [],
        collaborating: [], paused: [], blocked: [],
        done: [], cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("includes 'My active friend's notes are auto-loaded'", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", {}, makeOnboardingContext() as any))
    expect(result).toContain("My active friend's notes are auto-loaded")
  })

  it("includes kept-notes surfacing guidance", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", {}, makeOnboardingContext() as any))
    expect(result).toContain("The pre-turn kept-notes check may surface relevant diary, journal, or friend-note material")
  })

  it("includes 'My psyche files are always loaded'", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", {}, makeOnboardingContext() as any))
    expect(result).toContain("My psyche files are always loaded")
  })

  it("includes 'My task board is always loaded'", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(fs.readdirSync).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = flattenSystemPrompt(await buildSystem("teams", {}, makeOnboardingContext() as any))
    expect(result).toContain("My task board is always loaded")
  })
})

describe("pre-implementation scrutiny", () => {
  beforeEach(() => {
    vi.resetModules()
    setAgentProvider("minimax")
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        "validating": [],
        collaborating: [],
        paused: [],
        blocked: [],
        done: [],
        cancelled: [],
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
  })

  it("buildSystem includes scrutiny section when channel has coding tools (cli)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("pre-implementation scrutiny")
  })

  it("scrutiny section contains stranger-with-candy framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("What is this plan NOT telling me")
  })

  it("scrutiny section contains tinfoil-hat framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("What external system does this plan trust")
  })

  it("scrutiny section uses first-person voice", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    expect(result).toContain("I'm going to examine this plan through deeply suspicious eyes")
  })

  it("preImplementationScrutinySection returns empty when hasCodingTools is false", async () => {
    const { preImplementationScrutinySection } = await import("../../mind/scrutiny")
    const result = preImplementationScrutinySection(false)
    expect(result).toBe("")
  })

  it("preImplementationScrutinySection returns scrutiny text when hasCodingTools is true", async () => {
    const { preImplementationScrutinySection } = await import("../../mind/scrutiny")
    const result = preImplementationScrutinySection(true)
    expect(result).toContain("pre-implementation scrutiny")
    expect(result).toContain("I'm going to examine this plan through deeply suspicious eyes")
    expect(result).toContain("What is this plan NOT telling me")
    expect(result).toContain("What external system does this plan trust")
  })

  it("scrutiny section contains anti-hallucination clause", async () => {
    const { preImplementationScrutinySection } = await import("../../mind/scrutiny")
    const result = preImplementationScrutinySection(true)
    expect(result).toContain("silence is a valid outcome")
  })

  it("scrutiny section is placed in how-i-work group after workspace discipline", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key" } } })
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = flattenSystemPrompt(await buildSystem("cli"))
    const workspaceDisciplineIdx = result.indexOf("## how i work")
    const scrutinyIdx = result.indexOf("## pre-implementation scrutiny")
    expect(workspaceDisciplineIdx).toBeGreaterThan(-1)
    expect(scrutinyIdx).toBeGreaterThan(-1)
    expect(scrutinyIdx).toBeGreaterThan(workspaceDisciplineIdx)
  })
})
