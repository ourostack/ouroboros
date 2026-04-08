import { describe, it, expect, vi, beforeEach } from "vitest"

// Mock identity before importing phrases
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    configPath: "~/.agentsecrets/testagent/secrets.json",
    provider: "minimax",
    humanFacing: { provider: "minimax", model: "minimax-text-01" },
    agentFacing: { provider: "minimax", model: "minimax-text-01" },
    phrases: {
      thinking: ["working"],
      tool: ["running tool"],
      followup: ["processing"],
    },
  })),
  resetAgentConfigCache: vi.fn(),
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

describe("phrases - pickPhrase", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns a phrase from the pool", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    const pool = ["alpha", "bravo", "charlie"]
    const result = pickPhrase(pool)
    expect(pool).toContain(result)
  })

  it("avoids immediate repeat when lastUsed is provided", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    const pool = ["a", "b", "c"]
    // Run many times -- should never return lastUsed
    for (let i = 0; i < 50; i++) {
      expect(pickPhrase(pool, "a")).not.toBe("a")
    }
  })

  it("returns the only element for single-element pool", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    expect(pickPhrase(["only"])).toBe("only")
  })

  it("returns the only element even when lastUsed matches (single-element)", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    expect(pickPhrase(["only"], "only")).toBe("only")
  })

  it("returns empty string for empty pool", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    expect(pickPhrase([])).toBe("")
  })

  it("works without lastUsed parameter", async () => {
    const { pickPhrase } = await import("../../mind/phrases")
    const pool = ["x", "y", "z"]
    const result = pickPhrase(pool)
    expect(pool).toContain(result)
  })
})

describe("phrases - getPhrases from agent.json", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns phrases directly from loadAgentConfig().phrases", async () => {
    const identity = await import("../../heart/identity")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: {
        thinking: ["custom thinking"],
        tool: ["custom tool"],
        followup: ["custom followup"],
      },
    })

    const { getPhrases } = await import("../../mind/phrases")
    const phrases = getPhrases()

    expect(phrases.thinking).toEqual(["custom thinking"])
    expect(phrases.tool).toEqual(["custom tool"])
    expect(phrases.followup).toEqual(["custom followup"])
  })

  it("refreshes the cached agent config before loading phrases", async () => {
    const identity = await import("../../heart/identity")
    vi.mocked(identity.resetAgentConfigCache).mockClear()
    vi.mocked(identity.loadAgentConfig).mockClear()
    const { getPhrases } = await import("../../mind/phrases")
    getPhrases()

    expect(identity.resetAgentConfigCache).toHaveBeenCalledTimes(1)
    expect(identity.loadAgentConfig).toHaveBeenCalledTimes(1)
  })

  it("returns placeholders when loadAgentConfig has auto-filled phrases", async () => {
    // loadAgentConfig now always returns phrases (auto-filled with placeholders if missing)
    const identity = await import("../../heart/identity")
    vi.mocked(identity.loadAgentConfig).mockReturnValue({
      name: "testagent",
      configPath: "~/.agentsecrets/testagent/secrets.json",
      provider: "minimax",
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "minimax", model: "minimax-text-01" },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    })

    const { getPhrases } = await import("../../mind/phrases")
    const phrases = getPhrases()

    expect(phrases.thinking).toEqual(["working"])
    expect(phrases.tool).toEqual(["running tool"])
    expect(phrases.followup).toEqual(["processing"])
  })

  it("does not export THINKING_PHRASES, TOOL_PHRASES, FOLLOWUP_PHRASES", async () => {
    const mod = await import("../../mind/phrases")
    expect("THINKING_PHRASES" in mod).toBe(false)
    expect("TOOL_PHRASES" in mod).toBe(false)
    expect("FOLLOWUP_PHRASES" in mod).toBe(false)
  })
})

describe("phrases observability contract", () => {
  it("emits repertoire.load_end when loading phrase pools", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    const { getPhrases } = await import("../../mind/phrases")
    getPhrases()

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.load_end",
      component: "repertoire",
    }))
  })
})
