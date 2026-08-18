import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { canonicalMailIndexRecordSnapshot, type HostedMailIndexAuthorityObservation } from "../../mailroom/blob-store"
import type { StoredMailMessage } from "../../mailroom/core"
import type { MailMessageIndexRecord } from "../../mailroom/file-store"
import { syncHostedMailSearchCache } from "../../mailroom/hosted-cache-sync"
import {
  MAIL_SEARCH_TEXT_PROJECTION_VERSION,
  readMailSearchCoverageRecord,
  readMailSearchSkipReceipt,
  resetMailSearchCacheForTests,
  searchMailSearchCache,
  writeMailSearchCoverageRecord,
} from "../../mailroom/search-cache"

const tempRoots: string[] = []

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-hosted-cache-sync-"))
  tempRoots.push(dir)
  return dir
}

function plaintextMessage(
  id: string,
  overrides: Partial<StoredMailMessage> = {},
): StoredMailMessage {
  return {
    schemaVersion: 1,
    id,
    agentId: "slugger",
    mailboxId: "mailbox_slugger",
    compartmentKind: "native",
    compartmentId: "mailbox_slugger",
    recipient: "slugger@ouro.bot",
    envelope: { mailFrom: "sender@example.com", rcptTo: ["slugger@ouro.bot"] },
    placement: "imbox",
    trustReason: "stable-tail test",
    rawObject: `raw/${id}.eml`,
    rawSha256: `sha-${id}`,
    rawSize: 10,
    bodyForm: "plaintext",
    private: {
      from: ["sender@example.com"],
      to: ["slugger@ouro.bot"],
      cc: [],
      subject: id,
      text: `body ${id}`,
      snippet: `body ${id}`,
      attachments: [],
      untrustedContentWarning: "untrusted",
    },
    ingest: { schemaVersion: 1, kind: "smtp" },
    receivedAt: "2026-08-18T00:00:00.000Z",
    ...overrides,
  }
}

function missingKeyMessage(id: string, receivedAt: string): StoredMailMessage {
  const base = plaintextMessage(id, { receivedAt })
  const { private: _private, ...metadata } = base as Extract<StoredMailMessage, { bodyForm: "plaintext" }>
  return {
    ...metadata,
    bodyForm: "encrypted",
    rawObject: `raw/${id}.json`,
    privateEnvelope: {
      algorithm: "RSA-OAEP-SHA256+A256GCM",
      keyId: "mail_key_missing",
      wrappedKey: "wrapped",
      iv: "iv",
      authTag: "tag",
      ciphertext: "ciphertext",
    },
  }
}

function recordFor(message: StoredMailMessage): MailMessageIndexRecord {
  return {
    schemaVersion: 1,
    id: message.id,
    agentId: message.agentId,
    compartmentKind: message.compartmentKind,
    placement: message.placement,
    ...(message.source ? { source: message.source } : {}),
    receivedAt: message.receivedAt,
  }
}

function observation(
  records: MailMessageIndexRecord[],
  overrides: Partial<HostedMailIndexAuthorityObservation> = {},
): HostedMailIndexAuthorityObservation {
  return {
    totalNameCount: records.length,
    parsedRecordCount: records.length,
    parseFailureCount: 0,
    duplicateIds: [],
    records,
    snapshot: canonicalMailIndexRecordSnapshot(records),
    ...overrides,
  }
}

afterEach(() => {
  vi.useRealTimers()
  resetMailSearchCacheForTests()
  for (const dir of tempRoots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe("hosted cache stable-tail convergence", () => {
  it("fully reconciles additions, deletions, metadata changes, and changed missing-key receipts before publishing final coverage", async () => {
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const kept = plaintextMessage("mail_kept")
    const deleted = plaintextMessage("mail_deleted")
    const movedBefore = plaintextMessage("mail_moved", { placement: "screener" })
    const movedAfter = { ...movedBefore, placement: "imbox" as const }
    const missingBefore = missingKeyMessage("mail_missing", "2026-08-18T00:00:00.000Z")
    const missingAfter = missingKeyMessage("mail_missing", "2026-08-18T00:01:00.000Z")
    const added = plaintextMessage("mail_added", { receivedAt: "2026-08-18T00:02:00.000Z" })
    const firstRecords = [kept, deleted, movedBefore, missingBefore].map(recordFor)
    const finalRecords = [kept, added, movedAfter, missingAfter].map(recordFor)
    const observations = [observation(firstRecords), observation(finalRecords), observation(finalRecords)]
    const observeMessageIndexAuthority = vi.fn(async () => observations.shift()!)
    const currentMessages = new Map<string, StoredMailMessage>([
      [kept.id, kept],
      [deleted.id, deleted],
      [movedBefore.id, movedBefore],
      [missingBefore.id, missingBefore],
    ])
    const getIndexedMessageById = vi.fn(async (id: string) => currentMessages.get(id) ?? null)
    const firstPassComplete = vi.fn(() => {
      currentMessages.delete(deleted.id)
      currentMessages.set(added.id, added)
      currentMessages.set(movedAfter.id, movedAfter)
      currentMessages.set(missingAfter.id, missingAfter)
    })

    const result = await syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority },
      store: { getIndexedMessageById } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
      onProgress: (progress) => {
        if (progress.phase === "pass-complete" && progress.pass === 1) firstPassComplete()
      },
    })

    expect(observeMessageIndexAuthority).toHaveBeenCalledTimes(3)
    expect(firstPassComplete).toHaveBeenCalledOnce()
    expect(result.coverage).toEqual(expect.objectContaining({
      visibleMessageCount: 4,
      cachedMessageCount: 3,
      decryptableMessageCount: 3,
      skippedMessageCount: 1,
      messageIndexFingerprint: canonicalMailIndexRecordSnapshot(finalRecords).messageIndexFingerprint,
    }))
    expect(searchMailSearchCache({ agentId: "slugger" }, cacheOptions).map((document) => document.messageId).sort())
      .toEqual([added.id, kept.id, movedAfter.id].sort())
    expect(searchMailSearchCache({ agentId: "slugger" }, cacheOptions).find((document) => document.messageId === movedAfter.id)?.placement)
      .toBe("imbox")
    expect(readMailSearchSkipReceipt("slugger", missingAfter.id, cacheOptions)?.recordFingerprint)
      .toBe(canonicalMailIndexRecordSnapshot([recordFor(missingAfter)]).messageIndexFingerprint)
  })

  it.each([
    { label: "empty", followup: observation([]) },
    { label: "malformed", followup: observation([], { totalNameCount: 1, parseFailureCount: 1 }) },
    { label: "duplicate", followup: observation([], { totalNameCount: 1, duplicateIds: ["mail_duplicate"] }) },
  ])("fails on an $label follow-up observation without replacing prior coverage", async ({ followup }) => {
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const message = plaintextMessage("mail_initial")
    const record = recordFor(message)
    const prior = writeMailSearchCoverageRecord({
      schemaVersion: 1,
      agentId: "slugger",
      storeKind: "azure-blob",
      indexedAt: "2026-08-17T00:00:00.000Z",
      visibleMessageCount: 99,
      cachedMessageCount: 99,
      decryptableMessageCount: 99,
      skippedMessageCount: 0,
      messageIndexFingerprint: "prior",
      textProjectionVersion: MAIL_SEARCH_TEXT_PROJECTION_VERSION,
    }, cacheOptions)
    const observations = [observation([record]), followup]

    await expect(syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority: vi.fn(async () => observations.shift()!) },
      store: { getIndexedMessageById: vi.fn(async () => message) } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
    })).rejects.toThrow(/authority/i)

    expect(readMailSearchCoverageRecord({ agentId: "slugger", storeKind: "azure-blob" }, cacheOptions)).toEqual(prior)
  })

  it("fails after three changing passes and never claims convergence", async () => {
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const messages = Array.from({ length: 4 }, (_, index) => plaintextMessage(`mail_unstable_${index}`))
    const snapshots = [1, 2, 3, 4].map((count) => observation(messages.slice(0, count).map(recordFor)))

    await expect(syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority: vi.fn(async () => snapshots.shift()!) },
      store: { getIndexedMessageById: vi.fn(async (id: string) => messages.find((message) => message.id === id) ?? null) } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
    })).rejects.toThrow(/did not stabilize after 3 passes/i)

    expect(readMailSearchCoverageRecord({ agentId: "slugger", storeKind: "azure-blob" }, cacheOptions)).toBeNull()
  })

  it("limits body work to 20 workers and emits deterministic settlement progress", async () => {
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const messages = Array.from({ length: 251 }, (_, index) => plaintextMessage(`mail_concurrency_${index}`))
    const records = messages.map(recordFor)
    let active = 0
    let maxActive = 0
    const getIndexedMessageById = vi.fn(async (id: string) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      return messages.find((message) => message.id === id) ?? null
    })
    const progress: Array<{ phase: string; pass: number; settled: number; total: number }> = []

    await syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority: vi.fn(async () => observation(records)) },
      store: { getIndexedMessageById } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
      onProgress: (event) => progress.push(event),
    })

    expect(maxActive).toBe(20)
    expect(progress).toContainEqual({ phase: "pass-start", pass: 1, settled: 0, total: 251 })
    expect(progress).toContainEqual({ phase: "settled", pass: 1, settled: 250, total: 251 })
    expect(progress).toContainEqual({ phase: "pass-complete", pass: 1, settled: 251, total: 251 })
  })

  it("waits for all workers before failing and publishes neither receipt nor coverage for generic errors", async () => {
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const messages = ["mail_fail", "mail_slow_a", "mail_slow_b"].map((id) => plaintextMessage(id))
    let completed = 0
    const getIndexedMessageById = vi.fn(async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, id === "mail_fail" ? 1 : 10))
      completed += 1
      if (id === "mail_fail") throw new Error("generic body failure")
      return messages.find((message) => message.id === id) ?? null
    })

    await expect(syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority: vi.fn(async () => observation(messages.map(recordFor))) },
      store: { getIndexedMessageById } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
    })).rejects.toThrow(/generic body failure/i)

    expect(completed).toBe(3)
    expect(readMailSearchCoverageRecord({ agentId: "slugger", storeKind: "azure-blob" }, cacheOptions)).toBeNull()
    expect(readMailSearchSkipReceipt("slugger", "mail_fail", cacheOptions)).toBeNull()
  })

  it("emits a 30-second heartbeat during a stalled pass, isolates callback failures, and clears its timer", async () => {
    vi.useFakeTimers()
    const cacheRoot = tempDir()
    const cacheOptions = { cacheDirForAgent: () => cacheRoot }
    const message = plaintextMessage("mail_stalled")
    let releaseBody!: () => void
    const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve })
    const progress: Array<{ phase: string; pass: number; settled: number; total: number }> = []
    const sync = syncHostedMailSearchCache({
      agentId: "slugger",
      mode: "full-convergence",
      authority: { observeMessageIndexAuthority: vi.fn(async () => observation([recordFor(message)])) },
      store: { getIndexedMessageById: vi.fn(async () => { await bodyGate; return message }) } as never,
      privateKeys: {},
      storeKind: "azure-blob",
      cacheOptions,
      onProgress: (event) => {
        progress.push(event)
        if (event.phase === "pass-start") throw new Error("progress sink failed")
      },
    })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(progress).toContainEqual({ phase: "heartbeat", pass: 1, settled: 0, total: 1 })
    releaseBody()
    await sync
    expect(vi.getTimerCount()).toBe(0)
  })
})
