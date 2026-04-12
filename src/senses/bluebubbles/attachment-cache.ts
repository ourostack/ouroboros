import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesAttachmentSummary } from "./model"

/**
 * Bounded process-local cache of recently-seen BlueBubbles attachment summaries.
 *
 * Populated at attachment-hydration time so the `describe_image` tool can
 * look up a guid → summary later in the same turn (or a few turns later)
 * and re-download the bytes on demand. Intentionally NOT persisted — per
 * planning doc D4, session storage holds only the VLM description text,
 * never the raw image bytes. The cache is cleared on daemon restart, which
 * matches the product expectation that "describe_image works on recent
 * messages in this session".
 *
 * Bounded at MAX_CACHED_ATTACHMENTS entries; oldest entries evict first
 * when the limit is hit.
 */

const MAX_CACHED_ATTACHMENTS = 50

const cache = new Map<string, BlueBubblesAttachmentSummary>()

export function cacheBlueBubblesAttachment(summary: BlueBubblesAttachmentSummary): void {
  const guid = summary.guid?.trim()
  if (!guid) return
  // Re-insert to move to end (LRU behavior via Map insertion order).
  if (cache.has(guid)) cache.delete(guid)
  cache.set(guid, { ...summary })
  while (cache.size > MAX_CACHED_ATTACHMENTS) {
    // cache.size > 0 here, so keys().next().value is always defined.
    const oldestKey = cache.keys().next().value as string
    cache.delete(oldestKey)
  }
}

export function lookupBlueBubblesAttachment(guid: string): BlueBubblesAttachmentSummary | undefined {
  const trimmed = guid?.trim()
  if (!trimmed) return undefined
  return cache.get(trimmed)
}

export function resetBlueBubblesAttachmentCache(): void {
  cache.clear()
}

/* v8 ignore start — module-level observability event */
emitNervesEvent({
  component: "senses",
  event: "senses.bluebubbles_attachment_cache_loaded",
  message: "bluebubbles attachment cache module loaded",
  meta: { maxEntries: MAX_CACHED_ATTACHMENTS },
})
/* v8 ignore stop */
