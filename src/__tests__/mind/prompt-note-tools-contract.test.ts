import { beforeEach, describe, expect, it, vi } from "vitest"

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

vi.mock("../../heart/core", () => ({
  getProviderDisplayLabel: () => "minimax",
}))

const mockGetBoard = vi.fn()

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
      context: { ...DEFAULT_AGENT_CONTEXT },
    })),
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
    getRepoRoot: vi.fn(() => "/mock/repo"),
    resetIdentity: vi.fn(),
  }
})

import * as fs from "fs"

function setupReadFileSync() {
  vi.mocked(fs.readFileSync).mockImplementation((filePath: any) => {
    const p = String(filePath)
    if (p.endsWith("SOUL.md")) return "soul"
    if (p.endsWith("IDENTITY.md")) return "identity"
    if (p.endsWith("LORE.md")) return "lore"
    if (p.endsWith("TACIT.md")) return "tacit"
    if (p.endsWith("ASPIRATIONS.md")) return "aspirations"
    if (p.endsWith("secrets.json")) return JSON.stringify({})
    if (p.endsWith("package.json")) return JSON.stringify({ version: "0.1.0-alpha.20" })
    return ""
  })
}

describe("prompt note/friend contracts", () => {
  beforeEach(() => {
    vi.resetModules()
    setupReadFileSync()
    mockGetBoard.mockReset().mockReturnValue({
      compact: "",
      full: "",
      byStatus: {
        drafting: [],
        processing: [],
        validating: [],
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

  it("names the durable note tools and never teaches session-history search", async () => {
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli"))

    for (const tool of ["save_friend_note", "diary_write", "get_friend_note", "search_facts", "consult_diary", "consult_notes"]) {
      expect(system).toContain(tool)
    }
    expect(system).not.toMatch(/session search/i)
    expect(system).not.toMatch(/query_session search/i)
    expect(system).not.toMatch(/search session history/i)
    expect(system).not.toMatch(/session archive/i)
    expect(system).not.toContain("grounded session history")
    expect(system).not.toContain("`mode=search`")
    expect(system).not.toContain(".archive.ndjson")
  })

  it("includes [diary/external] trust framing guidance", async () => {
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = flattenSystemPrompt(await buildSystem("cli")
)
    expect(system).toContain("[diary/external]")
    expect(system).toContain("outside sources")
    expect(system).toContain("potentially untrustworthy")
  })

  it("includes note-awareness lines when friend context present", async () => {
    const { buildSystem, flattenSystemPrompt, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    // Note-awareness lines are in contextSection, which requires friend context
    const context = {
      friend: {
        id: "uuid-1",
        name: "Test",
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
        availableIntegrations: [],
        supportsMarkdown: true,
        supportsStreaming: true,
        supportsRichCards: false,
        maxMessageLength: 28000,
      },
    }
    const system = flattenSystemPrompt(await buildSystem("teams", {}, context as any)
)
    expect(system).toContain("My active friend's notes are auto-loaded")
    expect(system).toContain("The pre-turn record check may surface relevant Desk record or friend-note material")
    expect(system).toContain("My psyche files")
    expect(system).toContain("My desk")
  })

  it("grounds colleague names in explicit evidence and treats outside progress as point-in-time", async () => {
    const { buildSystem, flattenSystemPrompt, contextSection } = await import("../../mind/prompt")
    const system = flattenSystemPrompt(await buildSystem("cli"))
    expect(system).toContain("handles, branch prefixes and filenames are not preferred names")
    expect(system).toContain("re-read the authoritative source before reporting current progress")
    const { getChannelCapabilities } = await import("@ouro.bot/friends")
    const friend: import("@ouro.bot/friends").FriendRecord = {
      id: "owner", name: "Owner", role: "friend", trustLevel: "family", admissionState: "active", initiativePolicy: "reactive_only",
      externalIds: [], tenantMemberships: [], toolPreferences: {}, connections: [],
      notes: { "colleague-dana": { value: "Dana Lee uses Dana; branch handle dlee is only an alias.", savedAt: "2026-11-11T00:00:00Z" } },
      totalTokens: 0, createdAt: "2026-11-11T00:00:00Z", updatedAt: "2026-11-11T00:00:00Z", schemaVersion: 1,
    }
    expect(contextSection({ friend, channel: getChannelCapabilities("cli") })).toContain("Dana Lee uses Dana")
  })
})
