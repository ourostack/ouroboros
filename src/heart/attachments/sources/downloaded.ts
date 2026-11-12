import * as path from "node:path"
import { buildOriginalMaterializedAttachment, ensureReadableFile } from "../originals"
import { createAttachmentRecord, type AttachmentRecord } from "../types"
import type { AttachmentSourceAdapter } from "./adapter"
import { emitNervesEvent } from "../../../nerves/runtime"

// A file a sense downloaded into its own folder under state/attachments/materialized/<source>/. Telegram and Teams both work this way.

export type DownloadedAttachmentSource = "telegram" | "teams"

const SOURCE_LABEL: Record<DownloadedAttachmentSource, string> = { telegram: "Telegram", teams: "Teams" }

export interface DownloadedAttachmentSourceData {
  localPath: string
}

export type DownloadedAttachmentRecord<TSource extends DownloadedAttachmentSource = DownloadedAttachmentSource> =
  AttachmentRecord<TSource, DownloadedAttachmentSourceData>

export function buildDownloadedAttachmentRecord<TSource extends DownloadedAttachmentSource>(source: TSource, input: {
  sourceId: string
  displayName: string
  mimeType?: string
  byteCount?: number
  localPath: string
}, now = Date.now()): DownloadedAttachmentRecord<TSource> {
  const label = SOURCE_LABEL[source]
  if (!input.sourceId.trim()) throw new Error(`${label} attachment file id is required`)
  if (!path.isAbsolute(input.localPath)) throw new Error(`${label} attachment local path must be absolute`)
  emitNervesEvent({ component: "engine", event: "engine.downloaded_attachment_record_built", message: `${label} attachment record entered the shared attachment substrate`, meta: { source } })
  return createAttachmentRecord({
    source,
    sourceId: input.sourceId,
    displayName: input.displayName,
    mimeType: input.mimeType,
    byteCount: input.byteCount,
    sourceData: { localPath: path.resolve(input.localPath) },
  }, now)
}

export function downloadedAttachmentSourceAdapter(source: DownloadedAttachmentSource): AttachmentSourceAdapter {
  const label = SOURCE_LABEL[source]
  return {
    source,
    async materializeOriginal({ attachment, agentRoot }) {
      if (attachment.source !== source) throw new Error(`${source} adapter cannot materialize ${attachment.source} attachments`)
      const localPath = (attachment.sourceData as Partial<DownloadedAttachmentSourceData>).localPath
      if (typeof localPath !== "string" || !path.isAbsolute(localPath)) throw new Error(`${label} attachment local path is invalid`)
      const ownedRoot = path.resolve(agentRoot, "state", "attachments", "materialized", source)
      if (!path.resolve(localPath).startsWith(`${ownedRoot}${path.sep}`)) throw new Error(`${label} attachment local path is outside the owned attachment root`)
      await ensureReadableFile(localPath)
      return buildOriginalMaterializedAttachment(attachment, localPath)
    },
  }
}
