import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as zlib from "zlib"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { compactLegacySessionArchives, runAgentStateRetention } from "../../../heart/daemon/state-retention"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"

const DAY = 24 * 60 * 60_000
const NOW = Date.parse("2026-11-23T12:00:00Z")

function writeAged(file: string, content: string | Buffer, ageMs: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  const at = new Date(NOW - ageMs)
  fs.utimesSync(file, at, at)
}

function archiveLines(count: number): string {
  return Array.from({ length: count }, (_, i) => JSON.stringify({ id: `evt-${i}`, role: "assistant", content: `turn ${i} ${"x".repeat(200)}` })).join("\n") + "\n"
}

function captureEvents(): { events: LogEvent[]; stop: () => void } {
  const events: LogEvent[] = []
  const stop = registerGlobalLogSink((entry: LogEvent) => {
    if (entry.event.startsWith("daemon.state_retention")) events.push(entry)
  })
  return { events, stop }
}

describe("compactLegacySessionArchives", () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-retention-")) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("gzips session archives nobody has written for a week, byte for byte, and leaves live session files alone", async () => {
    const sessions = path.join(dir, "sessions")
    const inner = path.join(sessions, "self", "inner", "dialog.archive.ndjson")
    const chat = path.join(sessions, "friend-1", "bluebubbles", "chat_any;-;a@example.com.archive.ndjson")
    const recent = path.join(sessions, "friend-1", "mcp", "s1.archive.ndjson")
    const dialog = path.join(sessions, "self", "inner", "dialog.json")
    writeAged(inner, archiveLines(2_000), 190 * DAY)
    writeAged(chat, archiveLines(500), 30 * DAY)
    writeAged(recent, archiveLines(10), 2 * DAY)
    writeAged(dialog, "{\"events\":[]}", 400 * DAY)
    const innerBytes = fs.readFileSync(inner)
    const chatBytes = fs.readFileSync(chat)

    const result = await compactLegacySessionArchives({ sessionsRoot: sessions, now: () => NOW })

    expect(result).toMatchObject({ compacted: 2, skippedRecent: 1, failed: 0, bytesBefore: innerBytes.length + chatBytes.length })
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore / 5)
    expect(fs.existsSync(inner)).toBe(false)
    expect(zlib.gunzipSync(fs.readFileSync(`${inner}.gz`)).equals(innerBytes)).toBe(true)
    expect(zlib.gunzipSync(fs.readFileSync(`${chat}.gz`)).equals(chatBytes)).toBe(true)
    expect(fs.existsSync(recent)).toBe(true)
    expect(fs.readFileSync(dialog, "utf-8")).toBe("{\"events\":[]}")
    expect(fs.readdirSync(path.dirname(inner)).filter((name) => name.includes(".tmp"))).toEqual([])

    // A second pass finds nothing left to do.
    expect(await compactLegacySessionArchives({ sessionsRoot: sessions, now: () => NOW })).toMatchObject({ compacted: 0, skippedRecent: 1, failed: 0 })
  })

  it("finishes a pass that stopped after writing the gzip, and keeps an archive whose gzip doesn't match it", async () => {
    const sessions = path.join(dir, "sessions")
    const done = path.join(sessions, "a", "x.archive.ndjson")
    const clash = path.join(sessions, "b", "y.archive.ndjson")
    writeAged(done, archiveLines(50), 30 * DAY)
    fs.writeFileSync(`${done}.gz`, zlib.gzipSync(fs.readFileSync(done)))
    writeAged(clash, archiveLines(50), 30 * DAY)
    fs.writeFileSync(`${clash}.gz`, zlib.gzipSync(Buffer.from("something else\n")))

    const result = await compactLegacySessionArchives({ sessionsRoot: sessions, now: () => NOW })

    expect(result).toMatchObject({ compacted: 1, failed: 1 })
    expect(fs.existsSync(done)).toBe(false)
    expect(fs.existsSync(clash)).toBe(true)
    expect(zlib.gunzipSync(fs.readFileSync(`${clash}.gz`)).toString()).toBe("something else\n")
  })

  it("keeps an archive it can't read, or whose leftover gzip is corrupt, and leaves no temporary file", async () => {
    const sessions = path.join(dir, "sessions")
    const locked = path.join(sessions, "a", "x.archive.ndjson")
    const corrupt = path.join(sessions, "b", "y.archive.ndjson")
    writeAged(locked, archiveLines(50), 30 * DAY)
    fs.chmodSync(locked, 0o000)
    writeAged(corrupt, archiveLines(50), 30 * DAY)
    fs.writeFileSync(`${corrupt}.gz`, "not a gzip")
    try {
      expect(await compactLegacySessionArchives({ sessionsRoot: sessions, now: () => NOW })).toMatchObject({ compacted: 0, failed: 2 })
    } finally {
      fs.chmodSync(locked, 0o644)
    }
    expect(fs.readdirSync(path.dirname(locked))).toEqual(["x.archive.ndjson"])
    expect(fs.existsSync(corrupt)).toBe(true)
  })

  it("keeps an archive that changes while it is being compressed", async () => {
    const sessions = path.join(dir, "sessions")
    const file = path.join(sessions, "a", "x.archive.ndjson")
    writeAged(file, archiveLines(50), 30 * DAY)
    const result = await compactLegacySessionArchives({
      sessionsRoot: sessions,
      now: () => NOW,
      beforeCommit: () => fs.appendFileSync(file, "{\"id\":\"late\"}\n"),
    })
    expect(result).toMatchObject({ compacted: 0, failed: 1 })
    expect(fs.readFileSync(file, "utf-8")).toContain("\"late\"")
    expect(fs.existsSync(`${file}.gz`)).toBe(false)
    expect(fs.readdirSync(path.dirname(file))).toEqual(["x.archive.ndjson"])
  })

  it("does nothing when there are no sessions, and skips symlinks", async () => {
    expect(await compactLegacySessionArchives({ sessionsRoot: path.join(dir, "missing") }))
      .toEqual({ compacted: 0, skippedRecent: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 })
    const sessions = path.join(dir, "sessions")
    const outside = path.join(dir, "outside.archive.ndjson")
    writeAged(outside, archiveLines(5), 30 * DAY)
    fs.mkdirSync(sessions)
    fs.symlinkSync(outside, path.join(sessions, "link.archive.ndjson"))
    expect(await compactLegacySessionArchives({ sessionsRoot: sessions, now: () => NOW })).toMatchObject({ compacted: 0, failed: 0 })
    expect(fs.existsSync(outside)).toBe(true)
  })
})

describe("runAgentStateRetention", () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "state-retention-")) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it("runs for every agent it is given and reports counts only", async () => {
    writeAged(path.join(dir, "slugger.ouro", "state", "sessions", "self", "inner", "dialog.archive.ndjson"), archiveLines(100), 30 * DAY)
    fs.mkdirSync(path.join(dir, "empty.ouro"))
    const capture = captureEvents()
    try {
      const results = await runAgentStateRetention({ bundlesRoot: dir, agents: ["slugger", "empty"], now: () => NOW })
      expect(results.map((r) => [r.agent, r.sessionArchives.compacted])).toEqual([["slugger", 1], ["empty", 0]])
    } finally {
      capture.stop()
    }
    const done = capture.events.filter((e) => e.event === "daemon.state_retention_session_archives")
    expect(done).toHaveLength(2)
    expect(done[0].meta).toEqual(expect.objectContaining({ agent: "slugger", compacted: 1, skippedRecent: 0, failed: 0 }))
    expect(JSON.stringify(done)).not.toContain(dir)
  })

  it("keeps going when one agent's pass throws", async () => {
    const capture = captureEvents()
    try {
      const results = await runAgentStateRetention({
        bundlesRoot: dir,
        agents: ["broken", "fine"],
        now: () => NOW,
        compactSessions: async ({ sessionsRoot }) => {
          if (sessionsRoot.includes("broken")) throw new Error("disk went away")
          return { compacted: 0, skippedRecent: 0, failed: 0, bytesBefore: 0, bytesAfter: 0 }
        },
      })
      expect(results.map((r) => r.agent)).toEqual(["fine"])
    } finally {
      capture.stop()
    }
    expect(capture.events.map((e) => e.event)).toContain("daemon.state_retention_error")
  })
})
