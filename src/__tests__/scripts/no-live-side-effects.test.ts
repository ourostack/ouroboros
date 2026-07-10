import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

const {
  assertNoLiveSideEffects,
  main,
  runIfMain,
  runNoLiveSideEffectsCli,
} = require(path.resolve(__dirname, "../../../scripts/no-live-side-effects.cjs"))

describe("no-live-side-effects CI fuse", () => {
  it("blocks known live side-effect APIs in replay and shadow test files", () => {
    expect(() => assertNoLiveSideEffects({
      files: [{
        path: "src/__tests__/rsvp/replay.test.ts",
        text: "await createBlueBubblesClient().sendMessage({ text: 'oops' })",
      }],
    })).toThrow(/BlueBubbles send/i)
  })

  it("blocks launchctl, vault writes, daemon restarts, AislePlanner fetches, and legacy RSVP state writes", () => {
    const blockedSamples = [
      "await fetchAislePlannerLive()",
      "await writeVaultItem('runtime/config')",
      "spawnSync('launchctl', ['unload', plist])",
      "await restartDaemon()",
      "legacy.save_snapshot(snapshot)",
      "legacy.write_sent_state(state)",
      "legacy.run_report_pipeline()",
    ]

    for (const sample of blockedSamples) {
      expect(() => assertNoLiveSideEffects({
        files: [{ path: "src/__tests__/rsvp/replay.test.ts", text: sample }],
      }), sample).toThrow()
    }
  })

  it("passes clean files and defaults malformed input to an empty scan", () => {
    expect(assertNoLiveSideEffects({
      files: [{ path: "src/__tests__/rsvp/replay.test.ts", text: "const fixture = 'offline'" }],
    })).toEqual({ ok: true, checked: 1 })
    expect(assertNoLiveSideEffects({ files: [{ path: 5, text: 9 }] })).toEqual({ ok: true, checked: 1 })
    expect(assertNoLiveSideEffects(null)).toEqual({ ok: true, checked: 0 })
  })

  it("runs the CLI wrapper against injected file reads", () => {
    const stderr: string[] = []
    const readFileSync = vi.fn((filePath: string) => filePath.includes("bad") ? "sendMessage({})" : "offline fixture")
    const writeStderr = vi.fn((text: string) => stderr.push(text))

    expect(runNoLiveSideEffectsCli(["clean.test.ts"], { readFileSync, writeStderr })).toBe(0)
    expect(runNoLiveSideEffectsCli(["bad.test.ts"], { readFileSync, writeStderr })).toBe(1)
    expect(stderr.join("")).toContain("BlueBubbles send")
  })

  it("runs the CLI wrapper with default file reads and stderr writes", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "no-live-fuse-"))
    const cleanPath = path.join(tempRoot, "clean.test.ts")
    const badPath = path.join(tempRoot, "bad.test.ts")
    fs.writeFileSync(cleanPath, "offline fixture", "utf-8")
    fs.writeFileSync(badPath, "sendMessage({})", "utf-8")
    const originalWrite = process.stderr.write
    const stderr = vi.fn(() => true)
    try {
      process.stderr.write = stderr as unknown as typeof process.stderr.write
      expect(runNoLiveSideEffectsCli([cleanPath])).toBe(0)
      expect(runNoLiveSideEffectsCli([badPath])).toBe(1)
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("BlueBubbles send"))
    } finally {
      process.stderr.write = originalWrite
      fs.rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  it("stringifies non-Error CLI read failures", () => {
    const stderr: string[] = []
    const readFileSync = vi.fn(() => {
      throw "string read failure"
    })

    expect(runNoLiveSideEffectsCli(["bad.test.ts"], {
      readFileSync,
      writeStderr: (text: string) => stderr.push(text),
    })).toBe(1)
    expect(stderr.join("")).toContain("string read failure")
  })

  it("exposes the direct-entry branch as a testable helper", () => {
    expect(runIfMain(false, ["clean.test.ts"])).toBeUndefined()
    expect(runIfMain(true, [])).toBe(0)
  })

  it("reads files through main for the direct script path", () => {
    const fixturePath = path.join(__dirname, "no-live-clean.fixture.ts")
    expect(() => main([fixturePath])).toThrow()
  })
})
