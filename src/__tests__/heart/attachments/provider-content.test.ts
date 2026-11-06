import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { pngBytes } from "../../fixtures/minimal-images"

const roots: string[] = []

afterEach(() => {
  vi.doUnmock("../../../heart/identity")
  vi.resetModules()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function makeAgentRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-provider-content-"))
  roots.push(root)
  return root
}

describe("attachment provider content", () => {
  it("rejects empty required image input without changing ordinary empty scopes", async () => {
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")
    const input = { agentName: "boss", model: "gpt-5.4", message: "hello", attachmentIds: [] }
    await expect(buildAttachmentProviderContent(input)).resolves.toBeUndefined()
    await expect(buildAttachmentProviderContent({ ...input, requireVision: true })).rejects.toThrow("no attachments")
  })

  it.each(["gpt-5.3-codex", "unknown-model"])("refuses silent text fallback for required image input on %s", async (model) => {
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")
    await expect(buildAttachmentProviderContent({
      agentName: "boss", model, message: "inspect this", attachmentIds: ["attachment:cli-local-file:missing"], requireVision: true,
    })).rejects.toThrow(/vision/)
  })

  it("projects durable images into one provider-only multimodal user message", async () => {
    const agentRoot = makeAgentRoot()
    const bytes = pngBytes()
    const { ingestInlinePromptImages } = await import("../../../heart/attachments/inline-image")
    const attachments = ingestInlinePromptImages(
      "boss",
      [{ data: bytes.toString("base64"), mimeType: "image/png", name: "screen.png" }],
      { agentRoot },
    )
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")
    const normalizeImage = async ({ sourcePath }: { sourcePath: string }) => ({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: bytes.length,
    })

    expect(await buildAttachmentProviderContent({
      agentName: "boss",
      agentRoot,
      model: "gpt-5.4",
      message: "inspect attachment:cli-local-file:abc",
      attachmentIds: attachments.map((attachment) => attachment.id),
      normalizeImage,
    })).toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
      },
      { type: "text", text: "inspect attachment:cli-local-file:abc" },
    ])
  })

  it("keeps non-vision models text-only so attachment tools remain the fallback", async () => {
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")
    expect(await buildAttachmentProviderContent({
      agentName: "boss",
      model: "gpt-5.3-codex",
      message: "inspect the attachment",
      attachmentIds: ["attachment:cli-local-file:missing"],
    })).toBeUndefined()
  })

  it("uses the resolved agent root and default normalization for safe images", async () => {
    const agentRoot = makeAgentRoot()
    vi.resetModules()
    vi.doMock("../../../heart/identity", async () => {
      const actual = await vi.importActual<typeof import("../../../heart/identity")>("../../../heart/identity")
      return { ...actual, getAgentRoot: vi.fn(() => agentRoot) }
    })
    const bytes = pngBytes()
    const { ingestInlinePromptImages } = await import("../../../heart/attachments/inline-image")
    const attachments = ingestInlinePromptImages(
      "boss",
      [{ data: bytes.toString("base64"), mimeType: "image/png", name: "screen.png" }],
      { agentRoot },
    )
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")

    await expect(buildAttachmentProviderContent({
      agentName: "boss",
      model: "gpt-5.4",
      message: "inspect it",
      attachmentIds: [attachments[0]!.id],
    })).resolves.toEqual([
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
      },
      { type: "text", text: "inspect it" },
    ])
  })

  it("fails closed for missing, empty, oversized, and unsupported image materialization", async () => {
    const agentRoot = makeAgentRoot()
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")
    await expect(buildAttachmentProviderContent({
      agentName: "boss",
      agentRoot,
      model: "gpt-5.4",
      message: "missing",
      attachmentIds: ["attachment:cli-local-file:missing"],
    })).rejects.toThrow("Attachment not found")

    const { ingestInlinePromptImages } = await import("../../../heart/attachments/inline-image")
    const attachment = ingestInlinePromptImages(
      "boss",
      [{ data: pngBytes().toString("base64"), mimeType: "image/png", name: "screen.png" }],
      { agentRoot },
    )[0]!
    const normalizedPath = path.join(agentRoot, "normalized.bin")

    for (const [label, bytes, expected] of [
      ["empty", Buffer.alloc(0), "exceeds the provider image byte limit"],
      ["oversized", Buffer.alloc(5 * 1024 * 1024 + 1), "exceeds the provider image byte limit"],
      ["unsupported", Buffer.from("not-an-image"), "is not a supported provider image"],
    ] as const) {
      fs.writeFileSync(normalizedPath, bytes)
      await expect(buildAttachmentProviderContent({
        agentName: "boss",
        agentRoot,
        model: "gpt-5.4",
        message: label,
        attachmentIds: [attachment.id],
        normalizeImage: async () => ({
          path: normalizedPath,
          mimeType: "image/png",
          byteCount: bytes.length,
        }),
      })).rejects.toThrow(expected)
    }
  })

  it("skips non-image attachments instead of failing mixed turns", async () => {
    const agentRoot = makeAgentRoot()
    const { buildCliLocalFileAttachmentRecord } = await import("../../../heart/attachments/sources/cli-local-file")
    const { cacheRecentAttachment } = await import("../../../heart/attachments/store")
    const document = cacheRecentAttachment(
      "boss",
      buildCliLocalFileAttachmentRecord({
        path: path.join(agentRoot, "document.pdf"),
        mimeType: "application/pdf",
        byteCount: 10,
      }),
      agentRoot,
    )
    const { buildAttachmentProviderContent } = await import("../../../heart/attachments/provider-content")

    expect(await buildAttachmentProviderContent({
      agentName: "boss",
      agentRoot,
      model: "gpt-5.4",
      message: "inspect the document",
      attachmentIds: [document.id],
    })).toBeUndefined()
    await expect(buildAttachmentProviderContent({
      agentName: "boss", agentRoot, model: "gpt-5.4", message: "inspect", attachmentIds: [document.id], requireVision: true,
    })).rejects.toThrow("no image attachments")
  })

  it("sniffs provider image format instead of trusting the data URL MIME", async () => {
    const bytes = pngBytes()
    const data = bytes.toString("base64")
    const { parseProviderImageDataUrl } = await import("../../../heart/attachments/provider-content")

    expect(parseProviderImageDataUrl(`data:application/octet-stream;base64,${data}`)).toEqual({
      mimeType: "image/png",
      data,
    })
  })

  it("rejects malformed, non-canonical, empty, and unsupported provider image data", async () => {
    const { parseProviderImageDataUrl } = await import("../../../heart/attachments/provider-content")

    expect(() => parseProviderImageDataUrl("https://example.test/image.png"))
      .toThrow("supported base64 data URL")
    expect(() => parseProviderImageDataUrl("data:image/png;base64,"))
      .toThrow("supported base64 data URL")
    expect(() => parseProviderImageDataUrl("data:image/png;base64,A"))
      .toThrow("canonical base64")
    expect(() => parseProviderImageDataUrl("data:image/png;base64,AB=="))
      .toThrow("canonical base64")
    expect(() => parseProviderImageDataUrl(`data:image/png;base64,${Buffer.from("not-an-image").toString("base64")}`))
      .toThrow("supported format")
  })
})
