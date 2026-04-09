import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const testState = vi.hoisted(() => ({
  agentRoot: "",
}))

vi.mock("../../heart/identity", async () => {
  const actual = await vi.importActual<typeof import("../../heart/identity")>("../../heart/identity")
  return {
    ...actual,
    getAgentName: vi.fn(() => "testagent"),
    getAgentRoot: vi.fn(() => testState.agentRoot),
    getAgentToolsRoot: vi.fn(() => path.join(testState.agentRoot, "state", "tools")),
  }
})

vi.mock("../../heart/providers/minimax-vlm", () => ({
  minimaxVlmDescribe: vi.fn(),
}))

import { getToolsForChannel } from "../../repertoire/tools"
import { attachmentToolDefinitions } from "../../repertoire/tools-attachments"
import { getChannelCapabilities } from "../../mind/friends/channel"
import { rememberRecentAttachment } from "../../heart/attachments/store"
import { buildCliLocalFileAttachmentRecord } from "../../heart/attachments/types"
import * as materializeModule from "../../heart/attachments/materialize"
import { minimaxVlmDescribe } from "../../heart/providers/minimax-vlm"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tools-attachments-"))
  tempDirs.push(dir)
  testState.agentRoot = dir
  return dir
}

function writeFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, "utf-8")
  return filePath
}

beforeEach(() => {
  vi.resetAllMocks()
  testState.agentRoot = ""
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("attachment tool registration", () => {
  it("includes describe_image even on vision-capable chat models", () => {
    const tools = getToolsForChannel(
      getChannelCapabilities("bluebubbles"),
      undefined,
      undefined,
      undefined,
      undefined,
      "claude-opus-4-6",
    )

    expect(tools.find((tool) => tool.function.name === "describe_image")).toBeDefined()
  })

  it("exports generic attachment tools in the shared registry", () => {
    const names = attachmentToolDefinitions.map((def) => def.tool.function.name)
    expect(names).toEqual(expect.arrayContaining(["list_recent_attachments", "materialize_attachment", "describe_image"]))
  })
})

describe("attachment tool handlers", () => {
  it("lists recent attachments as JSON", async () => {
    const agentRoot = makeAgentRoot()
    rememberRecentAttachment(
      "testagent",
      buildCliLocalFileAttachmentRecord({
        path: "/tmp/screenshot.png",
        mimeType: "image/png",
        byteCount: 1234,
      }),
      agentRoot,
    )

    const tool = attachmentToolDefinitions.find((def) => def.tool.function.name === "list_recent_attachments")!
    const raw = await tool.handler({ limit: "5" })
    const parsed = JSON.parse(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data).toHaveLength(1)
    expect(parsed.data[0]?.id).toContain("attachment:cli-local-file:")
  })

  it("materializes attachments as JSON", async () => {
    const agentRoot = makeAgentRoot()
    const attachmentPath = writeFile(agentRoot, "capture.png", "png-bytes")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: attachmentPath,
      mimeType: "image/png",
      byteCount: 9,
    })
    rememberRecentAttachment("testagent", attachment, agentRoot)

    const tool = attachmentToolDefinitions.find((def) => def.tool.function.name === "materialize_attachment")!
    const raw = await tool.handler({ attachment_id: attachment.id, variant: "original" })
    const parsed = JSON.parse(raw)

    expect(parsed.ok).toBe(true)
    expect(parsed.data.path).toBe(attachmentPath)
    expect(parsed.data.variant).toBe("original")
  })

  it("describes images via attachment_id and vision-safe materialization", async () => {
    const agentRoot = makeAgentRoot()
    const normalizedPath = writeFile(agentRoot, "normalized.jpg", "jpeg-bytes")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: "/tmp/screenshot.tiff",
      mimeType: "image/tiff",
      byteCount: 100,
    })
    rememberRecentAttachment("testagent", attachment, agentRoot)

    vi.spyOn(materializeModule, "materializeAttachment").mockResolvedValue({
      attachmentId: attachment.id,
      variant: "vision_safe",
      path: normalizedPath,
      displayName: "screenshot.tiff",
      mimeType: "image/jpeg",
      byteCount: 10,
    })
    vi.mocked(minimaxVlmDescribe).mockResolvedValue("booking confirmation screenshot")

    const tool = attachmentToolDefinitions.find((def) => def.tool.function.name === "describe_image")!
    const result = await tool.handler({ attachment_id: attachment.id, prompt: "what booking is this?" })

    expect(materializeModule.materializeAttachment).toHaveBeenCalledWith(
      "testagent",
      attachment.id,
      expect.objectContaining({ variant: "vision_safe" }),
    )
    expect(minimaxVlmDescribe).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "what booking is this?",
        imageDataUrl: expect.stringContaining("data:image/jpeg;base64,"),
      }),
    )
    expect(result).toBe("booking confirmation screenshot")
  })

  it("accepts attachment_guid as a compatibility alias", async () => {
    const agentRoot = makeAgentRoot()
    const normalizedPath = writeFile(agentRoot, "normalized.jpg", "jpeg-bytes")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: "/tmp/screenshot.tiff",
      mimeType: "image/tiff",
      byteCount: 100,
    })
    rememberRecentAttachment("testagent", attachment, agentRoot)

    vi.spyOn(materializeModule, "materializeAttachment").mockResolvedValue({
      attachmentId: attachment.id,
      variant: "vision_safe",
      path: normalizedPath,
      displayName: "screenshot.tiff",
      mimeType: "image/jpeg",
      byteCount: 10,
    })
    vi.mocked(minimaxVlmDescribe).mockResolvedValue("booking confirmation screenshot")

    const tool = attachmentToolDefinitions.find((def) => def.tool.function.name === "describe_image")!
    await tool.handler({ attachment_guid: attachment.id, prompt: "what booking is this?" })

    expect(materializeModule.materializeAttachment).toHaveBeenCalledWith(
      "testagent",
      attachment.id,
      expect.any(Object),
    )
  })

  it("returns a structured friction envelope when an attachment cannot be found", async () => {
    makeAgentRoot()
    const tool = attachmentToolDefinitions.find((def) => def.tool.function.name === "describe_image")!
    const raw = await tool.handler({ attachment_id: "attachment:bluebubbles:missing", prompt: "what is this?" })
    const parsed = JSON.parse(raw)

    expect(parsed.ok).toBe(false)
    expect(parsed.tool).toBe("describe_image")
    expect(parsed.friction.kind).toBe("local_repair")
    expect(parsed.friction.suggested_next_actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "tool", tool: "list_recent_attachments" }),
      ]),
    )
  })
})
