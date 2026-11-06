/**
 * Unit 4a: rollup-vocabulary tests for `readDaemonHealthDeep`.
 *
 * `readDaemonHealthDeep` is the outlook-side reader that parses a
 * daemon-health.json file into the `OutlookDaemonHealthDeep` DTO. The
 * pre-Layer-1 implementation accepted any string for `status` and fell
 * back to `"unknown"` for non-string values.
 *
 * After Unit 4b, the parser uses `isDaemonStatus` to validate the
 * status field — any of the five `DaemonStatus` literals carries through
 * to the DTO; anything else (including the old `"running"` / `"ok"`
 * vocabulary that may still live in stale cached files) defensively
 * falls back to `"unknown"`. The DTO field type widens to
 * `DaemonStatus | "unknown"` so downstream Outlook consumers can rely
 * on the new vocabulary or detect the fallback.
 *
 * These tests are written against the new behavior. Until Unit 4b
 * lands, the assertions about old-vocabulary fallback fail because the
 * existing impl just passes the string through.
 */

import { afterEach, describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { readDaemonHealthDeep } from "../../../../heart/outlook/readers/runtime-readers"
import type { DaemonStatus } from "../../../../heart/daemon/daemon-health"

describe("runtime-readers rollup vocabulary — readDaemonHealthDeep", () => {
  let tmpDir: string

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function makeTmpDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rollup-readers-"))
    return tmpDir
  }

  function writeHealthRaw(healthPath: string, status: unknown): void {
    fs.writeFileSync(
      healthPath,
      JSON.stringify({
        status,
        mode: "prod",
        pid: 1234,
        startedAt: "2026-04-28T19:30:00.000Z",
        uptimeSeconds: 60,
        safeMode: null,
        degraded: [],
        agents: {},
        habits: {},
      }),
      "utf-8",
    )
  }

  describe("carries through valid DaemonStatus literals", () => {
    const validLiterals: DaemonStatus[] = ["healthy", "partial", "degraded", "safe-mode", "down"]
    for (const literal of validLiterals) {
      it(`carries '${literal}' through to the DTO`, () => {
        const healthPath = path.join(makeTmpDir(), "daemon-health.json")
        writeHealthRaw(healthPath, literal)
        const result = readDaemonHealthDeep(healthPath)
        expect(result).not.toBeNull()
        expect(result!.status).toBe(literal)
      })
    }
  })

  describe("defensive fallback to 'unknown' for non-DaemonStatus values", () => {
    it("falls back to 'unknown' for old-vocabulary 'running' (pre-layer-1 cached file)", () => {
      const healthPath = path.join(makeTmpDir(), "daemon-health.json")
      writeHealthRaw(healthPath, "running")
      const result = readDaemonHealthDeep(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("unknown")
    })

    it("falls back to 'unknown' for old-vocabulary 'ok' (pre-layer-1 cached file)", () => {
      const healthPath = path.join(makeTmpDir(), "daemon-health.json")
      writeHealthRaw(healthPath, "ok")
      const result = readDaemonHealthDeep(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("unknown")
    })

    it("falls back to 'unknown' for arbitrary junk strings", () => {
      const healthPath = path.join(makeTmpDir(), "daemon-health.json")
      writeHealthRaw(healthPath, "banana")
      const result = readDaemonHealthDeep(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("unknown")
    })

    it("falls back to 'unknown' for non-string status values (number)", () => {
      const healthPath = path.join(makeTmpDir(), "daemon-health.json")
      writeHealthRaw(healthPath, 42)
      const result = readDaemonHealthDeep(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("unknown")
    })

    it("falls back to 'unknown' when status is missing entirely", () => {
      const healthPath = path.join(makeTmpDir(), "daemon-health.json")
      fs.writeFileSync(
        healthPath,
        JSON.stringify({
          // status field omitted on purpose
          mode: "prod",
          pid: 1234,
          startedAt: "2026-04-28T19:30:00.000Z",
          uptimeSeconds: 60,
          safeMode: null,
          degraded: [],
          agents: {},
          habits: {},
        }),
        "utf-8",
      )
      const result = readDaemonHealthDeep(healthPath)
      expect(result).not.toBeNull()
      expect(result!.status).toBe("unknown")
    })
  })
})
