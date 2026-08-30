import * as fs from "node:fs/promises"
import * as path from "node:path"
import { cacheRecentAttachment } from "../heart/attachments/store"
import { getRecentAttachment } from "../heart/attachments/store"
import { originalStoragePath } from "../heart/attachments/originals"
import { ensureReadableFile } from "../heart/attachments/originals"
import { buildTelegramAttachmentRecord, type TelegramAttachmentRecord } from "../heart/attachments/sources/telegram"
import { emitNervesEvent } from "../nerves/runtime"
import type { TelegramBotApi, TelegramInboundAttachment } from "./telegram-client"

export const MAX_TELEGRAM_ATTACHMENT_BYTES = 20_000_000
const MAX_TELEGRAM_ATTACHMENTS_PER_MESSAGE = 8
const SAFE_FILE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,512}$/u

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"))
  if (Number.isFinite(advertised) && advertised > limit) throw new Error("advertised size exceeds limit")
  if (!response.body) throw new Error("empty response body")
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new Error("download exceeds limit")
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
}

export async function ingestTelegramAttachments(input: {
  agentName: string
  agentRoot: string
  botToken: string
  api: TelegramBotApi
  fetch?: typeof globalThis.fetch
  attachments: readonly TelegramInboundAttachment[]
}): Promise<{ attachments: TelegramAttachmentRecord[]; notices: string[] }> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const unique = [...new Map(input.attachments.map((attachment) => [attachment.fileId, attachment])).values()]
    .slice(0, MAX_TELEGRAM_ATTACHMENTS_PER_MESSAGE)
  const attachments: TelegramAttachmentRecord[] = []
  const notices: string[] = []
  for (const candidate of unique) {
    try {
      if (!/^[A-Za-z0-9_-]{1,512}$/u.test(candidate.fileId)) throw new Error("invalid file id")
      if (candidate.byteCount !== undefined && (!Number.isSafeInteger(candidate.byteCount) || candidate.byteCount < 0 || candidate.byteCount > MAX_TELEGRAM_ATTACHMENT_BYTES)) throw new Error("advertised size exceeds limit")
      const cached = getRecentAttachment(input.agentName, `attachment:telegram:${candidate.fileId}`, input.agentRoot)
      if (cached?.source === "telegram") {
        const localPath = (cached.sourceData as { localPath?: unknown }).localPath
        if (typeof localPath === "string") {
          await ensureReadableFile(localPath)
          attachments.push(cached as TelegramAttachmentRecord)
          continue
        }
      }
      const remote = await input.api.request<{ file_path?: unknown; file_size?: unknown }>("getFile", { file_id: candidate.fileId })
      if (typeof remote.file_path !== "string" || !SAFE_FILE_PATH.test(remote.file_path)) throw new Error("invalid remote path")
      if (remote.file_size !== undefined && (!Number.isSafeInteger(remote.file_size) || (remote.file_size as number) < 0 || (remote.file_size as number) > MAX_TELEGRAM_ATTACHMENT_BYTES)) throw new Error("advertised size exceeds limit")
      const response = await fetchImpl(`https://api.telegram.org/file/bot${input.botToken}/${remote.file_path}`, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`)
      const buffer = await readBounded(response, MAX_TELEGRAM_ATTACHMENT_BYTES)
      const provisional = buildTelegramAttachmentRecord({
        fileId: candidate.fileId,
        displayName: candidate.displayName,
        mimeType: candidate.mimeType ?? response.headers.get("content-type") ?? undefined,
        byteCount: buffer.length,
        localPath: path.resolve(input.agentRoot, "state", "attachments", ".pending", candidate.fileId),
      })
      const localPath = originalStoragePath(input.agentRoot, provisional, provisional.mimeType)
      await fs.mkdir(path.dirname(localPath), { recursive: true, mode: 0o700 })
      await fs.writeFile(localPath, buffer, { mode: 0o600 })
      const record = cacheRecentAttachment(input.agentName, buildTelegramAttachmentRecord({
        fileId: candidate.fileId,
        displayName: candidate.displayName,
        mimeType: provisional.mimeType,
        byteCount: buffer.length,
        localPath,
      }), input.agentRoot)
      attachments.push(record)
      emitNervesEvent({ component: "senses", event: "senses.telegram_attachment_ingested", message: "Telegram attachment entered the shared attachment store", meta: { kind: record.kind, byteCount: buffer.length } })
    } catch (error) {
      notices.push(`attachment unavailable: ${candidate.displayName}`)
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.telegram_attachment_ingest_error", message: "Telegram attachment ingestion failed", meta: { kind: candidate.kind, reason: error instanceof Error ? error.name : "unknown" } })
    }
  }
  return { attachments, notices }
}
