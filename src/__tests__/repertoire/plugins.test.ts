import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

// Mock fs before importing plugins
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// Mock identity — loadAgentConfig returns a config we control per-test
vi.mock("../../heart/identity", () => ({
  loadAgentConfig: vi.fn(),
}))

// Mock the version manager — getOuroCliHome returns a stable test root
vi.mock("../../heart/versioning/ouro-version-manager", () => ({
  getOuroCliHome: vi.fn(() => "/mock/home/.ouro-cli"),
}))

// Mock nerves so tests don't depend on it
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import * as fs from "fs"
import { loadAgentConfig } from "../../heart/identity"

describe("plugins.ts — directory helpers", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("getPluginsRoot returns ~/.ouro-cli/plugins/", async () => {
    const { getPluginsRoot } = await import("../../repertoire/plugins")
    expect(getPluginsRoot()).toBe(path.join("/mock/home/.ouro-cli", "plugins"))
  })

  it("getPluginDir returns ~/.ouro-cli/plugins/<id>/", async () => {
    const { getPluginDir } = await import("../../repertoire/plugins")
    expect(getPluginDir("desk")).toBe(
      path.join("/mock/home/.ouro-cli", "plugins", "desk"),
    )
  })

  it("getPluginSkillsDir returns ~/.ouro-cli/plugins/<id>/skills/", async () => {
    const { getPluginSkillsDir } = await import("../../repertoire/plugins")
    expect(getPluginSkillsDir("desk")).toBe(
      path.join("/mock/home/.ouro-cli", "plugins", "desk", "skills"),
    )
  })
})

describe("plugins.ts — listPlugins", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.statSync).mockReset()
  })

  it("returns empty list when plugins root doesn't exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listPlugins } = await import("../../repertoire/plugins")
    expect(listPlugins()).toEqual([])
  })

  it("lists plugin directory names under plugins root", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "desk",
      "work-suite",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    const { listPlugins } = await import("../../repertoire/plugins")
    expect(listPlugins()).toEqual(["desk", "work-suite"])
  })

  it("filters out non-directory entries (stray files)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "desk",
      ".DS_Store",
      "work-suite",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockImplementation((p: fs.PathLike) => {
      const isDir = String(p).endsWith("desk") || String(p).endsWith("work-suite")
      return { isDirectory: () => isDir } as fs.Stats
    })
    const { listPlugins } = await import("../../repertoire/plugins")
    expect(listPlugins()).toEqual(["desk", "work-suite"])
  })
})

describe("plugins.ts — listEnabledPlugins", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.statSync).mockReset()
    vi.mocked(loadAgentConfig).mockReset()
  })

  it("returns empty when agent has no plugins declared", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "x" },
      agentFacing: { provider: "anthropic", model: "x" },
      phrases: { thinking: [], tool: [], followup: [] },
    } as never)
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listEnabledPlugins } = await import("../../repertoire/plugins")
    expect(listEnabledPlugins()).toEqual([])
  })

  it("returns only enabled plugins that are also installed on disk", async () => {
    vi.mocked(loadAgentConfig).mockReturnValue({
      version: 2,
      enabled: true,
      humanFacing: { provider: "anthropic", model: "x" },
      agentFacing: { provider: "anthropic", model: "x" },
      phrases: { thinking: [], tool: [], followup: [] },
      plugins: [
        { id: "desk", enabled: true },
        { id: "work-suite", enabled: false }, // not enabled
        { id: "missing-plugin", enabled: true }, // not installed
      ],
    } as never)
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "desk",
      "work-suite",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    const { listEnabledPlugins } = await import("../../repertoire/plugins")
    const enabled = listEnabledPlugins()
    expect(enabled).toHaveLength(1)
    expect(enabled[0].id).toBe("desk")
  })
})

describe("plugins.ts — listPluginSkills", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.statSync).mockReset()
  })

  it("returns empty when no plugins are enabled", async () => {
    const { listPluginSkills } = await import("../../repertoire/plugins")
    expect(listPluginSkills([])).toEqual([])
  })

  it("returns flat-layout (skills/*.md) basenames", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "task-lifecycle.md",
      "session-start.md",
      "README.md", // typical non-skill .md — still surfaces (caller can filter via description-gating)
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
    } as fs.Stats)
    const { listPluginSkills } = await import("../../repertoire/plugins")
    const skills = listPluginSkills([{ id: "desk", enabled: true }])
    expect(skills).toContain("task-lifecycle")
    expect(skills).toContain("session-start")
    expect(skills).toContain("README")
  })

  it("returns directory-layout (skills/<name>/SKILL.md) names", async () => {
    // Simulate desk's actual layout: each skill is a directory containing SKILL.md
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const s = String(p)
      // skills dir + each SKILL.md exists
      return s.endsWith("skills") || s.endsWith("SKILL.md")
    })
    vi.mocked(fs.readdirSync).mockReturnValue([
      "task-lifecycle",
      "session-start",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => true,
    } as fs.Stats)
    const { listPluginSkills } = await import("../../repertoire/plugins")
    const skills = listPluginSkills([{ id: "desk", enabled: true }])
    expect(skills).toEqual(["session-start", "task-lifecycle"])
  })

  it("deduplicates skills across plugins", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([
      "task-lifecycle.md",
    ] as unknown as fs.Dirent[])
    vi.mocked(fs.statSync).mockReturnValue({
      isDirectory: () => false,
    } as fs.Stats)
    const { listPluginSkills } = await import("../../repertoire/plugins")
    const skills = listPluginSkills([
      { id: "desk", enabled: true },
      { id: "another-plugin", enabled: true },
    ])
    expect(skills).toEqual(["task-lifecycle"])
  })
})

describe("plugins.ts — loadPluginSkill", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("loads flat-layout skill content", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p).endsWith("session-start.md")
    })
    vi.mocked(fs.readFileSync).mockReturnValue("# session-start body" as never)
    const { loadPluginSkill } = await import("../../repertoire/plugins")
    expect(loadPluginSkill("desk", "session-start")).toBe("# session-start body")
  })

  it("loads directory-layout skill content (SKILL.md)", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return String(p).endsWith("SKILL.md")
    })
    vi.mocked(fs.readFileSync).mockReturnValue("# session-start SKILL.md body" as never)
    const { loadPluginSkill } = await import("../../repertoire/plugins")
    expect(loadPluginSkill("desk", "session-start")).toBe("# session-start SKILL.md body")
  })

  it("throws when skill not found in either layout", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { loadPluginSkill } = await import("../../repertoire/plugins")
    expect(() => loadPluginSkill("desk", "nonexistent")).toThrow(/plugin skill 'desk:nonexistent' not found/)
  })
})
