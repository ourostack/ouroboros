import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AttachmentRecord } from "./types"

export const MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE = 32 * 1024 * 1024
export const MAX_VLM_IMAGE_BYTES = 5 * 1024 * 1024

const SAFE_VLM_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"])
const SIZE_STEPS = [3072, 2560, 2048, 1600, 1280, 1024, 768] as const
const JPEG_QUALITIES = ["best", "90", "80", "70", "60"] as const

interface ProbeImageResult {
  hasAlpha: boolean
}

interface ProbeImageInput {
  sourcePath: string
}

interface RasterizeQuickLookInput {
  sourcePath: string
  outputDir: string
}

interface EncodeVariantInput {
  sourcePath: string
  outputDir: string
  targetFormat: "png" | "jpeg"
  maxEdge: number
  quality?: string
}

export interface NormalizeImageForVisionParams {
  attachment: AttachmentRecord
  sourcePath: string
  agentName: string
  agentRoot: string
  maxVlmBytes?: number
  probeImage?: (input: ProbeImageInput) => Promise<ProbeImageResult>
  rasterizeWithQuickLook?: (input: RasterizeQuickLookInput) => Promise<string>
  encodeVariant?: (input: EncodeVariantInput) => Promise<{
    path: string
    mimeType?: string
    byteCount?: number
  }>
}

export interface NormalizeImageForVisionResult {
  path: string
  mimeType?: string
  byteCount?: number
}

function materializedOutputDir(agentRoot: string, attachmentId: string): string {
  return path.join(agentRoot, "state", "attachments", "materialized", attachmentId.replace(/[:/]/g, "_"))
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, (error, stdout = "", stderr = "") => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

async function defaultProbeImage(input: ProbeImageInput): Promise<ProbeImageResult> {
  const output = await execFileText("/usr/bin/sips", ["-g", "hasAlpha", input.sourcePath])
  const hasAlpha = /hasAlpha:\s+(yes|1|true)/i.test(output)
  return { hasAlpha }
}

async function defaultRasterizeWithQuickLook(input: RasterizeQuickLookInput): Promise<string> {
  await fs.mkdir(input.outputDir, { recursive: true })
  await execFileText("/usr/bin/qlmanage", ["-t", "-s", "4096", "-o", input.outputDir, input.sourcePath])
  const entries = await fs.readdir(input.outputDir)
  const candidate = entries
    .filter((entry) => entry.startsWith(path.basename(input.sourcePath, path.extname(input.sourcePath))))
    .sort()[0]
  if (!candidate) {
    throw new Error("Quick Look did not produce a rasterized image")
  }
  return path.join(input.outputDir, candidate)
}

async function defaultEncodeVariant(input: EncodeVariantInput): Promise<{
  path: string
  mimeType?: string
  byteCount?: number
}> {
  await fs.mkdir(input.outputDir, { recursive: true })
  const extension = input.targetFormat === "png" ? ".png" : ".jpg"
  const basename = path.basename(input.sourcePath, path.extname(input.sourcePath))
  const outputPath = path.join(
    input.outputDir,
    `${basename}-${input.maxEdge}-${input.targetFormat}${input.quality ? `-${input.quality}` : ""}${extension}`,
  )
  const args = [
    "-s",
    "format",
    input.targetFormat,
    ...(input.targetFormat === "jpeg" && input.quality ? ["-s", "formatOptions", input.quality] : []),
    "-Z",
    String(input.maxEdge),
    input.sourcePath,
    "--out",
    outputPath,
  ]
  await execFileText("/usr/bin/sips", args)
  const stats = await fs.stat(outputPath)
  return {
    path: outputPath,
    mimeType: input.targetFormat === "png" ? "image/png" : "image/jpeg",
    byteCount: stats.size,
  }
}

export async function normalizeImageForVision(
  params: NormalizeImageForVisionParams,
): Promise<NormalizeImageForVisionResult> {
  const maxVlmBytes = params.maxVlmBytes ?? MAX_VLM_IMAGE_BYTES
  const originalMimeType = params.attachment.mimeType?.trim().toLowerCase()
  const originalByteCount = params.attachment.byteCount
  const outputDir = materializedOutputDir(params.agentRoot, params.attachment.id)

  if (
    originalMimeType
    && SAFE_VLM_MIME_TYPES.has(originalMimeType)
    && typeof originalByteCount === "number"
    && originalByteCount <= maxVlmBytes
  ) {
    emitNervesEvent({
      component: "engine",
      event: "engine.attachment_normalization_passthrough",
      message: "attachment image normalization updated",
      meta: {
      attachmentId: params.attachment.id,
      mimeType: originalMimeType,
      byteCount: originalByteCount,
      },
    })
    return {
      path: path.resolve(params.sourcePath),
      mimeType: originalMimeType,
      byteCount: originalByteCount,
    }
  }

  const probeImage = params.probeImage ?? defaultProbeImage
  const rasterizeWithQuickLook = params.rasterizeWithQuickLook ?? defaultRasterizeWithQuickLook
  const encodeVariant = params.encodeVariant ?? defaultEncodeVariant

  let workingSourcePath = path.resolve(params.sourcePath)
  let probe: ProbeImageResult
  try {
    probe = await probeImage({ sourcePath: workingSourcePath })
  } catch {
    emitNervesEvent({
      component: "engine",
      event: "engine.attachment_normalization_rasterize",
      message: "attachment image normalization updated",
      meta: {
        attachmentId: params.attachment.id,
        sourcePath: workingSourcePath,
      },
    })
    workingSourcePath = await rasterizeWithQuickLook({
      sourcePath: workingSourcePath,
      outputDir,
    })
    probe = await probeImage({ sourcePath: workingSourcePath })
  }

  const targetFormats: Array<"png" | "jpeg"> = probe.hasAlpha ? ["png", "jpeg"] : ["jpeg"]

  for (const targetFormat of targetFormats) {
    for (const maxEdge of SIZE_STEPS) {
      const qualities = targetFormat === "jpeg" ? JPEG_QUALITIES : [undefined]
      for (const quality of qualities) {
        const variant = await encodeVariant({
          sourcePath: workingSourcePath,
          outputDir,
          targetFormat,
          maxEdge,
          ...(quality ? { quality } : {}),
        })
        if ((variant.byteCount ?? Number.POSITIVE_INFINITY) <= maxVlmBytes) {
          emitNervesEvent({
            component: "engine",
            event: "engine.attachment_normalization_succeeded",
            message: "attachment image normalization updated",
            meta: {
              attachmentId: params.attachment.id,
              sourceMimeType: originalMimeType ?? "unknown",
              outputMimeType: variant.mimeType ?? `image/${targetFormat}`,
              byteCount: variant.byteCount,
              maxEdge,
              quality: quality ?? null,
            },
          })
          return variant
        }
      }
    }
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_normalization_failed",
    message: "attachment image normalization updated",
    meta: {
      attachmentId: params.attachment.id,
      sourceMimeType: originalMimeType ?? "unknown",
      sourceByteCount: originalByteCount ?? null,
      maxVlmBytes,
    },
  })
  throw new Error(`Attachment ${params.attachment.id} could not be normalized under the VLM byte budget`)
}
