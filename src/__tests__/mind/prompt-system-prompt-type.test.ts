import { describe, it, expect } from "vitest"
import { flattenSystemPrompt, type SystemPrompt } from "../../mind/prompt"

describe("SystemPrompt type and flattenSystemPrompt", () => {
  it("joins stable and volatile with double newline", () => {
    const sp: SystemPrompt = { stable: "A", volatile: "B" }
    expect(flattenSystemPrompt(sp)).toBe("A\n\nB")
  })

  it("returns only stable when volatile is empty", () => {
    const sp: SystemPrompt = { stable: "A", volatile: "" }
    expect(flattenSystemPrompt(sp)).toBe("A")
  })

  it("returns only volatile when stable is empty", () => {
    const sp: SystemPrompt = { stable: "", volatile: "B" }
    expect(flattenSystemPrompt(sp)).toBe("B")
  })

  it("returns empty string when both are empty", () => {
    const sp: SystemPrompt = { stable: "", volatile: "" }
    expect(flattenSystemPrompt(sp)).toBe("")
  })
})
