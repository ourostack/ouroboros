import type { DecryptedMailMessage } from "./core"

/**
 * In-process LRU cache for decrypted mail bodies. The cold path for a
 * single-message body fetch is: read encrypted blob from Azure Blob
 * Storage (~1-3s p50 even for small bodies, into tens of seconds for
 * HEY-sized HTML; #614 raised the timeout to 60s for this exact reason),
 * then RSA-OAEP+A256GCM decrypt. Repeated reads of the same message are
 * common — e.g. re-checking a booking confirmation when seeding a trip,
 * or following up on a thread.
 *
 * Cache invariants:
 * - keyed by `StoredMailMessage.id` (a deterministic content hash;
 *   rotating keys produces a new id, so stale ciphertext can never be
 *   served against a fresh key set).
 * - bounded by `MAIL_BODY_CACHE_MAX_ENTRIES` with insertion-order LRU
 *   eviction; oldest entries fall off when the cap is hit.
 * - per-process; a daemon restart clears it. That matches the assumption
 *   in #621 (BB own-handle discovery) and #618 (heartbeat recursion):
 *   ephemeral state is fine for fast feedback, durable signals go to
 *   nerves.
 */
export const MAIL_BODY_CACHE_MAX_ENTRIES = 50

const cache = new Map<string, DecryptedMailMessage>()

export function getCachedMailBody(messageId: string): DecryptedMailMessage | undefined {
  if (!messageId) return undefined
  const value = cache.get(messageId)
  if (!value) return undefined
  // Refresh insertion order so this entry is not the next to evict.
  cache.delete(messageId)
  cache.set(messageId, value)
  return value
}

export function cacheMailBody(message: DecryptedMailMessage): void {
  if (!message.id) return
  if (cache.has(message.id)) cache.delete(message.id)
  cache.set(message.id, message)
  while (cache.size > MAIL_BODY_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    /* v8 ignore start -- defensive: cache.size > 0 by the loop guard, so first key is defined */
    if (oldestKey === undefined) break
    /* v8 ignore stop */
    cache.delete(oldestKey)
  }
}

export function clearMailBodyCache(): void {
  cache.clear()
}

export function getMailBodyCacheSize(): number {
  return cache.size
}
