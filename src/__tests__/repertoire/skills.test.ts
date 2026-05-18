import { describe, it, expect, vi, beforeEach } from "vitest"
import * as path from "path"

// Mock fs before importing skills
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// Mock identity -- skills will use getAgentRoot() and getRepoRoot() for skills directory
vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/repo/testagent"),
  getRepoRoot: vi.fn(() => "/mock/harness"),
}))

// Mock plugins so each skills test runs in isolation; tests that exercise
// the plugin integration override these per-test.
vi.mock("../../repertoire/plugins", () => ({
  listEnabledPlugins: vi.fn(() => []),
  listPluginSkills: vi.fn(() => []),
  loadPluginSkill: vi.fn(),
}))

import * as fs from "fs"
import {
  listEnabledPlugins as mockedListEnabledPlugins,
  listPluginSkills as mockedListPluginSkills,
  loadPluginSkill as mockedLoadPluginSkill,
} from "../../repertoire/plugins"

describe("skills - getSkillsDir", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns skills directory under agent root", async () => {
    const { getSkillsDir } = await import("../../repertoire/skills")
    expect(getSkillsDir()).toBe(path.join("/mock/repo/testagent", "skills"))
  })
})

describe("skills - listSkills", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("returns empty array when skills directory does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual([])
  })

  it("returns empty array when skills directory is empty", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue([] as any)
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual([])
  })

  it("returns sorted skill names from .md files", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["zebra.md", "alpha.md", "beta.md"] as any)
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["alpha", "beta", "zebra"])
  })

  it("filters out non-.md files", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["skill.md", "readme.txt", "notes.json", "other.md"] as any)
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["other", "skill"])
  })

  it("returns only basenames without .md extension", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["self-edit.md"] as any)
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["self-edit"])
  })

  it("reads from agent root skills directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["test.md"] as any)
    const { listSkills } = await import("../../repertoire/skills")
    listSkills()
    const expectedDir = path.join("/mock/repo/testagent", "skills")
    expect(fs.existsSync).toHaveBeenCalledWith(expectedDir)
  })

  it("merges base skills and protocol mirrors into a deduplicated sorted list", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/repo/testagent/skills" || p === "/mock/repo/testagent/skills/protocols",
    )
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (p === "/mock/repo/testagent/skills") return ["self-edit.md", "shared.md"] as any
      if (p === "/mock/repo/testagent/skills/protocols") return ["shared.md", "work-planner.md"] as any
      return [] as any
    })

    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["self-edit", "shared", "work-planner"])
  })

  it("does not read from any canonical subagents directory", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/repo/testagent/skills",
    )
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (p === "/mock/repo/testagent/skills") return ["skill-a.md"] as any
      return [] as any
    })

    const { listSkills } = await import("../../repertoire/skills")
    listSkills()
    // Should only check skills dir and protocols dir, never subagents
    const calledPaths = vi.mocked(fs.existsSync).mock.calls.map(c => c[0])
    expect(calledPaths).not.toContainEqual(expect.stringContaining("subagents"))
  })
})

describe("skills - loadSkill", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("returns skill content when skill file exists", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("# My Skill\nDo the thing.")
    const { loadSkill } = await import("../../repertoire/skills")
    const content = loadSkill("my-skill")
    expect(content).toBe("# My Skill\nDo the thing.")
  })

  it("throws when skill file does not exist", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    const { loadSkill } = await import("../../repertoire/skills")
    expect(() => loadSkill("nonexistent")).toThrow("skill 'nonexistent' not found")
  })

  it("tracks loaded skill in loaded skills list", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill, getLoadedSkills } = await import("../../repertoire/skills")
    loadSkill("tracked-skill")
    expect(getLoadedSkills()).toContain("tracked-skill")
  })

  it("does not duplicate skill in loaded list on repeated loads", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill, getLoadedSkills } = await import("../../repertoire/skills")
    loadSkill("dup-skill")
    loadSkill("dup-skill")
    const loaded = getLoadedSkills()
    expect(loaded.filter((s) => s === "dup-skill")).toHaveLength(1)
  })

  it("loads from agent root skills directory", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill } = await import("../../repertoire/skills")
    loadSkill("my-skill")
    const expectedPath = path.join("/mock/repo/testagent", "skills", "my-skill.md")
    expect(fs.existsSync).toHaveBeenCalledWith(expectedPath)
  })

  it("falls back to protocol mirror when direct skill path is missing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/repo/testagent/skills/protocols/work-planner.md",
    )
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === "/mock/repo/testagent/skills/protocols/work-planner.md") {
        return "mirror planner protocol" as any
      }
      return "" as any
    })

    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("work-planner")).toBe("mirror planner protocol")
  })

  it("throws listing all 3 checked paths when skill is not found", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { loadSkill } = await import("../../repertoire/skills")
    expect(() => loadSkill("work-merger")).toThrow("/mock/repo/testagent/skills/work-merger.md")
    expect(() => loadSkill("work-merger")).toThrow("/mock/repo/testagent/skills/protocols/work-merger.md")
    expect(() => loadSkill("work-merger")).toThrow("/mock/harness/skills/work-merger.md")
    // Must NOT reference canonical subagents path
    expect(() => {
      try { loadSkill("work-merger") } catch (e: any) {
        if (e.message.includes("subagents")) throw new Error("should not reference subagents")
      }
    }).not.toThrow()
  })
})

describe("skills - getLoadedSkills", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("returns empty array when no skills have been loaded", async () => {
    const { getLoadedSkills } = await import("../../repertoire/skills")
    expect(getLoadedSkills()).toEqual([])
  })

  it("returns a copy, not the internal array", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill, getLoadedSkills } = await import("../../repertoire/skills")
    loadSkill("skill-a")
    const first = getLoadedSkills()
    first.push("injected")
    // Internal array should not be affected
    expect(getLoadedSkills()).toEqual(["skill-a"])
  })
})

describe("skills - clearLoadedSkills", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("clears all loaded skills", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill, getLoadedSkills, clearLoadedSkills } = await import("../../repertoire/skills")
    loadSkill("skill-x")
    loadSkill("skill-y")
    expect(getLoadedSkills()).toHaveLength(2)
    clearLoadedSkills()
    expect(getLoadedSkills()).toEqual([])
  })

  it("is safe to call when no skills are loaded", async () => {
    const { clearLoadedSkills, getLoadedSkills } = await import("../../repertoire/skills")
    clearLoadedSkills()
    expect(getLoadedSkills()).toEqual([])
  })
})

describe("skills - getHarnessSkillsDir", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it("returns skills directory under harness repo root", async () => {
    const { getHarnessSkillsDir } = await import("../../repertoire/skills")
    expect(getHarnessSkillsDir()).toBe(path.join("/mock/harness", "skills"))
  })
})

describe("skills - harness-level fallback in loadSkill", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("falls back to harness skills dir when agent + protocol paths miss", async () => {
    const harnessSkillPath = "/mock/harness/skills/configure-dev-tools.md"
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === harnessSkillPath,
    )
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === harnessSkillPath) return "harness skill content" as any
      return "" as any
    })

    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("configure-dev-tools")).toBe("harness skill content")
  })

  it("agent skill takes precedence over harness skill with same name", async () => {
    const agentSkillPath = "/mock/repo/testagent/skills/configure-dev-tools.md"
    const harnessSkillPath = "/mock/harness/skills/configure-dev-tools.md"
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === agentSkillPath || p === harnessSkillPath,
    )
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === agentSkillPath) return "agent override content" as any
      if (p === harnessSkillPath) return "harness skill content" as any
      return "" as any
    })

    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("configure-dev-tools")).toBe("agent override content")
  })

  it("error message lists all 3 checked paths when skill is not found", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const { loadSkill } = await import("../../repertoire/skills")
    expect(() => loadSkill("nonexistent-skill")).toThrow(
      "/mock/repo/testagent/skills/nonexistent-skill.md"
    )
    expect(() => loadSkill("nonexistent-skill")).toThrow(
      "/mock/repo/testagent/skills/protocols/nonexistent-skill.md"
    )
    expect(() => loadSkill("nonexistent-skill")).toThrow(
      "/mock/harness/skills/nonexistent-skill.md"
    )
  })
})

describe("skills - harness-level fallback in listSkills", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("merges harness skills into listing", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/repo/testagent/skills" || p === "/mock/harness/skills",
    )
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (p === "/mock/repo/testagent/skills") return ["agent-only.md"] as any
      if (p === "/mock/harness/skills") return ["harness-only.md", "configure-dev-tools.md"] as any
      return [] as any
    })

    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["agent-only", "configure-dev-tools", "harness-only"])
  })

  it("agent skills override harness skills by name (deduplication)", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/repo/testagent/skills" || p === "/mock/harness/skills",
    )
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (p === "/mock/repo/testagent/skills") return ["shared.md", "agent-only.md"] as any
      if (p === "/mock/harness/skills") return ["shared.md", "harness-only.md"] as any
      return [] as any
    })

    const { listSkills } = await import("../../repertoire/skills")
    const skills = listSkills()
    // shared appears once (deduplicated), all unique skills present
    expect(skills).toEqual(["agent-only", "harness-only", "shared"])
  })

  it("lists harness skills even when agent skills dir does not exist", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === "/mock/harness/skills",
    )
    vi.mocked(fs.readdirSync).mockImplementation((p) => {
      if (p === "/mock/harness/skills") return ["harness-skill.md"] as any
      return [] as any
    })

    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["harness-skill"])
  })
})

describe("skills - configure-dev-tools harness skill", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
  })

  it("loads configure-dev-tools from harness skills dir as fallback", async () => {
    const harnessSkillPath = "/mock/harness/skills/configure-dev-tools.md"
    vi.mocked(fs.existsSync).mockImplementation((p) =>
      p === harnessSkillPath,
    )
    vi.mocked(fs.readFileSync).mockImplementation((p) => {
      if (p === harnessSkillPath) return "# Configure Dev Tools\nSetup content" as any
      return "" as any
    })

    const { loadSkill } = await import("../../repertoire/skills")
    const content = loadSkill("configure-dev-tools")
    expect(content).toContain("Configure Dev Tools")
  })
})

describe("skills observability contract", () => {
  it("emits repertoire.load_start when loading a skill", async () => {
    vi.resetModules()
    const emitNervesEvent = vi.fn()
    vi.doMock("../../nerves/runtime", () => ({
      emitNervesEvent,
    }))

    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readFileSync).mockReturnValue("content")
    const { loadSkill } = await import("../../repertoire/skills")
    loadSkill("my-skill")

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "repertoire.load_start",
      component: "repertoire",
    }))
  })
})

describe("skills - plugin integration (W5.4)", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.mocked(fs.existsSync).mockReset()
    vi.mocked(fs.readdirSync).mockReset()
    vi.mocked(fs.readFileSync).mockReset()
    vi.mocked(mockedListEnabledPlugins).mockReset()
    vi.mocked(mockedListPluginSkills).mockReset()
    vi.mocked(mockedLoadPluginSkill).mockReset()
  })

  it("listSkills merges plugin skills with bundle skills (dedup + sort)", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["alpha.md", "shared.md"] as never)
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([
      { id: "desk", enabled: true },
    ])
    vi.mocked(mockedListPluginSkills).mockReturnValue([
      "task-lifecycle",
      "shared", // duplicate of bundle skill — dedup'd
    ])
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["alpha", "shared", "task-lifecycle"])
  })

  it("listSkills returns only bundle skills when no plugins enabled", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(fs.readdirSync).mockReturnValue(["alpha.md"] as never)
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([])
    vi.mocked(mockedListPluginSkills).mockReturnValue([])
    const { listSkills } = await import("../../repertoire/skills")
    expect(listSkills()).toEqual(["alpha"])
  })

  it("loadSkill falls back to plugin skill when not in bundle paths", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false) // no bundle paths match
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([
      { id: "desk", enabled: true },
    ])
    vi.mocked(mockedLoadPluginSkill).mockReturnValue("# plugin skill body")
    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("task-lifecycle")).toBe("# plugin skill body")
    expect(mockedLoadPluginSkill).toHaveBeenCalledWith("desk", "task-lifecycle")
  })

  it("loadSkill tries each enabled plugin in order until one succeeds", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([
      { id: "first-plugin", enabled: true },
      { id: "desk", enabled: true },
    ])
    vi.mocked(mockedLoadPluginSkill).mockImplementation(
      (pluginId: string) => {
        if (pluginId === "first-plugin") {
          throw new Error("skill not in this plugin")
        }
        return "# from desk"
      },
    )
    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("task-lifecycle")).toBe("# from desk")
  })

  it("loadSkill throws when skill is in neither bundle nor any plugin", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([
      { id: "desk", enabled: true },
    ])
    vi.mocked(mockedLoadPluginSkill).mockImplementation(() => {
      throw new Error("not found in plugin")
    })
    const { loadSkill } = await import("../../repertoire/skills")
    expect(() => loadSkill("nonexistent")).toThrow(/not found/)
  })

  it("loadSkill prefers bundle direct skill over plugin (bundle has precedence)", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) =>
      String(p).endsWith("/skills/task-lifecycle.md"),
    )
    vi.mocked(fs.readFileSync).mockReturnValue("# bundle direct" as never)
    vi.mocked(mockedListEnabledPlugins).mockReturnValue([
      { id: "desk", enabled: true },
    ])
    vi.mocked(mockedLoadPluginSkill).mockReturnValue("# from plugin")
    const { loadSkill } = await import("../../repertoire/skills")
    expect(loadSkill("task-lifecycle")).toBe("# bundle direct")
    // plugin loader should NOT have been consulted
    expect(mockedLoadPluginSkill).not.toHaveBeenCalled()
  })
})
