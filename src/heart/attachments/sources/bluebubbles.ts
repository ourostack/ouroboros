import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { BlueBubblesAttachmentSummary } from "../../../senses/bluebubbles/model"
import { downloadBlueBubblesAttachment } from "../../../senses/bluebubbles/attachment-download"
import { getBlueBubblesChannelConfig, getBlueBubblesConfig } from "../../config"
import { getAgentRoot } from "../../identity"
import { buildOriginalMaterializedAttachment, ensureReadableFile, originalStoragePath } from "../originals"
import { cacheRecentAttachment } from "../store"
import { createAttachmentRecord, type AttachmentRecord } from "../types"
import type { AttachmentSourceAdapter } from "./adapter"

export interface BlueBubblesAttachmentSourceData extends BlueBubblesAttachmentSummary {
  guid: string
  localPath?: string
}

export type BlueBubblesAttachmentRecord = AttachmentRecord<"bluebubbles", BlueBubblesAttachmentSourceData>

function normalizeBlueBubblesRecord(attachment: AttachmentRecord): BlueBubblesAttachmentRecord {
  if (attachment.source !== "bluebubbles") {
    throw new Error(`bluebubbles adapter cannot materialize ${attachment.source} attachments`)
  }

  const sourceData = attachment.sourceData as Record<string, unknown> | undefined
  const guid = typeof sourceData?.guid === "string" && sourceData.guid.trim().length > 0
    ? sourceData.guid.trim()
    : attachment.sourceId.trim()

  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required")
  }

  const localPath = typeof sourceData?.localPath === "string" && sourceData.localPath.trim().length > 0
    ? path.resolve(sourceData.localPath)
    : undefined

  return {
    ...attachment,
    source: "bluebubbles",
    sourceId: guid,
    sourceData: {
      guid,
      mimeType: typeof sourceData?.mimeType === "string" ? sourceData.mimeType : attachment.mimeType,
      transferName: typeof sourceData?.transferName === "string" ? sourceData.transferName : attachment.displayName,
      totalBytes: typeof sourceData?.totalBytes === "number" ? sourceData.totalBytes : attachment.byteCount,
      height: typeof sourceData?.height === "number" ? sourceData.height : undefined,
      width: typeof sourceData?.width === "number" ? sourceData.width : undefined,
      ...(localPath ? { localPath } : {}),
    },
  }
}

export function buildBlueBubblesAttachmentRecord(
  summary: BlueBubblesAttachmentSummary,
  now = Date.now(),
  options: {
    localPath?: string
    mimeType?: string
    byteCount?: number
  } = {},
): BlueBubblesAttachmentRecord {
  const guid = summary.guid?.trim()
  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required")
  }

  const displayName = summary.transferName?.trim() || guid
  const mimeType = options.mimeType?.trim().toLowerCase() || summary.mimeType?.trim().toLowerCase() || undefined

  return createAttachmentRecord(
    {
      source: "bluebubbles",
      sourceId: guid,
      displayName,
      mimeType,
      byteCount: options.byteCount ?? summary.totalBytes,
      sourceData: {
        ...summary,
        guid,
        ...(options.localPath ? { localPath: path.resolve(options.localPath) } : {}),
      },
    },
    now,
  )
}

export async function persistBlueBubblesAttachmentSource(
  agentName: string,
  attachment: BlueBubblesAttachmentRecord,
  input: {
    buffer: Buffer
    mimeType?: string
    byteCount?: number
  },
  agentRoot = getAgentRoot(agentName),
): Promise<BlueBubblesAttachmentRecord> {
  const normalizedAttachment = normalizeBlueBubblesRecord(attachment)
  const targetPath = originalStoragePath(agentRoot, normalizedAttachment, input.mimeType)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.writeFile(targetPath, input.buffer)

  const updated = buildBlueBubblesAttachmentRecord(
    {
      ...normalizedAttachment.sourceData,
      mimeType: input.mimeType ?? normalizedAttachment.sourceData.mimeType,
      totalBytes: input.byteCount ?? normalizedAttachment.byteCount,
    },
    normalizedAttachment.createdAt,
    {
      localPath: targetPath,
      mimeType: input.mimeType ?? normalizedAttachment.mimeType,
      byteCount: input.byteCount ?? normalizedAttachment.byteCount,
    },
  )
  updated.lastSeenAt = Date.now()
  cacheRecentAttachment(agentName, updated, agentRoot)

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_source_persisted",
    message: "attachment materialization updated",
    meta: {
      attachmentId: normalizedAttachment.id,
      source: normalizedAttachment.source,
      mimeType: updated.mimeType,
    },
  })

  return updated
}

export const blueBubblesAttachmentSourceAdapter: AttachmentSourceAdapter = {
  source: "bluebubbles",
  async materializeOriginal({ agentName, attachment, agentRoot }) {
    const normalizedAttachment = normalizeBlueBubblesRecord(attachment)
    const localPath = normalizedAttachment.sourceData.localPath?.trim()
    if (localPath) {
      await ensureReadableFile(localPath)
      return buildOriginalMaterializedAttachment(normalizedAttachment, localPath)
    }

    const fallbackPath = originalStoragePath(agentRoot, normalizedAttachment)
    try {
      await ensureReadableFile(fallbackPath)
      return buildOriginalMaterializedAttachment(normalizedAttachment, fallbackPath)
    } catch {
      const config = getBlueBubblesConfig()
      const channelConfig = getBlueBubblesChannelConfig()
      const downloaded = await downloadBlueBubblesAttachment(normalizedAttachment.sourceData, config, channelConfig)
      const updated = await persistBlueBubblesAttachmentSource(
        agentName,
        normalizedAttachment,
        {
          buffer: downloaded.buffer,
          mimeType: downloaded.contentType,
          byteCount: downloaded.buffer.length,
        },
        agentRoot,
      )
      const persistedPath = updated.sourceData.localPath
      /* v8 ignore next -- persistBlueBubblesAttachmentSource always writes localPath before returning @preserve */
      if (!persistedPath) {
        throw new Error("BlueBubbles attachment persistence did not yield a local path")
      }

      return buildOriginalMaterializedAttachment(
        updated,
        persistedPath,
        downloaded.contentType ?? updated.mimeType,
        downloaded.buffer.length,
      )
    }
  },
}
