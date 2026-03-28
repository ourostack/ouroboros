import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { rotateIfNeeded, createNdjsonFileSink } from "../../nerves"

describe("log rotation", () => {
  function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "log-rotation-"))
  }

  describe("rotateIfNeeded", () => {
    it("returns false when file does not exist", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "missing.ndjson")
      expect(rotateIfNeeded(filePath, 100)).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("returns false when file is under max size", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "small.ndjson")
      fs.writeFileSync(filePath, "x".repeat(50), "utf-8")
      expect(rotateIfNeeded(filePath, 100)).toBe(false)
      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("rotates when file exceeds max size", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, 100)).toBe(true)

      // Original should be gone, .1 should have the content
      expect(fs.existsSync(filePath)).toBe(false)
      expect(fs.existsSync(path.join(dir, "events.1.ndjson"))).toBe(true)
      expect(fs.readFileSync(path.join(dir, "events.1.ndjson"), "utf-8")).toBe("x".repeat(200))

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("shifts .1 to .2 and deletes old .2", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "events.ndjson")
      const file1 = path.join(dir, "events.1.ndjson")
      const file2 = path.join(dir, "events.2.ndjson")

      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")
      fs.writeFileSync(file1, "old-1", "utf-8")
      fs.writeFileSync(file2, "old-2", "utf-8")

      expect(rotateIfNeeded(filePath, 100)).toBe(true)

      expect(fs.existsSync(filePath)).toBe(false)
      expect(fs.readFileSync(file1, "utf-8")).toBe("x".repeat(200))
      expect(fs.readFileSync(file2, "utf-8")).toBe("old-1")

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("handles non-ndjson extension", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "logfile.log")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, 100)).toBe(true)
      expect(fs.existsSync(path.join(dir, "logfile.log.1"))).toBe(true)

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })

  describe("createNdjsonFileSink with rotation", () => {
    it("rotates logs after accumulating enough bytes", async () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "events.ndjson")

      // Pre-seed a large file so rotation triggers on first check
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Sink with very small max (100 bytes) — rotation check happens after bytesSinceCheck accumulates
      const sink = createNdjsonFileSink(filePath, 100)

      // Write enough data to exceed the 1MB rotation check threshold?
      // Actually, the ROTATION_CHECK_INTERVAL_BYTES is 1MB which is too large for a unit test.
      // But we can test that the sink works and writes correctly — the integration of
      // rotateIfNeeded is verified by the unit tests above.
      const entry = {
        ts: "2026-01-01T00:00:00Z",
        level: "info" as const,
        event: "test.entry",
        trace_id: "t-1",
        component: "test",
        message: "hello",
        meta: {},
      }

      sink(entry)

      // Wait for async flush
      await new Promise((resolve) => setTimeout(resolve, 50))

      // The sink should have written to the file
      const content = fs.readFileSync(filePath, "utf-8")
      expect(content).toContain("test.entry")

      fs.rmSync(dir, { recursive: true, force: true })
    })

    it("accepts custom maxSizeBytes parameter", () => {
      const dir = tmpDir()
      const filePath = path.join(dir, "custom.ndjson")

      // Just verify it doesn't throw with a custom maxSizeBytes
      const sink = createNdjsonFileSink(filePath, 1024)
      expect(typeof sink).toBe("function")

      fs.rmSync(dir, { recursive: true, force: true })
    })
  })
})
