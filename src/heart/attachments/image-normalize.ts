import { execFile, spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AttachmentRecord } from "./types"
import { probeImageBuffer } from "./image-format"

export const MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE = 32 * 1024 * 1024
export const MAX_VLM_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_VLM_IMAGE_EDGE = 8_000

const SAFE_VLM_MIME_TYPES = new Set(["image/gif", "image/png", "image/jpeg", "image/webp"])
const SIZE_STEPS = [3072, 2560, 2048, 1600, 1280, 1024, 768] as const
const JPEG_QUALITIES = ["best", "90", "80", "70", "60"] as const

function imageDecoderPath(): string | undefined {
  const executable = process.platform === "win32" ? "magick.exe" : "magick"
  const directories = [...(process.env.PATH ?? "").split(path.delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
  for (const directory of new Set(directories.filter((entry) => path.isAbsolute(entry)))) {
    const candidate = path.join(directory, executable)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* try the next installed media decoder */ }
  }
  return undefined
}

export function imageValidationAvailable(): boolean {
  return imageDecoderPath() !== undefined
}

/** Fully decode untrusted image bytes in memory before they enter the attachment store. */
export function isCompleteImageBuffer(bytes: Buffer, mimeType: string): boolean {
  const probe = probeImageBuffer(bytes)
  if (!probe || probe.mimeType !== mimeType || probe.pixelWidth > MAX_VLM_IMAGE_EDGE || probe.pixelHeight > MAX_VLM_IMAGE_EDGE) return false
  // Decoders may tolerate missing container terminators; admission must not.
  if (mimeType === "image/png" && !bytes.subarray(-12).equals(Buffer.from("0000000049454e44ae426082", "hex"))) return false
  if (mimeType === "image/jpeg" && !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) return false
  if (mimeType === "image/gif" && bytes.at(-1) !== 0x3b) return false
  if (mimeType === "image/webp" && bytes.readUInt32LE(4) + 8 !== bytes.length) return false
  const decoder = imageDecoderPath()
  if (!decoder) throw new Error("complete image validation requires the installed ImageMagick decoder")
  // The inline coder gives each format a seekable memory buffer; raw stdin can spool to a temporary file.
  const decoded = spawnSync(decoder, [
    "-regard-warnings", "-limit", "thread", "1",
    "-limit", "width", String(MAX_VLM_IMAGE_EDGE), "-limit", "height", String(MAX_VLM_IMAGE_EDGE),
    "-limit", "memory", "256MiB", "-limit", "map", "0", "-limit", "disk", "0",
    "-define", `png:chunk-malloc-max=${MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE}`,
    "inline:-", "null:",
  ], {
    input: `data:${mimeType};base64,${bytes.toString("base64")}`, stdio: ["pipe", "ignore", "pipe"],
    timeout: 30_000, killSignal: "SIGKILL", maxBuffer: 1024 * 1024,
  })
  if (decoded.error) throw decoded.error
  if (decoded.signal) throw new Error(`image decoder interrupted: ${decoded.signal}`)
  const valid = decoded.status === 0 && decoded.stderr.length === 0
  emitNervesEvent({
    component: "engine", event: "engine.attachment_image_integrity_checked",
    message: "complete image decoding checked", meta: { mimeType, byteCount: bytes.length, valid },
  })
  return valid
}

interface ProbeImageResult {
  hasAlpha: boolean
  pixelWidth?: number
  pixelHeight?: number
  mimeType?: string
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
  outputDir?: string
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
    execFile(file, args, { timeout: 30_000, killSignal: "SIGKILL" }, (error, stdout = "", stderr = "") => {
      if (error) {
        reject(new Error(stderr.trim() || stdout.trim() || error.message))
        return
      }
      resolve(stdout)
    })
  })
}

async function defaultProbeImage(input: ProbeImageInput): Promise<ProbeImageResult> {
  const output = await execFileText("/usr/bin/sips", [
    "-g", "hasAlpha",
    "-g", "format",
    "-g", "pixelWidth",
    "-g", "pixelHeight",
    input.sourcePath,
  ])
  const hasAlpha = /hasAlpha:\s+(yes|1|true)/i.test(output)
  const format = /format:\s+([A-Za-z0-9]+)/i.exec(output)?.[1]?.toLowerCase()
  const mimeType = format === "jpg" || format === "jpeg"
    ? "image/jpeg"
    : format === "png" || format === "webp" || format === "gif"
      ? `image/${format}`
      : undefined
  const pixelWidth = Number.parseInt(/pixelWidth:\s+(\d+)/i.exec(output)?.[1] ?? "", 10)
  const pixelHeight = Number.parseInt(/pixelHeight:\s+(\d+)/i.exec(output)?.[1] ?? "", 10)
  if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) {
    throw new Error("sips did not return image dimensions")
  }
  return { hasAlpha, pixelWidth, pixelHeight, mimeType }
}

async function defaultRasterizeWithQuickLook(input: RasterizeQuickLookInput): Promise<string> {
  await fs.mkdir(input.outputDir, { recursive: true })
  await execFileText("/usr/bin/qlmanage", ["-t", "-s", "4096", "-o", input.outputDir, input.sourcePath])
  const entries = await fs.readdir(input.outputDir)
  const sourceName = path.basename(input.sourcePath)
  const candidate = entries
    .filter((entry) => (
      entry !== sourceName
      && entry.startsWith(path.basename(input.sourcePath, path.extname(input.sourcePath)))
    ))
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
  const outputDir = params.outputDir
    ?? materializedOutputDir(params.agentRoot, params.attachment.id)

  const probeImage = params.probeImage ?? defaultProbeImage
  const rasterizeWithQuickLook = params.rasterizeWithQuickLook ?? defaultRasterizeWithQuickLook
  const encodeVariant = params.encodeVariant ?? defaultEncodeVariant

  let workingSourcePath = path.resolve(params.sourcePath)
  let rasterized = false
  const sourceBytes = await fs.readFile(workingSourcePath)
  const portableProbe = probeImageBuffer(sourceBytes)
  if (
    portableProbe
    && SAFE_VLM_MIME_TYPES.has(portableProbe.mimeType)
    && sourceBytes.length <= maxVlmBytes
    && portableProbe.pixelWidth !== undefined
    && portableProbe.pixelHeight !== undefined
    && portableProbe.pixelWidth > 0
    && portableProbe.pixelHeight > 0
    && portableProbe.pixelWidth <= MAX_VLM_IMAGE_EDGE
    && portableProbe.pixelHeight <= MAX_VLM_IMAGE_EDGE
  ) {
    emitNervesEvent({
      component: "engine",
      event: "engine.attachment_normalization_passthrough",
      message: "attachment image normalization updated",
      meta: {
        attachmentId: params.attachment.id,
        mimeType: portableProbe.mimeType,
        byteCount: sourceBytes.length,
        pixelWidth: portableProbe.pixelWidth,
        pixelHeight: portableProbe.pixelHeight,
      },
    })
    return {
      path: workingSourcePath,
      mimeType: portableProbe.mimeType,
      byteCount: sourceBytes.length,
    }
  }
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
    rasterized = true
    probe = await probeImage({ sourcePath: workingSourcePath })
  }

  const workingStats = await fs.stat(workingSourcePath)
  const dimensionsSafe = (
    probe.pixelWidth !== undefined
    && probe.pixelHeight !== undefined
    && probe.pixelWidth > 0
    && probe.pixelHeight > 0
    && probe.pixelWidth <= MAX_VLM_IMAGE_EDGE
    && probe.pixelHeight <= MAX_VLM_IMAGE_EDGE
  )
  if (
    !rasterized
    && probe.mimeType
    && SAFE_VLM_MIME_TYPES.has(probe.mimeType)
    && workingStats.size <= maxVlmBytes
    && dimensionsSafe
  ) {
    emitNervesEvent({
      component: "engine",
      event: "engine.attachment_normalization_passthrough",
      message: "attachment image normalization updated",
      meta: {
        attachmentId: params.attachment.id,
        mimeType: probe.mimeType,
        byteCount: workingStats.size,
        pixelWidth: probe.pixelWidth,
        pixelHeight: probe.pixelHeight,
      },
    })
    return {
      path: workingSourcePath,
      mimeType: probe.mimeType,
      byteCount: workingStats.size,
    }
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
        const variantStats = await fs.stat(variant.path)
        let variantProbe: ProbeImageResult | null = null
        try {
          variantProbe = await probeImage({ sourcePath: variant.path })
        } catch {
          variantProbe = null
        }
        const variantDimensionsSafe = variantProbe != null
          && variantProbe.pixelWidth !== undefined
          && variantProbe.pixelHeight !== undefined
          && variantProbe.pixelWidth > 0
          && variantProbe.pixelHeight > 0
          && variantProbe.pixelWidth <= MAX_VLM_IMAGE_EDGE
          && variantProbe.pixelHeight <= MAX_VLM_IMAGE_EDGE
        const verifiedMimeType = variantProbe?.mimeType
          ?? variant.mimeType
          ?? (targetFormat === "png" ? "image/png" : "image/jpeg")
        if (
          typeof variant.byteCount === "number"
          && variant.byteCount <= maxVlmBytes
          && variantStats.size <= maxVlmBytes
          && variantDimensionsSafe
        ) {
          emitNervesEvent({
            component: "engine",
            event: "engine.attachment_normalization_succeeded",
            message: "attachment image normalization updated",
            meta: {
              attachmentId: params.attachment.id,
              sourceMimeType: originalMimeType ?? "unknown",
              outputMimeType: verifiedMimeType,
              byteCount: variantStats.size,
              maxEdge,
              quality: quality ?? null,
            },
          })
          return {
            ...variant,
            mimeType: verifiedMimeType,
            byteCount: variantStats.size,
          }
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
      sourceByteCount: params.attachment.byteCount ?? null,
      maxVlmBytes,
    },
  })
  throw new Error(`Attachment ${params.attachment.id} could not be normalized under the VLM byte budget`)
}
