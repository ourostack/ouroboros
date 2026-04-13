import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  discoverLogFiles,
  readLastLines,
  formatLogLine,
  tailLogs,
} from "../../../heart/daemon/log-tailer"

describe("log-tailer", () => {
  describe("discoverLogFiles", () => {
    it("returns ndjson files from log directory", () => {
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson", "agent-slugger.ndjson", "notes.txt"],
      })

      expect(files).toHaveLength(2)
      expect(files[0]).toContain("agent-slugger.ndjson")
      expect(files[1]).toContain("daemon.ndjson")
    })

    it("returns empty when log dir does not exist", () => {
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: () => false,
        readdirSync: () => [],
      })

      expect(files).toEqual([])
    })

    it("filters by agent name", () => {
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: () => true,
        readdirSync: () => ["daemon.ndjson", "agent-slugger.ndjson", "agent-ouroboros.ndjson"],
        agentFilter: "slugger",
      })

      expect(files).toHaveLength(1)
      expect(files[0]).toContain("slugger")
    })
  })

  describe("readLastLines", () => {
    it("returns last N non-empty lines", () => {
      const readFileSync = vi.fn(() => "line1\nline2\nline3\nline4\nline5\n")
      const lines = readLastLines("/test/file.ndjson", 3, readFileSync)

      expect(lines).toEqual(["line3", "line4", "line5"])
    })

    it("returns all lines when fewer than N", () => {
      const readFileSync = vi.fn(() => "line1\nline2\n")
      const lines = readLastLines("/test/file.ndjson", 10, readFileSync)

      expect(lines).toEqual(["line1", "line2"])
    })

    it("returns empty on read error", () => {
      const readFileSync = vi.fn(() => { throw new Error("ENOENT") })
      const lines = readLastLines("/test/missing.ndjson", 10, readFileSync)

      expect(lines).toEqual([])
    })
  })

  describe("formatLogLine", () => {
    it("formats valid NDJSON log entry with color", () => {
      const entry = JSON.stringify({
        ts: "2026-03-07T12:00:00.000Z",
        level: "info",
        event: "test.event",
        trace_id: "abc",
        component: "daemon",
        message: "test message",
        meta: {},
      })

      const formatted = formatLogLine(entry)
      expect(formatted).toContain("INFO")
      expect(formatted).toContain("[daemon]")
      expect(formatted).toContain("test message")
      expect(formatted).toContain("\x1b[36m") // info color
    })

    it("returns raw line for invalid JSON", () => {
      expect(formatLogLine("not-json")).toBe("not-json")
    })

    it("uses no color prefix for unknown log level", () => {
      const entry = JSON.stringify({
        ts: "2026-03-07T12:00:00.000Z",
        level: "trace",
        event: "test",
        trace_id: "abc",
        component: "daemon",
        message: "trace msg",
        meta: {},
      })

      const formatted = formatLogLine(entry)
      expect(formatted).toContain("trace msg")
      // No color prefix — fallback to empty string
      expect(formatted).not.toContain("\x1b[36m")
      expect(formatted).not.toContain("\x1b[33m")
      expect(formatted).not.toContain("\x1b[31m")
    })

    it("uses warn color for warn level", () => {
      const entry = JSON.stringify({
        ts: "2026-03-07T12:00:00.000Z",
        level: "warn",
        event: "test",
        trace_id: "abc",
        component: "daemon",
        message: "warning",
        meta: {},
      })

      expect(formatLogLine(entry)).toContain("\x1b[33m")
    })
  })

  describe("tailLogs", () => {
    it("writes initial lines to writer", () => {
      const output: string[] = []
      const writer = (text: string) => { output.push(text) }

      tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson"],
        readFileSync: () => JSON.stringify({
          ts: "2026-03-07T12:00:00.000Z",
          level: "info",
          event: "test",
          trace_id: "abc",
          component: "daemon",
          message: "startup",
          meta: {},
        }) + "\n",
        writer,
        lines: 10,
      })

      expect(output.length).toBeGreaterThan(0)
      expect(output[0]).toContain("startup")
    })

    it("returns no-op cleanup when not following", () => {
      const cleanup = tailLogs({
        homeDir: "/home/test",
        existsSync: () => false,
        readdirSync: () => [],
        readFileSync: () => "",
      })

      expect(typeof cleanup).toBe("function")
      expect(() => cleanup()).not.toThrow()
    })

    it("sets up file watchers in follow mode", () => {
      const watched: string[] = []
      const unwatched: string[] = []
      const output: string[] = []

      const cleanup = tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson"],
        readFileSync: () => "",
        writer: (text: string) => { output.push(text) },
        follow: true,
        watchFile: (target) => { watched.push(target) },
        unwatchFile: (target) => { unwatched.push(target) },
      })

      expect(watched).toHaveLength(1)
      expect(watched[0]).toContain("daemon.ndjson")

      cleanup()
      expect(unwatched).toHaveLength(1)
    })

    it("streams new lines when file changes in follow mode", () => {
      const output: string[] = []
      let fileContent = ""
      let watchCallback: (() => void) | null = null

      tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson"],
        readFileSync: () => fileContent,
        writer: (text: string) => { output.push(text) },
        follow: true,
        watchFile: (_target, listener) => { watchCallback = listener },
        unwatchFile: () => {},
      })

      // Simulate new content
      const newEntry = JSON.stringify({
        ts: "2026-03-07T12:01:00.000Z",
        level: "info",
        event: "test",
        trace_id: "abc",
        component: "daemon",
        message: "new event",
        meta: {},
      })
      fileContent = `${newEntry}\n`
      watchCallback?.()

      expect(output.some((line) => line.includes("new event"))).toBe(true)
    })

    it("skips writing when content has not grown in follow mode", () => {
      const output: string[] = []
      const initialContent = JSON.stringify({
        ts: "2026-03-07T12:00:00.000Z",
        level: "info",
        event: "test",
        trace_id: "abc",
        component: "daemon",
        message: "existing",
        meta: {},
      }) + "\n"
      let watchCallback: (() => void) | null = null

      tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson"],
        readFileSync: () => initialContent,
        writer: (text: string) => { output.push(text) },
        follow: true,
        watchFile: (_target, listener) => { watchCallback = listener },
        unwatchFile: () => {},
      })

      // Clear initial output
      output.length = 0

      // Trigger watch callback — content hasn't grown, so nothing new should be written
      watchCallback?.()
      expect(output).toHaveLength(0)
    })

    it("handles read errors during follow mode gracefully", () => {
      let readCount = 0
      let watchCallback: (() => void) | null = null

      tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson"],
        readFileSync: () => {
          readCount++
          if (readCount > 1) throw new Error("ENOENT")
          return ""
        },
        writer: () => {},
        follow: true,
        watchFile: (_target, listener) => { watchCallback = listener },
        unwatchFile: () => {},
      })

      expect(() => watchCallback?.()).not.toThrow()
    })

    it("uses defaults when options are minimal", () => {
      const cleanup = tailLogs({})
      expect(typeof cleanup).toBe("function")
    })
  })

  // ---------------- PR 1 — gzip-aware reads (new rotation scheme) ----------------

  describe("gzip-aware log reading", () => {
    let tmp: string

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tailer-gz-"))
    })

    afterEach(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }
    })

    it("discoverLogFiles returns both .ndjson and .ndjson.gz files, oldest gz first then active", () => {
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => [
          "daemon.ndjson",
          "daemon.1.ndjson.gz",
          "daemon.2.ndjson.gz",
          "notes.txt",
        ],
      })

      // All three log files included, notes.txt excluded.
      expect(files).toHaveLength(3)
      // Order: oldest generations first (.2, .1), active .ndjson last.
      expect(files[0]).toContain("daemon.2.ndjson.gz")
      expect(files[1]).toContain("daemon.1.ndjson.gz")
      expect(files[2]).toContain("daemon.ndjson")
    })

    it("discoverLogFiles treats legacy uncompressed .N.ndjson as gen-N (read before active)", () => {
      // Mixed real-world state: the daemon shipped with the old scheme so
      // there's still a plain daemon.1.ndjson on disk, plus the active
      // stream. discoverLogFiles should treat the legacy file as rank 1
      // and sort it before the active daemon.ndjson (rank 0).
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => [
          "daemon.ndjson",
          "daemon.1.ndjson", // legacy uncompressed generation
          "random.txt",
        ],
      })

      expect(files).toHaveLength(2)
      // Legacy gen-1 first, active last.
      expect(files[0]).toContain("daemon.1.ndjson")
      expect(files[1]?.endsWith("daemon.ndjson")).toBe(true)
    })

    it("discoverLogFiles sorts stably across multiple stream names in both directions", () => {
      // Include three different streams so the comparator's `a.streamBase <
      // b.streamBase ? -1 : 1` ternary fires both branches during sort.
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => [
          "zed.ndjson",
          "alpha.ndjson",
          "mid.ndjson",
          "zed.1.ndjson.gz",
          "alpha.1.ndjson.gz",
        ],
      })

      expect(files).toHaveLength(5)
      // Alphabetical across streams, gzipped older first within each stream.
      expect(files[0]).toContain("alpha.1.ndjson.gz")
      expect(files[1]?.endsWith("alpha.ndjson")).toBe(true)
      expect(files[2]?.endsWith("mid.ndjson")).toBe(true)
      expect(files[3]).toContain("zed.1.ndjson.gz")
      expect(files[4]?.endsWith("zed.ndjson")).toBe(true)
    })

    it("discoverLogFiles ignores gz files whose name pattern does not match generation-N", () => {
      // e.g. an unrelated backup.ndjson.gz with no numeric generation
      // suffix should be dropped by parseLogFilename's genMatch guard.
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => [
          "daemon.ndjson",
          "backup.ndjson.gz", // no .N suffix before .ndjson.gz
        ],
      })

      // Only daemon.ndjson survives.
      expect(files).toHaveLength(1)
      expect(files[0]).toContain("daemon.ndjson")
    })

    it("discoverLogFiles respects agentFilter for gz files too", () => {
      const files = discoverLogFiles({
        homeDir: "/home/test",
        existsSync: () => true,
        readdirSync: () => [
          "agent-slugger.ndjson",
          "agent-slugger.1.ndjson.gz",
          "agent-ouroboros.ndjson",
          "agent-ouroboros.1.ndjson.gz",
        ],
        agentFilter: "slugger",
      })

      expect(files).toHaveLength(2)
      expect(files.every((f) => f.includes("slugger"))).toBe(true)
    })

    it("readLastLines decompresses a .ndjson.gz file via a binary-capable readFileSync", () => {
      // Build a real gzipped fixture on disk.
      const gzPath = path.join(tmp, "events.1.ndjson.gz")
      const raw = "a\nb\nc\nd\ne\n"
      fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(raw, "utf-8")))

      // DI stub that returns a Buffer for gz files and utf-8 for everything
      // else — matches how the production impl routes based on extension.
      const readStub = ((target: string, encoding?: "utf-8") => {
        if (target.endsWith(".gz")) {
          // The log-tailer ignores `encoding` for gz paths and expects a Buffer.
          return fs.readFileSync(target) as unknown as string
        }
        return fs.readFileSync(target, encoding ?? "utf-8")
      }) as (target: string, encoding: "utf-8") => string

      const lines = readLastLines(gzPath, 3, readStub)
      expect(lines).toEqual(["c", "d", "e"])
    })

    it("readLastLines decompresses a .ndjson.gz when the DI stub returns a binary string", () => {
      // Alternate code path: the DI stub returns a binary-encoded string
      // (e.g. from `fs.readFileSync(target, "binary")`) instead of a Buffer.
      // The log-tailer must still decompress correctly.
      const gzPath = path.join(tmp, "events.1.ndjson.gz")
      const raw = "one\ntwo\nthree\n"
      fs.writeFileSync(gzPath, zlib.gzipSync(Buffer.from(raw, "utf-8")))

      const readStub = ((target: string) => {
        // Return bytes as a binary-encoded string.
        return fs.readFileSync(target).toString("binary")
      }) as (target: string, encoding: "utf-8") => string

      const lines = readLastLines(gzPath, 10, readStub)
      expect(lines).toEqual(["one", "two", "three"])
    })

    it("readLastLines returns [] for a gzipped file that cannot be read", () => {
      const lines = readLastLines("/definitely/not/there.ndjson.gz", 10, (() => {
        throw new Error("ENOENT")
      }) as (target: string, encoding: "utf-8") => string)

      expect(lines).toEqual([])
    })

    it("tailLogs reads a mixed history across 1 active + 2 gzipped generations in chronological order", () => {
      const makeLine = (msg: string): string => JSON.stringify({
        ts: "2026-03-07T12:00:00.000Z",
        level: "info",
        event: "test",
        trace_id: "t",
        component: "daemon",
        message: msg,
        meta: {},
      })

      // Process-local fixture: match by basename. tailer's discoverLogFiles
      // will construct absolute paths like /home/test/AgentBundles/
      // slugger.ouro/state/daemon/logs/daemon.N.ndjson[.gz]. We key by
      // the basename of whatever the tailer asks for.
      const gen2Bytes = zlib.gzipSync(Buffer.from(`${makeLine("old-1")}\n${makeLine("old-2")}\n`, "utf-8"))
      const gen1Bytes = zlib.gzipSync(Buffer.from(`${makeLine("mid-1")}\n${makeLine("mid-2")}\n`, "utf-8"))
      const activeText = `${makeLine("active")}\n`

      // readFileSync is declared as returning string. For gz files the
      // tailer MUST route through a binary path and decompress. We fake
      // the binary path by letting the tailer pass through whatever
      // argument signature it uses. The production impl will use a
      // dedicated gunzip-aware helper, so it never calls our stub with
      // `"utf-8"` on a .gz file.
      const readFileSync = vi.fn((target: string, _encoding?: unknown) => {
        const base = path.basename(target)
        if (base === "daemon.2.ndjson.gz") return gen2Bytes as unknown as string
        if (base === "daemon.1.ndjson.gz") return gen1Bytes as unknown as string
        if (base === "daemon.ndjson") return activeText
        return ""
      })

      const output: string[] = []
      tailLogs({
        homeDir: "/home/test",
        existsSync: (p) => p.includes("logs"),
        readdirSync: () => ["daemon.ndjson", "daemon.1.ndjson.gz", "daemon.2.ndjson.gz"],
        readFileSync: readFileSync as unknown as (target: string, encoding: "utf-8") => string,
        writer: (text: string) => { output.push(text) },
        lines: 10,
      })

      // Chronological order: old generations first, then mid, then active.
      const joined = output.join("")
      const idxOld1 = joined.indexOf("old-1")
      const idxOld2 = joined.indexOf("old-2")
      const idxMid1 = joined.indexOf("mid-1")
      const idxMid2 = joined.indexOf("mid-2")
      const idxActive = joined.indexOf("active")

      expect(idxOld1).toBeGreaterThan(-1)
      expect(idxOld2).toBeGreaterThan(idxOld1)
      expect(idxMid1).toBeGreaterThan(idxOld2)
      expect(idxMid2).toBeGreaterThan(idxMid1)
      expect(idxActive).toBeGreaterThan(idxMid2)
    })
  })
})
