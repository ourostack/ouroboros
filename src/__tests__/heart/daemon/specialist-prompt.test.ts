import { describe, it, expect } from "vitest"

describe("buildSpecialistSystemPrompt", () => {
  it("includes SOUL.md text", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("I am the soul.", "I am the identity.", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("I am the soul.")
  })

  it("includes identity text", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul text", "I am Medusa, a serpentine specialist.", ["Agent1"], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("I am Medusa, a serpentine specialist.")
  })

  it("includes existing bundle names when provided", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", ["Slugger", "Ouroboros"], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("Slugger")
    expect(prompt).toContain("Ouroboros")
  })

  it("handles no bundles gracefully", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(0)
    expect(prompt).toContain("first hatchling")
  })

  it("handles empty SOUL and identity gracefully", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("", "", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toBeDefined()
    expect(prompt.length).toBeGreaterThan(0)
  })

  it("includes tool guidance for complete_adoption and the broader local tool surface", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("complete_adoption")
    expect(prompt).toContain("final_answer")
    expect(prompt).toContain("read_file")
    expect(prompt).toContain("write_file")
    expect(prompt).toContain("list_directory")
    expect(prompt).toContain("shell")
    expect(prompt).toContain("schedule_reminder")
  })

  it("includes tempDir path in the prompt", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-abc123",
      provider: "anthropic",
    })
    expect(prompt).toContain("/tmp/ouro-hatch-abc123")
  })

  it("includes provider info in the prompt", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "minimax",
    })
    expect(prompt).toContain("minimax")
  })

  it("includes bundle creation guidelines (psyche files)", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("SOUL.md")
    expect(prompt).toContain("IDENTITY.md")
    expect(prompt).toContain("LORE.md")
    expect(prompt).toContain("TACIT.md")
    expect(prompt).toContain("ASPIRATIONS.md")
    expect(prompt).toContain("agent.json")
  })

  it("includes voice rules for brevity", async () => {
    const { buildSpecialistSystemPrompt } = await import("../../../heart/daemon/specialist-prompt")
    const prompt = buildSpecialistSystemPrompt("soul", "identity", [], {
      tempDir: "/tmp/ouro-hatch-test",
      provider: "anthropic",
    })
    expect(prompt).toContain("Voice rules")
    expect(prompt).toContain("1-3 short sentences")
  })
})
