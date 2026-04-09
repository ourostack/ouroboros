import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  MAX_VLM_IMAGE_BYTES,
  normalizeImageForVision,
} from "../../../heart/attachments/image-normalize"
import { buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/types"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-normalize-"))
  tempDirs.push(dir)
  return dir
}

function makeFile(dir: string, name: string, content = "file"): string {
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

describe("normalizeImageForVision", () => {
  it("passes through already-safe supported images without transcoding", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "already-safe.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: MAX_VLM_IMAGE_BYTES - 1,
    })
    const probeImage = vi.fn()
    const encodeVariant = vi.fn()

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
      encodeVariant,
    })

    expect(result.path).toBe(sourcePath)
    expect(result.mimeType).toBe("image/png")
    expect(result.byteCount).toBe(MAX_VLM_IMAGE_BYTES - 1)
    expect(probeImage).not.toHaveBeenCalled()
    expect(encodeVariant).not.toHaveBeenCalled()
  })

  it("iterates deterministic jpeg attempts until one fits the transport budget", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "oversize.tiff")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: MAX_VLM_IMAGE_BYTES + 1_000,
    })
    const attempts: Array<{ format: string; maxEdge: number; quality?: string }> = []
    const encodeVariant = vi.fn(async (input: { targetFormat: string; maxEdge: number; quality?: string; outputDir: string }) => {
      attempts.push({
        format: input.targetFormat,
        maxEdge: input.maxEdge,
        quality: input.quality,
      })
      const filename = `${input.targetFormat}-${input.maxEdge}-${input.quality ?? "na"}.jpg`
      const outputPath = path.join(input.outputDir, filename)
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return {
        path: outputPath,
        mimeType: "image/jpeg",
        byteCount: input.quality === "80" ? MAX_VLM_IMAGE_BYTES - 500 : MAX_VLM_IMAGE_BYTES + 2_000,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
      encodeVariant,
    })

    expect(attempts.slice(0, 3)).toEqual([
      { format: "jpeg", maxEdge: 3072, quality: "best" },
      { format: "jpeg", maxEdge: 3072, quality: "90" },
      { format: "jpeg", maxEdge: 3072, quality: "80" },
    ])
    expect(result.mimeType).toBe("image/jpeg")
    expect(result.byteCount).toBe(MAX_VLM_IMAGE_BYTES - 500)
  })

  it("tries png first for alpha images, then falls back to jpeg when png stays too large", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "alpha.heic")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/heic",
      byteCount: MAX_VLM_IMAGE_BYTES + 1_000,
    })
    const attempts: string[] = []
    const encodeVariant = vi.fn(async (input: { targetFormat: string; outputDir: string }) => {
      attempts.push(input.targetFormat)
      const outputPath = path.join(input.outputDir, `${attempts.length}.${input.targetFormat}`)
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, input.targetFormat)
      return {
        path: outputPath,
        mimeType: `image/${input.targetFormat}`,
        byteCount: input.targetFormat === "png" ? MAX_VLM_IMAGE_BYTES + 10 : MAX_VLM_IMAGE_BYTES - 10,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage: vi.fn().mockResolvedValue({ hasAlpha: true }),
      encodeVariant,
    })

    expect(attempts[0]).toBe("png")
    expect(attempts).toContain("jpeg")
    expect(result.mimeType).toBe("image/jpeg")
  })

  it("falls back to Quick Look rasterization when the source probe fails", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "mystery.bmp")
    const rasterizedPath = makeFile(agentRoot, "rasterized.png")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/bmp",
      byteCount: MAX_VLM_IMAGE_BYTES + 2_000,
    })
    const probeImage = vi
      .fn()
      .mockRejectedValueOnce(new Error("sips could not read image"))
      .mockResolvedValueOnce({ hasAlpha: false })
    const rasterizeWithQuickLook = vi.fn().mockResolvedValue(rasterizedPath)
    const encodeVariant = vi.fn(async (input: { outputDir: string }) => {
      const outputPath = path.join(input.outputDir, "normalized.jpg")
      fs.mkdirSync(input.outputDir, { recursive: true })
      fs.writeFileSync(outputPath, "jpeg")
      return {
        path: outputPath,
        mimeType: "image/jpeg",
        byteCount: MAX_VLM_IMAGE_BYTES - 10,
      }
    })

    const result = await normalizeImageForVision({
      attachment,
      sourcePath,
      agentName: "slugger",
      agentRoot,
      probeImage,
      rasterizeWithQuickLook,
      encodeVariant,
    })

    expect(rasterizeWithQuickLook).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePath,
        outputDir: expect.stringContaining(path.join("state", "attachments", "materialized")),
      }),
    )
    expect(result.path).toContain("normalized.jpg")
  })

  it("throws a narrow error when no normalized variant can fit the budget", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "still-too-big.gif")
    const attachment = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/gif",
      byteCount: MAX_VLM_IMAGE_BYTES + 5_000,
    })

    await expect(
      normalizeImageForVision({
        attachment,
        sourcePath,
        agentName: "slugger",
        agentRoot,
        probeImage: vi.fn().mockResolvedValue({ hasAlpha: false }),
        encodeVariant: vi.fn(async (input: { outputDir: string }) => {
          const outputPath = path.join(input.outputDir, "too-big.jpg")
          fs.mkdirSync(input.outputDir, { recursive: true })
          fs.writeFileSync(outputPath, "jpeg")
          return {
            path: outputPath,
            mimeType: "image/jpeg",
            byteCount: MAX_VLM_IMAGE_BYTES + 1,
          }
        }),
      }),
    ).rejects.toThrow("could not be normalized under the VLM byte budget")
  })
})
