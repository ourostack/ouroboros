import { describe, expect, it } from "vitest"
// tools-base assembles every tool module and tools-a2a imports withCode from it, so load tools-base first, as the runtime does.
import "../../repertoire/tools-base"
import { a2aToolDefinitions } from "../../repertoire/tools-a2a"
import { bridgeToolDefinitions } from "../../repertoire/tools-bridge"

const definitions = [...a2aToolDefinitions, ...bridgeToolDefinitions]

describe("A2A and bridge tool cards", () => {
  it("gives every tool an Ouro AX card named after it, with kebab-case error codes", () => {
    for (const definition of definitions) {
      expect(definition.ax?.id).toBe(`tool:${definition.tool.function.name}`)
      expect(definition.ax!.errors.length).toBeGreaterThan(0)
      for (const error of definition.ax!.errors) expect(error.code).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/)
    }
  })

  it("marks only the lookups read, each with an explicit low-risk profile", () => {
    const reads = definitions.filter((definition) => definition.ax?.effect === "read").map((definition) => definition.tool.function.name)
    expect(reads).toEqual(["a2a_list_peers", "a2a_get_task", "list_delegations"])
    for (const definition of definitions.filter((entry) => entry.ax?.effect === "read")) {
      expect(definition.riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
  })
})
