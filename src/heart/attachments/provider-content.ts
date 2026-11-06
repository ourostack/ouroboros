import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import type OpenAI from "openai"

import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentRoot } from "../identity"
import { getModelCapabilities } from "../model-capabilities"
import { getAttachment } from "./store"
import { materializeAttachment, type MaterializeAttachmentOptions } from "./materialize"
import { MAX_VLM_IMAGE_BYTES, normalizeImageForVision } from "./image-normalize"
import { probeImageBuffer } from "./image-format"

export interface BuildAttachmentProviderContentInput {
  agentName: string
  message: string
  attachmentIds: readonly string[]
  model: string
  agentRoot?: string
  normalizeImage?: MaterializeAttachmentOptions["normalizeImage"]
  requireVision?: boolean
}

export async function buildAttachmentProviderContent(
  input: BuildAttachmentProviderContentInput,
): Promise<OpenAI.ChatCompletionUserMessageParam["content"] | undefined> {
  if (input.attachmentIds.length === 0) {
    if (input.requireVision) throw new Error("required image input has no attachments")
    return undefined
  }
  if (getModelCapabilities(input.model).vision !== true) {
    if (input.requireVision) throw new Error(`active model ${input.model} lacks required image vision support`)
    return undefined
  }

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_provider_projection",
    message: "attachment provider projection started",
    meta: {
      attachmentCount: input.attachmentIds.length,
      model: input.model,
    },
  })
  const agentRoot = input.agentRoot ?? getAgentRoot(input.agentName)
  const snapshotRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ouro-provider-image-"))
  try {
    const content: Exclude<OpenAI.ChatCompletionUserMessageParam["content"], string> = []
    for (const attachmentId of input.attachmentIds) {
      const attachment = getAttachment(input.agentName, attachmentId, agentRoot)
      if (!attachment) throw new Error(`Attachment not found: ${attachmentId}`)
      if (attachment.kind !== "image") continue
      const original = await materializeAttachment(input.agentName, attachmentId, {
        agentRoot,
        variant: "original",
      })
      const snapshotPath = path.join(
        snapshotRoot,
        `${content.length}-${path.basename(original.path)}`,
      )
      await fs.copyFile(original.path, snapshotPath)
      await fs.chmod(snapshotPath, 0o600)
      const normalized = input.normalizeImage
        ? await input.normalizeImage({
            attachment,
            sourcePath: snapshotPath,
            agentName: input.agentName,
            agentRoot,
          })
        : await normalizeImageForVision({
            attachment,
            sourcePath: snapshotPath,
            agentName: input.agentName,
            agentRoot,
            outputDir: path.join(snapshotRoot, "normalized"),
          })
      const bytes = await fs.readFile(normalized.path)
      if (bytes.length === 0 || bytes.length > MAX_VLM_IMAGE_BYTES) {
        throw new Error(`Attachment ${attachmentId} exceeds the provider image byte limit`)
      }
      const mimeType = probeImageBuffer(bytes)?.mimeType
      if (!mimeType) {
        throw new Error(`Attachment ${attachmentId} is not a supported provider image`)
      }
      content.push({
        type: "image_url",
        image_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` },
      })
    }
    if (content.length === 0) {
      if (input.requireVision) throw new Error("required image input has no image attachments")
      return undefined
    }
    content.push({ type: "text", text: input.message })
    return content
  } finally {
    await fs.rm(snapshotRoot, { recursive: true, force: true })
  }
}

export function parseProviderImageDataUrl(url: string): {
  mimeType: "image/gif" | "image/jpeg" | "image/png" | "image/webp"
  data: string
} {
  const match = /^data:[^;,]+;base64,([A-Za-z0-9+/]+={0,2})$/u.exec(url)
  if (!match) throw new Error("provider image must be a supported base64 data URL")
  const data = match[1]!
  const bytes = Buffer.from(data, "base64")
  if (bytes.length === 0 || bytes.toString("base64") !== data) {
    throw new Error("provider image must be canonical base64")
  }
  const mimeType = probeImageBuffer(bytes)?.mimeType
  if (!mimeType) throw new Error("provider image bytes must use a supported format")
  return {
    mimeType,
    data,
  }
}
