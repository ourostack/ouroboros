import { buildDownloadedAttachmentRecord, downloadedAttachmentSourceAdapter, type DownloadedAttachmentRecord, type DownloadedAttachmentSourceData } from "./downloaded"

export type TelegramAttachmentSourceData = DownloadedAttachmentSourceData
export type TelegramAttachmentRecord = DownloadedAttachmentRecord<"telegram">

export function buildTelegramAttachmentRecord(input: {
  fileId: string
  displayName: string
  mimeType?: string
  byteCount?: number
  localPath: string
}, now = Date.now()): TelegramAttachmentRecord {
  const { fileId, ...rest } = input
  return buildDownloadedAttachmentRecord("telegram", { sourceId: fileId, ...rest }, now)
}

export const telegramAttachmentSourceAdapter = downloadedAttachmentSourceAdapter("telegram")
