import * as path from "node:path"
import { buildOriginalMaterializedAttachment, ensureReadableFile } from "../originals"
import { createAttachmentRecord, type AttachmentRecord } from "../types"
import type { AttachmentSourceAdapter } from "./adapter"
import { emitNervesEvent } from "../../../nerves/runtime"

export interface TelegramAttachmentSourceData {
  localPath: string
}

export type TelegramAttachmentRecord = AttachmentRecord<"telegram", TelegramAttachmentSourceData>

export function buildTelegramAttachmentRecord(input: {
  fileId: string
  displayName: string
  mimeType?: string
  byteCount?: number
  localPath: string
}, now = Date.now()): TelegramAttachmentRecord {
  if (!input.fileId.trim()) throw new Error("Telegram attachment file id is required")
  if (!path.isAbsolute(input.localPath)) throw new Error("Telegram attachment local path must be absolute")
  emitNervesEvent({ component: "engine", event: "engine.telegram_attachment_record_built", message: "Telegram attachment record entered the shared attachment substrate", meta: {} })
  return createAttachmentRecord({
    source: "telegram",
    sourceId: input.fileId,
    displayName: input.displayName,
    mimeType: input.mimeType,
    byteCount: input.byteCount,
    sourceData: { localPath: path.resolve(input.localPath) },
  }, now)
}

export const telegramAttachmentSourceAdapter: AttachmentSourceAdapter = {
  source: "telegram",
  async materializeOriginal({ attachment, agentRoot }) {
    if (attachment.source !== "telegram") throw new Error(`telegram adapter cannot materialize ${attachment.source} attachments`)
    const localPath = (attachment.sourceData as Partial<TelegramAttachmentSourceData>).localPath
    if (typeof localPath !== "string" || !path.isAbsolute(localPath)) throw new Error("Telegram attachment local path is invalid")
    const ownedRoot = path.resolve(agentRoot, "state", "attachments", "materialized", "telegram")
    if (!path.resolve(localPath).startsWith(`${ownedRoot}${path.sep}`)) throw new Error("Telegram attachment local path is outside the owned attachment root")
    await ensureReadableFile(localPath)
    return buildOriginalMaterializedAttachment(attachment, localPath)
  },
}
