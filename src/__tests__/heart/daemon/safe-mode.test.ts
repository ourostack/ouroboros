import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

const mockEmitNervesEvent = vi.fn()
vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  detectSafeMode,
  pruneOldCrashes,
  SAFE_MODE_OVERRIDE_FILENAME,
  type SafeModeDetectionResult,
} from "../../../heart/daemon/safe-mode"

describe("safe-mode", () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
    vi.clearAllMocks()
  })

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "safe-mode-"))
    return tmpDir
  }

  function writeTombstone(dir: string, data: Record<string, unknown>): string {
    const filePath = path.join(dir, "daemon-death.json")
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8")
    return filePath
  }

  function writeOverrideFile(dir: string): string {
    const filePath = path.join(dir, SAFE_MODE_OVERRIDE_FILENAME)
    fs.writeFileSync(filePath, JSON.stringify({ createdAt: new Date().toISOString() }), "utf-8")
    return filePath
  }

  describe("detectSafeMode", () => {
    it("returns inactive when tombstone does not exist", () => {
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(false)
      expect(result.reason).toBe("")
      expect(result.enteredAt).toBe("")
    })

    it("returns inactive when tombstone has no recentCrashes", () => {
      const dir = makeTmpDir()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 10,
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(false)
    })

    it("returns inactive when recentCrashes has fewer than 3 entries", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 10,
        recentCrashes: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(false)
    })

    it("returns active when 3+ crashes within 5 minutes", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 180_000).toISOString(),  // 3 min ago
          new Date(now - 90_000).toISOString(),   // 1.5 min ago
          new Date(now - 10_000).toISOString(),   // 10s ago
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath, { now: () => now })

      expect(result.active).toBe(true)
      expect(result.reason).toContain("crash loop")
      expect(result.enteredAt).toBeTruthy()
    })

    it("returns inactive when 3+ crashes but spread over more than 5 minutes", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 10,
        recentCrashes: [
          new Date(now - 600_000).toISOString(),  // 10 min ago
          new Date(now - 400_000).toISOString(),  // ~6.7 min ago
          new Date(now - 200_000).toISOString(),  // ~3.3 min ago
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath, { now: () => now })

      expect(result.active).toBe(false)
    })

    it("only considers crashes within the 5-minute window", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 600_000).toISOString(),  // 10 min ago (outside window)
          new Date(now - 500_000).toISOString(),  // ~8.3 min ago (outside)
          new Date(now - 90_000).toISOString(),   // 1.5 min ago (inside)
          new Date(now - 30_000).toISOString(),   // 30s ago (inside)
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      // Only 2 within 5 minutes — not enough
      const result = detectSafeMode(tombstonePath, { now: () => now })

      expect(result.active).toBe(false)
    })

    it("returns inactive when override file exists (--force)", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now - 10_000).toISOString(),
        ],
      })
      writeOverrideFile(dir)
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath, { now: () => now })

      expect(result.active).toBe(false)
    })

    it("returns inactive in dev mode regardless of crashes", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now - 10_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath, { now: () => now, devMode: true })

      expect(result.active).toBe(false)
    })

    it("handles invalid JSON in tombstone gracefully", () => {
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")
      fs.writeFileSync(tombstonePath, "not valid json", "utf-8")

      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(false)
    })

    it("handles recentCrashes with non-string entries gracefully", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [42, null, new Date(now - 60_000).toISOString()],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath, { now: () => now })

      // Only 1 valid string entry within window — not enough
      expect(result.active).toBe(false)
    })

    it("filters out invalid date strings from recentCrashes", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          "not-a-valid-date",
          "also-invalid",
          new Date(now - 60_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      // Only 1 valid entry within window — not enough for safe mode
      const result = detectSafeMode(tombstonePath, { now: () => now })

      expect(result.active).toBe(false)
    })

    it("uses Date.now() as default when no now option provided", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now - 10_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      // No options at all — should use Date.now() internally
      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(true)
    })

    it("handles recentCrashes that is not an array gracefully", () => {
      const dir = makeTmpDir()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: "not-an-array",
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      const result = detectSafeMode(tombstonePath)

      expect(result.active).toBe(false)
    })

    it("emits nerves event when safe mode is detected", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 2,
        recentCrashes: [
          new Date(now - 60_000).toISOString(),
          new Date(now - 30_000).toISOString(),
          new Date(now - 10_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      detectSafeMode(tombstonePath, { now: () => now })

      expect(mockEmitNervesEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "daemon.safe_mode_entered",
          level: "error",
        })
      )
    })

    it("does not emit safe mode event when not in safe mode", () => {
      const dir = makeTmpDir()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 10,
        recentCrashes: [],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      detectSafeMode(tombstonePath)

      const safeModeEvents = mockEmitNervesEvent.mock.calls.filter(
        (c: any[]) => c[0]?.event === "daemon.safe_mode_entered"
      )
      expect(safeModeEvents).toHaveLength(0)
    })
  })

  describe("pruneOldCrashes", () => {
    it("removes entries older than the stability threshold from tombstone", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      const oldCrash = new Date(now - 600_000).toISOString()  // 10 min ago
      const recentCrash = new Date(now - 60_000).toISOString() // 1 min ago
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 120,
        recentCrashes: [oldCrash, recentCrash],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      pruneOldCrashes(tombstonePath, { now: () => now })

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const crashes = parsed.recentCrashes as string[]
      expect(crashes).toEqual([recentCrash])
    })

    it("clears all entries when all are old", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 600,
        recentCrashes: [
          new Date(now - 600_000).toISOString(),
          new Date(now - 500_000).toISOString(),
        ],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      pruneOldCrashes(tombstonePath, { now: () => now })

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.recentCrashes).toEqual([])
    })

    it("removes the override file on successful prune", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 120,
        recentCrashes: [],
      })
      writeOverrideFile(dir)
      const tombstonePath = path.join(dir, "daemon-death.json")
      const overridePath = path.join(dir, SAFE_MODE_OVERRIDE_FILENAME)

      expect(fs.existsSync(overridePath)).toBe(true)

      pruneOldCrashes(tombstonePath, { now: () => now })

      expect(fs.existsSync(overridePath)).toBe(false)
    })

    it("handles missing tombstone gracefully", () => {
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")

      expect(() => pruneOldCrashes(tombstonePath)).not.toThrow()
    })

    it("handles invalid JSON in tombstone gracefully", () => {
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")
      fs.writeFileSync(tombstonePath, "not valid json", "utf-8")

      expect(() => pruneOldCrashes(tombstonePath)).not.toThrow()
    })

    it("handles tombstone with no recentCrashes field", () => {
      const dir = makeTmpDir()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 120,
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      expect(() => pruneOldCrashes(tombstonePath)).not.toThrow()
    })

    it("filters out non-string entries in recentCrashes during prune", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      const recentCrash = new Date(now - 60_000).toISOString()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date(now).toISOString(),
        pid: 1234,
        uptimeSeconds: 120,
        recentCrashes: [42, null, recentCrash, "not-a-valid-date"],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      pruneOldCrashes(tombstonePath, { now: () => now })

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const crashes = parsed.recentCrashes as string[]
      // Only the valid recent ISO timestamp survives; invalid date string is filtered by isNaN
      expect(crashes).toEqual([recentCrash])
    })

    it("uses Date.now() as default when no now option provided for prune", () => {
      const dir = makeTmpDir()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "boom",
        stack: null,
        timestamp: new Date().toISOString(),
        pid: 1234,
        uptimeSeconds: 120,
        recentCrashes: [new Date(Date.now() - 1000).toISOString()],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      // No options — should use Date.now() internally
      pruneOldCrashes(tombstonePath)

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      // Recent crash (1s ago) should still be within the 5-minute window
      expect((parsed.recentCrashes as string[]).length).toBe(1)
    })

    it("preserves other tombstone fields when pruning", () => {
      const dir = makeTmpDir()
      const now = Date.now()
      writeTombstone(dir, {
        reason: "uncaughtException",
        message: "original message",
        stack: "stack trace here",
        timestamp: new Date(now).toISOString(),
        pid: 9999,
        uptimeSeconds: 42,
        recentCrashes: [new Date(now - 600_000).toISOString()],
      })
      const tombstonePath = path.join(dir, "daemon-death.json")

      pruneOldCrashes(tombstonePath, { now: () => now })

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      expect(parsed.reason).toBe("uncaughtException")
      expect(parsed.message).toBe("original message")
      expect(parsed.stack).toBe("stack trace here")
      expect(parsed.pid).toBe(9999)
      expect(parsed.uptimeSeconds).toBe(42)
      expect(parsed.recentCrashes).toEqual([])
    })
  })

  describe("writeDaemonTombstone with recentCrashes", () => {
    // This tests the extended DaemonTombstone interface: writeDaemonTombstone
    // should read existing tombstone, append current timestamp to recentCrashes, then write.
    // We import from daemon-tombstone and verify the extended behavior.

    it("appends crash timestamp to recentCrashes when writing tombstone", async () => {
      // We need to test that writeDaemonTombstone (the updated version) reads
      // existing recentCrashes and appends. We'll import it separately.
      const { writeDaemonTombstone, setTombstonePath } = await import("../../../heart/daemon/daemon-tombstone")
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")
      setTombstonePath(tombstonePath)

      // Write first crash
      writeDaemonTombstone("uncaughtException", new Error("first"))

      let raw = fs.readFileSync(tombstonePath, "utf-8")
      let parsed = JSON.parse(raw) as Record<string, unknown>
      const crashes1 = parsed.recentCrashes as string[]
      expect(Array.isArray(crashes1)).toBe(true)
      expect(crashes1.length).toBe(1)

      // Write second crash
      writeDaemonTombstone("uncaughtException", new Error("second"))

      raw = fs.readFileSync(tombstonePath, "utf-8")
      parsed = JSON.parse(raw) as Record<string, unknown>
      const crashes2 = parsed.recentCrashes as string[]
      expect(crashes2.length).toBe(2)

      // Reset
      setTombstonePath(null)
    })

    it("starts fresh recentCrashes array when tombstone has none", async () => {
      const { writeDaemonTombstone, setTombstonePath } = await import("../../../heart/daemon/daemon-tombstone")
      const dir = makeTmpDir()
      const tombstonePath = path.join(dir, "daemon-death.json")
      setTombstonePath(tombstonePath)

      // Write initial tombstone without recentCrashes
      fs.writeFileSync(tombstonePath, JSON.stringify({
        reason: "old",
        message: "old crash",
        stack: null,
        timestamp: "2026-01-01T00:00:00Z",
        pid: 1000,
        uptimeSeconds: 5,
      }), "utf-8")

      writeDaemonTombstone("uncaughtException", new Error("new crash"))

      const raw = fs.readFileSync(tombstonePath, "utf-8")
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const crashes = parsed.recentCrashes as string[]
      expect(Array.isArray(crashes)).toBe(true)
      expect(crashes.length).toBe(1)

      setTombstonePath(null)
    })
  })
})
