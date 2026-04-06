import { describe, it, expect, vi } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"

// Track nerves events
vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("agent-commerce skill file", () => {
  const skillPath = path.resolve(__dirname, "../../../skills/agent-commerce.md")

  it("skill file exists", () => {
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  it("contains Pattern A (API) guidance", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("Pattern A")
    expect(content).toContain("API")
    expect(content).toContain("Duffel")
    expect(content).toContain("LiteAPI")
  })

  it("contains Pattern B (browser best-effort) guidance", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("Pattern B")
    expect(content).toContain("browser")
  })

  it("contains Pattern C (link-only) guidance", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("Pattern C")
    expect(content).toContain("link")
  })

  it("references all commerce tool names", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    const tools = [
      "user_profile_store", "user_profile_get",
      "stripe_create_card", "stripe_deactivate_card",
      "flight_search", "flight_book",
    ]
    for (const tool of tools) {
      expect(content, `skill should reference ${tool}`).toContain(tool)
    }
  })

  it("includes payment autonomy levels", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("autonomy")
    expect(content).toContain("Level 0")
    expect(content).toContain("Level 3")
  })

  it("includes error handling guidance", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("price change")
    expect(content).toContain("partial failure")
  })

  it("includes CAPTCHA handoff guidance", () => {
    const content = fs.readFileSync(skillPath, "utf-8")
    expect(content).toContain("CAPTCHA")
  })
})
