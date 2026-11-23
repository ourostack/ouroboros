import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { PassThrough, Transform } from "stream"
import { pipeline } from "stream/promises"
import * as zlib from "zlib"

import { emitNervesEvent } from "../../nerves/runtime"
import { readRuntimeCredentialConfig } from "../runtime-credentials"

/**
 * Harness-side retention for an agent's `state/`. It never deletes data: it gzips files that nothing reads or writes
 * any more, checks the gzip gives back the same bytes, and only then removes the original.
 *
 * Session archives (`<session>.archive.ndjson`) are the history that sessions moved out of `dialog.json` before
 * session events replaced them. Their last readers were removed in May 2026 (b5ff704d0, "delete archive history
 * readers"), and nothing writes them, so an open session never needs one. Slugger's 42 archives were 6.6 GB.
 *
 * The local mailroom file store (`state/mailroom/messages`, `state/mailroom/raw`) is read only when the agent's mail is
 * local. Once its mail is hosted (`mailroom.azureAccountUrl` in its runtime config, which is what makes
 * `mailroom/reader.ts` use Azure Blob), the files are left over from before and nothing reads them; the mail search
 * cache (`state/mail-search`) then comes from the hosted store. Slugger's were 8.6 GB. To use the file store again,
 * `gunzip` them back first.
 */

export interface SessionArchiveRetentionResult {
  compacted: number
  skippedRecent: number
  failed: number
  bytesBefore: number
  bytesAfter: number
}

export type MailroomStore = "local" | "hosted" | "unknown"

export interface MailroomRetentionResult extends SessionArchiveRetentionResult {
  store: MailroomStore
}

export interface CompactUnusedMailroomFileStoreInput {
  mailroomRoot: string
  /** Where the agent's mail lives now. Only "hosted" lets anything be compressed. */
  store: MailroomStore
  now?: () => number
  /** A message written within this long is left alone. Default: 30 days. */
  minIdleMs?: number
}

export interface CompactLegacySessionArchivesInput {
  sessionsRoot: string
  now?: () => number
  /** An archive written to within this long is left alone. Default: 7 days. */
  minIdleMs?: number
  /** Test seam: runs after the gzip is written and checked, before it replaces the archive. */
  beforeCommit?: (file: string) => void
}

const ARCHIVE_SUFFIX = ".archive.ndjson"
const DEFAULT_MIN_IDLE_MS = 7 * 24 * 60 * 60_000
const MAILROOM_MIN_IDLE_MS = 30 * 24 * 60 * 60_000
const MAILROOM_FILE_STORE_DIRS = ["messages", "raw"] as const

function emptyResult(): SessionArchiveRetentionResult {
  return { compacted: 0, skippedRecent: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 }
}

function findArchives(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && entry.name.endsWith(ARCHIVE_SUFFIX)) found.push(full)
    }
  }
  walk(root)
  return found.sort()
}

function hashingStream(hash: ReturnType<typeof createHash>): Transform {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      callback(null, chunk)
    },
  })
}

async function sha256OfFile(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(file), hashingStream(hash), new PassThrough().resume())
  return hash.digest("hex")
}

async function sha256OfGunzip(file: string): Promise<string> {
  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(file), zlib.createGunzip(), hashingStream(hash), new PassThrough().resume())
  return hash.digest("hex")
}

function unchanged(before: fs.Stats, file: string): boolean {
  const after = fs.statSync(file)
  return after.size === before.size && after.mtimeMs === before.mtimeMs
}

/** Gzips one archive in place. Returns the gzip's size, or null when the archive was kept as it is. */
async function compactArchive(file: string, before: fs.Stats, beforeCommit?: (file: string) => void): Promise<number | null> {
  const gz = `${file}.gz`
  if (fs.existsSync(gz)) {
    // An earlier pass wrote the gzip and stopped before removing the archive; finish only if they match.
    const [original, packed] = await Promise.all([sha256OfFile(file), sha256OfGunzip(gz).catch(() => null)])
    if (original !== packed || !unchanged(before, file)) return null
    fs.unlinkSync(file)
    return fs.statSync(gz).size
  }
  const tmp = `${gz}.tmp-${process.pid}`
  try {
    const hash = createHash("sha256")
    await pipeline(fs.createReadStream(file), hashingStream(hash), zlib.createGzip({ level: 6 }), fs.createWriteStream(tmp))
    const original = hash.digest("hex")
    const packed = await sha256OfGunzip(tmp)
    beforeCommit?.(file)
    if (original !== packed || !unchanged(before, file)) {
      fs.rmSync(tmp, { force: true })
      return null
    }
    fs.renameSync(tmp, gz)
    fs.unlinkSync(file)
    return fs.statSync(gz).size
  } catch (error) {
    fs.rmSync(tmp, { force: true })
    throw error
  }
}

async function compactFiles(
  files: readonly string[], now: number, minIdleMs: number, beforeCommit?: (file: string) => void,
): Promise<SessionArchiveRetentionResult> {
  const result = emptyResult()
  for (const file of files) {
    const before = fs.statSync(file)
    if (now - before.mtimeMs < minIdleMs) {
      result.skippedRecent += 1
      continue
    }
    const packedSize = await compactArchive(file, before, beforeCommit).catch(() => null)
    if (packedSize === null) {
      result.failed += 1
      continue
    }
    result.compacted += 1
    result.bytesBefore += before.size
    result.bytesAfter += packedSize
  }
  return result
}

export async function compactLegacySessionArchives(input: CompactLegacySessionArchivesInput): Promise<SessionArchiveRetentionResult> {
  return compactFiles(findArchives(input.sessionsRoot), (input.now ?? Date.now)(), input.minIdleMs ?? DEFAULT_MIN_IDLE_MS, input.beforeCommit)
}

function findMailroomFiles(root: string): string[] {
  return MAILROOM_FILE_STORE_DIRS.flatMap((dir) => {
    const full = path.join(root, dir)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(full, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isFile() && !entry.name.endsWith(".gz") && !entry.name.includes(".gz.tmp-"))
      .map((entry) => path.join(full, entry.name))
      .sort()
  })
}

/** Gzips the local mailroom file store's messages, only once the agent's mail is hosted somewhere else. */
export async function compactUnusedMailroomFileStore(input: CompactUnusedMailroomFileStoreInput): Promise<MailroomRetentionResult> {
  if (input.store !== "hosted") return { store: input.store, ...emptyResult() }
  const result = await compactFiles(findMailroomFiles(input.mailroomRoot), (input.now ?? Date.now)(), input.minIdleMs ?? MAILROOM_MIN_IDLE_MS)
  return { store: input.store, ...result }
}

/** Where the agent's mail lives, by the same rule as `mailroom/reader.ts`: hosted when it names an Azure account. */
export function mailroomStoreFromRuntimeConfig(runtime: { ok: boolean; config?: Record<string, unknown> }): MailroomStore {
  if (!runtime.ok) return "unknown"
  const mailroom = runtime.config?.mailroom
  const account = mailroom && typeof mailroom === "object" ? (mailroom as { azureAccountUrl?: unknown }).azureAccountUrl : undefined
  return typeof account === "string" && account.trim().length > 0 ? "hosted" : "local"
}

export interface AgentStateRetentionResult {
  agent: string
  sessionArchives: SessionArchiveRetentionResult
  mailroom: MailroomRetentionResult
}

export interface RunAgentStateRetentionInput {
  bundlesRoot: string
  agents: readonly string[]
  now?: () => number
  compactSessions?: (input: CompactLegacySessionArchivesInput) => Promise<SessionArchiveRetentionResult>
  /** Where each agent's mail lives. Default: the runtime config this process has loaded; "unknown" leaves mail alone. */
  mailroomStore?: (agent: string) => MailroomStore
}

/** Runs retention for each agent in turn; one agent's failure doesn't stop the rest. Telemetry is counts only. */
export async function runAgentStateRetention(input: RunAgentStateRetentionInput): Promise<AgentStateRetentionResult[]> {
  const compactSessions = input.compactSessions ?? compactLegacySessionArchives
  const results: AgentStateRetentionResult[] = []
  for (const agent of input.agents) {
    try {
      const sessionsRoot = path.join(input.bundlesRoot, `${agent}.ouro`, "state", "sessions")
      const sessionArchives = await compactSessions({ sessionsRoot, now: input.now })
      emitNervesEvent({
        component: "daemon",
        event: "daemon.state_retention_session_archives",
        message: "gzipped session archives nothing reads any more",
        meta: { agent, ...sessionArchives },
      })
      const store = (input.mailroomStore ?? ((name: string) => mailroomStoreFromRuntimeConfig(readRuntimeCredentialConfig(name))))(agent)
      const mailroom = await compactUnusedMailroomFileStore({
        mailroomRoot: path.join(input.bundlesRoot, `${agent}.ouro`, "state", "mailroom"),
        store,
        now: input.now,
      })
      emitNervesEvent({
        component: "daemon",
        event: "daemon.state_retention_mailroom",
        message: "gzipped the local mail file store once the agent's mail is hosted",
        meta: { agent, ...mailroom },
      })
      results.push({ agent, sessionArchives, mailroom })
    } catch (error) {
      emitNervesEvent({
        level: "warn",
        component: "daemon",
        event: "daemon.state_retention_error",
        message: "state retention failed for one agent",
        // A code, never a message: messages carry paths.
        meta: { agent, errorCode: (error as NodeJS.ErrnoException | null)?.code ?? "unknown" },
      })
    }
  }
  return results
}
