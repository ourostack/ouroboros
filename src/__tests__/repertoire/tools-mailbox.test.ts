import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { registeredToolDefinitions, selectToolsForChannel } from "../../repertoire/tools"
import { callInTurnTool, listInTurnTools } from "../../repertoire/in-turn-tools-door"
import generated from "../../../actions/generated/mailbox-tools/tools.json"

describe("the in-turn registry routes the mailbox group from the generated tools.json", () => {
  it("registers each generated tool with its declared card", () => {
    for (const declared of generated.tools) {
      const definition = registeredToolDefinitions().find((d) => d.tool.function.name === declared.function.name)
      expect(definition?.tool.function).toEqual(declared.function)
      expect(definition?.ax).toEqual(declared.ax)
    }
  })

  it("serves them to the X-ray door with their cards, checked by the dispatcher like any tool", async () => {
    const listed = listInTurnTools().find((tool) => tool.function.name === "mailbox_list")
    expect(listed?.ax).toEqual(generated.tools[0]!.ax)
    await expect(callInTurnTool("mailbox_list", {})).resolves.toEqual(expect.objectContaining({ state: "refused", code: "not-run" }))
    await expect(callInTurnTool("mailbox_list", { all: "yes" })).resolves.toEqual(expect.objectContaining({ code: "invalid-arguments" }))
  })

  it("doesn't offer them in a turn before the letters store exists", () => {
    const selection = selectToolsForChannel({ channel: "cli", availableIntegrations: [], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } as never)
    expect(selection.ordinary.map((d) => d.tool.function.name)).not.toContain("mailbox_list")
  })
})
