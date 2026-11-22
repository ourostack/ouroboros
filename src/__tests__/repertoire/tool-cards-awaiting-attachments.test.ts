import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

vi.mock("../../heart/identity", () => ({ getAgentRoot: () => path.join(os.tmpdir(), "tool-cards-await-test-unused"), getAgentName: () => "slugger" }))

// tools-base assembles every tool module, so load it first, as the runtime does.
await import("../../repertoire/tools-base")
const { awaitingToolDefinitions } = await import("../../repertoire/tools-awaiting")
const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/

describe("await and attachment tool cards", () => {
  const defs = [...awaitingToolDefinitions, ...attachmentToolDefinitions]

  it("gives every tool a card named after it, with kebab-case codes", () => {
    for (const def of defs) {
      expect(def.ax?.id).toBe(`tool:${def.tool.function.name}`)
      expect(def.ax?.errors.length).toBeGreaterThan(0)
      for (const error of def.ax!.errors) expect(error.code).toMatch(KEBAB)
    }
  })

  it("marks only list_recent_attachments read, with an explicit low-risk profile", () => {
    const reads = defs.filter((def) => def.ax?.effect === "read")
    expect(reads.map((def) => def.tool.function.name)).toEqual(["list_recent_attachments"])
    expect(reads[0].riskProfile).toEqual({ mutates: "none", risk: "low" })
  })

  it("puts the awaits and the attachments in their own groups", () => {
    expect(awaitingToolDefinitions.map((def) => def.ax?.group)).toEqual(["turn-awaits", "turn-awaits", "turn-awaits"])
    expect(attachmentToolDefinitions.map((def) => def.ax?.group)).toEqual(["turn-attachments", "turn-attachments", "turn-attachments"])
  })

  it("ends a refusal with the code its card names", async () => {
    const cancel = awaitingToolDefinitions.find((def) => def.tool.function.name === "cancel_await")!
    const refusal = JSON.parse(await cancel.handler({ name: "has spaces" }))
    expect(refusal.code).toBe("invalid-await-name")
    expect(cancel.ax!.errors.map((error) => error.code)).toContain(refusal.code)
    const materialize = attachmentToolDefinitions.find((def) => def.tool.function.name === "materialize_attachment")!
    const friction = JSON.parse(await materialize.handler({ variant: "original" }))
    expect(friction.friction.signature).toBe("materialize_attachment:missing-attachment-id")
  })
})
