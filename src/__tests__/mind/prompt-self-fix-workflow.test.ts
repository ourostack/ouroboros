/**
 * Self-fix workflow contract tests — Unit 2.3
 *
 * Pins the locked self-fix workflow contract from the doing doc and verifies
 * it appears in the system prompt and workspace discipline section where the
 * agent will see it. Also verifies no direct-to-main bypass remains.
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

const emptyBoard = {
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
}

describe("self-fix workflow contract — locked content in prompt", () => {
  beforeEach(() => {
    vi.resetModules()
    setupReadFileSync()
    mockGetBoard.mockReset().mockReturnValue(emptyBoard)
  })

  it("includes the self-fix workflow contract in the system prompt", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // The core steps of the self-fix workflow
    expect(system).toContain("self-fix")
    expect(system).toContain("no direct-to-main")
    expect(system).toContain("no invisible self-modification")
  })

  it("self-fix workflow requires branch/PR/CI/review/merge discipline", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    // Must mention the explicit steps
    expect(system).toContain("create a branch")
    expect(system).toContain("coding_spawn")
    expect(system).toContain("push the branch and open a pr")
    expect(system).toContain("merge only after ci and review are green")
  })

  it("self-fix workflow requires recording what was personally verified", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("cli")

    expect(system).toContain("record what i personally verified")
    expect(system).toContain("no claiming verification i did not personally perform")
  })

  it("self-fix workflow is in the workspace discipline section", async () => {
    const { workspaceDisciplineSection } = await import("../../mind/prompt")
    const section = workspaceDisciplineSection()

    expect(section).toContain("self-fix")
    expect(section).toContain("no direct-to-main")
  })
})

describe("self-fix workflow contract — no direct-to-main bypass", () => {
  beforeEach(() => {
    vi.resetModules()
    setupReadFileSync()
    mockGetBoard.mockReset().mockReturnValue(emptyBoard)
  })

  it("workspace discipline does not contain any shortcut to push directly to main", async () => {
    const { workspaceDisciplineSection } = await import("../../mind/prompt")
    const section = workspaceDisciplineSection()

    // Should not suggest direct-to-main as acceptable
    expect(section).not.toMatch(/push directly to main/i)
    expect(section).not.toMatch(/commit directly to main/i)
  })

  it("self-fix contract appears on inner channel too", async () => {
    const { buildSystem, resetPsycheCache } = await import("../../mind/prompt")
    resetPsycheCache()
    const system = await buildSystem("inner")

    expect(system).toContain("self-fix")
    expect(system).toContain("no direct-to-main")
  })
})
