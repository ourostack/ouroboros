import { createHash } from "crypto"
import { statSync, readFileSync } from "fs"
import { emitNervesEvent } from "../nerves/runtime"

/** Compute sha256 hex hash of content */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export interface FileStateCacheEntry {
  hash: string
  mtime: number
  offset?: number
  limit?: number
  fullRead: boolean
  recordedAt: number
  messageId?: string
}

export interface FileStateSnapshot {
  filePath: string
  hash: string
  mtime: number
  messageId?: string
  createdAt: number
}

/**
 * Session-scoped LRU cache tracking file reads.
 * Stores content hashes (not full content) to limit memory.
 * Keyed by absolute file path.
 *
 * Also maintains a separate snapshot list for future rewind support.
 * Snapshots are indexed by content hash and linked to conversation messages.
 */
export class FileStateCache {
  private entries: Map<string, FileStateCacheEntry>
  private maxSize: number
  private snapshots: FileStateSnapshot[] = []
  private maxSnapshots: number = 100

  constructor(maxSize: number = 50) {
    this.entries = new Map()
    this.maxSize = maxSize
  }

  /**
   * Record a file read. Computes content hash and stores metadata.
   */
  record(
    filePath: string,
    content: string,
    mtime: number,
    offset?: number,
    limit?: number,
    messageId?: string,
  ): void {
    // If key already exists, delete it so re-insertion moves it to end (most recent)
    if (this.entries.has(filePath)) {
      this.entries.delete(filePath)
    }

    const hash = contentHash(content)
    const fullRead = offset === undefined && limit === undefined

    this.entries.set(filePath, {
      hash,
      mtime,
      offset: fullRead ? undefined : offset,
      limit: fullRead ? undefined : limit,
      fullRead,
      recordedAt: Date.now(),
      messageId,
    })

    emitNervesEvent({
      component: "mind",
      event: "mind.file_state.record",
      message: "recorded file state",
      meta: { path: filePath, hash, fullRead },
    })

    // Evict LRU (first entry in Map iteration order) if over capacity
    if (this.entries.size > this.maxSize) {
      const firstKey = this.entries.keys().next().value as string
      this.entries.delete(firstKey)
    }
  }

  /**
   * Get the cached state for a file path. Also promotes it in LRU order.
   */
  get(filePath: string): FileStateCacheEntry | undefined {
    const entry = this.entries.get(filePath)
    if (entry === undefined) return undefined

    // Promote to most-recently-used by re-inserting
    this.entries.delete(filePath)
    this.entries.set(filePath, entry)

    emitNervesEvent({
      component: "mind",
      event: "mind.file_state.get",
      message: "retrieved file state",
      meta: { path: filePath, hash: entry.hash },
    })

    return entry
  }

  /**
   * Check if a file has been modified since the last recorded read.
   * Uses mtime as primary signal, content hash as fallback for cloud sync / touch scenarios.
   * Returns { stale: false } if the path is not in cache or the file cannot be stat'd.
   */
  isStale(filePath: string): { stale: boolean; reason?: string } {
    const entry = this.entries.get(filePath)
    if (entry === undefined) return { stale: false }

    let currentMtime: number
    try {
      currentMtime = statSync(filePath).mtimeMs
    } catch {
      // File doesn't exist or can't be stat'd -- no basis for staleness
      return { stale: false }
    }

    // Fast path: mtime unchanged means not stale
    if (currentMtime === entry.mtime) return { stale: false }

    // mtime differs -- check content hash as fallback (handles touch / cloud sync)
    try {
      const currentContent = readFileSync(filePath, "utf-8")
      const currentHash = contentHash(currentContent)
      if (currentHash === entry.hash) return { stale: false }
      emitNervesEvent({
        component: "mind",
        event: "mind.file_state.stale_detected",
        message: "file staleness detected",
        meta: { path: filePath, previousHash: entry.hash, currentHash },
      })
      return { stale: true, reason: `file modified since last read (mtime and content differ)` }
    } catch {
      // Can't read file -- treat as not stale (file may have been deleted)
      return { stale: false }
    }
  }

  /**
   * Create a pre-edit snapshot of the current cache state for a file.
   * Snapshots are stored separately from the LRU cache for future rewind support.
   * Returns undefined if the path is not in cache.
   */
  snapshot(filePath: string): FileStateSnapshot | undefined {
    const entry = this.entries.get(filePath)
    if (entry === undefined) return undefined

    const snap: FileStateSnapshot = {
      filePath,
      hash: entry.hash,
      mtime: entry.mtime,
      messageId: entry.messageId,
      createdAt: Date.now(),
    }

    this.snapshots.push(snap)

    emitNervesEvent({
      component: "mind",
      event: "mind.file_state.snapshot_created",
      message: "created file state snapshot",
      meta: { path: filePath, hash: snap.hash },
    })

    // Evict oldest snapshots if over capacity
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots = this.snapshots.slice(this.snapshots.length - this.maxSnapshots)
    }

    return snap
  }

  /**
   * Get all snapshots in creation order.
   */
  getSnapshots(): readonly FileStateSnapshot[] {
    return this.snapshots
  }

  /**
   * Look up a snapshot by content hash. Returns the first match.
   */
  lookupSnapshotByHash(hash: string): FileStateSnapshot | undefined {
    return this.snapshots.find(s => s.hash === hash)
  }

  /**
   * Clear all snapshots.
   */
  clearSnapshots(): void {
    this.snapshots = []
  }

  /**
   * Clear all cached entries (does not clear snapshots).
   */
  clear(): void {
    emitNervesEvent({
      component: "mind",
      event: "mind.file_state.clear",
      message: "cleared file state cache",
      meta: { entryCount: this.entries.size },
    })
    this.entries.clear()
  }
}

/** Session-scoped singleton instance used by tool handlers */
export const fileStateCache = new FileStateCache()
