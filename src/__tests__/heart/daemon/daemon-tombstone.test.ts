import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  writeDaemonTombstone,
  readDaemonTombstone,
  getTombstonePath,
  setTombstonePath,
} from "../../../heart/daemon/daemon-tombstone"

describe("daemon-tombstone", () => {
  let tmpDir: string

  afterEach(() => {
    setTombstonePath(null)
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it("getTombstonePath returns a path under ~/.ouro-cli lazily", () => {
    const result = getTombstonePath()
    expect(result).toBe(path.join(os.homedir(), ".ouro-cli", "daemon-death.json"))
  })

  it("writeDaemonTombstone writes a valid JSON tombstone file", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-write-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    const error = new Error("boom")
    writeDaemonTombstone("uncaughtException", error)

    const raw = fs.readFileSync(tombstonePath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    expect(parsed.reason).toBe("uncaughtException")
    expect(parsed.message).toBe("boom")
    expect(parsed.stack).toContain("Error: boom")
    expect(typeof parsed.timestamp).toBe("string")
    expect(parsed.pid).toBe(process.pid)
    expect(typeof parsed.uptimeSeconds).toBe("number")
  })

  it("writeDaemonTombstone works without an error argument", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-no-err-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    writeDaemonTombstone("startupFailure")

    const raw = fs.readFileSync(tombstonePath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>

    expect(parsed.reason).toBe("startupFailure")
    expect(parsed.message).toBe("startupFailure")
    expect(parsed.stack).toBeNull()
  })

  it("writeDaemonTombstone creates parent directories if needed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-mkdir-"))
    const tombstonePath = path.join(tmpDir, "nested", "sub", "daemon-death.json")
    setTombstonePath(tombstonePath)

    writeDaemonTombstone("nested-test")

    expect(fs.existsSync(tombstonePath)).toBe(true)
  })

  it("writeDaemonTombstone does not throw when path is unwritable", () => {
    setTombstonePath("/dev/null/impossible/daemon-death.json")

    expect(() => writeDaemonTombstone("should-not-throw")).not.toThrow()
  })

  it("readDaemonTombstone reads a previously written tombstone", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-read-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    writeDaemonTombstone("uncaughtException", new Error("crash"))

    const tombstone = readDaemonTombstone()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.reason).toBe("uncaughtException")
    expect(tombstone!.message).toBe("crash")
    expect(tombstone!.stack).toContain("Error: crash")
    expect(tombstone!.pid).toBe(process.pid)
  })

  it("readDaemonTombstone returns null when file does not exist", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-missing-"))
    setTombstonePath(path.join(tmpDir, "nonexistent.json"))

    expect(readDaemonTombstone()).toBeNull()
  })

  it("readDaemonTombstone returns null for invalid JSON", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-invalid-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, "not valid json", "utf-8")

    expect(readDaemonTombstone()).toBeNull()
  })

  it("readDaemonTombstone returns null when reason or timestamp are missing", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-bad-shape-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, JSON.stringify({ reason: 42, timestamp: "yes" }), "utf-8")
    expect(readDaemonTombstone()).toBeNull()

    fs.writeFileSync(tombstonePath, JSON.stringify({ reason: "test" }), "utf-8")
    expect(readDaemonTombstone()).toBeNull()
  })

  it("readDaemonTombstone handles partial fields gracefully", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-partial-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, JSON.stringify({
      reason: "crash",
      timestamp: "2026-01-01T00:00:00Z",
      // missing message, stack, pid, uptimeSeconds
    }), "utf-8")

    const tombstone = readDaemonTombstone()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.message).toBe("crash") // falls back to reason
    expect(tombstone!.stack).toBeNull()
    expect(tombstone!.pid).toBe(0)
    expect(tombstone!.uptimeSeconds).toBe(0)
  })

  it("setTombstonePath overrides the default path and null resets", () => {
    setTombstonePath("/custom/path.json")
    expect(getTombstonePath()).toBe("/custom/path.json")

    setTombstonePath(null)
    expect(getTombstonePath()).toBe(path.join(os.homedir(), ".ouro-cli", "daemon-death.json"))
  })
})
