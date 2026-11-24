import { createHash } from "crypto"
import * as fs from "fs"
import * as path from "path"
import * as zlib from "zlib"

import type { HostedMailCopies } from "../../mailroom/blob-store"
import { hostedMessageStorageId, type MailEnvelopeInput } from "../../mailroom/core"

export type { HostedMailCopies, HostedMailMessageRecord } from "../../mailroom/blob-store"

/**
 * Deletes a gzipped local mail copy only once it has proven that Blob holds the same mail.
 *
 * Retention gzips the local mailroom file store once an agent's mail is hosted (`state-retention.ts`). Those files
 * are left over from before the move, but not every one is guaranteed to have been uploaded, so a copy is deleted only
 * when, under the same key, Blob's `messages/<id>.json` records the same raw MIME (`rawSha256` and `rawSize` equal to
 * the local raw file's real hash and size) and Blob's raw object exists and isn't empty. The hosted store encrypts the
 * raw MIME, so the bytes themselves can't be compared; the hash it records is of the plaintext it encrypted.
 *
 * The key is the hosted id (the local id plus its destination, see `hostedMessageStorageId`), or the local id itself.
 * Anything else keeps the copy: no record, a different size or hash, a missing raw object, a Blob error, or a local
 * copy that doesn't match its own record.
 */

export interface ProvenMailroomCopiesResult {
  checked: number
  deleted: number
  bytesFreed: number
  notInBlob: number
  mismatched: number
  unconfirmed: number
  localInvalid: number
  changed: number
  deferred: number
}

export interface PruneProvenMailroomCopiesInput {
  mailroomRoot: string
  hosted: HostedMailCopies
  /** Most copies checked in one pass; the rest wait for the next. Default: 5000. */
  maxPerPass?: number
}

const DEFAULT_MAX_PER_PASS = 5000

interface LocalCopy {
  messagePath: string
  rawPath: string
  keys: string[]
  rawSha256: string
  rawSize: number
  messageStat: fs.Stats
  rawStat: fs.Stats
}

function emptyResult(): ProvenMailroomCopiesResult {
  return { checked: 0, deleted: 0, bytesFreed: 0, notInBlob: 0, mismatched: 0, unconfirmed: 0, localInvalid: 0, changed: 0, deferred: 0 }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

/** Reads a gzipped local copy and checks its raw file matches its own record; null when it doesn't. */
function readLocalCopy(root: string, messagePath: string): LocalCopy | null {
  try {
    const messageStat = fs.statSync(messagePath)
    const record = JSON.parse(zlib.gunzipSync(fs.readFileSync(messagePath)).toString("utf-8")) as Record<string, unknown>
    const id = text(record.id)
    const rawObject = text(record.rawObject)
    const rawSha256 = text(record.rawSha256)
    if (!id || !rawObject || !rawSha256 || typeof record.rawSize !== "number") return null
    const rawPath = path.resolve(root, `${rawObject}.gz`)
    if (!rawPath.startsWith(path.join(path.resolve(root), "raw") + path.sep)) return null
    const rawStat = fs.statSync(rawPath)
    const raw = zlib.gunzipSync(fs.readFileSync(rawPath))
    if (raw.byteLength !== record.rawSize || createHash("sha256").update(raw).digest("hex") !== rawSha256) return null
    const keys = [id]
    const agentId = text(record.agentId)
    const mailboxId = text(record.mailboxId)
    const address = text(record.recipient)
    if (agentId && mailboxId && address && record.envelope && typeof record.envelope === "object") {
      keys.unshift(hostedMessageStorageId(record.envelope as MailEnvelopeInput, raw, { agentId, mailboxId, address }))
    }
    return { messagePath, rawPath, keys: [...new Set(keys)], rawSha256, rawSize: raw.byteLength, messageStat, rawStat }
  } catch {
    return null
  }
}

type Verdict = "proven" | "not-in-blob" | "mismatched"

async function verdictFor(copy: LocalCopy, hosted: HostedMailCopies): Promise<Verdict> {
  let mismatched = false
  for (const key of copy.keys) {
    const record = await hosted.readMessage(key)
    if (!record) continue
    if (record.rawSha256 !== copy.rawSha256 || record.rawSize !== copy.rawSize) {
      mismatched = true
      continue
    }
    const rawObject = text(record.rawObject)
    const size = rawObject ? await hosted.rawObjectSize(rawObject) : null
    if (size !== null && size > 0) return "proven"
  }
  return mismatched ? "mismatched" : "not-in-blob"
}

function unchanged(before: fs.Stats, file: string): boolean {
  try {
    const after = fs.statSync(file)
    return after.size === before.size && after.mtimeMs === before.mtimeMs
  } catch {
    return false
  }
}

export async function pruneProvenMailroomCopies(input: PruneProvenMailroomCopiesInput): Promise<ProvenMailroomCopiesResult> {
  const result = emptyResult()
  const messagesDir = path.join(input.mailroomRoot, "messages")
  let names: string[]
  try {
    names = fs.readdirSync(messagesDir).filter((name) => name.endsWith(".json.gz")).sort()
  } catch {
    return result
  }
  const limit = input.maxPerPass ?? DEFAULT_MAX_PER_PASS
  result.deferred = Math.max(0, names.length - limit)
  for (const name of names.slice(0, limit)) {
    result.checked += 1
    const copy = readLocalCopy(input.mailroomRoot, path.join(messagesDir, name))
    if (!copy) {
      result.localInvalid += 1
      continue
    }
    let verdict: Verdict
    try {
      verdict = await verdictFor(copy, input.hosted)
    } catch {
      result.unconfirmed += 1
      continue
    }
    if (verdict === "not-in-blob") {
      result.notInBlob += 1
      continue
    }
    if (verdict === "mismatched") {
      result.mismatched += 1
      continue
    }
    if (!unchanged(copy.rawStat, copy.rawPath) || !unchanged(copy.messageStat, copy.messagePath)) {
      result.changed += 1
      continue
    }
    // The raw file first: a message record without its raw file is caught as localInvalid next pass and kept.
    fs.unlinkSync(copy.rawPath)
    fs.unlinkSync(copy.messagePath)
    result.deleted += 1
    result.bytesFreed += copy.rawStat.size + copy.messageStat.size
  }
  return result
}
