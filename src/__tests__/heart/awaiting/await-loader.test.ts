import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { loadPendingAwaitsForCommitments } from "../../../heart/awaiting/await-loader"
import { writeAwaitRuntimeState } from "../../../heart/awaiting/await-runtime-state"

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "await-loader-"))
}

function writeAwait(root: string, name: string, body: string): void {
  const dir = path.join(root, "awaiting")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${name}.md`), body, "utf-8")
}

describe("loadPendingAwaitsForCommitments", () => {
  const cleanup: string[] = []

  afterEach(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("returns empty when no awaiting dir", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    expect(loadPendingAwaitsForCommitments(root)).toEqual([])
  })

  it("loads a single pending await with runtime state", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeAwait(root, "hey_export", [
      "---",
      "condition: HEY export visible",
      "cadence: 5m",
      "status: pending",
      "---",
      "",
    ].join("\n"))
    writeAwaitRuntimeState(root, "hey_export", {
      last_checked: "2026-05-10T20:05:00.000Z",
      last_observation: "no download yet",
      checked_count: 3,
    })

    const result = loadPendingAwaitsForCommitments(root)
    expect(result).toEqual([
      {
        name: "hey_export",
        condition: "HEY export visible",
        checkedCount: 3,
        lastCheckedAt: "2026-05-10T20:05:00.000Z",
        lastObservation: "no download yet",
      },
    ])
  })

  it("skips non-pending awaits", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeAwait(root, "resolved_one", [
      "---",
      "condition: c",
      "status: resolved",
      "---",
    ].join("\n"))
    writeAwait(root, "expired_one", [
      "---",
      "condition: c",
      "status: expired",
      "---",
    ].join("\n"))
    expect(loadPendingAwaitsForCommitments(root)).toEqual([])
  })

  it("skips awaits with no condition", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeAwait(root, "no_cond", [
      "---",
      "cadence: 5m",
      "---",
    ].join("\n"))
    expect(loadPendingAwaitsForCommitments(root)).toEqual([])
  })

  it("skips non-.md files in the awaiting dir", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    const dir = path.join(root, "awaiting")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "README.txt"), "not an await", "utf-8")
    expect(loadPendingAwaitsForCommitments(root)).toEqual([])
  })

  it("falls back to defaults when runtime state missing", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    writeAwait(root, "x", [
      "---",
      "condition: c",
      "status: pending",
      "---",
    ].join("\n"))
    expect(loadPendingAwaitsForCommitments(root)).toEqual([
      { name: "x", condition: "c", checkedCount: 0, lastCheckedAt: null, lastObservation: null },
    ])
  })

  it("survives a malformed await file by skipping it", () => {
    const root = makeTempRoot()
    cleanup.push(root)
    const dir = path.join(root, "awaiting")
    fs.mkdirSync(dir, { recursive: true })
    // make a markdown file but make readFile fail by writing as directory (will throw)
    const filePath = path.join(dir, "bad.md")
    fs.mkdirSync(filePath, { recursive: true })
    expect(loadPendingAwaitsForCommitments(root)).toEqual([])
  })
})
