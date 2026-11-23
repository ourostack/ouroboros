import { describe, expect, it } from "vitest"
import { reportFailureToolDefinition } from "../../repertoire/tools-escalation"

// The Ouro AX census's booklet-words check reads a door's description, its card's when line and its fixes: each says what the door does, not a rule for the reader.
const BOOKLET = /\b(always|never|do not|use this whenever|you must)\b/i

describe("report_failure", () => {
  it("says what it does, with no booklet words", () => {
    const def = reportFailureToolDefinition
    const texts = [def.tool.function.description ?? "", def.ax!.when, ...def.ax!.errors.map((error) => error.fix)]
    expect(texts.filter((text) => BOOKLET.test(text))).toEqual([])
  })

  it("still says a local save is not a delivery", () => {
    expect(reportFailureToolDefinition.tool.function.description).toMatch(/saved locally/)
    expect(reportFailureToolDefinition.tool.function.description).toMatch(/not a delivery or a GitHub issue/)
  })
})
