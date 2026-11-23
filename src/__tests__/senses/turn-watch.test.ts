import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../nerves/runtime"
import type { ChannelCallbacks } from "../../heart/core"
import {
  TURN_STALLED_AFTER_MS,
  beginTurnInFlight,
  isWatchedSense,
  snapshotTurnsInFlight,
  watchTurnCallbacks,
} from "../../senses/turn-watch"

const START = Date.parse("2026-11-22T10:00:00.000Z")

function markerDir(root: string, sense: string): string {
  return path.join(root, "state", "senses", sense, "turns-in-flight")
}

function markers(root: string, sense: string): Array<Record<string, unknown>> {
  const dir = markerDir(root, sense)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")))
}

function callbacksSpy(): ChannelCallbacks & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onModelStart: vi.fn(),
    onModelStreamStart: vi.fn(),
    onTextChunk: vi.fn(),
    onReasoningChunk: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onToolResult: vi.fn(),
    onError: vi.fn(),
  } as unknown as ChannelCallbacks & Record<string, ReturnType<typeof vi.fn>>
}

describe("turn watch", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-watch-"))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("watches the senses that have a status row of their own, and leaves iMessage to its own tracker", () => {
    for (const sense of ["teams", "mail", "voice", "a2a", "telegram"]) expect(isWatchedSense(sense)).toBe(true)
    for (const sense of ["bluebubbles", "cli", "inner", "mcp", "external-event"]) expect(isWatchedSense(sense)).toBe(false)
  })

  it("records a turn while it runs and removes the record when it ends", () => {
    const watch = beginTurnInFlight(root, "telegram", "chat-1", START)
    expect(markers(root, "telegram")).toEqual([
      expect.objectContaining({ pid: process.pid, sessionKey: "chat-1", startedAt: "2026-11-22T10:00:00.000Z", lastProgressAt: "2026-11-22T10:00:00.000Z" }),
    ])
    watch.finish()
    expect(markers(root, "telegram")).toEqual([])
    watch.finish()
    expect(markers(root, "telegram")).toEqual([])
  })

  it("counts a turn as stalled only after five minutes with no progress", () => {
    const watch = beginTurnInFlight(root, "teams", "conv", START)
    expect(snapshotTurnsInFlight(root, "teams", START + TURN_STALLED_AFTER_MS - 1)).toEqual({
      activeTurnCount: 1,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: "2026-11-22T10:00:00.000Z",
      oldestActiveTurnAgeMs: TURN_STALLED_AFTER_MS - 1,
    })
    expect(snapshotTurnsInFlight(root, "teams", START + TURN_STALLED_AFTER_MS)).toEqual({
      activeTurnCount: 1,
      stalledTurnCount: 1,
      oldestActiveTurnStartedAt: "2026-11-22T10:00:00.000Z",
      oldestActiveTurnAgeMs: TURN_STALLED_AFTER_MS,
      longestSilenceMs: TURN_STALLED_AFTER_MS,
    })
    watch.finish()
  })

  it("progress resets the silence, but is written at most every 30 seconds", () => {
    const watch = beginTurnInFlight(root, "teams", "conv", START)
    watch.touch(START + 29_999)
    expect(markers(root, "teams")[0]!.lastProgressAt).toBe("2026-11-22T10:00:00.000Z")
    watch.touch(START + 30_000)
    expect(markers(root, "teams")[0]!.lastProgressAt).toBe("2026-11-22T10:00:30.000Z")
    expect(snapshotTurnsInFlight(root, "teams", START + 30_000 + TURN_STALLED_AFTER_MS - 1).stalledTurnCount).toBe(0)
    expect(snapshotTurnsInFlight(root, "teams", START + 30_000 + TURN_STALLED_AFTER_MS).stalledTurnCount).toBe(1)
    watch.finish()
    watch.touch(START + 120_000)
    expect(markers(root, "teams")).toEqual([])
  })

  it("ignores turns of a process that is gone, and records from other senses", () => {
    const dir = markerDir(root, "mail")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "dead.json"), JSON.stringify({ pid: 999_999, sessionKey: "x", startedAt: "2026-11-22T09:00:00.000Z", lastProgressAt: "2026-11-22T09:00:00.000Z" }))
    const other = beginTurnInFlight(root, "voice", "call", START - 3_600_000)
    expect(snapshotTurnsInFlight(root, "mail", START, (pid) => pid !== 999_999)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
    other.finish()
  })

  it("ignores a turn recorded before the sense's current process started", () => {
    const dir = markerDir(root, "telegram")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "earlier.json"), JSON.stringify({ pid: process.pid, sessionKey: "x", startedAt: "2026-11-22T09:00:00.000Z", lastProgressAt: "2026-11-22T09:00:00.000Z" }))
    expect(snapshotTurnsInFlight(root, "telegram", START, undefined, Date.parse("2026-11-22T09:30:00.000Z"))).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
    expect(snapshotTurnsInFlight(root, "telegram", START, undefined, Date.parse("2026-11-22T09:00:00.000Z")).stalledTurnCount).toBe(1)
  })

  it("skips records it cannot read, and reads nothing when the sense never ran a turn", () => {
    const dir = markerDir(root, "a2a")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "garbled.json"), "{not json")
    fs.writeFileSync(path.join(dir, "partial.json"), JSON.stringify({ pid: process.pid, startedAt: "not a date" }))
    fs.writeFileSync(path.join(dir, "bad-date.json"), JSON.stringify({ pid: process.pid, sessionKey: "x", startedAt: "2026-11-22T09:00:00.000Z", lastProgressAt: "soon" }))
    fs.writeFileSync(path.join(dir, "null.json"), "null")
    fs.writeFileSync(path.join(dir, "note.txt"), "ignored")
    expect(snapshotTurnsInFlight(root, "a2a", START)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
    expect(snapshotTurnsInFlight(root, "telegram", START)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
  })

  it("clears its own process's records left by a turn that never finished, but not another live process's", () => {
    const dir = markerDir(root, "telegram")
    fs.mkdirSync(dir, { recursive: true })
    const stale = { pid: process.pid, sessionKey: "old", startedAt: "2026-11-22T09:00:00.000Z", lastProgressAt: "2026-11-22T09:00:00.000Z" }
    fs.writeFileSync(path.join(dir, "stale-same-pid.json"), JSON.stringify(stale))
    fs.writeFileSync(path.join(dir, "dead-pid.json"), JSON.stringify({ ...stale, pid: 999_999 }))
    fs.writeFileSync(path.join(dir, "live-other.json"), JSON.stringify({ ...stale, pid: process.ppid }))
    fs.writeFileSync(path.join(dir, "garbled.json"), "{")
    const watch = beginTurnInFlight(root, "telegram", "new", START)
    expect(fs.readdirSync(dir).sort()).toEqual(["live-other.json", expect.stringMatching(/^\d+-\d+\.json$/)].sort())
    watch.finish()
  })

  it("keeps the record of another turn this process is still running", () => {
    const first = beginTurnInFlight(root, "teams", "one", START)
    const second = beginTurnInFlight(root, "teams", "two", START + 1_000)
    expect(markers(root, "teams").map((record) => record.sessionKey).sort()).toEqual(["one", "two"])
    expect(snapshotTurnsInFlight(root, "teams", START + 2_000)).toEqual(expect.objectContaining({ activeTurnCount: 2, oldestActiveTurnStartedAt: "2026-11-22T10:00:00.000Z" }))
    first.finish()
    second.finish()
  })

  it("finds the oldest turn whichever order the records are listed in", () => {
    const dir = markerDir(root, "voice")
    fs.mkdirSync(dir, { recursive: true })
    const record = (startedAt: string) => JSON.stringify({ pid: process.pid, sessionKey: "call", startedAt, lastProgressAt: startedAt })
    fs.writeFileSync(path.join(dir, "a.json"), record("2026-11-22T09:59:00.000Z"))
    fs.writeFileSync(path.join(dir, "b.json"), record("2026-11-22T09:58:00.000Z"))
    expect(snapshotTurnsInFlight(root, "voice", START).oldestActiveTurnStartedAt).toBe("2026-11-22T09:58:00.000Z")
  })

  it("warns once when progress can no longer be written, and the turn carries on", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    const watch = beginTurnInFlight(root, "mail", "inbox", START)
    const dir = markerDir(root, "mail")
    fs.renameSync(dir, `${dir}-moved`)
    fs.writeFileSync(dir, "a file where the folder was")
    watch.touch(START + 30_000)
    watch.touch(START + 60_000)
    expect(emit.mock.calls.filter(([event]) => event.event === "senses.turn_watch_write_error")).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ sense: "mail", action: "write" }) }))
    watch.finish()
  })

  it("never throws into the turn when the record cannot be written or removed", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    const blocked = path.join(root, "blocked")
    fs.writeFileSync(blocked, "a file where the state folder should be")
    const watch = beginTurnInFlight(blocked, "teams", "conv", START)
    watch.touch(START + 60_000)
    watch.finish()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "senses.turn_watch_write_error", meta: expect.objectContaining({ sense: "teams" }) }))
  })

  it("logs when a turn starts and ends", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    beginTurnInFlight(root, "teams", "conv", START).finish()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.turn_watch_started", meta: expect.objectContaining({ sense: "teams" }) }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.turn_watch_finished", meta: expect.objectContaining({ sense: "teams" }) }))
  })

  it("counts every model and tool callback as progress, and passes each call through unchanged", () => {
    const callbacks = callbacksSpy()
    const touch = vi.fn()
    const watched = watchTurnCallbacks(callbacks, touch)
    watched.onModelStart()
    watched.onModelStreamStart()
    watched.onTextChunk("hi")
    watched.onReasoningChunk("hmm")
    watched.onToolStart("shell", { command: "ls" })
    watched.onToolEnd("shell", "ok", true)
    watched.onToolResult?.([])
    expect(touch).toHaveBeenCalledTimes(7)
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("hi")
    expect(callbacks.onToolStart).toHaveBeenCalledWith("shell", { command: "ls" })
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("shell", "ok", true)
    watched.onError(new Error("x"), "transient")
    expect(touch).toHaveBeenCalledTimes(7)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
  })

  it("keeps the callbacks object's own fields live in both directions", () => {
    const callbacks = callbacksSpy() as ChannelCallbacks & { label?: string }
    const watched = watchTurnCallbacks(callbacks, vi.fn()) as ChannelCallbacks & { label?: string }
    watched.label = "set through the watch"
    expect(callbacks.label).toBe("set through the watch")
    callbacks.settleOutputMode = "text-only" as never
    expect(watched.settleOutputMode).toBe("text-only")
    expect("onKick" in watched).toBe(false)
  })

  it("calls each callback on the original object", () => {
    const seen: unknown[] = []
    const callbacks = { ...callbacksSpy(), onTextChunk(this: unknown) { seen.push(this) } } as ChannelCallbacks
    watchTurnCallbacks(callbacks, vi.fn()).onTextChunk("x")
    expect(seen).toEqual([callbacks])
  })
})
