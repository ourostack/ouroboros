import { describe, it, expect, vi, beforeEach } from "vitest"

describe("ensureSkillManagement", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  function mockFs(opts: { existsSync?: (p: string) => boolean; readdirSync?: () => string[] }) {
    vi.doMock("fs", () => ({
      existsSync: opts.existsSync ?? (() => true),
      readdirSync: opts.readdirSync ?? (() => ["slugger.ouro"]),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    }))
  }

  function mockIdentity() {
    vi.doMock("../../../heart/identity", () => ({
      getAgentBundlesRoot: () => "/mock/AgentBundles",
    }))
  }

  function mockNerves() {
    const emitNervesEvent = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))
    return emitNervesEvent
  }

  it("skips when skill-management.md already exists in all bundles", async () => {
    mockFs({ existsSync: () => true, readdirSync: () => ["slugger.ouro"] })
    mockIdentity()
    mockNerves()

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()
    // No fetch, no write — early return
  })

  it("skips when bundles root does not exist", async () => {
    mockFs({ existsSync: () => false })
    mockIdentity()
    mockNerves()

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()
  })

  it("skips when no .ouro bundles found", async () => {
    mockFs({ existsSync: () => true, readdirSync: () => [] })
    mockIdentity()
    mockNerves()

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()
  })

  it("fetches and writes to all bundles missing the skill", async () => {
    const written: string[] = []
    const existsSync = vi.fn((p: string) => {
      if (p === "/mock/AgentBundles") return true
      return !String(p).includes("skill-management") // bundles exist, skill doesn't
    })
    vi.doMock("fs", () => ({
      existsSync,
      readdirSync: () => ["slugger.ouro", "other.ouro"],
      writeFileSync: vi.fn((p: string) => { written.push(p) }),
      mkdirSync: vi.fn(),
    }))
    mockIdentity()
    mockNerves()

    const mockFetch = vi.fn(async () => ({ ok: true, text: async () => "# Skill Content" }))
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(mockFetch).toHaveBeenCalledOnce()
    expect(written).toContain("/mock/AgentBundles/slugger.ouro/skills/skill-management.md")
    expect(written).toContain("/mock/AgentBundles/other.ouro/skills/skill-management.md")

    vi.unstubAllGlobals()
  })

  it("warns and continues on network failure", async () => {
    mockFs({
      existsSync: (p: string) => p === "/mock/AgentBundles" ? true : !String(p).includes("skill-management"),
      readdirSync: () => ["slugger.ouro"],
    })
    mockIdentity()
    const emitNervesEvent = mockNerves()

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network timeout") }))

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "daemon.skill_management_install_error" }),
    )
    vi.unstubAllGlobals()
  })

  it("warns on non-ok HTTP response", async () => {
    mockFs({
      existsSync: (p: string) => p === "/mock/AgentBundles" ? true : !String(p).includes("skill-management"),
      readdirSync: () => ["slugger.ouro"],
    })
    mockIdentity()
    const emitNervesEvent = mockNerves()

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })))

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ level: "warn", event: "daemon.skill_management_install_error" }),
    )
    vi.unstubAllGlobals()
  })

  it("handles non-Error thrown values", async () => {
    mockFs({
      existsSync: (p: string) => p === "/mock/AgentBundles" ? true : !String(p).includes("skill-management"),
      readdirSync: () => ["slugger.ouro"],
    })
    mockIdentity()
    const emitNervesEvent = mockNerves()

    vi.stubGlobal("fetch", vi.fn(async () => { throw "string error" }))

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ error: "string error" }) }),
    )
    vi.unstubAllGlobals()
  })
})
