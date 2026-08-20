import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-acceptance-marker-"))

vi.mock("../../../heart/identity", () => ({
  getAgentRoot: (agentName: string) => path.join(root, `${agentName}.ouro`),
}))

import {
  clearSanctuaryAcceptanceMarker,
  clearSanctuaryAcceptanceGateStatus,
  publishSanctuaryAcceptanceGateStatus,
  readSanctuaryAcceptanceMarker,
  sanctuaryAcceptanceEventMeta,
  writeSanctuaryAcceptanceMarker,
} from "../../../heart/daemon/sanctuary-acceptance-marker"

afterEach(() => fs.rmSync(path.join(root, "sanctuary.ouro"), { recursive: true, force: true }))

describe("Sanctuary acceptance marker", () => {
  it("atomically publishes only the redacted scenario digest and enforces ownership on clear", () => {
    const marker = {
      schemaVersion: "sanctuary-acceptance-marker-v1" as const,
      label: "approval-suspend",
      scenarioHandleDigest: "a".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    }
    writeSanctuaryAcceptanceMarker("sanctuary", marker)

    expect(readSanctuaryAcceptanceMarker("sanctuary")).toEqual(marker)
    expect(sanctuaryAcceptanceEventMeta("sanctuary")).toEqual({ scenarioHandleDigest: "a".repeat(64) })
    expect(fs.statSync(path.join(root, "sanctuary.ouro", "state", "acceptance", "active-scenario.json")).mode & 0o777).toBe(0o600)
    expect(() => clearSanctuaryAcceptanceMarker("sanctuary", "b".repeat(64))).toThrow("ownership mismatch")
    clearSanctuaryAcceptanceMarker("sanctuary", "a".repeat(64))
    expect(readSanctuaryAcceptanceMarker("sanctuary")).toBeNull()
  })

  it("does not read or publish markers for other agents", () => {
    expect(readSanctuaryAcceptanceMarker("slugger")).toBeNull()
    expect(sanctuaryAcceptanceEventMeta("slugger")).toEqual({})
    expect(() => writeSanctuaryAcceptanceMarker("slugger", {
      schemaVersion: "sanctuary-acceptance-marker-v1",
      label: "wrong-agent",
      scenarioHandleDigest: "c".repeat(64),
      startedAt: "2026-08-20T12:00:00.000Z",
    })).toThrow("restricted")
  })

  it("publishes the exact non-sensitive external gate status and clears it at finalization", () => {
    const filePath = path.join(root, "evidence", "current-scenario-gate.json")
    publishSanctuaryAcceptanceGateStatus({
      label: "approval-approve",
      gate: "telegram-delayed-approve",
      phase: "waiting",
      startedAt: "2026-08-20T12:00:00.000Z",
    }, filePath)
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      label: "approval-approve",
      gate: "telegram-delayed-approve",
      phase: "waiting",
      startedAt: "2026-08-20T12:00:00.000Z",
    })
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o644)
    clearSanctuaryAcceptanceGateStatus(filePath)
    expect(fs.existsSync(filePath)).toBe(false)
  })
})
