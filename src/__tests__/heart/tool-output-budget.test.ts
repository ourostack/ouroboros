import { describe, it, expect } from "vitest"
import { fitToolOutputForModel, TOOL_OUTPUT_MAX_CHARS } from "../../heart/tool-output-budget"

describe("fitToolOutputForModel", () => {
  it("returns output within the budget unchanged", () => {
    const text = "a".repeat(TOOL_OUTPUT_MAX_CHARS)
    expect(fitToolOutputForModel("glob", text)).toBe(text)
  })

  it("keeps the start and the end of oversized output and says what was cut and how to see it", () => {
    const lines = Array.from({ length: 200_000 }, (_, i) => `file-${i}.json`)
    const text = lines.join("\n")
    const fitted = fitToolOutputForModel("glob", text)
    expect(fitted.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + 400)
    expect(fitted.startsWith("file-0.json\nfile-1.json")).toBe(true)
    expect(fitted.endsWith("file-199999.json")).toBe(true)
    expect(fitted).toContain(`glob returned ${text.length.toLocaleString("en-US")} characters`)
    expect(fitted).toContain("narrow")
  })

  it("cuts on line boundaries so no line is split", () => {
    const text = Array.from({ length: 50_000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")
    const fitted = fitToolOutputForModel("shell", text)
    for (const line of fitted.split("\n")) {
      if (line.startsWith("[")) continue
      if (line === "") continue
      expect(line).toMatch(/^line \d+ x{20}$/)
    }
  })

  it("still fits output that is one enormous line", () => {
    const text = "y".repeat(TOOL_OUTPUT_MAX_CHARS * 5)
    const fitted = fitToolOutputForModel("read_file", text)
    expect(fitted.length).toBeLessThanOrEqual(TOOL_OUTPUT_MAX_CHARS + 400)
    expect(fitted).toContain("read_file returned")
  })
})
