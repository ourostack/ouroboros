import * as fs from "node:fs/promises"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

// The file a chat sense sends for the shared send_file tool. Each app takes files differently, but they all start here.

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".epub": "application/epub+zip",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
}

export interface ChatFile {
  name: string
  contentType: string
  bytes: Buffer
}

function megabytes(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`
}

/** Reads a local file to send into a chat, refusing one the app won't take. */
export async function readChatFile(filePath: string, maxBytes: number): Promise<ChatFile> {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error(`${filePath} is not a file`)
  if (stat.size === 0) throw new Error(`${filePath} is empty`)
  if (stat.size > maxBytes) throw new Error(`${path.basename(filePath)} is ${megabytes(stat.size)}; this chat takes files up to ${megabytes(maxBytes)}`)
  const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  emitNervesEvent({ component: "senses", event: "senses.chat_file_read", message: "read a file to send into a chat", meta: { contentType, bytes: stat.size } })
  return { name: path.basename(filePath), contentType, bytes: await fs.readFile(filePath) }
}
