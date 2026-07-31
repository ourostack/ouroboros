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

  it("returns presentation roles without exposing the authoritative ingress locator", async () => {
    const tool = findTool("orientation_get")
    const captureKeyHash = "a".repeat(64)

    const result = await tool.handler({}, {
      signin: async () => undefined,
      currentIngressEvidence: {
        schemaVersion: 1,
        provider: "bluebubbles",
        captureKeyHash,
      },
      orientationFrame: {
        schemaVersion: 1,
        channel: "bluebubbles",
        currentUserSpeech: ["Ari: please end the report"],
        priorAssistantReferents: [],
        signals: [],
        actionPolicy: { mode: "normal" },
        source: {
          kind: "bluebubbles",
          authority: "presentation_only",
          conversationKind: "group",
          event: {
            provider: "bluebubbles",
            kind: "message",
            sourceEventType: "new-message",
            fromMe: false,
          },
          actor: {
            role: "observed_actor",
            provider: "imessage-handle",
            externalId: "ari@example.test",
            displayName: "Ari",
          },
          participants: [{
            role: "group_participant_only",
            provider: "imessage-handle",
            externalId: "rachel@example.test",
            displayName: "Rachel",
          }],
        },
      },
    })

    const parsed = JSON.parse(result)
    expect(parsed.source).toMatchObject({
      authority: "presentation_only",
      actor: { role: "observed_actor", externalId: "ari@example.test" },
      participants: [{ role: "group_participant_only", externalId: "rachel@example.test" }],
    })
    expect(parsed).not.toHaveProperty("currentIngressEvidence")
    expect(result).not.toContain(captureKeyHash)
    expect(result).not.toContain("captureKeyHash")
  })
})
