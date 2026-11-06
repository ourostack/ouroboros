import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../nerves/runtime"

export interface MigrateLocalMailroomToPlaintextInput {
  /** Agent owning the mailroom — only this agent's records are touched. */
  agentId: string
  /**
   * Root directory of the file-backed mailroom store, e.g.
   * `~/AgentBundles/<agent>.ouro/state/mailroom`. Layout:
   *   <root>/messages/<id>.json
   *   <root>/raw/<id>.{json|eml}
   */
  mailroomRoot: string
  /**
   * Root directory of the per-agent mail search cache, e.g.
   * `~/AgentBundles/<agent>.ouro/state/mail-search`. Layout:
   *   <root>/<messageId>.json
   *   <root>/coverage/<encoded>.json
   */
  searchCacheRoot: string
}

export interface MigrateLocalMailroomToPlaintextResult {
  wipedEnvelopes: number
  wipedRaw: number
  wipedCoverageRecords: number
  wipedOrphanSearchDocs: number
}

interface MessageEnvelopeShape {
  agentId?: unknown
  bodyForm?: unknown
  private?: unknown
}

interface SearchCacheDocShape {
  agentId?: unknown
  messageId?: unknown
}

interface CoverageRecordShape {
  agentId?: unknown
  storeKind?: unknown
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T
  } catch {
    return null
  }
}

function listJsonEntries(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json"))
}

/**
 * One-time, idempotent cleanup of pre-plaintext residue.
 *
 * Wipes:
 *  - `messages/*.json` for this agent that are not already in the new plaintext
 *    shape (no `bodyForm: "plaintext"` AND no `private` field). Unparseable JSON
 *    also goes — we cannot safely keep ambiguous bytes.
 *  - `raw/*.json` files that look like an `EncryptedPayload` JSON wrapper (the
 *    pre-change raw-storage shape). Plaintext `.eml` files are preserved.
 *    Non-EncryptedPayload JSON in `raw/` is left alone.
 *  - Coverage records in `searchCacheRoot/coverage/` whose `storeKind` is no
 *    longer reachable (`azure-blob` from a previous hosted attachment) or whose
 *    JSON is unreadable. `file` coverage records are preserved.
 *  - Orphan search-cache docs in `searchCacheRoot/*.json` that belong to this
 *    agent but reference a `messageId` no longer present in `messages/`.
 *
 * Idempotent: a second run finds nothing to wipe and returns zeroed counts.
 */
export function migrateLocalMailroomToPlaintext(
  input: MigrateLocalMailroomToPlaintextInput,
): MigrateLocalMailroomToPlaintextResult {
  const messagesDir = path.join(input.mailroomRoot, "messages")
  const rawDir = path.join(input.mailroomRoot, "raw")
  const coverageDir = path.join(input.searchCacheRoot, "coverage")

  let wipedEnvelopes = 0
  let wipedRaw = 0
  let wipedCoverageRecords = 0
  let wipedOrphanSearchDocs = 0

  // 1. Messages: drop pre-plaintext or malformed shapes for this agent.
  const surviving = new Set<string>()
  for (const entry of listJsonEntries(messagesDir)) {
    const filePath = path.join(messagesDir, entry)
    const value = readJson<MessageEnvelopeShape>(filePath)
    if (value === null) {
      // Unparseable JSON — we cannot tell whose it is or what shape, but the
      // pre-change codebase wrote message JSON here; treat as wipeable.
      fs.unlinkSync(filePath)
      wipedEnvelopes += 1
      continue
    }
    const isCurrentShape = value.bodyForm === "plaintext" && value.private !== undefined && value.private !== null
    if (isCurrentShape) {
      const stem = entry.slice(0, -".json".length)
      surviving.add(stem)
      continue
    }
    // We don't restrict to a specific agentId here because the file store is
    // single-agent: the bundle owns this directory and the migration is
    // initiated from inside that bundle.
    fs.unlinkSync(filePath)
    wipedEnvelopes += 1
  }

  // 2. Raw artifacts: drop pre-change encrypted JSON wrappers.
  if (fs.existsSync(rawDir)) {
    for (const entry of fs.readdirSync(rawDir)) {
      if (!entry.endsWith(".json")) continue
      const filePath = path.join(rawDir, entry)
      const value = readJson<{ algorithm?: unknown; ciphertext?: unknown }>(filePath)
      const isEncryptedPayload = value !== null
        && typeof value.algorithm === "string"
        && value.algorithm.startsWith("RSA-OAEP")
        && typeof value.ciphertext === "string"
      if (!isEncryptedPayload) continue
      fs.unlinkSync(filePath)
      wipedRaw += 1
    }
  }

  // 3. Coverage records: drop azure-blob (no longer reachable) and malformed.
  for (const entry of listJsonEntries(coverageDir)) {
    const filePath = path.join(coverageDir, entry)
    const value = readJson<CoverageRecordShape>(filePath)
    if (value === null) {
      fs.unlinkSync(filePath)
      wipedCoverageRecords += 1
      continue
    }
    if (value.agentId !== input.agentId) continue
    if (value.storeKind === "file") continue
    fs.unlinkSync(filePath)
    wipedCoverageRecords += 1
  }

  // 4. Orphan search-cache docs.
  for (const entry of listJsonEntries(input.searchCacheRoot)) {
    const filePath = path.join(input.searchCacheRoot, entry)
    const value = readJson<SearchCacheDocShape>(filePath)
    if (value === null) continue
    if (value.agentId !== input.agentId) continue
    if (typeof value.messageId !== "string") continue
    if (surviving.has(value.messageId)) continue
    fs.unlinkSync(filePath)
    wipedOrphanSearchDocs += 1
  }

  emitNervesEvent({
    component: "senses",
    event: "senses.mail_local_migration_executed",
    message: "local mailroom plaintext migration executed",
    meta: {
      agentId: input.agentId,
      wipedEnvelopes,
      wipedRaw,
      wipedCoverageRecords,
      wipedOrphanSearchDocs,
    },
  })

  return { wipedEnvelopes, wipedRaw, wipedCoverageRecords, wipedOrphanSearchDocs }
}
