import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { FileStateCache, contentHash } from "../../mind/file-state"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"

describe("FileStateCache", () => {
  let cache: FileStateCache

  beforeEach(() => {
    cache = new FileStateCache()
  })

  describe("record and get", () => {
    it("stores entry and retrieves it by path", () => {
      cache.record("/tmp/foo.ts", "hello world", 1234567890)
      const entry = cache.get("/tmp/foo.ts")
      expect(entry).toBeDefined()
      expect(entry!.hash).toBeTypeOf("string")
      expect(entry!.hash.length).toBe(64) // sha256 hex
      expect(entry!.mtime).toBe(1234567890)
      expect(entry!.fullRead).toBe(true)
    })

    it("returns undefined for nonexistent path", () => {
      expect(cache.get("/tmp/nonexistent.ts")).toBeUndefined()
    })

    it("stores content hash, not full content", () => {
      cache.record("/tmp/foo.ts", "hello world", 1234567890)
      const entry = cache.get("/tmp/foo.ts")
      // entry should not contain the original content
      expect(entry).not.toHaveProperty("content")
      expect(entry!.hash).toBeDefined()
    })

    it("tracks partial reads with offset and limit", () => {
      cache.record("/tmp/foo.ts", "partial content", 1234567890, 10, 50)
      const entry = cache.get("/tmp/foo.ts")
      expect(entry).toBeDefined()
      expect(entry!.offset).toBe(10)
      expect(entry!.limit).toBe(50)
      expect(entry!.fullRead).toBe(false)
    })

    it("marks full read when no offset/limit provided", () => {
      cache.record("/tmp/foo.ts", "full content", 1234567890)
      const entry = cache.get("/tmp/foo.ts")
      expect(entry!.fullRead).toBe(true)
      expect(entry!.offset).toBeUndefined()
      expect(entry!.limit).toBeUndefined()
    })

    it("records timestamp of when entry was cached", () => {
      const before = Date.now()
      cache.record("/tmp/foo.ts", "content", 1234567890)
      const after = Date.now()
      const entry = cache.get("/tmp/foo.ts")
      expect(entry!.recordedAt).toBeGreaterThanOrEqual(before)
      expect(entry!.recordedAt).toBeLessThanOrEqual(after)
    })

    it("updates existing entry on re-record", () => {
      cache.record("/tmp/foo.ts", "old content", 1000)
      cache.record("/tmp/foo.ts", "new content", 2000)
      const entry = cache.get("/tmp/foo.ts")
      expect(entry!.mtime).toBe(2000)
    })
  })

  describe("LRU eviction", () => {
    it("evicts least recently used entry when exceeding max size", () => {
      const smallCache = new FileStateCache(3)
      smallCache.record("/a", "a", 1)
      smallCache.record("/b", "b", 2)
      smallCache.record("/c", "c", 3)
      // All three present
      expect(smallCache.get("/a")).toBeDefined()
      expect(smallCache.get("/b")).toBeDefined()
      expect(smallCache.get("/c")).toBeDefined()

      // Adding a 4th should evict the LRU
      // /a was accessed most recently (via get above), /b next, /c next
      // Actually after the gets: access order is /a, /b, /c
      // So /a is LRU after recording, but we accessed all three
      // Let's be explicit: access /b and /c so /a is LRU
      smallCache.get("/b")
      smallCache.get("/c")
      smallCache.record("/d", "d", 4)

      expect(smallCache.get("/a")).toBeUndefined()
      expect(smallCache.get("/b")).toBeDefined()
      expect(smallCache.get("/c")).toBeDefined()
      expect(smallCache.get("/d")).toBeDefined()
    })

    it("defaults to 50 entries max", () => {
      const defaultCache = new FileStateCache()
      for (let i = 0; i < 51; i++) {
        defaultCache.record(`/file-${i}`, `content-${i}`, i)
      }
      // First entry should be evicted
      expect(defaultCache.get("/file-0")).toBeUndefined()
      // Last entry should be present
      expect(defaultCache.get("/file-50")).toBeDefined()
    })
  })

  describe("clear", () => {
    it("removes all entries", () => {
      cache.record("/a", "a", 1)
      cache.record("/b", "b", 2)
      cache.clear()
      expect(cache.get("/a")).toBeUndefined()
      expect(cache.get("/b")).toBeUndefined()
    })
  })

  describe("hash consistency", () => {
    it("produces same hash for same content", () => {
      cache.record("/a", "hello", 1)
      cache.record("/b", "hello", 2)
      expect(cache.get("/a")!.hash).toBe(cache.get("/b")!.hash)
    })

    it("produces different hash for different content", () => {
      cache.record("/a", "hello", 1)
      cache.record("/b", "world", 2)
      expect(cache.get("/a")!.hash).not.toBe(cache.get("/b")!.hash)
    })
  })

  describe("isStale", () => {
    let tmpDir: string
    let tmpFile: string

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-state-test-"))
      tmpFile = path.join(tmpDir, "test.txt")
    })

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    })

    it("returns not stale when file mtime matches recorded mtime", () => {
      fs.writeFileSync(tmpFile, "hello")
      const mtime = fs.statSync(tmpFile).mtimeMs
      cache.record(tmpFile, "hello", mtime)

      const result = cache.isStale(tmpFile)
      expect(result.stale).toBe(false)
    })

    it("returns stale when file mtime is newer and content differs", () => {
      fs.writeFileSync(tmpFile, "original")
      const mtime = fs.statSync(tmpFile).mtimeMs
      cache.record(tmpFile, "original", mtime)

      // Modify the file (changes mtime and content)
      fs.writeFileSync(tmpFile, "modified")

      const result = cache.isStale(tmpFile)
      expect(result.stale).toBe(true)
      expect(result.reason).toBeDefined()
    })

    it("returns not stale when path is not in cache (no basis for comparison)", () => {
      const result = cache.isStale("/nonexistent/path")
      expect(result.stale).toBe(false)
    })

    it("uses content hash as fallback when mtime differs but content is same", () => {
      fs.writeFileSync(tmpFile, "same content")
      const mtime = fs.statSync(tmpFile).mtimeMs
      cache.record(tmpFile, "same content", mtime)

      // Touch the file to change mtime but keep same content
      const futureTime = mtime + 10000
      fs.utimesSync(tmpFile, new Date(futureTime), new Date(futureTime))

      const result = cache.isStale(tmpFile)
      // Content hash matches, so not stale despite mtime change
      expect(result.stale).toBe(false)
    })

    it("returns not stale when file no longer exists (cannot compare)", () => {
      fs.writeFileSync(tmpFile, "content")
      const mtime = fs.statSync(tmpFile).mtimeMs
      cache.record(tmpFile, "content", mtime)
      fs.unlinkSync(tmpFile)

      const result = cache.isStale(tmpFile)
      expect(result.stale).toBe(false)
    })

    it("returns not stale when stat succeeds but read fails", () => {
      fs.writeFileSync(tmpFile, "content")
      const mtime = fs.statSync(tmpFile).mtimeMs
      cache.record(tmpFile, "content", mtime)

      // Change mtime to trigger hash check, then make file unreadable
      const futureTime = mtime + 10000
      fs.utimesSync(tmpFile, new Date(futureTime), new Date(futureTime))
      fs.chmodSync(tmpFile, 0o000)

      const result = cache.isStale(tmpFile)
      // Can't read to hash-compare, so treat as not stale
      expect(result.stale).toBe(false)

      // Restore permissions for cleanup
      fs.chmodSync(tmpFile, 0o644)
    })
  })

  describe("contentHash", () => {
    it("returns sha256 hex digest", () => {
      const hash = contentHash("hello world")
      expect(hash).toBeTypeOf("string")
      expect(hash.length).toBe(64)
      // Known sha256 of "hello world"
      expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9")
    })
  })

  describe("messageId on cache entries", () => {
    it("stores optional messageId with record", () => {
      cache.record("/tmp/foo.ts", "content", 1234567890, undefined, undefined, "msg-001")
      const entry = cache.get("/tmp/foo.ts")
      expect(entry!.messageId).toBe("msg-001")
    })

    it("messageId is undefined when not provided", () => {
      cache.record("/tmp/foo.ts", "content", 1234567890)
      const entry = cache.get("/tmp/foo.ts")
      expect(entry!.messageId).toBeUndefined()
    })
  })

  describe("snapshots", () => {
    it("creates a snapshot from current cache entry", () => {
      cache.record("/tmp/foo.ts", "content", 1000, undefined, undefined, "msg-001")
      const snap = cache.snapshot("/tmp/foo.ts")
      expect(snap).toBeDefined()
      expect(snap!.hash).toBe(contentHash("content"))
      expect(snap!.mtime).toBe(1000)
      expect(snap!.messageId).toBe("msg-001")
      expect(snap!.filePath).toBe("/tmp/foo.ts")
    })

    it("returns undefined when path is not in cache", () => {
      expect(cache.snapshot("/nonexistent")).toBeUndefined()
    })

    it("stores snapshots separately from LRU cache", () => {
      cache.record("/tmp/foo.ts", "content", 1000)
      cache.snapshot("/tmp/foo.ts")

      // Clearing LRU cache should not clear snapshots
      cache.clear()
      expect(cache.get("/tmp/foo.ts")).toBeUndefined()

      const snapshots = cache.getSnapshots()
      expect(snapshots.length).toBe(1)
    })

    it("getSnapshots returns all snapshots in order", () => {
      cache.record("/a", "a", 1)
      cache.snapshot("/a")
      cache.record("/b", "b", 2)
      cache.snapshot("/b")

      const snapshots = cache.getSnapshots()
      expect(snapshots.length).toBe(2)
      expect(snapshots[0].filePath).toBe("/a")
      expect(snapshots[1].filePath).toBe("/b")
    })

    it("lookupSnapshotByHash returns matching snapshot", () => {
      cache.record("/tmp/foo.ts", "content", 1000, undefined, undefined, "msg-001")
      cache.snapshot("/tmp/foo.ts")
      const hash = contentHash("content")

      const found = cache.lookupSnapshotByHash(hash)
      expect(found).toBeDefined()
      expect(found!.filePath).toBe("/tmp/foo.ts")
      expect(found!.messageId).toBe("msg-001")
    })

    it("lookupSnapshotByHash returns undefined when no match", () => {
      expect(cache.lookupSnapshotByHash("nonexistent-hash")).toBeUndefined()
    })

    it("enforces max 100 snapshots per session", () => {
      for (let i = 0; i < 101; i++) {
        cache.record(`/file-${i}`, `content-${i}`, i)
        cache.snapshot(`/file-${i}`)
      }
      const snapshots = cache.getSnapshots()
      expect(snapshots.length).toBe(100)
      // First snapshot should be evicted
      expect(snapshots[0].filePath).toBe("/file-1")
      expect(snapshots[99].filePath).toBe("/file-100")
    })

    it("clearSnapshots removes all snapshots", () => {
      cache.record("/a", "a", 1)
      cache.snapshot("/a")
      cache.clearSnapshots()
      expect(cache.getSnapshots().length).toBe(0)
    })
  })
})
