import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { materializeAttachment, persistBlueBubblesAttachmentSource } from "../../../heart/attachments/materialize"
import { rememberRecentAttachment } from "../../../heart/attachments/store"
import { buildBlueBubblesAttachmentRecord, buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/types"
import * as configModule from "../../../heart/config"
import * as downloadModule from "../../../senses/bluebubbles/attachment-download"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-materialize-"))
  tempDirs.push(dir)
  return dir
}

function makeFile(dir: string, name: string, content: string): string {
  const target = path.join(dir, name)
  fs.writeFileSync(target, content, "utf-8")
  return target
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("materializeAttachment", () => {
  it("persists BlueBubbles sources with the correct extension mapping", async () => {
    const agentRoot = makeAgentRoot()
    const cases = [
      ["image/jpeg", ".jpg"],
      ["image/png", ".png"],
      ["image/webp", ".webp"],
      ["image/gif", ".gif"],
      ["image/tiff", ".tiff"],
      ["image/bmp", ".bmp"],
      ["image/heic", ".heic"],
      ["application/pdf", ".pdf"],
      ["audio/mp3", ".mp3"],
      ["audio/mpeg", ".mp3"],
      ["audio/mp4", ".m4a"],
    ] as const

    for (const [mimeType, extension] of cases) {
      const record = buildBlueBubblesAttachmentRecord({
        guid: `GUID-${extension}`,
        transferName: "attachment",
        mimeType,
      })
      const persisted = await persistBlueBubblesAttachmentSource(
        "slugger",
        record,
        { buffer: Buffer.from("bytes"), mimeType, byteCount: 5 },
        agentRoot,
      )

      expect(persisted.sourceData.localPath).toContain(`original${extension}`)
    }
  })

  it("falls back to the attachment mime type when persisting a BlueBubbles source without an explicit mime", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-fallback-mime",
      transferName: "capture",
      mimeType: "image/png",
      totalBytes: 5,
    })

    const persisted = await persistBlueBubblesAttachmentSource(
      "slugger",
      record,
      { buffer: Buffer.from("bytes"), byteCount: 5 },
      agentRoot,
    )

    expect(persisted.mimeType).toBe("image/png")
    expect(persisted.sourceData.localPath).toContain("original.png")
  })

  it("falls back to the attachment byte count when persisting a BlueBubbles source without an explicit byte size", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-fallback-bytes",
      transferName: "capture.png",
      mimeType: "image/png",
      totalBytes: 7,
    })

    const persisted = await persistBlueBubblesAttachmentSource(
      "slugger",
      record,
      { buffer: Buffer.from("bytes") },
      agentRoot,
    )

    expect(persisted.byteCount).toBe(7)
    expect(persisted.sourceData.localPath).toContain("original.png")
  })

  it("persists attachments without an extension when neither the name nor mime suggests one", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-no-extension",
      transferName: "capture",
    })

    const persisted = await persistBlueBubblesAttachmentSource(
      "slugger",
      record,
      { buffer: Buffer.from("bytes") },
      agentRoot,
    )

    expect(persisted.sourceData.localPath).toMatch(/original$/)
  })

  it("persists attachments without an extension when the mime type is present but unrecognized", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-unknown-mime",
      transferName: "capture",
      mimeType: "application/octet-stream",
    })

    const persisted = await persistBlueBubblesAttachmentSource(
      "slugger",
      record,
      { buffer: Buffer.from("bytes"), mimeType: "application/octet-stream", byteCount: 5 },
      agentRoot,
    )

    expect(persisted.sourceData.localPath).toMatch(/original$/)
  })

  it("returns the original CLI file path for original variants", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "capture.png", "not-really-a-png")
    const record = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: 17,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    const materialized = await materializeAttachment("slugger", record.id, {
      agentRoot,
      variant: "original",
    })

    expect(materialized.path).toBe(sourcePath)
    expect(materialized.displayName).toBe("capture.png")
    expect(materialized.variant).toBe("original")
    expect(materialized.byteCount).toBe(17)
  })

  it("delegates image normalization for vision_safe variants", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "capture.tiff", "tiff-bytes")
    const normalizedPath = makeFile(agentRoot, "capture.jpg", "jpeg-bytes")
    const record = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: 18,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    const normalizeImage = vi.fn().mockResolvedValue({
      path: normalizedPath,
      mimeType: "image/jpeg",
      byteCount: 11,
    })

    const materialized = await materializeAttachment("slugger", record.id, {
      agentRoot,
      variant: "vision_safe",
      normalizeImage,
    })

    expect(normalizeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ id: record.id }),
        sourcePath,
      }),
    )
    expect(materialized.path).toBe(normalizedPath)
    expect(materialized.mimeType).toBe("image/jpeg")
    expect(materialized.variant).toBe("vision_safe")
  })

  it("materializes BlueBubbles originals from a persisted local path or fallback copy", async () => {
    const agentRoot = makeAgentRoot()
    const localPath = makeFile(agentRoot, "local.jpg", "jpeg")
    const localRecord = buildBlueBubblesAttachmentRecord(
      {
        guid: "GUID-local",
        transferName: "local",
        mimeType: "image/jpeg",
      },
      1,
      { localPath, byteCount: 4 },
    )
    rememberRecentAttachment("slugger", localRecord, agentRoot)

    const fromLocal = await materializeAttachment("slugger", localRecord.id, { agentRoot, variant: "original" })
    expect(fromLocal.path).toBe(localPath)

    const fallbackRecord = buildBlueBubblesAttachmentRecord({
      guid: "GUID-fallback",
      transferName: "fallback",
      mimeType: "image/jpeg",
    })
    const fallbackPath = path.join(agentRoot, "state", "attachments", "materialized", "bluebubbles", "GUID-fallback", "original.jpg")
    fs.mkdirSync(path.dirname(fallbackPath), { recursive: true })
    fs.writeFileSync(fallbackPath, "jpeg")
    rememberRecentAttachment("slugger", fallbackRecord, agentRoot)

    const fromFallback = await materializeAttachment("slugger", fallbackRecord.id, { agentRoot, variant: "original" })
    expect(fromFallback.path).toBe(fallbackPath)
  })

  it("downloads and persists BlueBubbles originals on demand", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-download",
      transferName: "download",
      mimeType: "image/png",
    })
    rememberRecentAttachment("slugger", record, agentRoot)
    vi.spyOn(configModule, "getBlueBubblesConfig").mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret",
      accountId: "default",
    })
    vi.spyOn(configModule, "getBlueBubblesChannelConfig").mockReturnValue({
      port: 1234,
      webhookPath: "/bb",
      requestTimeoutMs: 1_000,
    })
    vi.spyOn(downloadModule, "downloadBlueBubblesAttachment").mockResolvedValue({
      buffer: Buffer.from("downloaded"),
      contentType: "image/png",
    })

    const materialized = await materializeAttachment("slugger", record.id, { agentRoot, variant: "original" })

    expect(downloadModule.downloadBlueBubblesAttachment).toHaveBeenCalled()
    expect(materialized.path).toContain(path.join("bluebubbles", "GUID-download", "original.png"))
    expect(fs.readFileSync(materialized.path, "utf-8")).toBe("downloaded")
  })

  it("falls back to the stored attachment mime when BlueBubbles download content type is missing", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildBlueBubblesAttachmentRecord({
      guid: "GUID-download-fallback",
      transferName: "download",
      mimeType: "image/png",
    })
    rememberRecentAttachment("slugger", record, agentRoot)
    vi.spyOn(configModule, "getBlueBubblesConfig").mockReturnValue({
      serverUrl: "http://bluebubbles.local",
      password: "secret",
      accountId: "default",
    })
    vi.spyOn(configModule, "getBlueBubblesChannelConfig").mockReturnValue({
      port: 1234,
      webhookPath: "/bb",
      requestTimeoutMs: 1_000,
    })
    vi.spyOn(downloadModule, "downloadBlueBubblesAttachment").mockResolvedValue({
      buffer: Buffer.from("downloaded"),
      contentType: undefined,
    })

    const materialized = await materializeAttachment("slugger", record.id, { agentRoot, variant: "original" })

    expect(materialized.mimeType).toBe("image/png")
    expect(materialized.path).toContain(path.join("bluebubbles", "GUID-download-fallback", "original.png"))
  })

  it("rejects vision_safe for non-image attachments", async () => {
    const agentRoot = makeAgentRoot()
    const record = buildCliLocalFileAttachmentRecord({
      path: makeFile(agentRoot, "notes.pdf", "pdf"),
      mimeType: "application/pdf",
      byteCount: 3,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    await expect(
      materializeAttachment("slugger", record.id, { agentRoot, variant: "vision_safe" }),
    ).rejects.toThrow("is not an image")
  })

  it("falls back to the attachment mime when normalization omits mimeType", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "capture.tiff", "tiff-bytes")
    const normalizedPath = makeFile(agentRoot, "capture-no-mime.jpg", "jpeg-bytes")
    const record = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: 18,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    const materialized = await materializeAttachment("slugger", record.id, {
      agentRoot,
      variant: "vision_safe",
      normalizeImage: vi.fn().mockResolvedValue({
        path: normalizedPath,
        byteCount: 11,
      }),
    })

    expect(materialized.mimeType).toBe("image/tiff")
    expect(materialized.path).toBe(normalizedPath)
  })

  it("rejects unknown attachment ids", async () => {
    const agentRoot = makeAgentRoot()

    await expect(
      materializeAttachment("slugger", "attachment:bluebubbles:missing", { agentRoot }),
    ).rejects.toThrow("Attachment not found: attachment:bluebubbles:missing")
  })
})
