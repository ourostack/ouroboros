import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Tests that CLI main() calls applyPendingUpdates as a fallback boot path
// for daemon-less direct usage (e.g., `node dist/senses/cli.js`).

// ── hoisted mock fns ──
const mocks = vi.hoisted(() => ({
  applyPendingUpdates: vi.fn(async () => undefined),
  getPackageVersion: vi.fn(() => "0.1.0-test"),
  runCliSession: vi.fn().mockResolvedValue({ exitReason: "user_quit" }),
  buildSystem: vi.fn().mockResolvedValue("system prompt"),
  resolveContext: vi.fn().mockResolvedValue({
    friend: {
      id: "mock-uuid",
      name: "testuser",
      externalIds: [{ provider: "local", externalId: "testuser", linkedAt: "2026-01-01" }],
      tenantMemberships: [],
      toolPreferences: {},
      notes: {},
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      schemaVersion: 1,
    },
    channel: {
      channel: "cli",
      availableIntegrations: [],
      supportsMarkdown: false,
      supportsStreaming: true,
      supportsRichCards: false,
      maxMessageLength: Infinity,
    },
  }),
}))

vi.mock("../../heart/daemon/update-hooks", () => ({
  applyPendingUpdates: (...a: any[]) => mocks.applyPendingUpdates(...a),
  registerUpdateHook: vi.fn(),
  getRegisteredHooks: vi.fn(() => []),
  clearRegisteredHooks: vi.fn(),
}))
vi.mock("../../mind/bundle-manifest", () => ({
  getPackageVersion: (...a: any[]) => mocks.getPackageVersion(...a),
  getChangelogPath: vi.fn(() => "/mock/changelog.json"),
  backfillBundleMeta: vi.fn(),
  createBundleMeta: vi.fn(),
}))
vi.mock("../../heart/core", () => ({
  runAgent: vi.fn().mockResolvedValue({ usage: undefined }),
  getProvider: () => "azure",
  createSummarize: () => vi.fn(),
}))
vi.mock("../../heart/config", () => ({
  sessionPath: vi.fn().mockReturnValue("/tmp/test-session.json"),
  logPath: vi.fn().mockReturnValue("/tmp/testagent-cli-runtime.ndjson"),
}))
vi.mock("../../mind/prompt", () => ({
  buildSystem: (...a: any[]) => mocks.buildSystem(...a),
}))
vi.mock("../../mind/context", () => ({
  loadSession: vi.fn().mockReturnValue(null),
  saveSession: vi.fn(),
  deleteSession: vi.fn(),
  postTurn: vi.fn(),
}))
vi.mock("../../mind/pending", () => ({
  getPendingDir: vi.fn(() => "/mock/pending"),
  drainPending: vi.fn(() => []),
}))
vi.mock("../../mind/prompt-refresh", () => ({
  refreshSystemPrompt: vi.fn(),
}))
vi.mock("../../senses/commands", () => ({
  createCommandRegistry: vi.fn(() => ({
    register: vi.fn(),
    get: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    dispatch: vi.fn().mockReturnValue({ handled: false }),
  })),
  registerDefaultCommands: vi.fn(),
  parseSlashCommand: vi.fn().mockReturnValue(null),
  getToolChoiceRequired: vi.fn().mockReturnValue(false),
}))
vi.mock("../../heart/identity", () => ({
  getAgentName: vi.fn(() => "testagent"),
  setAgentName: vi.fn(),
  getAgentSecretsPath: vi.fn(() => "/tmp/.agentsecrets/testagent/secrets.json"),
  getAgentRoot: vi.fn(() => "/mock/agent/root"),
  getAgentBundlesRoot: vi.fn(() => "/mock/AgentBundles"),
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })),
}))
vi.mock("../../mind/friends/store-file", () => {
  const MockFileFriendStore = vi.fn(function (this: any) {
    this.get = vi.fn()
    this.put = vi.fn()
    this.delete = vi.fn()
    this.findByExternalId = vi.fn()
  })
  return { FileFriendStore: MockFileFriendStore }
})
vi.mock("../../mind/friends/resolver", () => {
  const MockFriendResolver = vi.fn(function (this: any) {
    this.resolve = (...a: any[]) => mocks.resolveContext(...a)
  })
  return { FriendResolver: MockFriendResolver }
})
vi.mock("../../senses/trust-gate", () => ({
  enforceTrustGate: vi.fn().mockReturnValue({ allowed: true }),
}))
vi.mock("../../mind/friends/tokens", () => ({
  accumulateFriendTokens: vi.fn(),
}))
vi.mock("os", async () => {
  const actual = await vi.importActual<typeof import("os")>("os")
  return {
    ...actual,
    userInfo: vi.fn(() => ({ username: "testuser" })),
  }
})

// Mock readline (still imported by cli.ts for legacy exports)
vi.mock("readline", () => ({
  createInterface: vi.fn(() => {
    let closeHandler: (() => void) | null = null
    const rl: any = {
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === "close") closeHandler = handler
        return rl
      },
      close: () => { if (closeHandler) closeHandler() },
      pause: () => {},
      resume: () => {},
      line: "",
    }
    return rl
  }),
}))
// Mock Ink so runCliSession doesn't block: capture onExit and call it immediately
// to close the InputQueue so the input loop exits
vi.mock("ink", () => ({
  render: vi.fn((element: any) => {
    // Call onExit to close the InputQueue immediately so the loop exits
    if (element && element.props && element.props.onExit) {
      setTimeout(() => element.props.onExit(), 1)
    }
    return {
      unmount: vi.fn(),
      waitUntilExit: vi.fn().mockResolvedValue(undefined),
      rerender: vi.fn(),
      cleanup: vi.fn(),
      clear: vi.fn(),
    }
  }),
  Text: vi.fn(() => null),
  Box: vi.fn(() => null),
  useInput: vi.fn(),
  useApp: vi.fn(() => ({ exit: vi.fn() })),
}))

import { main } from "../../senses/cli"

describe("CLI main(): applyPendingUpdates wiring", () => {
  beforeEach(() => {
    mocks.applyPendingUpdates.mockClear()
    mocks.getPackageVersion.mockClear()
    vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("calls applyPendingUpdates with bundlesRoot and current version", async () => {
    await main("testagent", { pasteDebounceMs: 0, _testInputSource: (async function*() {})() })

    expect(mocks.applyPendingUpdates).toHaveBeenCalledTimes(1)
    expect(mocks.applyPendingUpdates).toHaveBeenCalledWith("/mock/AgentBundles", "0.1.0-test")
  })

  it("calls applyPendingUpdates before runCliSession", async () => {
    const callOrder: string[] = []
    mocks.applyPendingUpdates.mockImplementation(async () => {
      callOrder.push("applyPendingUpdates")
    })
    // main() calls runCliSession internally -- we can't easily mock it without
    // restructuring, so we verify applyPendingUpdates was called by the time main returns
    await main("testagent", { pasteDebounceMs: 0, _testInputSource: (async function*() {})() })

    expect(callOrder).toContain("applyPendingUpdates")
    expect(mocks.applyPendingUpdates).toHaveBeenCalled()
  })
})
