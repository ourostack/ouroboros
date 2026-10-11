import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"

import {
  formatUpdateStatusLine,
  readUpdateState,
  updateStatePath,
  writeUpdateState,
  type SelfUpdateState,
} from "../../../heart/versioning/update-state"

const NOW = Date.parse("2026-10-11T12:00:00.000Z")

function state(overrides: Partial<SelfUpdateState> = {}): SelfUpdateState {
  return {
    schemaVersion: 1,
    lastRunAt: new Date(NOW - 10 * 60_000).toISOString(),
    outcome: "current",
    currentVersion: "0.1.0-alpha.896",
    failedVersions: [],
    consecutiveFailures: 0,
    ...overrides,
  }
}

describe("update state file", () => {
  it("round-trips through an atomic write and tolerates bad files", () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "update-state-"))
    try {
      expect(readUpdateState({ homeDir })).toBeNull()
      writeUpdateState(state({ outcome: "rolled-back", latestVersion: "0.1.0-alpha.897", detail: "unhealthy" }), { homeDir })
      expect(readUpdateState({ homeDir })).toMatchObject({ outcome: "rolled-back", latestVersion: "0.1.0-alpha.897" })
      writeUpdateState(state(), { homeDir })
      expect(readUpdateState({ homeDir })?.outcome).toBe("current")

      fs.writeFileSync(updateStatePath(homeDir), JSON.stringify({ schemaVersion: 2 }))
      expect(readUpdateState({ homeDir })).toBeNull()

      fs.writeFileSync(updateStatePath(homeDir), JSON.stringify({ schemaVersion: 1, lastRunAt: "x", outcome: "current", failedVersions: ["a", 3], consecutiveFailures: "2" }))
      expect(readUpdateState({ homeDir })).toMatchObject({ failedVersions: ["a"], consecutiveFailures: 0 })

      fs.writeFileSync(updateStatePath(homeDir), JSON.stringify({ schemaVersion: 1, lastRunAt: "x", outcome: "current" }))
      expect(readUpdateState({ homeDir })).toMatchObject({ failedVersions: [], consecutiveFailures: 0 })

      fs.writeFileSync(updateStatePath(homeDir), "null")
      expect(readUpdateState({ homeDir })).toBeNull()
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true })
    }
  })

  it("defaults to the user's home directory", () => {
    expect(updateStatePath()).toBe(path.join(os.homedir(), ".ouro-cli", "update-state.json"))
  })
})

describe("formatUpdateStatusLine", () => {
  const opts = { now: NOW, updaterInstalled: true }

  it("explains a missing record", () => {
    expect(formatUpdateStatusLine(null, opts)).toBe("Updates: no update check recorded yet; run `ouro self-update`")
    expect(formatUpdateStatusLine(null, { now: NOW, updaterInstalled: false }))
      .toBe("Updates: needs attention: the unattended updater is not installed; run `ouro self-update` once")
  })

  it("describes healthy outcomes", () => {
    expect(formatUpdateStatusLine(state({ source: "github" }), opts)).toBe("Updates: current at 0.1.0-alpha.896 (checked 10m ago via github)")
    expect(formatUpdateStatusLine(state(), opts)).toBe("Updates: current at 0.1.0-alpha.896 (checked 10m ago)")
    expect(formatUpdateStatusLine(state({ outcome: "updated", source: "npm-registry", lastRunAt: new Date(NOW - 3 * 3600_000).toISOString() }), opts))
      .toBe("Updates: updated to 0.1.0-alpha.896 3h ago via npm-registry")
    expect(formatUpdateStatusLine(state({ outcome: "updated" }), opts)).toBe("Updates: updated to 0.1.0-alpha.896 10m ago")
    expect(formatUpdateStatusLine(state({ outcome: "pinned", detail: "pin honored until 2026-10-18" }), opts))
      .toBe("Updates: pinned to 0.1.0-alpha.896 (checked 10m ago; pin honored until 2026-10-18)")
    expect(formatUpdateStatusLine(state({ outcome: "pinned" }), opts)).toBe("Updates: pinned to 0.1.0-alpha.896 (checked 10m ago; pin honored)")
  })

  it("leads with needs attention for failures, stale runs and a missing updater", () => {
    expect(formatUpdateStatusLine(state({ outcome: "unreachable", currentVersion: null, detail: "no release source answered" }), opts))
      .toBe("Updates: needs attention: unreachable 10m ago on unknown version: no release source answered")
    expect(formatUpdateStatusLine(state({ outcome: "rolled-back", latestVersion: "0.1.0-alpha.897" }), opts))
      .toBe("Updates: needs attention: rolled-back 10m ago on 0.1.0-alpha.896 (latest 0.1.0-alpha.897): no detail")
    const stale = state({ lastRunAt: new Date(NOW - 5 * 24 * 3600_000).toISOString() })
    expect(formatUpdateStatusLine(stale, { now: NOW, updaterInstalled: false })).toBe(
      `Updates: current at 0.1.0-alpha.896 (checked 5d ago); needs attention: the updater has not run since ${stale.lastRunAt}; needs attention: the unattended updater is not installed; run \`ouro self-update\` once`,
    )
    expect(formatUpdateStatusLine(state({ lastRunAt: new Date(NOW + 60_000).toISOString() }), opts)).toBe("Updates: current at 0.1.0-alpha.896 (checked 0m ago)")
  })
})
