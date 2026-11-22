import { describe, expect, it } from "vitest"

import type { ToolContext } from "../../repertoire/tools-base"
import { shepherdSendToolDefinition, shepherdToolDefinitions } from "../../repertoire/tools-shepherd"
import { shepherdGuidanceToolDefinitions } from "../../repertoire/tools-shepherd-guidance"

const family = { context: { friend: { id: "friend-ari", name: "Ari", trustLevel: "family" } } } as unknown as ToolContext

describe("Shepherd tool cards", () => {
  it("gives every Shepherd tool a card under its own id in the turn-shepherd group", () => {
    expect(shepherdToolDefinitions).toHaveLength(11)
    for (const definition of shepherdToolDefinitions) {
      expect(definition.ax, definition.tool.function.name).toMatchObject({ id: `tool:${definition.tool.function.name}`, group: "turn-shepherd" })
    }
  })

  it("calls a tool read exactly when its risk profile says it changes nothing", () => {
    for (const definition of shepherdToolDefinitions) {
      const mutates = (definition.riskProfile as { mutates: string }).mutates
      expect(definition.ax!.effect, definition.tool.function.name).toBe(mutates === "none" ? "read" : "write")
    }
  })

  it("refuses a choosing key with no screen under screen-required", async () => {
    expect(JSON.parse(await shepherdSendToolDefinition.handler({ session: "surface:1", key: "enter" }, family))).toEqual({
      error: "enter can approve or choose on a prompt, so pass screen from a shepherd_read made just before", code: "screen-required",
    })
  })

  it("ends each guidance refusal with its code", async () => {
    const [history] = shepherdGuidanceToolDefinitions
    expect(JSON.parse(await history!.handler({}, undefined))).toMatchObject({ code: "family-only" })
    expect(JSON.parse(await history!.handler({}, family))).toEqual({ error: "Shepherd guidance needs an agent runtime", code: "no-agent-runtime" })
  })
})
