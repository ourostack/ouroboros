/**
 * Reads the complete lines a nerves log gained since the last run. The cursor is a byte offset plus the file's inode
 * and a hash of its first bytes, so a run can tell its file from one that replaced it.
 *
 * The nerves sink rotates `foo.ndjson` by renaming it to `foo.1.ndjson`, writing `foo.1.ndjson.gz` from it and then
 * removing the plain copy; the next write starts a new `foo.ndjson`. When the active file is no longer the cursor's
 * file, the reader finishes generation 1 from the cursor's offset if its first bytes match (the gzipped copy, or the
 * plain one while the gzip is still being written), then reads the new file from the start. If nothing matches (the
 * file was replaced, or it rotated more than once between runs), the lines in between are lost: the reader says so as
 * a gap and starts the new file from the start.
 *
 * Each file is opened once and read through that one descriptor, so a rotation between two reads can't mix files.
 * A run reads at most `maxBytes` of the active file; the cursor then points part-way in and `more` is true. Generation 1
 * is finished whole (at most the sink's 25 MB rotation size).
 */
import crypto from "node:crypto"
import zlib from "node:zlib"
import { emitNervesEvent } from "../../nerves/runtime"
import type { GuardedFs, ReadHandle } from "./guarded-fs"

export interface FileCursor {
  ino: number
  offset: number
  /** sha256 of the first `headLength` bytes. */
  head: string
  headLength: number
}

export interface ReadResult {
  lines: string[]
  /** Undefined when the next run should read the active file from its start. */
  cursor: FileCursor | undefined
  /** True when lines may have been missed. */
  gap: boolean
  /** True when the active file has more bytes than this read took. */
  more: boolean
}

export const HEAD_BYTES = 1024
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

function hashHead(bytes: Buffer, length: number): string {
  return crypto.createHash("sha256").update(bytes.subarray(0, length)).digest("hex")
}

/** Complete lines in `bytes`, and how many bytes they used (a half-written last line waits for the next run). */
function completeLines(bytes: Buffer): { lines: string[]; used: number } {
  const end = bytes.lastIndexOf(0x0a)
  if (end < 0) return { lines: [], used: 0 }
  const lines = bytes.subarray(0, end).toString("utf8").split("\n").filter((line) => line.length > 0)
  return { lines, used: end + 1 }
}

/** The whole of generation 1 of `active` (a `.ndjson` file): the gzipped copy, else the plain one, else null. */
function readGenerationOne(gfs: GuardedFs, active: string): Buffer | null {
  const base = active.slice(0, -".ndjson".length)
  const gz = gfs.readWhole(`${base}.1.ndjson.gz`)
  if (gz) {
    try {
      return zlib.gunzipSync(gz)
    } catch {
      // Still being written, or damaged: the plain copy is still there while a rotation is in progress.
    }
  }
  return gfs.readWhole(`${base}.1.ndjson`)
}

function matches(handle: ReadHandle, cursor: FileCursor): boolean {
  return handle.ino === cursor.ino && handle.size >= cursor.offset && hashHead(handle.read(0, cursor.headLength), cursor.headLength) === cursor.head
}

/** Reads `handle` from `start`, at most `maxBytes`, appending complete lines to `into`. */
function readFrom(handle: ReadHandle, start: number, maxBytes: number, into: string[]): { cursor: FileCursor; more: boolean; gap: boolean } {
  const bytes = handle.read(start, maxBytes)
  const { lines, used } = completeLines(bytes)
  into.push(...lines)
  // A line longer than a whole part would stop the log for good: skip it as a gap and go on after it.
  const tooLong = used === 0 && bytes.length >= maxBytes
  const offset = start + (tooLong ? bytes.length : used)
  const headLength = Math.min(HEAD_BYTES, offset)
  const head = hashHead(handle.read(0, headLength), headLength)
  return { cursor: { ino: handle.ino, offset, head, headLength }, more: offset < handle.size && (used > 0 || tooLong), gap: tooLong }
}

export function readNewLines(gfs: GuardedFs, active: string, cursor: FileCursor | undefined, maxBytes = DEFAULT_MAX_BYTES): ReadResult {
  const lines: string[] = []
  const fromActive = gfs.withFile(active, (handle) => {
    if (cursor && matches(handle, cursor)) return readFrom(handle, cursor.offset, maxBytes, lines)
    if (!cursor) return readFrom(handle, 0, maxBytes, lines)
    // The cursor's file is gone from this name: finish generation 1 if it is the cursor's file.
    const matched = finishGenerationOne(gfs, active, cursor, lines)
    if (!matched) {
      emitNervesEvent({ level: "warn", component: "eval", event: "eval.watch_log_gap", message: "a watched log was replaced; lines in between are lost", meta: {} })
    }
    const read = readFrom(handle, 0, maxBytes, lines)
    return { ...read, gap: read.gap || !matched }
  })
  if (fromActive) return { lines, ...fromActive }
  if (!cursor) return { lines, cursor: undefined, gap: false, more: false }
  // Rotated, and the new file doesn't exist yet: once generation 1 is finished, the next run starts the new file from 0.
  return finishGenerationOne(gfs, active, cursor, lines) ? { lines, cursor: undefined, gap: false, more: false } : { lines: [], cursor, gap: false, more: false }
}

function finishGenerationOne(gfs: GuardedFs, active: string, cursor: FileCursor, into: string[]): boolean {
  const generation = readGenerationOne(gfs, active)
  // A cursor with no head (its first read held no whole line) can't tell one file from another, so it never matches.
  if (generation === null || cursor.headLength === 0 || generation.length < cursor.offset || hashHead(generation, cursor.headLength) !== cursor.head) return false
  into.push(...completeLines(generation.subarray(cursor.offset)).lines)
  return true
}
