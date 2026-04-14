import { beforeEach, describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../nerves/runtime"

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => "/tmp/agents/testagent"),
    getAgentToolsRoot: vi.fn(() => "/tmp/agents/testagent/state/tools"),
  }
})

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.test_run",
    message: testName,
    meta: { test: true },
  })
}

describe("describe_image tool", () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe("tool schema and AX-1 description", () => {
    it("appears in the shared attachment tool registry", async () => {
      emitTestEvent("describe_image shared registry")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")
      expect(def).toBeDefined()
    })

    it("description is a paragraph (>=150 chars) and not a one-liner starting with 'Describes'", async () => {
      emitTestEvent("describe_image description length")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")!
      const description = def.tool.function.description ?? ""
      expect(description.length).toBeGreaterThanOrEqual(150)
      expect(description).not.toMatch(/^Describes? (an )?image\.$/)
    })

    it("description mentions VLM use, targeted prompts, and attachment normalization", async () => {
      emitTestEvent("describe_image description semantics")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")!
      const description = (def.tool.function.description ?? "").toLowerCase()
      expect(description).toMatch(/vision-language model|\bvlm\b/)
      expect(description).toContain("targeted")
      expect(description).toMatch(/normalize|normalizes|normalizing/)
      expect(description).toMatch(/attachment_id|attachment guid|attachment_guid/)
    })

    it("accepts attachment_id, keeps attachment_guid as a compatibility alias, and requires prompt", async () => {
      emitTestEvent("describe_image params")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")!
      const params = def.tool.function.parameters as {
        type: string
        properties: Record<string, { type: string; description?: string }>
        required?: string[]
      }
      expect(params.type).toBe("object")
      expect(params.properties.attachment_id?.type).toBe("string")
      expect(params.properties.attachment_guid?.type).toBe("string")
      expect(params.properties.prompt?.type).toBe("string")
      expect(params.required).toEqual(["prompt"])
    })
  })

  describe("tool-set registration", () => {
    it("is available for BlueBubbles on non-vision models", async () => {
      emitTestEvent("describe_image bluebubbles non-vision")
      const { getToolsForChannel } = await import("../../repertoire/tools")
      const { getChannelCapabilities } = await import("../../mind/friends/channel")
      const tools = getToolsForChannel(
        getChannelCapabilities("bluebubbles"),
        undefined,
        undefined,
        undefined,
        undefined,
        "MiniMax-M2.5",
      )
      expect(tools.find((t) => t.function.name === "describe_image")).toBeDefined()
    })

    it("stays available for BlueBubbles on vision-capable models", async () => {
      emitTestEvent("describe_image bluebubbles vision")
      const { getToolsForChannel } = await import("../../repertoire/tools")
      const { getChannelCapabilities } = await import("../../mind/friends/channel")
      const tools = getToolsForChannel(
        getChannelCapabilities("bluebubbles"),
        undefined,
        undefined,
        undefined,
        undefined,
        "claude-opus-4-6",
      )
      expect(tools.find((t) => t.function.name === "describe_image")).toBeDefined()
    })

    it("is also available on non-BlueBubbles channels because attachment handling is cross-sense", async () => {
      emitTestEvent("describe_image teams")
      const { getToolsForChannel } = await import("../../repertoire/tools")
      const { getChannelCapabilities } = await import("../../mind/friends/channel")
      const tools = getToolsForChannel(
        getChannelCapabilities("teams"),
        undefined,
        undefined,
        undefined,
        undefined,
        "claude-opus-4-6",
      )
      expect(tools.find((t) => t.function.name === "describe_image")).toBeDefined()
    })
  })

  describe("recoverable errors", () => {
    it("returns structured friction when attachment id is missing", async () => {
      emitTestEvent("describe_image missing attachment id")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")!
      const raw = await def.handler({ prompt: "what is in this image?" }, undefined)
      const parsed = JSON.parse(raw) as {
        ok: boolean
        tool: string
        friction: { kind: string; suggested_next_actions: Array<{ kind: string; tool?: string }> }
      }
      expect(parsed.ok).toBe(false)
      expect(parsed.tool).toBe("describe_image")
      expect(parsed.friction.kind).toBe("input_error")
      expect(parsed.friction.suggested_next_actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "tool", tool: "list_recent_attachments" })]),
      )
    })

    it("returns structured friction when prompt is missing", async () => {
      emitTestEvent("describe_image missing prompt")
      const { attachmentToolDefinitions } = await import("../../repertoire/tools-attachments")
      const def = attachmentToolDefinitions.find((d) => d.tool.function.name === "describe_image")!
      const raw = await def.handler({ attachment_id: "attachment:bluebubbles:test" }, undefined)
      const parsed = JSON.parse(raw) as {
        ok: boolean
        friction: { kind: string; suggested_next_actions: Array<{ kind: string; message?: string }> }
      }
      expect(parsed.ok).toBe(false)
      expect(parsed.friction.kind).toBe("input_error")
      expect(parsed.friction.suggested_next_actions).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "message" })]),
      )
    })
  })
})
