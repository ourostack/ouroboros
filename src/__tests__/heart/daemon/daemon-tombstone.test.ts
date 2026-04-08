import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  writeDaemonTombstone,
  readDaemonTombstone,
  getTombstonePath,
  setTombstonePath,
  captureDeathForensics,
  RECENT_CRASHES_MAX,
  type CaptureForensicsDeps,
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

  it("caps recentCrashes at RECENT_CRASHES_MAX entries", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-cap-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    // Pre-populate with one more crash than the cap allows
    const seedCrashes = Array.from({ length: RECENT_CRASHES_MAX + 50 }, (_, i) => `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`)
    fs.writeFileSync(tombstonePath, JSON.stringify({
      reason: "previous",
      timestamp: "2026-01-01T00:00:00Z",
      pid: 1,
      uptimeSeconds: 0,
      recentCrashes: seedCrashes,
    }), "utf-8")

    writeDaemonTombstone("uncaughtException", new Error("new crash"))

    const raw = fs.readFileSync(tombstonePath, "utf-8")
    const parsed = JSON.parse(raw) as { recentCrashes: string[] }
    expect(parsed.recentCrashes.length).toBe(RECENT_CRASHES_MAX)
    // The most recent crash (the one we just wrote) should be at the end
    expect(parsed.recentCrashes[parsed.recentCrashes.length - 1]).toMatch(/^20\d{2}-/)
    // The oldest seeded crash should have been dropped (we seeded 150, kept 100)
    expect(parsed.recentCrashes).not.toContain(seedCrashes[0])
  })

  it("captureDeathForensics returns parent info and process snapshot via injected ps runner", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 4242,
      runPs: (args) => {
        if (args[0] === "-p") return "node /path/to/parent.js\n"
        if (args[0] === "-eo") {
          return "  4242     1 node /path/to/parent.js\n  9999     1 node vitest --run\n  1234  4242 ouro daemon-entry.js\n  5555     1 unrelated process\n"
        }
        return null
      },
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.parentPid).toBe(4242)
    expect(forensics.parentCommand).toBe("node /path/to/parent.js")
    expect(forensics.processSnapshot).toContain("vitest")
    expect(forensics.processSnapshot).toContain("ouro")
    expect(forensics.processSnapshot).not.toContain("unrelated")
    expect(forensics.killerHint).toContain("vitest")
  })

  it("captureDeathForensics flags launchd parents in killerHint", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 1,
      runPs: (args) => {
        if (args[0] === "-p") return "/sbin/launchd\n"
        return "  1     0 /sbin/launchd\n"
      },
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.killerHint).toContain("launchd")
  })

  it("captureDeathForensics flags pkill/killall in killerHint", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 4242,
      runPs: (args) => {
        if (args[0] === "-p") return "bash\n"
        return "  4242     1 bash\n  9999  4242 pkill -TERM ouro\n"
      },
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.killerHint).toContain("pkill/killall")
  })

  it("captureDeathForensics handles ps failures gracefully", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 4242,
      runPs: () => null,
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.parentPid).toBe(4242)
    expect(forensics.parentCommand).toBeNull()
    expect(forensics.processSnapshot).toBeNull()
    expect(forensics.killerHint).toBeNull()
  })

  it("captureDeathForensics handles missing ppid gracefully", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 0,
      runPs: (args) => (args[0] === "-eo" ? "  9999     1 node\n" : null),
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.parentPid).toBeNull()
    expect(forensics.parentCommand).toBeNull()
  })

  it("captureDeathForensics handles ppid throw gracefully", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => { throw new Error("ppid unavailable") },
      runPs: () => null,
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.parentPid).toBeNull()
  })

  it("captureDeathForensics returns null processSnapshot when no relevant processes match", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 4242,
      runPs: (args) => {
        if (args[0] === "-p") return "bash\n"
        return "  4242     1 bash\n  5555     1 systemd\n"
      },
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.processSnapshot).toBeNull()
  })

  it("captureDeathForensics returns null parentCommand when ps returns empty", () => {
    const deps: CaptureForensicsDeps = {
      ppid: () => 4242,
      runPs: (args) => {
        if (args[0] === "-p") return "   \n"
        return "  4242     1 node\n"
      },
    }

    const forensics = captureDeathForensics(deps)
    expect(forensics.parentCommand).toBeNull()
  })

  it("writeDaemonTombstone captures forensics for sigterm reason", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-sigterm-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    const forensicsDeps: CaptureForensicsDeps = {
      ppid: () => 9999,
      runPs: (args) => {
        if (args[0] === "-p") return "node mock-parent\n"
        return "  9999     1 node mock-parent\n  1234  9999 ouro daemon\n"
      },
    }

    writeDaemonTombstone("sigterm", new Error("daemon received SIGTERM"), forensicsDeps)

    const tombstone = readDaemonTombstone()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.forensics).toBeDefined()
    expect(tombstone!.forensics!.parentPid).toBe(9999)
    expect(tombstone!.forensics!.parentCommand).toBe("node mock-parent")
    expect(tombstone!.forensics!.processSnapshot).toContain("ouro daemon")
  })

  it("writeDaemonTombstone captures forensics for sigint reason", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-sigint-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    const forensicsDeps: CaptureForensicsDeps = {
      ppid: () => 1234,
      runPs: () => "  1234     1 zsh\n",
    }

    writeDaemonTombstone("sigint", new Error("daemon received SIGINT"), forensicsDeps)

    const tombstone = readDaemonTombstone()
    expect(tombstone!.forensics).toBeDefined()
    expect(tombstone!.forensics!.parentPid).toBe(1234)
  })

  it("writeDaemonTombstone skips forensics for non-signal reasons", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-no-forensics-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    writeDaemonTombstone("uncaughtException", new Error("crash"))

    const tombstone = readDaemonTombstone()
    expect(tombstone!.forensics).toBeUndefined()
  })

  it("readDaemonTombstone parses forensics field when present", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-forensics-read-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, JSON.stringify({
      reason: "sigterm",
      timestamp: "2026-04-08T01:37:07Z",
      pid: 98340,
      uptimeSeconds: 30,
      recentCrashes: [],
      forensics: {
        parentPid: 1,
        parentCommand: "/sbin/launchd",
        processSnapshot: "  98340     1 node",
        killerHint: "launchd parent",
      },
    }), "utf-8")

    const tombstone = readDaemonTombstone()
    expect(tombstone!.forensics).toBeDefined()
    expect(tombstone!.forensics!.parentPid).toBe(1)
    expect(tombstone!.forensics!.parentCommand).toBe("/sbin/launchd")
    expect(tombstone!.forensics!.killerHint).toBe("launchd parent")
  })

  it("readDaemonTombstone returns null forensics when field is malformed", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-bad-forensics-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, JSON.stringify({
      reason: "sigterm",
      timestamp: "2026-04-08T01:37:07Z",
      pid: 98340,
      uptimeSeconds: 30,
      recentCrashes: [],
      forensics: "not-an-object",
    }), "utf-8")

    const tombstone = readDaemonTombstone()
    expect(tombstone).not.toBeNull()
    expect(tombstone!.forensics).toBeUndefined()
  })

  it("readDaemonTombstone parses forensics with mixed valid/null fields", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tombstone-partial-forensics-"))
    const tombstonePath = path.join(tmpDir, "daemon-death.json")
    setTombstonePath(tombstonePath)

    fs.writeFileSync(tombstonePath, JSON.stringify({
      reason: "sigterm",
      timestamp: "2026-04-08T01:37:07Z",
      pid: 98340,
      uptimeSeconds: 30,
      recentCrashes: [],
      forensics: {
        parentPid: "not a number", // wrong type — should become null
        parentCommand: 42, // wrong type — should become null
        processSnapshot: null,
        killerHint: undefined,
      },
    }), "utf-8")

    const tombstone = readDaemonTombstone()
    expect(tombstone!.forensics).toBeDefined()
    expect(tombstone!.forensics!.parentPid).toBeNull()
    expect(tombstone!.forensics!.parentCommand).toBeNull()
    expect(tombstone!.forensics!.processSnapshot).toBeNull()
    expect(tombstone!.forensics!.killerHint).toBeNull()
  })
})
