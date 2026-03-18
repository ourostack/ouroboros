import { describe, it, expect, vi, beforeEach } from "vitest"

describe("ensureSkillManagement", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("skips when skill-management.md already exists", async () => {
    const existsSync = vi.fn(() => true)
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(existsSync).toHaveBeenCalledWith("/mock/agent/skills/skill-management.md")
    expect(writeFileSync).not.toHaveBeenCalled()
  })

  it("fetches from GitHub and writes file when missing", async () => {
    const existsSync = vi.fn(() => false)
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => "# Skill Management\nContent here.",
    }))
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(mockFetch).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/ouroborosbot/ouroboros-skills/main/skills/skill-management/SKILL.md",
    )
    expect(mkdirSync).toHaveBeenCalledWith("/mock/agent/skills", { recursive: true })
    expect(writeFileSync).toHaveBeenCalledWith(
      "/mock/agent/skills/skill-management.md",
      "# Skill Management\nContent here.",
      "utf-8",
    )

    vi.unstubAllGlobals()
  })

  it("warns and continues on network failure", async () => {
    const existsSync = vi.fn(() => false)
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    const emitNervesEvent = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const mockFetch = vi.fn(async () => { throw new Error("network timeout") })
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")

    // Should not throw
    await ensureSkillManagement()

    expect(writeFileSync).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.skill_management_install_error",
      }),
    )

    vi.unstubAllGlobals()
  })

  it("warns and continues when fetch returns non-ok status", async () => {
    const existsSync = vi.fn(() => false)
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    const emitNervesEvent = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const mockFetch = vi.fn(async () => ({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    }))
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(writeFileSync).not.toHaveBeenCalled()
    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.skill_management_install_error",
      }),
    )

    vi.unstubAllGlobals()
  })

  it("warns and continues when writeFileSync throws", async () => {
    const existsSync = vi.fn(() => false)
    const writeFileSync = vi.fn(() => { throw new Error("EACCES: permission denied") })
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    const emitNervesEvent = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const mockFetch = vi.fn(async () => ({
      ok: true,
      text: async () => "# Content",
    }))
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        component: "daemon",
        event: "daemon.skill_management_install_error",
      }),
    )

    vi.unstubAllGlobals()
  })

  it("handles non-Error thrown values in the catch branch", async () => {
    const existsSync = vi.fn(() => false)
    const writeFileSync = vi.fn()
    const mkdirSync = vi.fn()
    vi.doMock("fs", () => ({ existsSync, writeFileSync, mkdirSync }))
    vi.doMock("../../../heart/identity", () => ({
      getAgentRoot: () => "/mock/agent",
    }))
    const emitNervesEvent = vi.fn()
    vi.doMock("../../../nerves/runtime", () => ({ emitNervesEvent }))

    const mockFetch = vi.fn(async () => { throw "string error value" })
    vi.stubGlobal("fetch", mockFetch)

    const { ensureSkillManagement } = await import("../../../heart/daemon/skill-management-installer")
    await ensureSkillManagement()

    expect(emitNervesEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        meta: expect.objectContaining({ error: "string error value" }),
      }),
    )

    vi.unstubAllGlobals()
  })
})
