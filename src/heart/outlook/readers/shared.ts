import * as fs from "fs"
import * as path from "path"
import { emitNervesEvent } from "../../../nerves/runtime"
import type { RuntimeMetadata } from "../../daemon/runtime-metadata"
import {
  loadSessionEnvelopeFile,
  type SessionEnvelope,
} from "../../session-events"
import type { OutlookIssue } from "../outlook-types"

export interface OutlookReadOptions {
  bundlesRoot?: string
  homeDir?: string
  now?: () => Date
  runtimeMetadata?: RuntimeMetadata
  agentNames?: string[]
}

export const ACTIVE_CODING_STATUSES = new Set(["spawning", "running", "waiting_input", "stalled"])
export const BLOCKED_CODING_STATUSES = new Set(["waiting_input", "stalled"])
export const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000

export function issue(code: string, detail: string): OutlookIssue {
  return { code, detail }
}

export function safeReaddir(dir: string): string[] {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

export function safeIsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory()
  /* v8 ignore start */
  } catch {
    return false
  }
  /* v8 ignore stop */
}

/* v8 ignore start — defensive friend name resolution */
export function resolveFriendName(friendsDir: string, friendId: string): string {
  try {
    const raw = fs.readFileSync(path.join(friendsDir, `${friendId}.json`), "utf-8")
    const parsed = JSON.parse(raw) as { name?: unknown }
    return typeof parsed.name === "string" ? parsed.name : friendId
  } catch {
    return friendId
  }
}

/* v8 ignore stop */

/* v8 ignore start — utility helpers with defensive branches */
export function safeFileMtime(filePath: string): string | null {
  try {
    return fs.statSync(filePath).mtime.toISOString()
  } catch {
    return null
  }
}

export function truncateExcerpt(content: string | null, maxLength = 200): string | null {
  if (!content) return null
  if (content.length <= maxLength) return content
  const truncated = content.slice(0, maxLength)
  const lastSpace = truncated.lastIndexOf(" ")
  return (lastSpace > maxLength * 0.6 ? truncated.slice(0, lastSpace) : truncated) + "…"
}

/* v8 ignore stop */

export function readSessionEnvelope(sessionPath: string): SessionEnvelope | null {
  emitNervesEvent({
    component: "heart",
    event: "heart.outlook_session_envelope_read",
    message: "reading outlook session envelope",
    meta: { sessionPath },
  })
  return loadSessionEnvelopeFile(sessionPath)
}
