import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: vi.fn() }))

import { registeredToolDefinitions, selectToolsForChannel } from "../../repertoire/tools"
import { callInTurnTool, listInTurnTools } from "../../repertoire/in-turn-tools-door"
import { validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
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
    expect(listed?.ax).toEqual(generated.tools.find((tool) => tool.function.name === "mailbox_list")!.ax)
    await expect(callInTurnTool("mailbox_list", {})).resolves.toEqual(expect.objectContaining({ state: "refused", code: "not-run" }))
    await expect(callInTurnTool("mailbox_list", { all: "yes" })).resolves.toEqual(expect.objectContaining({ code: "invalid-arguments" }))
  })

  it("advertises schemas the dispatcher's strict validator compiles, so a well-formed call reaches its handler", () => {
    const valid: Record<string, object> = {
      mailbox_send: { kind: "decide", subject: "Which?", whyOnlyYou: "Yours.", options: [{ label: "A", effect: "a" }, { label: "B", effect: "b" }], links: [{ label: "PR", url: "https://x" }], dedupeKey: "k", urgency: "today", holdUntil: "interactive", expiresAt: "2026-12-01T17:00:00Z", lane: "desk/x" },
      mailbox_list: { all: true, mine: true, kind: "do" },
      mailbox_read: { letter: "L1" },
      mailbox_wait: { letter: "L1", cursor: 0, timeout: 5 },
      mailbox_withdraw: { letter: "L1", reason: "moot" },
      mailbox_deliver: { letter: "L1" },
    }
    for (const declared of generated.tools) {
      const args = valid[declared.function.name]!
      expect([declared.function.name, validateAdvertisedToolArguments(JSON.stringify(args), declared.function.parameters as never)])
        .toEqual([declared.function.name, expect.objectContaining({ ok: true })])
    }
  })

  it("offers them in every ordinary turn, and the person-only answer in none", () => {
    const selection = selectToolsForChannel({ channel: "cli", availableIntegrations: [], supportsMarkdown: true, supportsStreaming: true, supportsRichCards: false, maxMessageLength: Infinity } as never)
    const offered = selection.ordinary.map((d) => d.tool.function.name)
    for (const declared of generated.tools) expect(offered).toContain(declared.function.name)
    expect(offered).not.toContain("mailbox_answer")
  })

  it("answers a model that calls the person-only mailbox_answer with its refusal, before any handler", async () => {
    await expect(callInTurnTool("mailbox_answer", { letter: "L1", option: "2" })).resolves.toEqual(expect.objectContaining({ state: "refused" }))
  })
})
