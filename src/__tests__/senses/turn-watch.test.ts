import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as nerves from "../../nerves/runtime"
import type { ChannelCallbacks } from "../../heart/core"
import {
  PROGRESS_WRITE_EVERY_MS,
  TOOL_STALLED_AFTER_MS,
  TURN_STALLED_AFTER_MS,
  beginTurnInFlight,
  isWatchedSense,
  snapshotTurnsInFlight,
  watchTurnCallbacks,
} from "../../senses/turn-watch"

const START = Date.parse("2026-11-22T10:00:00.000Z")
const STALL = TURN_STALLED_AFTER_MS + PROGRESS_WRITE_EVERY_MS

function markerDir(root: string, sense: string): string {
  return path.join(root, "state", "senses", sense, "turns-in-flight")
}

function markers(root: string, sense: string): Array<Record<string, unknown>> {
  const dir = markerDir(root, sense)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")))
}

function writeRecord(root: string, sense: string, name: string, fields: Record<string, unknown>): void {
  const dir = markerDir(root, sense)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, name), JSON.stringify({
    pid: process.pid,
    sessionKey: "x",
    startedAt: "2026-11-22T09:00:00.000Z",
    lastProgressAt: "2026-11-22T09:00:00.000Z",
    toolsRunning: 0,
    ...fields,
  }))
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

const noProgress = () => ({ touch: vi.fn(), toolStarted: vi.fn(), toolEnded: vi.fn() })

describe("turn watch", () => {
  let root: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "turn-watch-"))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("watches the pipeline senses that have a status row, and leaves iMessage and mail out", () => {
    for (const sense of ["teams", "voice", "a2a", "telegram"]) expect(isWatchedSense(sense)).toBe(true)
    for (const sense of ["bluebubbles", "mail", "cli", "inner", "mcp", "external-event"]) expect(isWatchedSense(sense)).toBe(false)
  })

  it("records a turn while it runs and removes the record when it ends", () => {
    const watch = beginTurnInFlight(root, "telegram", "chat-1", START)
    expect(markers(root, "telegram")).toEqual([{
      pid: process.pid,
      sessionKey: "chat-1",
      startedAt: "2026-11-22T10:00:00.000Z",
      lastProgressAt: "2026-11-22T10:00:00.000Z",
      toolsRunning: 0,
    }])
    watch.finish()
    expect(markers(root, "telegram")).toEqual([])
    watch.finish()
    expect(markers(root, "telegram")).toEqual([])
  })

  it("counts a quiet turn as stalled only once the record is surely five minutes old", () => {
    const watch = beginTurnInFlight(root, "teams", "conv", START)
    expect(snapshotTurnsInFlight(root, "teams", START + STALL - 1)).toEqual({
      activeTurnCount: 1,
      stalledTurnCount: 0,
      oldestActiveTurnStartedAt: "2026-11-22T10:00:00.000Z",
      oldestActiveTurnAgeMs: STALL - 1,
    })
    expect(snapshotTurnsInFlight(root, "teams", START + STALL)).toEqual({
      activeTurnCount: 1,
      stalledTurnCount: 1,
      oldestActiveTurnStartedAt: "2026-11-22T10:00:00.000Z",
      oldestActiveTurnAgeMs: STALL,
      longestSilenceMs: STALL,
      stalledPids: [process.pid],
    })
    watch.finish()
  })

  it("progress resets the silence, but is written at most every 30 seconds", () => {
    const watch = beginTurnInFlight(root, "teams", "conv", START)
    watch.touch(START + 29_999)
    expect(markers(root, "teams")[0]!.lastProgressAt).toBe("2026-11-22T10:00:00.000Z")
    watch.touch(START + 30_000)
    expect(markers(root, "teams")[0]!.lastProgressAt).toBe("2026-11-22T10:00:30.000Z")
    expect(snapshotTurnsInFlight(root, "teams", START + 30_000 + STALL - 1).stalledTurnCount).toBe(0)
    expect(snapshotTurnsInFlight(root, "teams", START + 30_000 + STALL).stalledTurnCount).toBe(1)
    watch.finish()
    watch.touch(START + 120_000)
    expect(markers(root, "teams")).toEqual([])
  })

  it("gives a running tool up to 15 minutes, and goes back to five once it ends", () => {
    const watch = beginTurnInFlight(root, "a2a", "peer", START)
    watch.toolStarted(START + 1_000)
    watch.toolStarted(START + 2_000)
    expect(markers(root, "a2a")[0]).toEqual(expect.objectContaining({ toolsRunning: 2, lastProgressAt: "2026-11-22T10:00:02.000Z" }))
    const toolStall = START + 2_000 + TOOL_STALLED_AFTER_MS + PROGRESS_WRITE_EVERY_MS
    expect(snapshotTurnsInFlight(root, "a2a", toolStall - 1).stalledTurnCount).toBe(0)
    expect(snapshotTurnsInFlight(root, "a2a", toolStall).stalledTurnCount).toBe(1)
    watch.toolEnded(START + 3_000)
    expect(markers(root, "a2a")[0]!.toolsRunning).toBe(1)
    watch.toolEnded(START + 4_000)
    watch.toolEnded(START + 5_000)
    expect(markers(root, "a2a")[0]).toEqual(expect.objectContaining({ toolsRunning: 0, lastProgressAt: "2026-11-22T10:00:05.000Z" }))
    expect(snapshotTurnsInFlight(root, "a2a", START + 5_000 + STALL).stalledTurnCount).toBe(1)
    watch.finish()
    watch.toolStarted(START + 6_000)
    watch.toolEnded(START + 7_000)
    expect(markers(root, "a2a")).toEqual([])
  })

  it("ignores turns of a process that is gone", () => {
    writeRecord(root, "voice", "dead.json", { pid: 999_999 })
    expect(snapshotTurnsInFlight(root, "voice", START, (pid) => pid !== 999_999)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
  })

  it("ignores a turn recorded before the sense's current process started", () => {
    writeRecord(root, "telegram", "earlier.json", {})
    expect(snapshotTurnsInFlight(root, "telegram", START, undefined, Date.parse("2026-11-22T09:30:00.000Z"))).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
    expect(snapshotTurnsInFlight(root, "telegram", START, undefined, Date.parse("2026-11-22T09:00:00.000Z")).stalledTurnCount).toBe(1)
  })

  it("skips records it cannot read, and reads nothing when the sense never ran a turn", () => {
    const dir = markerDir(root, "a2a")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "garbled.json"), "{not json")
    fs.writeFileSync(path.join(dir, "null.json"), "null")
    fs.writeFileSync(path.join(dir, "note.txt"), "ignored")
    writeRecord(root, "a2a", "no-session.json", { sessionKey: 7 })
    writeRecord(root, "a2a", "no-tools.json", { toolsRunning: undefined })
    writeRecord(root, "a2a", "bad-start.json", { startedAt: "not a date" })
    writeRecord(root, "a2a", "bad-progress.json", { lastProgressAt: "soon" })
    expect(snapshotTurnsInFlight(root, "a2a", START)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
    expect(snapshotTurnsInFlight(root, "telegram", START)).toEqual({ activeTurnCount: 0, stalledTurnCount: 0 })
  })

  it("finds the oldest turn whichever order the records are listed in, and names each stalled process once", () => {
    writeRecord(root, "voice", "a.json", { startedAt: "2026-11-22T09:59:00.000Z" })
    writeRecord(root, "voice", "b.json", { startedAt: "2026-11-22T09:58:00.000Z" })
    writeRecord(root, "voice", "c.json", { pid: process.ppid, startedAt: "2026-11-22T09:30:00.000Z", lastProgressAt: "2026-11-22T09:30:00.000Z" })
    writeRecord(root, "voice", "d.json", { startedAt: "2026-11-22T09:59:30.000Z", lastProgressAt: "2026-11-22T09:59:30.000Z" })
    expect(snapshotTurnsInFlight(root, "voice", START)).toEqual(expect.objectContaining({
      activeTurnCount: 4,
      stalledTurnCount: 3,
      oldestActiveTurnStartedAt: "2026-11-22T09:30:00.000Z",
      longestSilenceMs: 60 * 60_000,
      stalledPids: [process.ppid, process.pid].sort((a, b) => a - b),
    }))
  })

  it("clears its own process's records left by a turn that never finished, but not another live process's", () => {
    writeRecord(root, "telegram", "stale-same-pid.json", {})
    writeRecord(root, "telegram", "dead-pid.json", { pid: 999_999 })
    writeRecord(root, "telegram", "live-other.json", { pid: process.ppid })
    fs.writeFileSync(path.join(markerDir(root, "telegram"), "garbled.json"), "{")
    const watch = beginTurnInFlight(root, "telegram", "new", START)
    expect(fs.readdirSync(markerDir(root, "telegram")).sort()).toEqual(["live-other.json", expect.stringMatching(/^\d+-\d+\.json$/)].sort())
    watch.finish()
  })

  it("keeps the record of another turn this process is still running", () => {
    const first = beginTurnInFlight(root, "teams", "one", START)
    const second = beginTurnInFlight(root, "teams", "two", START + 1_000)
    expect(markers(root, "teams").map((record) => record.sessionKey).sort()).toEqual(["one", "two"])
    first.finish()
    second.finish()
  })

  it("never throws into the turn when the record cannot be written or removed", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    const blocked = path.join(root, "blocked")
    fs.writeFileSync(blocked, "a file where the state folder should be")
    const watch = beginTurnInFlight(blocked, "teams", "conv", START)
    watch.touch(START + 60_000)
    watch.toolStarted(START + 61_000)
    watch.finish()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ level: "warn", event: "senses.turn_watch_write_error", meta: expect.objectContaining({ sense: "teams", action: "prepare" }) }))
  })

  it("warns once when progress can no longer be written, leaves no temporary file, and the turn carries on", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    const watch = beginTurnInFlight(root, "voice", "call", START)
    const dir = markerDir(root, "voice")
    const [file] = fs.readdirSync(dir)
    // A folder now sits where the record goes, so the rename fails; the temporary file must not stay behind.
    fs.rmSync(path.join(dir, file!), { force: true })
    fs.mkdirSync(path.join(dir, file!, "occupied"), { recursive: true })
    watch.touch(START + 30_000)
    watch.touch(START + 60_000)
    expect(emit.mock.calls.filter(([event]) => event.event === "senses.turn_watch_write_error")).toHaveLength(1)
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ sense: "voice", action: "write" }) }))
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
    watch.finish()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ sense: "voice", action: "remove" }) }))
  })

  it("logs when a turn starts and ends", () => {
    const emit = vi.spyOn(nerves, "emitNervesEvent")
    beginTurnInFlight(root, "teams", "conv", START).finish()
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.turn_watch_started", meta: expect.objectContaining({ sense: "teams" }) }))
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.turn_watch_finished", meta: expect.objectContaining({ sense: "teams" }) }))
  })

  it("counts model and tool callbacks as progress, marks tool calls, and passes each call through unchanged", () => {
    const callbacks = callbacksSpy()
    const progress = noProgress()
    const watched = watchTurnCallbacks(callbacks, progress)
    watched.onModelStart()
    watched.onModelStreamStart()
    watched.onTextChunk("hi")
    watched.onReasoningChunk("hmm")
    watched.onToolResult?.([])
    expect(progress.touch).toHaveBeenCalledTimes(5)
    watched.onToolStart("shell", { command: "ls" })
    expect(progress.toolStarted).toHaveBeenCalledTimes(1)
    watched.onToolEnd("shell", "ok", true)
    expect(progress.toolEnded).toHaveBeenCalledTimes(1)
    expect(callbacks.onTextChunk).toHaveBeenCalledWith("hi")
    expect(callbacks.onToolStart).toHaveBeenCalledWith("shell", { command: "ls" })
    expect(callbacks.onToolEnd).toHaveBeenCalledWith("shell", "ok", true)
    watched.onError(new Error("x"), "transient")
    expect(progress.touch).toHaveBeenCalledTimes(5)
    expect(callbacks.onError).toHaveBeenCalledTimes(1)
  })

  it("keeps the callbacks object's own fields live in both directions", () => {
    const callbacks = callbacksSpy() as ChannelCallbacks & { label?: string }
    const watched = watchTurnCallbacks(callbacks, noProgress()) as ChannelCallbacks & { label?: string }
    watched.label = "set through the watch"
    expect(callbacks.label).toBe("set through the watch")
    callbacks.settleOutputMode = "text-only" as never
    expect(watched.settleOutputMode).toBe("text-only")
    expect("onKick" in watched).toBe(false)
  })

  it("calls each callback on the original object", () => {
    const seen: unknown[] = []
    const callbacks = { ...callbacksSpy(), onTextChunk(this: unknown) { seen.push(this) } } as ChannelCallbacks
    watchTurnCallbacks(callbacks, noProgress()).onTextChunk("x")
    expect(seen).toEqual([callbacks])
  })
})
