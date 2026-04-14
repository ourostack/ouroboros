import { describe, it, expect, vi, beforeEach } from "vitest"

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

vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(() => ({
    name: "testagent",
    provider: "minimax",
  })),
  getAgentName: vi.fn(() => "testagent"),
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/repo"),
  resetIdentity: vi.fn(),
}))

describe("observeTool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("is exported from tools-base", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool).toBeDefined()
  })

  it("has type 'function'", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.type).toBe("function")
  })

  it("has function.name 'observe'", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.function.name).toBe("observe")
  })

  it("has a description about absorbing without responding", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    expect(observeTool.function.description).toMatch(/absorb/i)
    expect(observeTool.function.description).toMatch(/without responding/i)
  })

  it("has a reason string parameter", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    const params = observeTool.function.parameters as any
    expect(params.type).toBe("object")
    expect(params.properties.reason).toBeDefined()
    expect(params.properties.reason.type).toBe("string")
  })

  it("reason parameter is optional (not in required)", async () => {
    const { observeTool } = await import("../../repertoire/tools-base")
    const params = observeTool.function.parameters as any
    // required should either not exist or not include "reason"
    expect(params.required ?? []).not.toContain("reason")
  })

  it("is exported alongside settleTool", async () => {
    const { observeTool, settleTool } = await import("../../repertoire/tools-base")
    expect(observeTool).toBeDefined()
    expect(settleTool).toBeDefined()
    // They should be different tools
    expect(observeTool.function.name).not.toBe(settleTool.function.name)
  })

  it("is re-exported from tools.ts", async () => {
    const { observeTool } = await import("../../repertoire/tools")
    expect(observeTool).toBeDefined()
    expect(observeTool.function.name).toBe("observe")
  })
})
