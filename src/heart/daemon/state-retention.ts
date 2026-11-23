import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import { PassThrough, Transform } from "stream"
import { pipeline } from "stream/promises"
import * as zlib from "zlib"

import { emitNervesEvent } from "../../nerves/runtime"

/**
 * Harness-side retention for an agent's `state/`. It never deletes data: it gzips files that nothing reads or writes
 * any more, checks the gzip gives back the same bytes, and only then removes the original.
 *
 * Session archives (`<session>.archive.ndjson`) are the history that sessions moved out of `dialog.json` before
 * session events replaced them. Their last readers were removed in May 2026 (b5ff704d0, "delete archive history
 * readers"), and nothing writes them, so an open session never needs one. Slugger's 42 archives were 6.6 GB.
 */

export interface SessionArchiveRetentionResult {
  compacted: number
  skippedRecent: number
  failed: number
  bytesBefore: number
  bytesAfter: number
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

export async function compactLegacySessionArchives(input: CompactLegacySessionArchivesInput): Promise<SessionArchiveRetentionResult> {
  const now = (input.now ?? Date.now)()
  const minIdleMs = input.minIdleMs ?? DEFAULT_MIN_IDLE_MS
  const result = emptyResult()
  for (const file of findArchives(input.sessionsRoot)) {
    const before = fs.statSync(file)
    if (now - before.mtimeMs < minIdleMs) {
      result.skippedRecent += 1
      continue
    }
    const packedSize = await compactArchive(file, before, input.beforeCommit).catch(() => null)
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

export interface AgentStateRetentionResult {
  agent: string
  sessionArchives: SessionArchiveRetentionResult
}

export interface RunAgentStateRetentionInput {
  bundlesRoot: string
  agents: readonly string[]
  now?: () => number
  compactSessions?: (input: CompactLegacySessionArchivesInput) => Promise<SessionArchiveRetentionResult>
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
      results.push({ agent, sessionArchives })
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
