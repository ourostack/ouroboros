import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { AwaitFile } from "../../../heart/awaiting/await-parser"

const mockEmitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  applyAwaitRuntimeState,
  readAwaitRuntimeState,
  recordAwaitCheck,
  writeAwaitRuntimeState,
} from "../../../heart/awaiting/await-runtime-state"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function makeAwait(overrides: Partial<AwaitFile> = {}): AwaitFile {
  return {
    name: "hey_export",
    condition: "HEY export download visible",
    cadence: "5m",
    alert: "bluebubbles",
    mode: "full",
    max_age: "24h",
    status: "pending",
    created_at: "2026-05-10T20:00:00.000Z",
    filed_from: "cli",
    filed_for_friend_id: "ari",
    body: "",
    resolved_at: null,
    resolution_observation: null,
    expired_at: null,
    last_observation_at_expiry: null,
    canceled_at: null,
    cancel_reason: null,
    ...overrides,
  }
}

describe("await-runtime-state", () => {
  const cleanup: string[] = []

  afterEach(() => {
    mockEmitNervesEvent.mockReset()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("returns null when no state file exists", () => {
    const bundleRoot = makeTempDir("await-rs-empty")
    cleanup.push(bundleRoot)
    expect(readAwaitRuntimeState(bundleRoot, "hey_export")).toBeNull()
  })

  it("writes and reads runtime state", () => {
    const bundleRoot = makeTempDir("await-rs-write")
    cleanup.push(bundleRoot)

    writeAwaitRuntimeState(bundleRoot, "hey_export", {
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "no download yet",
      checked_count: 1,
    })

    const result = readAwaitRuntimeState(bundleRoot, "hey_export")
    expect(result).toEqual({
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "no download yet",
      checked_count: 1,
    })

    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "daemon.await_runtime_state_write",
    }))
  })

  it("merge-writes partial state", () => {
    const bundleRoot = makeTempDir("await-rs-merge")
    cleanup.push(bundleRoot)

    writeAwaitRuntimeState(bundleRoot, "hey_export", {
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "first",
      checked_count: 1,
    })

    writeAwaitRuntimeState(bundleRoot, "hey_export", {
      last_observation: "second",
    })

    const result = readAwaitRuntimeState(bundleRoot, "hey_export")
    expect(result?.last_observation).toBe("second")
    expect(result?.last_checked).toBe("2026-05-10T20:05:00.000Z")
    expect(result?.checked_count).toBe(1)
  })

  it("recordAwaitCheck increments count and updates timestamps", () => {
    const bundleRoot = makeTempDir("await-rs-record")
    cleanup.push(bundleRoot)

    recordAwaitCheck(bundleRoot, "hey_export", "first obs", "2026-05-10T20:05:00.000Z")
    let state = readAwaitRuntimeState(bundleRoot, "hey_export")
    expect(state).toEqual({
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "first obs",
      checked_count: 1,
    })

    recordAwaitCheck(bundleRoot, "hey_export", "second obs", "2026-05-10T20:10:00.000Z")
    state = readAwaitRuntimeState(bundleRoot, "hey_export")
    expect(state).toEqual({
      last_checked: "2026-05-10T20:10:00.000Z",
      last_observation: "second obs",
      checked_count: 2,
    })
  })

  it("applyAwaitRuntimeState merges fields onto an AwaitFile", () => {
    const bundleRoot = makeTempDir("await-rs-apply")
    cleanup.push(bundleRoot)

    writeAwaitRuntimeState(bundleRoot, "hey_export", {
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "first",
      checked_count: 3,
    })

    const result = applyAwaitRuntimeState(bundleRoot, makeAwait())
    expect((result as any).last_checked).toBe("2026-05-10T20:05:00.000Z")
    expect((result as any).last_observation).toBe("first")
    expect((result as any).checked_count).toBe(3)
  })

  it("applyAwaitRuntimeState returns base file unchanged when state missing", () => {
    const bundleRoot = makeTempDir("await-rs-apply-empty")
    cleanup.push(bundleRoot)

    const base = makeAwait()
    const result = applyAwaitRuntimeState(bundleRoot, base)
    expect((result as any).last_checked).toBeUndefined()
    expect(result.condition).toBe(base.condition)
  })

  it("writes JSON file at state/awaits/<name>.json", () => {
    const bundleRoot = makeTempDir("await-rs-path")
    cleanup.push(bundleRoot)

    writeAwaitRuntimeState(bundleRoot, "hey_export", {
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "obs",
      checked_count: 1,
    })

    const filePath = path.join(bundleRoot, "state", "awaits", "hey_export.json")
    expect(fs.existsSync(filePath)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      schemaVersion: number
      name: string
      last_checked: string
      last_observation: string
      checked_count: number
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.name).toBe("hey_export")
    expect(parsed.last_checked).toBe("2026-05-10T20:05:00.000Z")
    expect(parsed.last_observation).toBe("obs")
    expect(parsed.checked_count).toBe(1)
  })

  it("coerces malformed fields to null/zero when reading", () => {
    const bundleRoot = makeTempDir("await-rs-coerce")
    cleanup.push(bundleRoot)
    const dir = path.join(bundleRoot, "state", "awaits")
    fs.mkdirSync(dir, { recursive: true })
    // wrong types: numbers/booleans where strings expected; string where number expected
    fs.writeFileSync(
      path.join(dir, "hey_export.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "hey_export",
        last_checked: 5,
        last_observation: true,
        checked_count: "not a number",
      }),
      "utf-8",
    )
    expect(readAwaitRuntimeState(bundleRoot, "hey_export")).toEqual({
      last_checked: null,
      last_observation: null,
      checked_count: 0,
    })
  })

  it("writes new state when partial omits prior keys (no merge collapse)", () => {
    const bundleRoot = makeTempDir("await-rs-merge-defaults")
    cleanup.push(bundleRoot)
    // No prior file; partial omits everything -> defaults
    writeAwaitRuntimeState(bundleRoot, "hey_export", {})
    expect(readAwaitRuntimeState(bundleRoot, "hey_export")).toEqual({
      last_checked: null,
      last_observation: null,
      checked_count: 0,
    })
  })

  it("readAwaitRuntimeState returns null if file is malformed", () => {
    const bundleRoot = makeTempDir("await-rs-malformed")
    cleanup.push(bundleRoot)
    const dir = path.join(bundleRoot, "state", "awaits")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "hey_export.json"), "not-json", "utf-8")
    expect(readAwaitRuntimeState(bundleRoot, "hey_export")).toBeNull()
  })
})
