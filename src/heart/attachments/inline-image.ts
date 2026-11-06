import { createHash, randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as path from "node:path"

import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import { acquireSessionTurnLease, withImmediateSessionTurnLease } from "../../mind/session-transaction"
import { buildCliLocalFileAttachmentRecord, type CliLocalFileAttachmentRecord } from "./sources/cli-local-file"
import { cacheRecentAttachment, getAttachment, removeAttachment } from "./store"
import { isCompleteImageBuffer } from "./image-normalize"

export const MAX_PROMPT_IMAGE_COUNT = 4
export const MAX_PROMPT_IMAGE_BYTES = 8 * 1024 * 1024
/** Splitting input into multiple images does not expand the prompt's byte budget. */
export const MAX_PROMPT_TOTAL_IMAGE_BYTES = MAX_PROMPT_IMAGE_BYTES

const PROMPT_IMAGE_EXTENSIONS = new Map<string, string>([
  ["image/gif", ".gif"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/webp", ".webp"],
])

const NON_BASE64_CHARACTER = /[^A-Za-z0-9+/]/u

export interface InlinePromptImage {
  data: string
  mimeType: string
  name?: string
}

export interface IngestInlinePromptImagesOptions {
  agentRoot?: string
  now?: number
  signal?: AbortSignal
}

export interface InlinePromptImageTransaction {
  attachments: CliLocalFileAttachmentRecord[]
  /** Retain accepted or possibly admitted data, then release the ingress lease. */
  commit(): Promise<void>
  /** Only for definitely unadmitted data. Reused objects are never removed. */
  rollback(): Promise<void>
}

export function getInlinePromptImagePath(
  agentName: string,
  digest: string,
  extension: string,
  agentRoot = getAgentRoot(agentName),
): string {
  return path.join(agentRoot, "state", "attachments", "inline", digest.slice(0, 2), `${digest}${extension}`)
}

/** A prompt image the client must fix. Distinct from an I/O fault while storing a valid image. */
export class InlinePromptImageRejection extends Error {
  constructor(message: string) {
    super(message)
    this.name = "InlinePromptImageRejection"
  }
}

function rejected(reason: string): InlinePromptImageRejection {
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.attachment_inline_rejected",
    message: "inline prompt image rejected before the turn started",
    meta: { reason },
  })
  return new InlinePromptImageRejection(reason)
}

function decodePromptImage(image: InlinePromptImage, remainingBytes: number): { bytes: Buffer; extension: string; mimeType: string } {
  const mimeType = image.mimeType.trim().toLowerCase()
  const extension = PROMPT_IMAGE_EXTENSIONS.get(mimeType)
  if (!extension) throw rejected(`unsupported image mime type: ${mimeType || "(missing)"}`)

  const data = image.data
  if (data.length === 0) throw rejected("image data must not be empty")

  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  if ((data.length / 4) * 3 - padding > MAX_PROMPT_IMAGE_BYTES) {
    throw rejected(`image exceeds ${MAX_PROMPT_IMAGE_BYTES} bytes`)
  }
  if ((data.length / 4) * 3 - padding > remainingBytes) {
    throw rejected(`prompt exceeds ${MAX_PROMPT_TOTAL_IMAGE_BYTES} decoded image bytes`)
  }
  if (data.length % 4 !== 0 || NON_BASE64_CHARACTER.test(data.slice(0, data.length - padding))) {
    throw rejected("image data must be strict base64")
  }

  const bytes = Buffer.from(data, "base64")
  if (bytes.toString("base64") !== data) throw rejected("image data must be strict base64")
  return { bytes, extension, mimeType }
}

function validatePromptImages(images: readonly InlinePromptImage[]) {
  if (images.length > MAX_PROMPT_IMAGE_COUNT) {
    throw rejected(`prompt supports at most ${MAX_PROMPT_IMAGE_COUNT} images`)
  }
  let remainingBytes = MAX_PROMPT_TOTAL_IMAGE_BYTES
  const decoded = images.map((image) => {
    const value = decodePromptImage(image, remainingBytes)
    remainingBytes -= value.bytes.length
    return { ...value, name: image.name }
  })
  for (const image of decoded) {
    if (!isCompleteImageBuffer(image.bytes, image.mimeType)) {
      throw rejected(`image data is invalid or incomplete for ${image.mimeType}`)
    }
  }
  return decoded
}

function promptImageDisplayName(name: string | undefined, digest: string, extension: string): string {
  const candidate = path.basename(name?.trim() ?? "").trim()
  return candidate || `image-${digest.slice(0, 8)}${extension}`
}

function rollbackPromptImages(written: readonly string[]): void {
  if (written.length === 0) return
  for (const target of written) {
    try {
      fs.unlinkSync(target)
    } catch {
      /* rollback is best effort; the original ingestion failure is the reportable one */
    }
  }
  emitNervesEvent({
    level: "warn",
    component: "engine",
    event: "engine.attachment_inline_rollback",
    message: "inline prompt image bytes rolled back after a failed ingestion",
    meta: { count: written.length },
  })
}

/** Publish under the ingress lease. Rollback removes only bytes and metadata created by this transaction; accepted or reused objects survive. */
function writeInlinePromptImages(
  agentName: string,
  images: ReturnType<typeof validatePromptImages>,
  options: IngestInlinePromptImagesOptions = {},
): { attachments: CliLocalFileAttachmentRecord[]; rollback(): void } {
  const agentRoot = options.agentRoot ?? getAgentRoot(agentName)
  const written: string[] = []
  const newMetadata: string[] = []
  const rollback = () => {
    try {
      for (const id of newMetadata) removeAttachment(agentName, id, agentRoot)
    } finally {
      rollbackPromptImages(written)
    }
  }
  const records = new Map<string, CliLocalFileAttachmentRecord>()
  let accepted: CliLocalFileAttachmentRecord[]
  try {
    for (const { bytes, extension, mimeType, name } of images) {
      const digest = createHash("sha256").update(bytes).digest("hex")
      const targetPath = getInlinePromptImagePath(agentName, digest, extension, agentRoot)
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true })
        const temporaryPath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`
        written.push(temporaryPath)
        fs.writeFileSync(temporaryPath, bytes, { mode: 0o600 })
        fs.renameSync(temporaryPath, targetPath)
        written[written.length - 1] = targetPath
      }
      const record = buildCliLocalFileAttachmentRecord({
        path: targetPath,
        mimeType,
        byteCount: bytes.byteLength,
        displayName: promptImageDisplayName(name, digest, extension),
      }, options.now)
      if (getAttachment(agentName, record.id, agentRoot)) {
        const newlyWritten = written.indexOf(targetPath)
        if (newlyWritten >= 0) written.splice(newlyWritten, 1)
      }
      if (!records.has(record.id)) records.set(record.id, record)
    }
    accepted = [...records.values()].map((record) => {
      if (!getAttachment(agentName, record.id, agentRoot)) newMetadata.push(record.id)
      return cacheRecentAttachment(agentName, record, agentRoot)
    })
  } catch (error) {
    try { rollback() } catch { /* preserve the original storage failure */ }
    throw error
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_inline_ingested",
    message: "inline prompt images ingested into the attachment store",
    meta: { count: accepted.length },
  })
  return { attachments: accepted, rollback }
}

function ingressLeasePath(agentRoot: string): string {
  return path.join(agentRoot, "state", "attachments", "inline-ingress")
}

export function ingestInlinePromptImages(
  agentName: string,
  images: readonly InlinePromptImage[],
  options: IngestInlinePromptImagesOptions = {},
): CliLocalFileAttachmentRecord[] {
  const decoded = validatePromptImages(images)
  if (decoded.length === 0) return []
  const agentRoot = options.agentRoot ?? getAgentRoot(agentName)
  return withImmediateSessionTurnLease(ingressLeasePath(agentRoot), () =>
    writeInlinePromptImages(agentName, decoded, { ...options, agentRoot }).attachments)
}

export async function prepareInlinePromptImages(
  agentName: string,
  images: readonly InlinePromptImage[],
  options: IngestInlinePromptImagesOptions = {},
): Promise<InlinePromptImageTransaction> {
  options.signal?.throwIfAborted()
  const decoded = validatePromptImages(images)
  if (decoded.length === 0) return { attachments: [], commit: async () => undefined, rollback: async () => undefined }
  const agentRoot = options.agentRoot ?? getAgentRoot(agentName)
  // ponytail: serialize inline ingresses per agent through admission; use per-object leases only if throughput requires it.
  const lease = await acquireSessionTurnLease(ingressLeasePath(agentRoot))
  let stored: ReturnType<typeof writeInlinePromptImages>
  try {
    options.signal?.throwIfAborted()
    stored = writeInlinePromptImages(agentName, decoded, { ...options, agentRoot })
  } catch (error) {
    await lease.release()
    throw error
  }
  let finished = false
  const finish = async (rollback: boolean) => {
    if (finished) return
    finished = true
    try {
      if (rollback) stored.rollback()
    } finally {
      await lease.release()
    }
  }
  return { attachments: stored.attachments, commit: () => finish(false), rollback: () => finish(true) }
}
