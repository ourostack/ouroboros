import * as fs from "fs"
import * as path from "path"

import { describe, expect, it } from "vitest"

import {
  AdapterDiagnosticsRegistry,
  type HabitAdapterDiagnosticProjectionV1,
} from "../../../heart/habits/adapter-diagnostics"

function projection(
  overrides: Partial<HabitAdapterDiagnosticProjectionV1> = {},
): HabitAdapterDiagnosticProjectionV1 {
  return {
    schemaVersion: 1,
    adapter: { id: "custom-adapter", version: 1 },
    status: "degraded",
    evidence: [{ ref: "evidence:adapter-a", sha256: "a".repeat(64) }],
    blockers: [{
      code: "credential_locked",
      actor: "human-required",
      message: "Unlock the configured credential source.",
    }],
    observedAt: "2026-07-24T12:00:00.000Z",
    expiresAt: "2026-07-24T12:05:00.000Z",
    ...overrides,
  }
}

describe("closed habit adapter diagnostics", () => {
  it("keys projections by the exact adapter pair", () => {
    const registry = new AdapterDiagnosticsRegistry()
    registry.publish(projection())

    expect(registry.get("custom-adapter", 1)).toEqual(projection())
    expect(registry.get("custom-adapter", 2)).toBeNull()
  })

  it("rejects duplicates, malformed hashes, and unlabeled blockers", () => {
    const registry = new AdapterDiagnosticsRegistry()
    registry.publish(projection())
    expect(() => registry.publish(projection())).toThrow(/duplicate/i)
    expect(() => new AdapterDiagnosticsRegistry().publish(projection({
      evidence: [{ ref: "evidence:a", sha256: "latest" }],
    }))).toThrow(/sha256|hash/i)
    expect(() => new AdapterDiagnosticsRegistry().publish(projection({
      blockers: [{ code: "blocked", actor: "operator" as "human-required", message: "Blocked." }],
    }))).toThrow(/actor/i)
  })

  it("returns an inert closed projection with no execution authority", () => {
    const registry = new AdapterDiagnosticsRegistry()
    registry.publish(projection())
    const rendered = registry.list()

    expect(rendered).toEqual([projection()])
    expect(Object.keys(rendered[0]).sort()).toEqual([
      "adapter",
      "blockers",
      "evidence",
      "expiresAt",
      "observedAt",
      "schemaVersion",
      "status",
    ])
    expect(JSON.stringify(rendered)).not.toContain("habitName")
    expect(JSON.stringify(rendered)).not.toContain("toolName")
    expect(JSON.stringify(rendered)).not.toContain("credentialValue")
    expect(Object.values(rendered[0]).some((value) => typeof value === "function")).toBe(false)
  })
})

describe("common habit execution ownership", () => {
  const repoRoot = path.resolve(__dirname, "../../../..")
  const commonOwners = [
    "src/heart/daemon/daemon.ts",
    "src/heart/daemon/doctor.ts",
    "src/heart/habits/habit-parser.ts",
    "src/heart/habits/habit-scheduler.ts",
    "src/senses/private-runtime.ts",
    "src/senses/private-runtime-worker.ts",
  ]

  it.each(commonOwners)("keeps %s free of personal workflow imports and selection branches", (relativePath) => {
    const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
    const importSpecifiers = Array.from(source.matchAll(/(?:from\s+|import\s*\()(["'])([^"']+)\1/g), (match) => match[2])

    expect(importSpecifiers.filter((specifier) => /(?:^|\/)rsvp(?:\/|$)/.test(specifier))).toEqual([])
    expect(source).not.toMatch(/\bisRsvpHabitName\b|\brunNativeRsvpHabit\b|\bparseRsvpAwareHabitFile\b/)
  })

  it("does not select adapters from habit names in common daemon dispatch", () => {
    const source = fs.readFileSync(path.join(repoRoot, "src/heart/daemon/daemon.ts"), "utf8")
    expect(source).not.toMatch(/habitName[^\n]{0,120}(?:startsWith|includes|match|test)\s*\(/)
    expect(source).toContain("dispatchHabitExecution")
  })
})
