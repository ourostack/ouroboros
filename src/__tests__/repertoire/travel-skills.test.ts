import { describe, it, expect, vi } from "vitest"
import * as fs from "fs"
import * as path from "path"

// Mock fs before importing skills
vi.mock("fs", () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}))

// Mock identity
vi.mock("../../heart/identity", () => ({
  getAgentRoot: vi.fn(() => "/mock/agent"),
  getRepoRoot: vi.fn(() => path.resolve(__dirname, "../../../")),
}))

describe("travel planning skill", () => {
  it("loadSkill('travel-planning') returns non-empty content", async () => {
    // Mock the agent skills dir to not have travel-planning (so it falls through to harness)
    vi.mocked(fs.existsSync).mockImplementation((p) => {
      const pathStr = String(p)
      if (pathStr.includes("/mock/agent/skills")) return false
      // Harness skills dir and files exist
      return true
    })
    vi.mocked(fs.readdirSync).mockImplementation((dir) => {
      const dirStr = String(dir)
      if (dirStr.includes("/mock/agent")) return [] as any
      if (dirStr.includes("protocols")) return [] as any
      // Return actual harness skills dir listing
      const realSkillsDir = path.resolve(__dirname, "../../../skills")
      return fs.readdirSync.getMockImplementation
        ? ["browser-navigation.md", "configure-dev-tools.md", "travel-planning.md"] as any
        : [] as any
    })
    vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
      const pathStr = String(filePath)
      // Read the actual skill file from disk for verification
      if (pathStr.includes("travel-planning.md")) {
        const realPath = path.resolve(__dirname, "../../../skills/travel-planning.md")
        const { readFileSync } = require("node:fs")
        return readFileSync(realPath, "utf-8")
      }
      return ""
    })

    const { loadSkill } = await import("../../repertoire/skills")
    const content = loadSkill("travel-planning")

    expect(content.length).toBeGreaterThan(0)
  })

  it("travel-planning skill references expected tool names", async () => {
    // Read the actual file directly
    const realPath = path.resolve(__dirname, "../../../skills/travel-planning.md")
    const { readFileSync } = require("node:fs")
    const content = readFileSync(realPath, "utf-8")

    expect(content).toContain("vault_get")
    expect(content).toContain("weather_lookup")
    expect(content).toContain("travel_advisory")
    expect(content).toContain("geocode_search")
  })

  it("travel-planning skill mentions browser-navigation skill", async () => {
    const realPath = path.resolve(__dirname, "../../../skills/travel-planning.md")
    const { readFileSync } = require("node:fs")
    const content = readFileSync(realPath, "utf-8")

    expect(content).toContain("browser-navigation")
  })

  it("travel-planning skill includes human confirmation gates", async () => {
    const realPath = path.resolve(__dirname, "../../../skills/travel-planning.md")
    const { readFileSync } = require("node:fs")
    const content = readFileSync(realPath, "utf-8")

    expect(content).toContain("ALWAYS confirm")
    expect(content).toContain("Human Confirmation")
  })
})

describe("browser-navigation skill", () => {
  it("browser-navigation.md references expected patterns", async () => {
    const realPath = path.resolve(__dirname, "../../../skills/browser-navigation.md")
    const { readFileSync } = require("node:fs")
    const content = readFileSync(realPath, "utf-8")

    expect(content).toContain("browser_navigate")
    expect(content).toContain("CAPTCHA")
    expect(content).toContain("vault_get")
  })
})
