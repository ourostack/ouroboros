import { describe, expect, it, vi, beforeEach } from "vitest"

// Mock heart/identity BEFORE importing the coding module, otherwise
// `getCodingSessionManager()` will call `getAgentName()` which throws
// under vitest (no --agent in argv). Previously the manager silently
// fell back to "default", constructed real-fs state paths rooted at
// `~/AgentBundles/default.ouro/state/coding/sessions.json`, and leaked
// writes there via `shutdown()` → `persistState()`. The fallback is
// gone now; tests MUST mock identity.
vi.mock("../../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/identity")>(
    "../../../heart/identity",
  )
  return {
    ...actual,
    getAgentName: vi.fn(() => "test-coding-singleton"),
    getAgentRoot: vi.fn(() => "/tmp/coding-singleton-test/test-coding-singleton.ouro"),
  }
})

// Block all real-fs persistence calls the manager makes so shutdown()
// → persistState() doesn't try to mkdir/write anywhere on disk.
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs")
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ""),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  }
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe("coding manager singleton", () => {
  it("initializes once and reuses singleton until reset", async () => {
    const { getCodingSessionManager, resetCodingSessionManager } = await import(
      "../../../repertoire/coding"
    )
    resetCodingSessionManager()

    const first = getCodingSessionManager()
    const second = getCodingSessionManager()
    expect(second).toBe(first)

    resetCodingSessionManager()
    const third = getCodingSessionManager()
    expect(third).not.toBe(first)
  })

  it("allows reset when no manager exists", async () => {
    const { getCodingSessionManager, resetCodingSessionManager } = await import(
      "../../../repertoire/coding"
    )
    resetCodingSessionManager()
    resetCodingSessionManager()
    const manager = getCodingSessionManager()
    expect(manager).toBeDefined()
  })
})
