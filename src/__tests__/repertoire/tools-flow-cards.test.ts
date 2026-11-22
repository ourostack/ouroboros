import { describe, expect, it } from "vitest"

import { FLOW_TOOL_REFUSALS, observeTool, ponderTool, restTool, settleTool, speakTool, toolCards } from "../../repertoire/tools-flow"

const schemas = [ponderTool, observeTool, settleTool, speakTool, restTool]

describe("flow tool cards", () => {
  it("gives each turn-flow tool one card under its own id in the turn-flow group", () => {
    expect(toolCards.map((card) => card.id).sort()).toEqual(schemas.map((schema) => `tool:${schema.function.name}`).sort())
    for (const card of toolCards) expect(card.group, card.id).toBe("turn-flow")
  })

  it("ends every refusal with a code the tool's card names", () => {
    const codes = new Set(toolCards.flatMap((card) => card.errors.map((error) => error.code)))
    const texts = [
      FLOW_TOOL_REFUSALS.settleAlone,
      FLOW_TOOL_REFUSALS.observeAlone,
      FLOW_TOOL_REFUSALS.restAlone,
      FLOW_TOOL_REFUSALS.settleHeldWork,
      FLOW_TOOL_REFUSALS.restHeldWork,
      FLOW_TOOL_REFUSALS.restFreshWork,
      FLOW_TOOL_REFUSALS.speakEmpty,
      FLOW_TOOL_REFUSALS.speakNotDelivered("boom"),
      FLOW_TOOL_REFUSALS.ponderCreateIncomplete,
      FLOW_TOOL_REFUSALS.ponderReviseIncomplete,
      FLOW_TOOL_REFUSALS.ponderHeldWork,
    ]
    for (const text of texts) {
      const code = /\(code: ([a-z-]+)\)$/.exec(text)?.[1]
      expect(code, text).toBeDefined()
      expect(codes.has(code!), text).toBe(true)
    }
    expect(FLOW_TOOL_REFUSALS.speakNotDelivered("boom")).toContain("speak delivery failed: boom.")
  })

  it("keeps settle's schema as it was", () => {
    expect(settleTool.function.parameters).toEqual({
      type: "object",
      properties: {
        answer: { type: "string" },
        intent: { type: "string", enum: ["complete", "blocked", "direct_reply"] },
      },
      required: ["answer"],
    })
  })
})
