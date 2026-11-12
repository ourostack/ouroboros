import { createHash } from "node:crypto"
import { readBoundedResponse, storeDownloadedAttachment } from "../heart/attachments/downloaded-store"
import type { DownloadedAttachmentRecord } from "../heart/attachments/sources/downloaded"
import { attachmentTurnLines, ATTACHMENT_WORDS_TIMEOUT_MS } from "../heart/attachments/understand"
import { emitNervesEvent } from "../nerves/runtime"

// Files, pictures and voice clips someone sends the agent in Teams, kept and put into words like every other sense.

export const MAX_TEAMS_ATTACHMENT_BYTES = 20_000_000
const MAX_TEAMS_ATTACHMENTS_PER_MESSAGE = 8
const FILE_DOWNLOAD_INFO = "application/vnd.microsoft.teams.file.download.info"
// The bot token only goes to Microsoft's own Bot Framework media hosts, never to an arbitrary contentUrl.
const BOT_MEDIA_HOST = /(^|\.)(botframework\.com|trafficmanager\.net|teams\.microsoft\.com|skype\.com)$/u

export interface TeamsActivityAttachment {
  contentType?: string
  contentUrl?: string
  name?: string
  content?: unknown
}

interface TeamsDownload { url: string; displayName: string; mimeType?: string; needsBotToken: boolean }

function downloadFor(attachment: TeamsActivityAttachment): TeamsDownload | null {
  const contentType = attachment.contentType ?? ""
  if (contentType === FILE_DOWNLOAD_INFO) {
    const downloadUrl = (attachment.content as { downloadUrl?: unknown } | undefined)?.downloadUrl
    return typeof downloadUrl === "string" ? { url: downloadUrl, displayName: attachment.name || "file", needsBotToken: false } : null
  }
  if (!/^(image|audio|video)\//u.test(contentType) || typeof attachment.contentUrl !== "string") return null
  return { url: attachment.contentUrl, displayName: attachment.name || contentType.replace("/", "."), mimeType: contentType, needsBotToken: true }
}

export async function ingestTeamsAttachments(input: {
  agentName: string
  agentRoot: string
  attachments: readonly TeamsActivityAttachment[] | undefined
  getBotToken: () => Promise<string | undefined>
  fetch?: typeof globalThis.fetch
}): Promise<{ attachments: DownloadedAttachmentRecord<"teams">[]; notices: string[] }> {
  const fetchImpl = input.fetch ?? globalThis.fetch
  const attachments: DownloadedAttachmentRecord<"teams">[] = []
  const notices: string[] = []
  const downloads = (input.attachments ?? []).map(downloadFor).filter((download): download is TeamsDownload => download !== null)
  for (const download of downloads.slice(0, MAX_TEAMS_ATTACHMENTS_PER_MESSAGE)) {
    try {
      const url = new URL(download.url)
      if (url.protocol !== "https:") throw new Error("attachment URL is not https")
      const headers: Record<string, string> = {}
      if (download.needsBotToken && BOT_MEDIA_HOST.test(url.hostname)) {
        const token = await input.getBotToken()
        if (token) headers.authorization = `Bearer ${token}`
      }
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(30_000) })
      if (!response.ok) throw new Error(`download failed with HTTP ${response.status}`)
      const buffer = await readBoundedResponse(response, MAX_TEAMS_ATTACHMENT_BYTES)
      attachments.push(await storeDownloadedAttachment({
        agentName: input.agentName,
        agentRoot: input.agentRoot,
        source: "teams",
        sourceId: createHash("sha256").update(download.url).digest("hex").slice(0, 32),
        displayName: download.displayName,
        mimeType: download.mimeType ?? response.headers.get("content-type") ?? undefined,
        buffer,
      }))
    } catch (error) {
      notices.push(`attachment unavailable: ${download.displayName} (${error instanceof Error ? error.message : String(error)})`)
      emitNervesEvent({ level: "warn", component: "senses", event: "senses.teams_attachment_ingest_error", message: "Teams attachment ingestion failed", meta: { reason: error instanceof Error ? error.message : String(error) } })
    }
  }
  return { attachments, notices }
}

/** The text the agent sees for a Teams message: what was typed, then its attachments in words. */
export async function teamsInboundText(text: string, input: Parameters<typeof ingestTeamsAttachments>[0]): Promise<string> {
  const ingested = await ingestTeamsAttachments(input)
  const lines = await attachmentTurnLines(ingested.attachments, { agentName: input.agentName, agentRoot: input.agentRoot, userText: text, timeoutMs: ATTACHMENT_WORDS_TIMEOUT_MS })
  return [text, ...lines, ...ingested.notices].filter(Boolean).join("\n")
}
