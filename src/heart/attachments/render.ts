import { emitNervesEvent } from "../../nerves/runtime"
import type { AttachmentRecord } from "./types"

function formatBytes(byteCount?: number): string {
  if (typeof byteCount !== "number" || !Number.isFinite(byteCount) || byteCount < 0) {
    return "unknown size"
  }
  if (byteCount >= 1024 * 1024) {
    return `${(byteCount / (1024 * 1024)).toFixed(1)} MB`
  }
  if (byteCount >= 1024) {
    return `${Math.round(byteCount / 1024)} KB`
  }
  return `${byteCount} B`
}

export function renderAttachmentBlock(attachments: AttachmentRecord[]): string {
  if (attachments.length === 0) return ""

  const body = attachments.map((attachment) =>
    `- ${attachment.id} | ${attachment.kind} | ${attachment.displayName} | ${attachment.mimeType ?? "unknown mime"} | ${formatBytes(attachment.byteCount)}`,
  )
  const rendered = ["[attachments]", ...body].join("\n")

  emitNervesEvent({
    component: "engine",
    event: "engine.attachment_block_rendered",
    message: "attachment transcript block rendered",
    meta: { count: attachments.length },
  })

  return rendered
}
