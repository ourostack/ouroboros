import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { Entity } from "@microsoft/teams.api"
import { normalizeImageForVision, MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE } from "../heart/attachments/image-normalize"
import { buildCliLocalFileAttachmentRecord } from "../heart/attachments/sources/cli-local-file"
import { emitNervesEvent } from "../nerves/runtime"

export const MAX_TEAMS_INLINE_IMAGE_BYTES = 56 * 1024
export const MAX_TEAMS_IMAGE_CAPTION_LENGTH = 1024

export interface TeamsImageAttachment {
  contentType: "image/png" | "image/jpeg"
  contentUrl: string
  name: string
}

interface TeamsImageMessage {
  type: "message"
  text: string
  replyToId?: string
  attachments: TeamsImageAttachment[]
  entities: Entity[]
  channelData: { feedbackLoopEnabled: true }
}

function imageMime(bytes: Buffer): TeamsImageAttachment["contentType"] {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png"
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg"
  throw new Error("Teams image must contain PNG or JPEG bytes")
}

async function readBoundedImage(filePath: string, maxBytes: number): Promise<Buffer> {
  const file = await fs.open(filePath, "r")
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size === 0 || stat.size > maxBytes) {
      throw new Error(`Teams image must be a nonempty regular file under ${maxBytes} bytes`)
    }
    // Bound the actual read as well as the stat, including a file that grows after the stat.
    const bytes = Buffer.alloc(stat.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== stat.size) throw new Error("Teams image changed while reading; nothing was sent")
    return bytes.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

export async function prepareTeamsImage(input: {
  path: string
  agentName: string
  agentRoot: string
}): Promise<TeamsImageAttachment> {
  if (!path.isAbsolute(input.path)) throw new Error("Teams image path must be absolute")
  const original = await readBoundedImage(input.path, MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE)
  const mimeType = imageMime(original)
  const attachment = buildCliLocalFileAttachmentRecord({ path: input.path, mimeType, byteCount: original.length })
  const normalized = await normalizeImageForVision({
    attachment, sourcePath: input.path, agentName: input.agentName, agentRoot: input.agentRoot,
    maxEdge: 1024, maxVlmBytes: MAX_TEAMS_INLINE_IMAGE_BYTES,
  })
  const bytes = await readBoundedImage(normalized.path, MAX_TEAMS_INLINE_IMAGE_BYTES)
  const contentType = imageMime(bytes)
  if (normalized.mimeType !== contentType) throw new Error("Normalized Teams image MIME does not match its bytes")
  emitNervesEvent({
    component: "channels", event: "channel.teams_image_prepared",
    message: "private image prepared for inline Teams delivery",
    meta: { mimeType: contentType, byteCount: bytes.length, maxEdge: 1024 },
  })
  return {
    contentType,
    contentUrl: `data:${contentType};base64,${bytes.toString("base64")}`,
    name: `${path.basename(input.path, path.extname(input.path)).slice(0, 100)}${contentType === "image/png" ? ".png" : ".jpg"}`,
  }
}

export function createTeamsImageSender(
  send: (message: TeamsImageMessage) => Promise<unknown>,
  replyToId?: string,
  entities: Entity[] = [],
): (attachment: TeamsImageAttachment, caption: string) => Promise<string> {
  return async (attachment, caption) => {
    if (caption.length > MAX_TEAMS_IMAGE_CAPTION_LENGTH) throw new Error("Teams image caption exceeds 1024 characters")
    const message: TeamsImageMessage = {
      type: "message", text: caption, replyToId, attachments: [attachment],
      entities, channelData: { feedbackLoopEnabled: true },
    }
    if (Buffer.byteLength(JSON.stringify(message), "utf8") > 80 * 1024) {
      throw new Error("Teams image message exceeds the inline payload budget; nothing was sent")
    }
    const receipt = await send(message)
    if (!receipt || typeof receipt !== "object" || !("id" in receipt)
      || typeof receipt.id !== "string" || !receipt.id.trim()) {
      throw new Error("Teams image delivery is unknown: no activity receipt returned; do not retry automatically")
    }
    emitNervesEvent({
      component: "channels", event: "channel.teams_image_accepted",
      message: "Teams accepted an inline image activity; client rendering is not verified",
      meta: { activityId: receipt.id, mimeType: attachment.contentType },
    })
    return receipt.id
  }
}
