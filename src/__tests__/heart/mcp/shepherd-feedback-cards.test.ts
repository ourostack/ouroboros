import { describe, expect, it } from "vitest"
import { getToolSchemas } from "../../../heart/mcp/mcp-server"

// The Ouro AX census's booklet-words check reads a door's description, its card's when line and its fixes: each says what the door does, not a rule for the reader.
const BOOKLET = /\b(always|never|do not|use this whenever|you must)\b/i

describe("shepherd feedback MCP tools", () => {
  for (const name of ["shepherd_feedback", "shepherd_feedback_status"]) {
    it(`${name} says what it does, with no booklet words`, () => {
      const schema = getToolSchemas().find((tool) => tool.name === name)!
      const texts = [schema.description, schema.ax!.when, ...schema.ax!.errors.map((error) => error.fix)]
      expect(texts.filter((text) => BOOKLET.test(text))).toEqual([])
    })
  }
})
