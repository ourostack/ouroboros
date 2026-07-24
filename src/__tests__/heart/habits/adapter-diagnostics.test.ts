import * as fs from "fs"
import * as os from "os"
import * as path from "path"

import { describe, expect, it } from "vitest"

import {
  AdapterDiagnosticsRegistry,
  listStoredAdapterDiagnostics,
  writeAdapterDiagnosticProjection,
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

  it.each([
    ["schema version", { schemaVersion: 2 as 1 }],
    ["adapter id", { adapter: { id: "Bad_ID", version: 1 as const } }],
    ["adapter version", { adapter: { id: "custom-adapter", version: 2 as 1 } }],
    ["status", { status: "unknown" as "blocked" }],
    ["evidence ref", { evidence: [{ ref: "", sha256: "a".repeat(64) }] }],
    ["blocker code", { blockers: [{ code: "Bad Code", actor: "agent-runnable" as const, message: "Blocked." }] }],
    ["blocker message", { blockers: [{ code: "blocked", actor: "agent-runnable" as const, message: "" }] }],
    ["observed timestamp", { observedAt: "never" }],
    ["expiry timestamp", { expiresAt: "never" }],
  ])("rejects malformed %s", (_label, overrides) => {
    expect(() => new AdapterDiagnosticsRegistry().publish(projection(overrides))).toThrow()
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

  it("replaces one adapter projection without creating duplicate authority", () => {
    const registry = new AdapterDiagnosticsRegistry()
    registry.publish(projection())
    registry.replace(projection({ status: "healthy", blockers: [] }))

    expect(registry.list()).toEqual([projection({ status: "healthy", blockers: [] })])
  })

  it("writes and reloads sorted bundle-local projections", () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "adapter-diagnostics-"))
    const secondBundle = path.join(bundlesRoot, "zeta.ouro")
    const firstBundle = path.join(bundlesRoot, "alpha.ouro")
    writeAdapterDiagnosticProjection(secondBundle, projection({ adapter: { id: "zeta-adapter", version: 1 } }))
    writeAdapterDiagnosticProjection(firstBundle, projection({ adapter: { id: "alpha-adapter", version: 1 } }))

    expect(listStoredAdapterDiagnostics(bundlesRoot).map((entry) => entry.adapter.id)).toEqual([
      "alpha-adapter",
      "zeta-adapter",
    ])
    const stored = path.join(firstBundle, "state", "habits", "adapter-diagnostics", "alpha-adapter-v1.json")
    expect(fs.statSync(stored).mode & 0o777).toBe(0o600)
  })

  it("returns no stored diagnostics for an absent root and rejects malformed stored rows", () => {
    const bundlesRoot = path.join(os.tmpdir(), `missing-adapter-diagnostics-${Date.now()}`)
    expect(listStoredAdapterDiagnostics(bundlesRoot)).toEqual([])

    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "empty-adapter-diagnostics-"))
    fs.mkdirSync(path.join(emptyRoot, "empty.ouro"), { recursive: true })
    expect(listStoredAdapterDiagnostics(emptyRoot)).toEqual([])

    const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "malformed-adapter-diagnostics-"))
    const directory = path.join(malformedRoot, "agent.ouro", "state", "habits", "adapter-diagnostics")
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, "ignored.txt"), "not json", "utf8")
    fs.mkdirSync(path.join(malformedRoot, "not-a-bundle"), { recursive: true })
    fs.writeFileSync(path.join(directory, "bad.json"), JSON.stringify(projection({ observedAt: "never" })), "utf8")
    expect(() => listStoredAdapterDiagnostics(malformedRoot)).toThrow(/timestamp/i)
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
