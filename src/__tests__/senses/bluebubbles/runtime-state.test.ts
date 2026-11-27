import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

describe("BlueBubbles runtime state", () => {
  let tmpRoot = ""
  const originalHome = process.env.HOME

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-runtime-state-"))
    process.env.HOME = tmpRoot
  })

  afterEach(() => {
    process.env.HOME = originalHome
    vi.restoreAllMocks()
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  it("writes runtime state to bundle storage and reads it back", async () => {
    const {
      getBlueBubblesRuntimeStatePath,
      readBlueBubblesRuntimeState,
      writeBlueBubblesRuntimeState,
    } = await import("../../../senses/bluebubbles/runtime-state")

    const state = {
      upstreamStatus: "ok" as const,
      detail: "upstream reachable",
      lastCheckedAt: "2026-03-11T18:14:00.000Z",
      proofMethod: "bluebubbles.checkHealth",
      pendingRecoveryCount: 0,
      oldestPendingRecoveryAt: undefined,
      oldestPendingRecoveryAgeMs: undefined,
      activeTurnCount: undefined,
      stalledTurnCount: undefined,
      oldestActiveTurnStartedAt: "2026-03-11T18:13:00.000Z",
      oldestActiveTurnAgeMs: 60_000,
      lastRecoveredAt: "2026-03-11T18:14:01.000Z",
      lastRecoveredMessageGuid: "msg-1",
    }

    const filePath = writeBlueBubblesRuntimeState("slugger", state)

    expect(filePath).toBe(
      path.join(
        tmpRoot,
        "AgentBundles",
        "slugger.ouro",
        "state",
        "senses",
        "bluebubbles",
        "runtime.json",
      ),
    )
    expect(getBlueBubblesRuntimeStatePath("slugger")).toBe(filePath)
    expect(readBlueBubblesRuntimeState("slugger")).toEqual({ ...state, lastHeartbeatAt: expect.any(String) })
  })

  it("replaces the file whole and stamps a heartbeat on every write", async () => {
    const { getBlueBubblesRuntimeStatePath, readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    const before = Date.now()
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", lastCheckedAt: "2026-03-11T18:14:00.000Z", pendingRecoveryCount: 0 })
    const heartbeat = Date.parse(readBlueBubblesRuntimeState("slugger").lastHeartbeatAt!)
    expect(heartbeat).toBeGreaterThanOrEqual(before)
    expect(heartbeat).toBeLessThanOrEqual(Date.now())
    // Written to a private temporary file and renamed into place, so a reader never sees half of it.
    expect(fs.readdirSync(path.dirname(getBlueBubblesRuntimeStatePath("slugger")))).toEqual(["runtime.json"])
    expect(fs.statSync(getBlueBubblesRuntimeStatePath("slugger")).mode & 0o777).toBe(0o600)
  })

  it("keeps the catch-up cursor through writes that do not move it", async () => {
    const { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", lastCheckedAt: "2026-03-11T18:14:00.000Z", catchUpThrough: "2026-03-11T18:14:00.000Z", pendingRecoveryCount: 0 })
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "recovery pass running", lastCheckedAt: "2026-03-11T18:14:30.000Z", pendingRecoveryCount: 0 })
    expect(readBlueBubblesRuntimeState("slugger")).toEqual(expect.objectContaining({ lastCheckedAt: "2026-03-11T18:14:30.000Z", catchUpThrough: "2026-03-11T18:14:00.000Z" }))
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", lastCheckedAt: "2026-03-11T18:15:00.000Z", catchUpThrough: "2026-03-11T18:15:00.000Z", pendingRecoveryCount: 0 })
    expect(readBlueBubblesRuntimeState("slugger").catchUpThrough).toBe("2026-03-11T18:15:00.000Z")
  })

  it("keeps the arrival cursor through writes that do not move it", async () => {
    const { readBlueBubblesRuntimeState, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", catchUpThrough: "2026-03-11T18:14:00.000Z", catchUpRowId: 30158, pendingRecoveryCount: 0 })
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "recovery pass running", catchUpThrough: "2026-03-11T18:14:30.000Z", pendingRecoveryCount: 0 })
    expect(readBlueBubblesRuntimeState("slugger").catchUpRowId).toBe(30158)
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", catchUpThrough: "2026-03-11T18:15:00.000Z", catchUpRowId: 30161, pendingRecoveryCount: 0 })
    expect(readBlueBubblesRuntimeState("slugger").catchUpRowId).toBe(30161)
    const settling = { recoveryLookbackSince: "2026-03-10T18:15:00.000Z", recoveryLookbackUntil: "2026-03-11T18:45:00.000Z" }
    writeBlueBubblesRuntimeState("slugger", { upstreamStatus: "ok", detail: "upstream reachable", catchUpThrough: "2026-03-11T18:15:30.000Z", catchUpRowId: 30162, ...settling, pendingRecoveryCount: 0 })
    expect(readBlueBubblesRuntimeState("slugger")).toEqual(expect.objectContaining({ catchUpRowId: 30162, ...settling }))
  })

  it("refreshes the heartbeat of the state on disk, and writes nothing when there is none", async () => {
    const { getBlueBubblesRuntimeStatePath, readBlueBubblesRuntimeState, touchBlueBubblesRuntimeHeartbeat, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")
    touchBlueBubblesRuntimeHeartbeat("slugger")
    expect(fs.existsSync(getBlueBubblesRuntimeStatePath("slugger"))).toBe(false)

    const state = { upstreamStatus: "ok" as const, detail: "upstream reachable; recovery pass running", lastCheckedAt: "2026-03-11T18:14:00.000Z", catchUpThrough: "2026-03-11T18:13:30.000Z", pendingRecoveryCount: 2 }
    writeBlueBubblesRuntimeState("slugger", state)
    const firstHeartbeat = readBlueBubblesRuntimeState("slugger").lastHeartbeatAt!
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(firstHeartbeat) + 30_000)
    touchBlueBubblesRuntimeHeartbeat("slugger")
    expect(readBlueBubblesRuntimeState("slugger")).toEqual(expect.objectContaining({ ...state, lastHeartbeatAt: new Date(Date.parse(firstHeartbeat) + 30_000).toISOString() }))
  })

  it("normalizes malformed state values and falls back to defaults when the file is missing", async () => {
    const {
      getBlueBubblesRuntimeStatePath,
      readBlueBubblesRuntimeState,
      writeBlueBubblesRuntimeState,
    } = await import("../../../senses/bluebubbles/runtime-state")

    expect(readBlueBubblesRuntimeState("slugger")).toEqual({
      upstreamStatus: "unknown",
      detail: "startup health probe pending",
      pendingRecoveryCount: 0,
    })

    const filePath = getBlueBubblesRuntimeStatePath("slugger")
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        upstreamStatus: "maybe",
        detail: "   ",
        lastCheckedAt: 42,
        lastHeartbeatAt: 43,
        catchUpThrough: 44,
        catchUpRowId: 1.5,
        proofMethod: 99,
        pendingRecoveryCount: Number.NaN,
        oldestPendingRecoveryAt: 44,
        oldestPendingRecoveryAgeMs: "old",
        activeTurnCount: "active",
        stalledTurnCount: "stalled",
        oldestActiveTurnStartedAt: 55,
        oldestActiveTurnAgeMs: "ancient",
        lastRecoveredAt: 99,
        lastRecoveredMessageGuid: 100,
      }, null, 2) + "\n",
      "utf-8",
    )

    expect(readBlueBubblesRuntimeState("slugger")).toEqual({
      upstreamStatus: "unknown",
      detail: "startup health probe pending",
      lastCheckedAt: undefined,
      lastHeartbeatAt: undefined,
      catchUpThrough: undefined,
      catchUpRowId: undefined,
      proofMethod: undefined,
      pendingRecoveryCount: 0,
      oldestPendingRecoveryAt: undefined,
      oldestPendingRecoveryAgeMs: undefined,
      activeTurnCount: undefined,
      stalledTurnCount: undefined,
      oldestActiveTurnStartedAt: undefined,
      oldestActiveTurnAgeMs: undefined,
      lastRecoveredAt: undefined,
      lastRecoveredMessageGuid: undefined,
    })

    fs.rmSync(filePath, { force: true })
    const runtimeDir = path.dirname(filePath)
    fs.rmSync(runtimeDir, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(runtimeDir), { recursive: true })
    fs.writeFileSync(runtimeDir, "blocked", "utf-8")

    expect(writeBlueBubblesRuntimeState("slugger", {
      upstreamStatus: "error",
      detail: "upstream unreachable",
      lastCheckedAt: "2026-03-11T18:15:00.000Z",
      pendingRecoveryCount: 2,
    })).toBe(filePath)
  })

  it("stringifies non-Error runtime-state serialization failures without throwing", async () => {
    const { getBlueBubblesRuntimeStatePath, writeBlueBubblesRuntimeState } = await import("../../../senses/bluebubbles/runtime-state")

    const badState = {
      upstreamStatus: "error" as const,
      pendingRecoveryCount: 1,
      lastCheckedAt: "2026-03-11T18:16:00.000Z",
      get detail() {
        throw "string-runtime-failure"
      },
    }

    expect(writeBlueBubblesRuntimeState("slugger", badState as any)).toBe(
      getBlueBubblesRuntimeStatePath("slugger"),
    )
  })
})
