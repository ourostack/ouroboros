import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HabitFile } from "../../../heart/habits/habit-parser"

const mockEmitNervesEvent = vi.fn()

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  applyHabitRuntimeState,
  readHabitLastRun,
  recordHabitRun,
  writeHabitLastRun,
} from "../../../heart/habits/habit-runtime-state"

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function makeHabit(overrides: Partial<HabitFile> = {}): HabitFile {
  return {
    name: "heartbeat",
    title: "Heartbeat",
    cadence: "30m",
    status: "active",
    lastRun: "2026-03-27T10:00:00.000Z",
    created: "2026-03-01T00:00:00.000Z",
    tools: undefined,
    body: "Check in.",
    ...overrides,
  }
}

describe("habit-runtime-state", () => {
  const cleanup: string[] = []

  afterEach(() => {
    mockEmitNervesEvent.mockReset()
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("writes and reads habit lastRun from bundle runtime state", () => {
    const bundleRoot = makeTempDir("habit-runtime-state")
    cleanup.push(bundleRoot)

    writeHabitLastRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z")

    expect(readHabitLastRun(bundleRoot, "heartbeat")).toBe("2026-03-27T12:00:00.000Z")
    const record = JSON.parse(
      fs.readFileSync(path.join(bundleRoot, "state", "habits", "heartbeat.json"), "utf-8"),
    ) as { schemaVersion: number; name: string; lastRun: string; updatedAt: string }
    expect(record.schemaVersion).toBe(1)
    expect(record.name).toBe("heartbeat")
    expect(record.lastRun).toBe("2026-03-27T12:00:00.000Z")
    expect(record.updatedAt).toBe("2026-03-27T12:00:00.000Z")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "daemon",
      event: "daemon.habit_runtime_state_write",
    }))
  })

  it("prefers runtime state over legacy habit frontmatter", () => {
    const bundleRoot = makeTempDir("habit-runtime-override")
    cleanup.push(bundleRoot)

    writeHabitLastRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z")

    const resolved = applyHabitRuntimeState(bundleRoot, makeHabit({
      lastRun: "2026-03-27T10:00:00.000Z",
    }))

    expect(resolved.lastRun).toBe("2026-03-27T12:00:00.000Z")
  })

  it("falls back to legacy frontmatter when runtime state is missing", () => {
    const bundleRoot = makeTempDir("habit-runtime-fallback")
    cleanup.push(bundleRoot)

    const resolved = applyHabitRuntimeState(bundleRoot, makeHabit({
      lastRun: "2026-03-27T10:00:00.000Z",
    }))

    expect(resolved.lastRun).toBe("2026-03-27T10:00:00.000Z")
  })

  it("records habit runs in runtime state and strips legacy lastRun from the definition file", () => {
    const bundleRoot = makeTempDir("habit-runtime-record")
    cleanup.push(bundleRoot)

    const definitionPath = path.join(bundleRoot, "habits", "heartbeat.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, [
      "---",
      "title: Heartbeat",
      "cadence: 30m",
      "status: active",
      "lastRun: 2026-03-27T10:00:00.000Z",
      "last_run: 2026-03-27T09:00:00.000Z",
      "created: 2026-03-01T00:00:00.000Z",
      "---",
      "",
      "Check in.",
      "",
    ].join("\n"), "utf-8")

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z", { definitionPath })

    expect(readHabitLastRun(bundleRoot, "heartbeat")).toBe("2026-03-27T12:00:00.000Z")
    const updatedDefinition = fs.readFileSync(definitionPath, "utf-8")
    expect(updatedDefinition).not.toContain("lastRun:")
    expect(updatedDefinition).not.toContain("last_run:")
    expect(updatedDefinition).toContain("title: Heartbeat")
    expect(updatedDefinition).toContain("Check in.")
  })

  it("still records runtime state when the habit definition file is missing", () => {
    const bundleRoot = makeTempDir("habit-runtime-missing-definition")
    cleanup.push(bundleRoot)

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z", {
      definitionPath: path.join(bundleRoot, "habits", "heartbeat.md"),
    })

    expect(readHabitLastRun(bundleRoot, "heartbeat")).toBe("2026-03-27T12:00:00.000Z")
  })

  it("records runtime state without needing a definition path", () => {
    const bundleRoot = makeTempDir("habit-runtime-no-definition-option")
    cleanup.push(bundleRoot)

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z")

    expect(readHabitLastRun(bundleRoot, "heartbeat")).toBe("2026-03-27T12:00:00.000Z")
  })

  it("leaves non-frontmatter habit definitions untouched when recording runtime state", () => {
    const bundleRoot = makeTempDir("habit-runtime-no-frontmatter")
    cleanup.push(bundleRoot)

    const definitionPath = path.join(bundleRoot, "habits", "heartbeat.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, "just a note\n", "utf-8")

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z", { definitionPath })

    expect(fs.readFileSync(definitionPath, "utf-8")).toBe("just a note\n")
  })

  it("leaves unterminated frontmatter definitions untouched when recording runtime state", () => {
    const bundleRoot = makeTempDir("habit-runtime-unterminated")
    cleanup.push(bundleRoot)

    const definitionPath = path.join(bundleRoot, "habits", "heartbeat.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    fs.writeFileSync(definitionPath, "---\ntitle: Heartbeat\nlastRun: 2026-03-27T10:00:00.000Z\n", "utf-8")

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z", { definitionPath })

    expect(fs.readFileSync(definitionPath, "utf-8")).toContain("lastRun: 2026-03-27T10:00:00.000Z")
  })

  it("does not rewrite the definition file when no legacy lastRun fields are present", () => {
    const bundleRoot = makeTempDir("habit-runtime-no-legacy-fields")
    cleanup.push(bundleRoot)

    const definitionPath = path.join(bundleRoot, "habits", "heartbeat.md")
    fs.mkdirSync(path.dirname(definitionPath), { recursive: true })
    const original = [
      "---",
      "title: Heartbeat",
      "cadence: 30m",
      "status: active",
      "created: 2026-03-01T00:00:00.000Z",
      "---",
      "",
      "Check in.",
      "",
    ].join("\n")
    fs.writeFileSync(definitionPath, original, "utf-8")

    recordHabitRun(bundleRoot, "heartbeat", "2026-03-27T12:00:00.000Z", { definitionPath })

    expect(fs.readFileSync(definitionPath, "utf-8")).toBe(original)
  })
})
