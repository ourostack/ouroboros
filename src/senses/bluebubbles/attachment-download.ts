import * as path from "node:path"
import { MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE } from "../../heart/attachments/image-normalize"
import type { BlueBubblesAttachmentSummary } from "./model"

export interface BlueBubblesConfig {
  serverUrl: string
  password: string
  accountId: string
}

export interface BlueBubblesChannelConfig {
  port: number
  webhookPath: string
  requestTimeoutMs: number
}

const MAX_NON_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif", ".tif", ".tiff", ".bmp"])

function buildBlueBubblesApiUrl(baseUrl: string, endpoint: string, password: string): string {
  const root = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`
  const url = new URL(endpoint.replace(/^\//, ""), root)
  url.searchParams.set("password", password)
  return url.toString()
}

function inferContentType(attachment: BlueBubblesAttachmentSummary, responseType?: string | null): string | undefined {
  const normalizedResponseType = responseType?.split(";")[0]?.trim().toLowerCase()
  if (normalizedResponseType) {
    return normalizedResponseType
  }
  return attachment.mimeType?.trim().toLowerCase() || undefined
}

export function isBlueBubblesImageAttachment(
  attachment: BlueBubblesAttachmentSummary,
  contentType?: string,
): boolean {
  if (contentType?.startsWith("image/")) return true
  const normalizedMime = attachment.mimeType?.trim().toLowerCase()
  if (normalizedMime?.startsWith("image/")) return true
  const extension = path.extname(attachment.transferName ?? "").toLowerCase()
  return IMAGE_EXTENSIONS.has(extension)
}

function maxDownloadBytesForAttachment(
  attachment: BlueBubblesAttachmentSummary,
  contentType?: string,
): number {
  return isBlueBubblesImageAttachment(attachment, contentType)
    ? MAX_ATTACHMENT_DOWNLOAD_BYTES_IMAGE
    : MAX_NON_IMAGE_ATTACHMENT_BYTES
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachmentSummary,
  config: BlueBubblesConfig,
  channelConfig: BlueBubblesChannelConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Buffer; contentType?: string }> {
  const guid = attachment.guid?.trim()
  if (!guid) {
    throw new Error("attachment guid missing")
  }

  const advertisedLimit = maxDownloadBytesForAttachment(attachment)
  if (typeof attachment.totalBytes === "number" && attachment.totalBytes > advertisedLimit) {
    throw new Error(`attachment exceeds ${advertisedLimit} byte limit`)
  }

  const url = buildBlueBubblesApiUrl(
    config.serverUrl,
    `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    config.password,
  )
  const response = await fetchImpl(url, {
    method: "GET",
    signal: AbortSignal.timeout(channelConfig.requestTimeoutMs),
  })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`)
  }

  const contentType = inferContentType(attachment, response.headers.get("content-type"))
  const buffer = Buffer.from(await response.arrayBuffer())
  const actualLimit = maxDownloadBytesForAttachment(attachment, contentType)
  if (buffer.length > actualLimit) {
    throw new Error(`attachment exceeds ${actualLimit} byte limit`)
  }

  return {
    buffer,
    contentType,
  }
}
