/**
 * Memory judgement heuristic tests — Unit 3.3
 *
 * Pins the locked memory judgement rules from the doing doc and verifies
 * they appear in the system prompt where the agent will see them.
 */
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

describe("memory judgement heuristics — locked content", () => {
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

  it("includes locked memory judgement heuristics in the system prompt", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // Friend note routing: person-specific information
    expect(system).toContain("save a friend note when i learn something about a specific person")
    expect(system).toContain("preferences")
    expect(system).toContain("workflow expectations")

    // Diary routing: durable system/workflow conclusions
    expect(system).toContain("write to diary when i learn something durable")
    expect(system).toContain("engineering decisions")
    expect(system).toContain("failure modes")

    // Ephemeral: transient execution details
    expect(system).toContain("keep it ephemeral when it is only useful for the current turn")
    expect(system).toContain("temporary branch names")

    // Disambiguation rules
    expect(system).toContain("if it is about a person, default friend note")
    expect(system).toContain("if it is about the system, default diary")

    // Noise filter
    expect(system).toContain("do not save noise")
    expect(system).toContain("if i keep re-deriving it, save it")
  })

  it("includes the full locked heuristic block verbatim", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // The section header should be present
    expect(system).toContain("## memory judgement")

    // Key decision rules
    expect(system).toContain("if it changes both, save both deliberately")
    expect(system).toContain("if i am unlikely to reuse it, leave it in the session")
  })

  it("heuristics appear in the tool contracts section alongside tool descriptions", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // The tool contracts section should still have the tool descriptions
    expect(system).toContain("save_friend_note")
    expect(system).toContain("diary_write")
    expect(system).toContain("recall")

    // AND the memory judgement heuristics should be present (either in the same
    // section or in a dedicated section)
    expect(system).toContain("memory judgement")
  })
})

describe("memory judgement heuristics — routing rules", () => {
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

  it("friend note guidance mentions personal facts and preferences", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    expect(system).toContain("personal facts")
    expect(system).toContain("tool or communication likes/dislikes")
  })

  it("diary guidance mentions continuity patterns and coding workflow truths", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    expect(system).toContain("continuity patterns")
    expect(system).toContain("coding workflow truths")
  })

  it("ephemeral guidance mentions one-off shell output", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    expect(system).toContain("one-off shell output with no durable lesson")
  })

  it("diary guidance mentions bundle-layout discoveries so agents persist them", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // Regression guard: slugger once spent a recall scan looking for a custom
    // travel/ folder that was right at the bundle root, then said "i should
    // know my own folder structure next time" — which is impossible without
    // writing it down. The diary guidance now explicitly flags bundle-layout
    // discoveries as a thing worth persisting.
    expect(system).toContain("the shape of my own bundle")
    expect(system).toContain("bundle-layout")
  })
})

describe("non-persistent memory realism — locked content", () => {
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

  it("body map says custom top-level folders may exist and instructs list_directory before recall", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // Standard folders are not exhaustive
    expect(system).toContain("custom top-level folders")
    // When in doubt, list the bundle root before searching notes
    expect(system).toContain("list_directory")
    expect(system).toContain("BEFORE reaching for `recall`")
  })

  it("contextSection tells the agent it does not just remember anything between sessions", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // Explicit anti-pattern call-out
    expect(system).toContain("i do not \"just remember\" anything between sessions")
    // Three sources of knowledge in any given session
    expect(system).toContain("blank slate carrying only")
    // Resolutions don't persist — only files do
    expect(system).toContain("future me cannot inherit resolutions, only files")
  })
})
