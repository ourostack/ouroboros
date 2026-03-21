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
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
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
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider,
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("chaos monkey coding assistant")
    expect(result).toContain("crack jokes")
  })

  it("reads active session summaries from bundle-local state", async () => {
    setupReadFileSync()
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    await buildSystem()

    expect(fs.existsSync).toHaveBeenCalledWith("/mock/repo/testagent/state/sessions")
  })

  it("includes identity section with Ouroboros name", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("i am Ouroboros")
    expect(result).toContain("i use lowercase")
  })

  it("includes repo workspace discipline guidance for local harness edits", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("## repo workspace discipline")
    expect(result).toContain("safe_workspace")
    expect(result).toContain("workspace path/branch")
    expect(result).toContain("first concrete action")
  })

  it("includes active bridge work when bridge context is present", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem(
      "teams",
      {
        bridgeContext: "bridge-1: relay Ari between cli and teams (task: 2026-03-13-1600-shared-relay)",
      } as any,
      makeOnboardingContext() as any,
    )
    expect(result).toContain("## active bridge work")
    expect(result).toContain("bridge-1")
    expect(result).toContain("shared-relay")
  })

  it("reuses a pre-headed bridge section without duplicating the heading", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem(
      "teams",
      {
        bridgeContext: "## active bridge work\nbridge-2: keep cli and teams aligned",
      } as any,
      makeOnboardingContext() as any,
    )
    expect(result).toContain("## active bridge work\nbridge-2: keep cli and teams aligned")
    expect(result.match(/## active bridge work/g)).toHaveLength(1)
  })

  it("renders one shared active-work section when a center-of-gravity frame is present", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem(
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
    )

    expect(result).toContain("## what i'm holding")
    expect(result).not.toContain("i told them i'd carry Ari across cli and teams.")
    expect(result).toContain("relates to bridge bridge-1")
  })

  it("gives family members an always-on all-sessions truth rule without a status-question switch", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const baseContext = makeOnboardingContext()

    const result = await buildSystem(
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
    )

    expect(result).toContain("if a family member asks what i'm up to or how things are going, that includes the material live work i can see across sessions, not just this thread.")
    expect(result).toContain("i answer naturally from the live world-state in this prompt.")
  })

  it("elevates an exact live-status format when this turn is a direct status check", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem(
      "cli",
      {
        statusCheckRequested: true,
        activeWorkFrame: {
          centerOfGravity: "local-turn",
          currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
          currentObligation: null,
          mustResolveBeforeHandoff: false,
          inner: { status: "idle", hasPending: false, job: { status: "idle", content: null, origin: null, mode: "reflect", obligationStatus: null, surfacedResult: null, queuedAt: null, startedAt: null, surfacedAt: null } },
          bridges: [],
          taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
          friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
          codingSessions: [],
          pendingObligations: [],
          bridgeSuggestion: null,
        },
      } as any,
    )

    expect(result).toContain("## status question on this turn")
    expect(result).toContain("reply using exactly these five lines and nothing else")
    expect(result).toContain("live conversation: cli/session")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain('current artifact: <actual artifact or "no artifact yet">')
    expect(result).toContain("latest checkpoint: <freshest concrete thing i just finished or verified>")
    expect(result).toContain("next action: <smallest concrete next step i'm taking now>")
  })

  it("requires family status checks to include other active sessions after the five-line header", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const baseContext = makeOnboardingContext()

    const result = await buildSystem(
      "cli",
      {
        statusCheckRequested: true,
        statusCheckScope: "all-sessions-family",
        activeWorkFrame: {
          centerOfGravity: "inward-work",
          currentSession: { friendId: "uuid-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
          currentObligation: "close the loop visibly",
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
    )

    expect(result).toContain("other active sessions:")
    expect(result).toContain("- <session label>: <what i'm doing there right now>")
  })

  it("does not render a status-check section when no active-work frame is available", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem(
      "cli",
      {
        statusCheckRequested: true,
      } as any,
    )

    expect(result).not.toContain("## status question on this turn")
    expect(result).not.toContain("reply using exactly these five lines and nothing else")
  })

  it("makes current trust context and candidate target chats explicit enough to reason about", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const context = makeOnboardingContext()
    context.friend.role = "acquaintance"
    context.friend.trustLevel = "acquaintance"
    context.friend.externalIds = [
      { provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-14T18:00:00.000Z" },
      { provider: "imessage-handle", externalId: "group:any;+;project-group-123", linkedAt: "2026-03-14T18:00:00.000Z" },
    ]

    const result = await buildSystem(
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
    )

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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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

    const result = await buildSystem(
      "cli",
      {},
      context as any,
    )

    expect(result).not.toContain("## trust context")
  })

  it("makes remote trust context explicit even when there is no related shared-group anchor", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const context = makeOnboardingContext()
    context.friend.role = "acquaintance"
    context.friend.trustLevel = "acquaintance"
    context.friend.externalIds = [
      { provider: "imessage-handle", externalId: "ari@mendelow.me", linkedAt: "2026-03-14T18:00:00.000Z" },
    ]

    const result = await buildSystem(
      "teams",
      {},
      context as any,
    )

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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem(
      "bluebubbles",
      {
        delegationDecision: {
          target: "delegate-inward",
          reasons: ["explicit_reflection", "cross_session"],
          outwardClosureRequired: true,
        },
      } as any,
      makeOnboardingContext() as any,
    )

    expect(result).toContain("## what i'm sensing about this conversation")
    expect(result).toContain("Something here calls for reflection")
    expect(result).toContain("say something outward before going inward")
  })

  it("includes lore section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("## my lore")
    expect(result).toContain("ouroboros")
  })

  it("does not include friends section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).not.toContain("## my friends")
    expect(result).not.toContain(MOCK_FRIENDS)
  })

  it("includes tacit knowledge section", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("## tacit knowledge")
    expect(result).toContain("structured logging")
  })

  it("includes aspirations section from psyche/ASPIRATIONS.md", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("## my aspirations")
    expect(result).toContain("improving the harness")
  })

  it("includes runtime info section for cli channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("i introduce myself on boot")
    expect(result).toContain("testagent") // agent name from identity mock
    expect(result).toContain("## my body") // body map replaces old one-liner
  })

  it("includes runtime info section for teams channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("teams")
    expect(result).toContain("Microsoft Teams")
    expect(result).toContain("i keep responses concise")
    expect(result).not.toContain("i introduce myself on boot")
  })

  it("includes the current sense plus an available-senses summary", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
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
      if (p.endsWith("secrets.json")) {
        return JSON.stringify({
          teams: {
            clientId: "cid",
            clientSecret: "secret",
            tenantId: "tenant",
          },
        })
      }
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams")

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
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli")

    expect(result).toContain("sense states:")
    expect(result).toContain("interactive = available when opened by the user")
    expect(result).toContain("disabled = turned off in agent.json")
    expect(result).toContain("needs_config = enabled but missing required secrets.json values")
    expect(result).toContain("If asked how to enable another sense, I explain the relevant agent.json senses entry and required secrets.json fields instead of guessing.")
  })

  it("falls back to needs_config when the secrets file cannot be parsed", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams")

    expect(result).toContain("Teams: needs_config")
  })

  it("shows BlueBubbles as ready when it is enabled and fully configured", async () => {
    setupReadFileSync()
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
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
      if (p.endsWith("secrets.json")) {
        return JSON.stringify({
          bluebubbles: {
            serverUrl: "http://localhost:1234",
            password: "pw",
          },
        })
      }
      if (p.endsWith("package.json")) return MOCK_PACKAGE_JSON
      return ""
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("bluebubbles")

    expect(result).toContain("BlueBubbles: ready")
  })

  it("defaults to cli channel", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("i introduce myself on boot")
  })

  it("includes date section with current date", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    const today = new Date().toISOString().slice(0, 10)
    expect(result).toContain(`current date: ${today}`)
  })

  it("includes tools section with tool names", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
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
      },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).not.toContain("## task board")
  })

  it("includes skills section from listSkills", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue(["code-review", "self-edit", "self-query"])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("## my skills (use load_skill to activate)")
    expect(result).toContain("code-review, self-edit, self-query")
  })

  it("omits skills section when no skills available", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue([])
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).not.toContain("## my skills")
  })

  it("does NOT export isOwnCodebase (removed)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const prompt = await import("../../mind/prompt")
    expect("isOwnCodebase" in prompt).toBe(false)
  })

  it("includes azure provider string when azure config is set", async () => {
    setAgentProvider("azure")
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-azure-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "gpt-4o-deploy",
          modelName: "test-model",
        },
      },
    })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
    expect(result).toContain("azure openai (gpt-4o-deploy, model: test-model)")
  })

  it("includes anthropic provider string when Anthropic model is configured with Claude setup-token credentials", async () => {
    setAgentProvider("anthropic")
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
          model: "claude-opus-4-6",
          setupToken: `sk-ant-oat01-${"a".repeat(80)}`,
        },
      },
    } as any)
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    try {
      const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
      resetPsycheCache()
      const result = await buildSystem()
      expect(result).toContain("anthropic (claude-opus-4-6)")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("includes openai codex provider string when OpenAI Codex OAuth is configured", async () => {
    setAgentProvider("openai-codex")
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        "openai-codex": {
          model: "gpt-5.4",
          oauthAccessToken: makeOpenAICodexAccessToken(),
        },
      },
    } as any)
    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    try {
      const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
      resetPsycheCache()
      const result = await buildSystem()
      expect(result).toContain("openai codex (gpt-5.4)")
    } finally {
      mockExit.mockRestore()
    }
  })

  it("uses 'default' deployment when azure deployment is not set", async () => {
    setAgentProvider("azure")
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({
      providers: {
        azure: {
          apiKey: "test-azure-key",
          endpoint: "https://test.openai.azure.com",
          deployment: "temp-deploy",
          modelName: "test-model",
        },
      },
    })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    const result = await buildSystem()
    expect(result).toContain("azure openai (default, model: test-model)")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem()
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    await buildSystem()
    expect(friendsReadCount).toBe(0)
  })

  it("includes tool behavior section when toolChoiceRequired is true", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: true })
    expect(result).toContain("## tool behavior")
    expect(result).toContain("tool_choice is set to \"required\"")
    expect(result).toContain("final_answer")
    expect(result).toContain("ONLY tool call")
  })

  it("does NOT include tool behavior section when toolChoiceRequired is false", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: false })
    expect(result).not.toContain("## tool behavior")
    expect(result).not.toContain("final_answer")
  })

  it("includes tool behavior section when options is undefined (defaults on)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("## tool behavior")
  })

  it("tool behavior section contains decision-tree framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: true })
    // Decision tree: mentions calling tools for info and final_answer for responding
    expect(result).toMatch(/need.*information.*call a tool/i)
    expect(result).toMatch(/ready to respond.*call.*final_answer/i)
  })

  it("tool behavior section contains anti-no-op pattern", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: true })
    // Anti-pattern: warns against calling no-op tools before final_answer
    expect(result).toMatch(/do not call.*no-op|do NOT call.*no-op/i)
  })

  it("tool behavior section clarifies final_answer is a tool call", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: true })
    // Clarification: final_answer IS a tool call satisfying the requirement
    expect(result).toMatch(/final_answer.*tool call.*satisfies|final_answer.*is a tool call/i)
  })

  it("toolsSection includes final_answer in tool list when options undefined (defaults on)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    // The tools section should list final_answer when defaults on
    expect(result).toContain("- final_answer:")
  })

  it("toolsSection does NOT include final_answer when toolChoiceRequired is false", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli", { toolChoiceRequired: false })
    expect(result).not.toContain("- final_answer:")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    // buildSystem with no options should never produce "## my flags"
    const result = await buildSystem("teams")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).not.toContain("i can read and modify my own source code")
  })

  it("cli channel includes boot greeting", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("i introduce myself on boot")
  })

  it("teams channel includes concise behavior", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("cli")
    expect(result).toContain("process type: cli session")
  })

  it("inner channel includes process type: inner dialog", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("inner")
    expect(result).toContain("process type: inner dialog")
  })

  it("teams channel includes process type: teams handler", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("teams")
    expect(result).toContain("process type: teams handler")
  })

  it("bluebubbles channel includes process type: bluebubbles handler", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { runtimeInfoSection, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = runtimeInfoSection("bluebubbles")
    expect(result).toContain("process type: bluebubbles handler")
  })

  it("includes daemon status field", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    // Should not throw
    const result = await buildSystem()
    expect(typeof result).toBe("string")
  })

  it("caches psyche text after first load", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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

  it("includes memory ephemerality instruction when friend context exists", async () => {
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
    // Should include instruction about ephemeral conversation memory
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams", { currentObligation: "finish the current task" }, makeOnboardingContext() as any)

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
    expect(result.toLowerCase()).not.toContain("only when the conversation is genuinely fresh and idle")
  })

  it("buildSystem omits onboarding when a queued follow-up exists", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams", { hasQueuedFollowUp: true }, makeOnboardingContext() as any)

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
  })

  it("buildSystem omits onboarding when mustResolveBeforeHandoff is active", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams", { mustResolveBeforeHandoff: true }, makeOnboardingContext() as any)

    expect(result.toLowerCase()).not.toContain("i actively ask my friend about themselves")
  })

  it("buildSystem keeps first-person onboarding language during a genuine lull", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("teams", undefined, makeOnboardingContext() as any)

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

  it("includes working-memory trust instruction", async () => {
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

  it("memory instruction lowers the bar -- saves anything learned, not just important things", async () => {
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
    // Memory instruction should NOT say "something important" -- bar is too high
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    const result = await buildSystem("teams", undefined, ctx)
    expect(result).toContain("## friend context")
    expect(result).toContain("Jordan")
  })

  it("includes local tools in the system prompt for trusted one-to-one bluebubbles contexts", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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

    const result = await buildSystem("bluebubbles", undefined, ctx)
    expect(result).toContain("- read_file:")
    expect(result).toContain("- shell:")
  })

  it("omits context section when context is undefined", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).not.toContain("## friend context")
  })

  it("returns a Promise (async function)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = buildSystem("cli")
    expect(result).toBeInstanceOf(Promise)
  })

  // --- B1: buildSystem("inner") channel routing ---

  it("buildSystem('inner') returns a system prompt string", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(typeof result).toBe("string")
    expect(result.length).toBeGreaterThan(0)
  })

  it("buildSystem('inner') includes psyche sections", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
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

  it("buildSystem('inner') includes runtimeInfoSection, toolsSection, taskBoardSection, skillsSection, memoryFriendToolContractSection", async () => {
    setupReadFileSync()
    vi.mocked(listSkills).mockReturnValue(["code-review"])
    mockGetBoard.mockReturnValueOnce({
      compact: "[Tasks] processing:1",
      full: "full",
      byStatus: { drafting: [], processing: ["t"], "validating": [], collaborating: [], paused: [], blocked: [], done: [] },
      actionRequired: [],
      unresolvedDependencies: [],
      activeSessions: [],
    })
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(result).toContain("## runtime")
    expect(result).toContain("## my tools")
    expect(result).toContain("## task board")
    expect(result).toContain("## my skills")
    expect(result).toContain("## memory and friend tool contracts")
    expect(result).toContain("query_session")
    expect(result).toContain("mode=search")
  })

  it("buildSystem('inner') does NOT include contextSection output (no friend context, no onboarding)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(result).not.toContain("## friend context")
    expect(result).not.toContain("first-impressions")
    expect(result).not.toContain("i introduce myself on boot")
  })

  it("buildSystem('inner') includes metacognitive framing text", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(result).toContain("this is my inner dialog. there is no one else here.")
    expect(result).toContain("the messages that appear here are my own awareness surfacing")
    expect(result).toContain("i can think freely here")
  })

  it("buildSystem includes delegation hints with explicit reasons and closure state", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli", {
      delegationDecision: {
        target: "delegate-inward",
        reasons: ["cross_session", "task_state"],
        outwardClosureRequired: true,
      },
    } as any)

    expect(result).toContain("## what i'm sensing about this conversation")
    expect(result).toContain("This touches other conversations")
    expect(result).toContain("say something outward before going inward")
  })

  it("buildSystem renders empty delegation reasons as none and optional closure as not required", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli", {
      delegationDecision: {
        target: "fast-path",
        reasons: [],
        outwardClosureRequired: false,
      },
    } as any)

    // fast-path target returns empty string, no delegation hint in prompt
    expect(result).not.toContain("## what i'm sensing")
    expect(result).not.toContain("delegation hint")
  })

  it("buildSystem('inner') includes inner dialog loop orientation", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(result).toContain("thoughts worth sharing can go outward")
    expect(result).toContain("think. share. think some more.")
  })

  it("buildSystem('cli') does NOT include metacognitive framing", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).not.toContain("this is my inner dialog. there is no one else here.")
  })

  // --- A: Body map + self-evolution orientation ---

  it("buildSystem includes 'my home is fully mine' and bundle directory path", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("my home is fully mine")
    expect(result).toContain("~/AgentBundles/testagent.ouro/")
  })

  it("buildSystem includes 'my bones are the framework' and @ouro.bot/cli", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("my bones are the framework")
    expect(result).toContain("@ouro.bot/cli")
  })

  it("buildSystem includes ouro CLI command reference in body map", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("ouro whoami")
    expect(result).toContain("ouro task board")
    expect(result).toContain("ouro friend list")
    expect(result).toContain("ouro --help")
  })

  it("buildSystem no longer contains the old one-liner about source code modification", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).not.toContain("i can read and modify my own source code")
  })

  it("buildSystem includes self-evolution orientation ('mine to explore and evolve')", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("mine to explore and evolve")
  })

  it("buildSystem('inner') includes body map (foundational anatomy for all channels)", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    expect(result).toContain("## my body")
    expect(result).toContain("my home is fully mine")
    expect(result).toContain("my bones are the framework")
  })

  it("body map interpolates agent name (not literal '{name}')", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
    expect(result).toContain("sometimes a thought of mine surfaces")
  })

  it("buildSystem('inner') does NOT include external loop orientation", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("inner")
    // Inner dialog has metacognitive framing with its own loop text
    expect(result).toContain("think. share. think some more.")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    const result = await buildSystem("bluebubbles", undefined, ctx as any)
    expect(result).toMatch(/open/)
    expect(result).toMatch(/anyone|don't know/i)
  })

  it("buildSystem includes channel nature for teams", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
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
    const result = await buildSystem("teams", undefined, ctx as any)
    expect(result).toMatch(/org|organization/i)
  })

  it("buildSystem does NOT include channel nature for CLI", async () => {
    setupReadFileSync()
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const result = await buildSystem("cli")
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: makeFriendForGroup({ trustLevel: "acquaintance" }),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = await buildSystem("bluebubbles", undefined, ctx as any)
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

  it("returns non-empty string containing no_response when isGroupChat is true on remote channel", async () => {
    const { groupChatParticipationSection } = await import("../../mind/prompt")
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = groupChatParticipationSection(ctx as any)
    expect(result).not.toBe("")
    expect(result).toContain("no_response")
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
    // Must mention no_response
    expect(result).toMatch(/no_response/)
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
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const ctx = {
      friend: makeFriendForGroup(),
      channel: makeChannelCaps("bluebubbles", "open"),
      isGroupChat: true,
    }
    const result = await buildSystem("bluebubbles", undefined, ctx as any)
    expect(result).toContain("no_response")
    expect(result).toMatch(/reaction|tapback/i)
  })
})

describe("session orientation prompting", () => {
  beforeEach(() => {
    setupReadFileSync()
  })

  it("buildSystem includes execution discipline guidance", async () => {
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli")

    expect(result).toContain("## execution discipline")
    expect(result).toContain("do the work instead of narrating intentions")
    expect(result).toContain("don't pretend progress")
    expect(result).toContain("answer ad-hoc questions directly without losing the main objective")
  })

  it("buildSystem includes durable session orientation when provided", async () => {
    const { patchRuntimeConfig, resetConfigCache } = await import("../../heart/config")
    resetConfigCache()
    patchRuntimeConfig({ providers: { minimax: { apiKey: "test-key", model: "test-model" } } })
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()

    const result = await buildSystem("cli", {
      sessionOrientation: {
        updatedAt: "2026-03-21T09:00:00.000Z",
        goal: "tighten the harness backbone",
        constraints: ["keep it simple"],
        progress: ["edit_file src/mind/prompt.ts"],
        readFiles: ["src/mind/context.ts"],
        modifiedFiles: ["src/mind/prompt.ts"],
      },
    })

    expect(result).toContain("## session orientation")
    expect(result).toContain("goal: tighten the harness backbone")
    expect(result).toContain("- keep it simple")
    expect(result).toContain("- edit_file src/mind/prompt.ts")
  })
})
