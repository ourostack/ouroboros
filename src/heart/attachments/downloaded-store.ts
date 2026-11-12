import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"
import { writeFileAtomic } from "../atomic-file"
import { cacheRecentAttachment } from "./store"
import { originalStoragePath } from "./originals"
import { buildDownloadedAttachmentRecord, type DownloadedAttachmentRecord, type DownloadedAttachmentSource } from "./sources/downloaded"

// Download and keep an inbound file the same way for every sense: read no more than the limit, write it atomically, remember it.

export async function readBoundedResponse(response: Response, limit: number): Promise<Buffer> {
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


/** Keep a downloaded file as the original of an attachment record and remember it for the agent's attachment tools. */
export async function storeDownloadedAttachment<TSource extends DownloadedAttachmentSource>(input: {
  agentName: string
  agentRoot: string
  source: TSource
  sourceId: string
  displayName: string
  mimeType?: string
  buffer: Buffer
}): Promise<DownloadedAttachmentRecord<TSource>> {
  const describe = (localPath: string) => ({
    sourceId: input.sourceId,
    displayName: input.displayName,
    mimeType: input.mimeType,
    byteCount: input.buffer.length,
    localPath,
  })
  const provisional = buildDownloadedAttachmentRecord(input.source, describe(path.resolve(input.agentRoot, "state", "attachments", ".pending", input.sourceId)))
  const localPath = originalStoragePath(input.agentRoot, provisional, provisional.mimeType)
  await writeFileAtomic(localPath, input.buffer)
  emitNervesEvent({ component: "engine", event: "engine.downloaded_attachment_stored", message: "downloaded attachment stored", meta: { source: input.source, byteCount: input.buffer.length } })
  return cacheRecentAttachment(input.agentName, buildDownloadedAttachmentRecord(input.source, describe(localPath)), input.agentRoot) as DownloadedAttachmentRecord<TSource>
}
