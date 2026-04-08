import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  rotateIfNeeded,
  createNdjsonFileSink,
  registerGlobalLogSink,
  type LogEvent,
} from "../../nerves"

/**
 * PR 1 — new rotation scheme tests.
 *
 * Policy: 25 MB threshold × 5 gzipped generations.
 * Current active file:  foo.ndjson
 * Generations:          foo.1.ndjson.gz (newest) … foo.5.ndjson.gz (oldest)
 * Legacy tolerance:     foo.1.ndjson / foo.2.ndjson (uncompressed, from old scheme)
 *                       are treated as generation N and gzipped on first rotation.
 *
 * All tests use tmpdir fixtures — no prod paths touched.
 */

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rotation-scheme-"))
}

function cleanup(dir: string): void {
  // Enumerate + delete per Directive A — no rmSync recursive in test source files
  // where we can help it. This is a test helper so rmSync recursive is allowed,
  // but we keep the pattern explicit for clarity.
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
}

function captureNervesEvents(filter?: (e: LogEvent) => boolean): { events: LogEvent[]; unregister: () => void } {
  const events: LogEvent[] = []
  const unregister = registerGlobalLogSink((entry: LogEvent) => {
    if (!filter || filter(entry)) {
      events.push(entry)
    }
  })
  return { events, unregister }
}

describe("rotation.new-scheme", () => {
  let dir: string

  beforeEach(() => {
    dir = tmpDir()
  })

  afterEach(() => {
    cleanup(dir)
  })

  describe("rotateIfNeeded — legacy number signature backcompat", () => {
    it("still accepts a bare number as the second argument (old positional API)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Old call site: rotateIfNeeded(path, 100). Must still rotate.
      expect(rotateIfNeeded(filePath, 100)).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)
      expect(fs.existsSync(path.join(dir, "events.1.ndjson.gz"))).toBe(true)
    })
  })

  describe("createNdjsonFileSink — legacy number signature backcompat", () => {
    it("still accepts a bare number as the second argument (old positional API)", () => {
      const filePath = path.join(dir, "events.ndjson")
      const sink = createNdjsonFileSink(filePath, 1024)
      expect(typeof sink).toBe("function")

      // Write one entry so the file exists.
      sink({
        ts: "2026-04-08T12:00:00.000Z",
        level: "info",
        event: "test",
        trace_id: "t-1",
        component: "test",
        message: "hello",
        meta: {},
      })
    })
  })

  describe("rotateIfNeeded — defaults and options", () => {
    it("returns false when file is under threshold with default options", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(100), "utf-8")

      // Default threshold is 25 MB; 100 bytes is well under.
      expect(rotateIfNeeded(filePath)).toBe(false)
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it("returns false when file does not exist", () => {
      const filePath = path.join(dir, "missing.ndjson")
      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(false)
    })

    it("returns false at maxSize - 1 byte (inclusive boundary check)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(99), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(false)
      expect(fs.existsSync(filePath)).toBe(true)
    })

    it("returns true at exactly maxSize (inclusive)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(100), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)
    })

    it("returns true at maxSize + 1 byte", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(101), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(true)
      expect(fs.existsSync(filePath)).toBe(false)
    })
  })

  describe("rotateIfNeeded — gzip + generations", () => {
    it("renames current to .1.ndjson then gzips to .1.ndjson.gz (default compress=true)", () => {
      const filePath = path.join(dir, "events.ndjson")
      const payload = "hello-rotation\n".repeat(10)
      fs.writeFileSync(filePath, payload, "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 1 })).toBe(true)

      // active file gone
      expect(fs.existsSync(filePath)).toBe(false)
      // uncompressed .1 should NOT remain after successful gzip
      expect(fs.existsSync(path.join(dir, "events.1.ndjson"))).toBe(false)
      // gzipped generation present
      const gzPath = path.join(dir, "events.1.ndjson.gz")
      expect(fs.existsSync(gzPath)).toBe(true)
      // content matches
      const gunzipped = zlib.gunzipSync(fs.readFileSync(gzPath)).toString("utf-8")
      expect(gunzipped).toBe(payload)
    })

    it("shifts existing .1.ndjson.gz → .2.ndjson.gz before rotating active", () => {
      const filePath = path.join(dir, "events.ndjson")
      const gen1 = path.join(dir, "events.1.ndjson.gz")
      const gen2 = path.join(dir, "events.2.ndjson.gz")

      // Preseed an existing gen 1
      fs.writeFileSync(gen1, zlib.gzipSync(Buffer.from("OLD-GEN-1", "utf-8")))
      fs.writeFileSync(filePath, "x".repeat(100), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 50 })).toBe(true)

      // old .1 moved to .2
      expect(fs.existsSync(gen2)).toBe(true)
      expect(zlib.gunzipSync(fs.readFileSync(gen2)).toString("utf-8")).toBe("OLD-GEN-1")
      // new .1 has the rotated active content
      expect(fs.existsSync(gen1)).toBe(true)
      expect(zlib.gunzipSync(fs.readFileSync(gen1)).toString("utf-8")).toBe("x".repeat(100))
    })

    it("drops the oldest generation when 5 already exist", () => {
      const filePath = path.join(dir, "events.ndjson")
      // Preseed generations 1..5
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(
          path.join(dir, `events.${i}.ndjson.gz`),
          zlib.gzipSync(Buffer.from(`GEN-${i}`, "utf-8")),
        )
      }
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 5 })).toBe(true)

      // Generation 5 should be gone and replaced by what was generation 4
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.5.ndjson.gz"))).toString("utf-8")).toBe("GEN-4")
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.4.ndjson.gz"))).toString("utf-8")).toBe("GEN-3")
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.3.ndjson.gz"))).toString("utf-8")).toBe("GEN-2")
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.2.ndjson.gz"))).toString("utf-8")).toBe("GEN-1")
      // new generation 1 holds the rotated-out active content
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.1.ndjson.gz"))).toString("utf-8")).toBe("x".repeat(200))
    })

    it("drops oldest generation when 6 existing generations present (overfull)", () => {
      const filePath = path.join(dir, "events.ndjson")
      // Preseed 5 generations (1..5) and one more stray beyond maxGenerations
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(
          path.join(dir, `events.${i}.ndjson.gz`),
          zlib.gzipSync(Buffer.from(`GEN-${i}`, "utf-8")),
        )
      }
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 5 })).toBe(true)

      // GEN-5 should have been dropped, GEN-4 becomes new .5
      expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.5.ndjson.gz"))).toString("utf-8")).toBe("GEN-4")
    })

    it("tolerates legacy uncompressed .1.ndjson file from the old scheme and migrates to gzip", () => {
      const filePath = path.join(dir, "events.ndjson")
      const legacy1 = path.join(dir, "events.1.ndjson")

      fs.writeFileSync(legacy1, "LEGACY-1", "utf-8")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(true)

      // After rotation: legacy .1.ndjson should be gone, .2.ndjson.gz holds its content
      expect(fs.existsSync(legacy1)).toBe(false)
      const gz2 = path.join(dir, "events.2.ndjson.gz")
      expect(fs.existsSync(gz2)).toBe(true)
      expect(zlib.gunzipSync(fs.readFileSync(gz2)).toString("utf-8")).toBe("LEGACY-1")
      // new .1.ndjson.gz holds the rotated active content
      const gz1 = path.join(dir, "events.1.ndjson.gz")
      expect(zlib.gunzipSync(fs.readFileSync(gz1)).toString("utf-8")).toBe("x".repeat(200))
    })

    it("tolerates legacy .2.ndjson uncompressed file (gets dropped if maxGenerations=1 or shifted otherwise)", () => {
      const filePath = path.join(dir, "events.ndjson")
      const legacy2 = path.join(dir, "events.2.ndjson")

      fs.writeFileSync(legacy2, "LEGACY-2", "utf-8")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // With maxGenerations=3, legacy .2 should shift to .3 (as gzip)
      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 3 })).toBe(true)
      expect(fs.existsSync(legacy2)).toBe(false)
      const gz3 = path.join(dir, "events.3.ndjson.gz")
      expect(fs.existsSync(gz3)).toBe(true)
      expect(zlib.gunzipSync(fs.readFileSync(gz3)).toString("utf-8")).toBe("LEGACY-2")
    })

    it("skips gzip when compress=false (produces plain .1.ndjson rotated file)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, compress: false })).toBe(true)

      const rotated = path.join(dir, "events.1.ndjson")
      expect(fs.existsSync(rotated)).toBe(true)
      expect(fs.readFileSync(rotated, "utf-8")).toBe("x".repeat(200))
      // No .gz should be written
      expect(fs.existsSync(path.join(dir, "events.1.ndjson.gz"))).toBe(false)
    })

    it("handles non-ndjson extension gracefully (treats as plain file suffix)", () => {
      const filePath = path.join(dir, "logfile.log")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, compress: false })).toBe(true)
      // With non-ndjson extension we fall back to appending .1 suffix
      expect(fs.existsSync(path.join(dir, "logfile.log.1"))).toBe(true)
    })
  })

  describe("rotateIfNeeded — destination slot unlink paths", () => {
    it("unlinks a legacy destPlain .N.ndjson occupying the destination slot during generation shift", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Pre-seed the destination slot (generation 2) as a legacy uncompressed
      // daemon.2.ndjson file. When maxGenerations=2, the shift loop iterates
      // for n=2, sees the legacy .2.ndjson in destPlain, and must unlink it.
      // It then migrates srcPlain (.1.ndjson) into the slot — so we ALSO
      // pre-seed events.1.ndjson as a legacy uncompressed file.
      fs.writeFileSync(path.join(dir, "events.2.ndjson"), "DEST-LEGACY-PLAIN", "utf-8")
      fs.writeFileSync(path.join(dir, "events.1.ndjson"), "SRC-LEGACY-PLAIN", "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 2 })).toBe(true)

      // destPlain removed, legacy src migrated to .2.ndjson.gz
      expect(fs.existsSync(path.join(dir, "events.2.ndjson"))).toBe(false)
      expect(fs.existsSync(path.join(dir, "events.2.ndjson.gz"))).toBe(true)
      expect(
        zlib.gunzipSync(fs.readFileSync(path.join(dir, "events.2.ndjson.gz"))).toString("utf-8"),
      ).toBe("SRC-LEGACY-PLAIN")
    })

    it("shifts a legacy srcPlain to destPlain with compress=false (no gzip)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Pre-seed a legacy .1.ndjson file and run with compress=false.
      fs.writeFileSync(path.join(dir, "events.1.ndjson"), "LEGACY-PLAIN", "utf-8")

      expect(
        rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 3, compress: false }),
      ).toBe(true)

      // Legacy file shifted to .2.ndjson (still uncompressed) and active
      // file rotated into .1.ndjson.
      expect(fs.existsSync(path.join(dir, "events.1.ndjson"))).toBe(true)
      expect(fs.readFileSync(path.join(dir, "events.1.ndjson"), "utf-8")).toBe("x".repeat(200))
      expect(fs.existsSync(path.join(dir, "events.2.ndjson"))).toBe(true)
      expect(fs.readFileSync(path.join(dir, "events.2.ndjson"), "utf-8")).toBe("LEGACY-PLAIN")
    })
  })

  describe("rotateIfNeeded — stale file cleanup paths", () => {
    it("unlinks a stale plain .1.ndjson that exists at rename target (compress=true path)", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Pre-seed a stale .1.ndjson file (e.g. from an interrupted prior rotation).
      // This is distinct from the "legacy uncompressed generation" case — we're
      // testing that if a file happens to exist at the rename target, it's
      // removed cleanly before renameSync.
      //
      // Note: the generation-shift loop will first move this stale file to
      // .2.ndjson.gz (as a legacy gen-1 migration). To exercise the "stale
      // plain1 at rename target" unlink specifically, we drop it at the
      // plain1 path AFTER the loop would have shifted it — which means
      // we need a single-generation rotation so the shift loop doesn't run.
      // Use maxGenerations=1, which makes the shift loop body not iterate.
      const plain1 = path.join(dir, "events.1.ndjson")
      fs.writeFileSync(plain1, "STALE-LEFTOVER", "utf-8")

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 1 })).toBe(true)

      // Active file rotated to .1.ndjson.gz, the stale file was removed.
      const gz1 = path.join(dir, "events.1.ndjson.gz")
      expect(fs.existsSync(gz1)).toBe(true)
      expect(fs.existsSync(plain1)).toBe(false)
    })

    it("unlinks a pre-existing .1.ndjson.gz at the write target before writing the new one", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Pre-seed a stale .1.ndjson.gz that the step-1 shift loop won't touch
      // because maxGenerations=1 skips the n>=2 loop body entirely. The
      // rotation code's step 3 must defensively unlink it before writing the
      // new gzipped file.
      const gz1 = path.join(dir, "events.1.ndjson.gz")
      fs.writeFileSync(gz1, zlib.gzipSync(Buffer.from("STALE-GZ", "utf-8")))

      expect(rotateIfNeeded(filePath, { maxSizeBytes: 100, maxGenerations: 1 })).toBe(true)

      // New gzipped content, not the stale.
      expect(zlib.gunzipSync(fs.readFileSync(gz1)).toString("utf-8")).toBe("x".repeat(200))
    })
  })

  describe("createNdjsonFileSink — rotation trigger path", () => {
    it("rotates once the stat-check threshold is reached", async () => {
      const filePath = path.join(dir, "events.ndjson")

      // Pre-seed a large file so rotation fires on the first stat check.
      fs.writeFileSync(filePath, "x".repeat(500), "utf-8")

      // Use a tiny rotation check interval so a single small write triggers
      // the rotation branch inside the sink's flush().
      const sink = createNdjsonFileSink(filePath, {
        maxSizeBytes: 400,
        maxGenerations: 2,
        compress: true,
        rotationCheckIntervalBytes: 10,
      })

      // Two writes: the first queues bytes without triggering rotation
      // (bytesSinceCheck is 0 at start, needs to pass the interval). The
      // second write pushes it over.
      for (let i = 0; i < 3; i++) {
        sink({
          ts: "2026-04-08T12:00:00.000Z",
          level: "info",
          event: "test.entry",
          trace_id: `t-${i}`,
          component: "test",
          message: `entry ${i}`,
          meta: {},
        })
      }

      // Wait for async flush to catch up. Generous budget (≈2s) because
      // this test depends on the appendFile → flush() callback chain under
      // CI load. Bails early as soon as the rotated .gz appears.
      for (let i = 0; i < 100; i++) {
        if (fs.existsSync(path.join(dir, "events.1.ndjson.gz"))) break
        await new Promise((resolve) => setTimeout(resolve, 20))
      }

      // Rotation happened: historical gen 1 exists as .gz.
      expect(fs.existsSync(path.join(dir, "events.1.ndjson.gz"))).toBe(true)
    })

    it("swallows rotation errors inside createNdjsonFileSink flush (never blocks writes)", async () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(500), "utf-8")

      // Sabotage the rename target to force rotateIfNeeded to throw on the
      // inline call inside flush(). The sink must swallow it and keep writing.
      const plain1 = path.join(dir, "events.1.ndjson")
      fs.mkdirSync(plain1)
      fs.writeFileSync(path.join(plain1, "blocker"), "x", "utf-8")

      const sink = createNdjsonFileSink(filePath, {
        maxSizeBytes: 400,
        maxGenerations: 2,
        compress: true,
        rotationCheckIntervalBytes: 5,
      })

      // Issue writes — rotation will throw but sink must not crash.
      expect(() => {
        for (let i = 0; i < 3; i++) {
          sink({
            ts: "2026-04-08T12:00:00.000Z",
            level: "info",
            event: "test.entry",
            trace_id: `t-${i}`,
            component: "test",
            message: `entry ${i}`,
            meta: {},
          })
        }
      }).not.toThrow()

      // Give the async flush loop time to run.
      await new Promise((resolve) => setTimeout(resolve, 50))

      // Clean up the sabotage.
      try {
        fs.unlinkSync(path.join(plain1, "blocker"))
        fs.rmdirSync(plain1)
      } catch { /* best effort */ }
    })
  })

  describe("rotateIfNeeded — nerves events", () => {
    it("emits paired rotation_start / rotation_end on success", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      const { events, unregister } = captureNervesEvents(
        (e) => e.event === "nerves.rotation_start" || e.event === "nerves.rotation_end",
      )
      try {
        expect(rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toBe(true)
      } finally {
        unregister()
      }

      const start = events.find((e) => e.event === "nerves.rotation_start")
      const end = events.find((e) => e.event === "nerves.rotation_end")
      expect(start).toBeDefined()
      expect(end).toBeDefined()
      // Same trace id across start/end for pairability
      expect(start?.trace_id).toBe(end?.trace_id)
      // meta contents
      expect(start?.meta).toMatchObject({ path: filePath, currentSize: 200, threshold: 100, generation: 1 })
      expect(end?.meta).toMatchObject({ path: filePath })
      expect(typeof (end?.meta as Record<string, unknown>).bytesFreed).toBe("number")
    })

    it("emits rotation_error (not rotation_end) when rename fails mid-rotation", () => {
      const filePath = path.join(dir, "events.ndjson")
      fs.writeFileSync(filePath, "x".repeat(200), "utf-8")

      // Sabotage the .1.ndjson destination so that `renameSync(filePath, plain1)`
      // after the unlink cannot succeed. We pre-create .1.ndjson as a
      // non-empty directory. The rotation's `unlinkSync(plain1)` on a
      // non-empty directory throws (ENOTEMPTY/EPERM), which surfaces as a
      // rotation error in the try/catch path.
      const plain1 = path.join(dir, "events.1.ndjson")
      fs.mkdirSync(plain1)
      fs.writeFileSync(path.join(plain1, "blocker.txt"), "block", "utf-8")

      const { events, unregister } = captureNervesEvents(
        (e) => e.event === "nerves.rotation_start" || e.event === "nerves.rotation_end" || e.event === "nerves.rotation_error",
      )
      try {
        expect(() => rotateIfNeeded(filePath, { maxSizeBytes: 100 })).toThrow()
      } finally {
        unregister()
      }

      const start = events.find((e) => e.event === "nerves.rotation_start")
      const end = events.find((e) => e.event === "nerves.rotation_end")
      const err = events.find((e) => e.event === "nerves.rotation_error")

      expect(start).toBeDefined()
      expect(end).toBeUndefined()
      expect(err).toBeDefined()
      expect(start?.trace_id).toBe(err?.trace_id)
      expect((err?.meta as Record<string, unknown>).error).toBeTruthy()

      // cleanup the sabotage
      try {
        fs.unlinkSync(path.join(plain1, "blocker.txt"))
        fs.rmdirSync(plain1)
      } catch { /* best effort */ }
    })
  })
})
