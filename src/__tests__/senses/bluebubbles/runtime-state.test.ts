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
    expect(readBlueBubblesRuntimeState("slugger")).toEqual(state)
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
        proofMethod: 99,
        pendingRecoveryCount: Number.NaN,
        oldestPendingRecoveryAt: 44,
        oldestPendingRecoveryAgeMs: "old",
        lastRecoveredAt: 99,
        lastRecoveredMessageGuid: 100,
      }, null, 2) + "\n",
      "utf-8",
    )

    expect(readBlueBubblesRuntimeState("slugger")).toEqual({
      upstreamStatus: "unknown",
      detail: "startup health probe pending",
      lastCheckedAt: undefined,
      proofMethod: undefined,
      pendingRecoveryCount: 0,
      oldestPendingRecoveryAt: undefined,
      oldestPendingRecoveryAgeMs: undefined,
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
