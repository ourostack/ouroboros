import { describe, expect, it } from "vitest"
import { orientationToolDefinitions } from "../../repertoire/tools-orientation"

function findTool(name: string) {
  const def = orientationToolDefinitions.find((candidate) => candidate.tool.function.name === name)
  if (!def) throw new Error(`Tool "${name}" not found`)
  return def
}

describe("orientation_get tool", () => {
  it("returns a clear message when no orientation frame exists", async () => {
    const tool = findTool("orientation_get")

    expect(await tool.handler({})).toBe("no orientation frame is available for this turn.")
  })

  it("returns the current frame as structured JSON", async () => {
    const tool = findTool("orientation_get")

    const result = await tool.handler({}, {
      signin: async () => undefined,
      orientationFrame: {
        schemaVersion: 1,
        channel: "bluebubbles",
        currentUserSpeech: ["same"],
        priorAssistantReferents: [
          { kind: "ordered_list_item", label: "1", text: "small fix" },
        ],
        signals: ["terse_referent"],
        actionPolicy: {
          mode: "correction_hold",
          reason: "Current user speech appears referent-dependent; inspect orientation before mutating durable state.",
        },
      },
    })

    expect(JSON.parse(result)).toMatchObject({
      channel: "bluebubbles",
      currentUserSpeech: ["same"],
      priorAssistantReferents: [{ label: "1", text: "small fix" }],
      actionPolicy: { mode: "correction_hold" },
    })
  })
})
