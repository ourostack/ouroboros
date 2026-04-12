import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"

import { describe, expect, it } from "vitest"

import type { NervesCoverageReport } from "../../nerves/coverage/audit"
import { auditNervesCoverage } from "../../nerves/coverage/audit"

/**
 * Integration tests for the rewritten auditNervesCoverage() report.
 *
 * The new report must contain:
 * - schema_redaction (preserved)
 * - every_test_emits (Rule 1)
 * - start_end_pairing (Rule 2)
 * - error_context (Rule 3)
 * - source_coverage (Rule 4)
 * - file_completeness (Rule 5)
 *
 * Old sections (event_catalog, logpoint_coverage) must NOT exist.
 */

function createAuditFixture() {
  const runDir = mkdtempSync(join(tmpdir(), "ouro-audit-int-"))
  const eventsPath = join(runDir, "vitest-events.ndjson")
  const perTestPath = join(runDir, "vitest-events-per-test.json")
  const sourceRoot = join(runDir, "src")
  mkdirSync(sourceRoot, { recursive: true })
  return { runDir, eventsPath, perTestPath, sourceRoot }
}

describe("audit integration - new 5-rule report shape", () => {
  it("report contains all 5 rule sections plus schema_redaction", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    // Minimal valid data
    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test.event",
      trace_id: "t1",
      component: "test",
      message: "msg",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, JSON.stringify({
      "some test": [{ component: "test", event: "test.event" }],
    }), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    const nc = report.nerves_coverage

    expect(nc).toHaveProperty("schema_redaction")
    expect(nc).toHaveProperty("every_test_emits")
    expect(nc).toHaveProperty("start_end_pairing")
    expect(nc).toHaveProperty("error_context")
    expect(nc).toHaveProperty("source_coverage")
    expect(nc).toHaveProperty("file_completeness")

    // Old sections must be gone
    const ncAny = nc as Record<string, unknown>
    expect(ncAny["event_catalog"]).toBeUndefined()
    expect(ncAny["logpoint_coverage"]).toBeUndefined()
  })

  it("overall_status is pass when all rules pass", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_start",
      trace_id: "t1",
      component: "test",
      message: "msg",
      meta: {},
    }) + "\n" + JSON.stringify({
      ts: "2026-03-05T00:00:01.000Z",
      level: "info",
      event: "test_end",
      trace_id: "t1",
      component: "test",
      message: "msg",
      meta: {},
    }) + "\n", "utf8")

    writeFileSync(perTestPath, JSON.stringify({
      "some test": [
        { component: "test", event: "test_start" },
        { component: "test", event: "test_end" },
      ],
    }), "utf8")

    // Create a source file with emitNervesEvent
    writeFileSync(join(sourceRoot, "mod.ts"), `
import { emitNervesEvent } from "../nerves/runtime"
emitNervesEvent({ component: "test", event: "test_start", message: "s" })
emitNervesEvent({ component: "test", event: "test_end", message: "e" })
`, "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    expect(report.overall_status).toBe("pass")
    expect(report.required_actions).toEqual([])
  })

  it("accepts append-only per-test ndjson records from parallel workers", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")

    writeFileSync(perTestPath, [
      JSON.stringify({
        testName: "worker one > emits",
        events: [{ component: "tests", event: "test_case_observed", level: "info", meta: { worker: 1 } }],
      }),
      JSON.stringify({
        testName: "worker two > emits",
        events: [{ component: "tests", event: "test_case_observed", level: "info", meta: { worker: 2 } }],
      }),
      "",
    ].join("\n"), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("pass")
    expect(report.nerves_coverage.every_test_emits.total_tests).toBe(2)
  })

  it("accepts a single per-test JSON record for compatibility", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, JSON.stringify({
      testName: "worker one > emits",
      events: [{ component: "tests", event: "test_case_observed", level: "info", meta: { worker: 1 } }],
    }), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("pass")
    expect(report.nerves_coverage.every_test_emits.total_tests).toBe(1)
  })

  it("fails when the per-test artifact has no captured test records", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, JSON.stringify({}), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
    expect(report.required_actions).toContainEqual(expect.objectContaining({
      target: "every-test-emits",
    }))
  })

  it("fails gracefully when the per-test artifact is empty", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, "", "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("fails gracefully when a per-test ndjson line is not a record", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, [
      JSON.stringify({ testName: "worker one > emits", events: [{ component: "tests", event: "test_case_observed" }] }),
      JSON.stringify({ nope: true }),
      "",
    ].join("\n"), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("fails gracefully when the per-test artifact is JSON null", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, "null", "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("fails gracefully when the per-test artifact is a JSON primitive", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test_case_observed",
      trace_id: "t1",
      component: "tests",
      message: "observed",
      meta: {},
    }) + "\n", "utf8")
    writeFileSync(perTestPath, "42", "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })

    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("overall_status is fail when any rule fails", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test.event",
      trace_id: "t1",
      component: "test",
      message: "msg",
      meta: {},
    }) + "\n", "utf8")

    // A test with zero events - Rule 1 will fail
    writeFileSync(perTestPath, JSON.stringify({
      "test with events": [{ component: "test", event: "test.event" }],
      "silent test": [],
    }), "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    expect(report.overall_status).toBe("fail")
    expect(report.required_actions.length).toBeGreaterThan(0)
  })

  it("handles malformed perTestPath JSON gracefully", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, "", "utf8")
    writeFileSync(perTestPath, "{not-json", "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("handles missing perTestPath gracefully", () => {
    const { eventsPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "test.event",
      trace_id: "t1",
      component: "test",
      message: "msg",
      meta: {},
    }) + "\n", "utf8")

    const report = auditNervesCoverage({
      eventsPath,
      perTestPath: "/nonexistent/path.json",
      sourceRoot,
    })

    // Rules that depend on per-test data should fail gracefully
    expect(report.nerves_coverage.every_test_emits.status).toBe("fail")
  })

  it("reports source_coverage failure as advisory (not in required_actions)", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    // Events file has no events matching the source keys
    writeFileSync(eventsPath, "", "utf8")
    writeFileSync(perTestPath, JSON.stringify({}), "utf8")

    // Source has emitNervesEvent but events are not observed
    writeFileSync(join(sourceRoot, "mod.ts"), `
import { emitNervesEvent } from "../nerves/runtime"
emitNervesEvent({ component: "engine", event: "engine.turn_start", message: "s" })
`, "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    // Source coverage still reports the failure in the data
    expect(report.nerves_coverage.source_coverage.status).toBe("fail")
    expect(report.nerves_coverage.source_coverage.missing).toContain("engine:engine.turn_start")
    // But it's advisory -- not in required_actions (many tests mock emitNervesEvent)
    expect(report.required_actions).not.toContainEqual(expect.objectContaining({
      target: "source-coverage",
    }))
  })

  it("reports file_completeness failure for non-type files without events", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, "", "utf8")
    writeFileSync(perTestPath, JSON.stringify({}), "utf8")

    // A non-type file with no emitNervesEvent call
    writeFileSync(join(sourceRoot, "helper.ts"), `
export function helper() { return 42 }
`, "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    expect(report.nerves_coverage.file_completeness.status).toBe("fail")
    expect(report.required_actions).toContainEqual(expect.objectContaining({
      target: "file-completeness",
    }))
  })

  it("ignores non-ts files in source root", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, "", "utf8")
    writeFileSync(perTestPath, JSON.stringify({}), "utf8")

    // A non-ts file should be ignored
    writeFileSync(join(sourceRoot, "readme.md"), "# Hello", "utf8")
    writeFileSync(join(sourceRoot, "types.ts"), "export type Foo = string", "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    // types.ts is type-only so exempt, readme.md is ignored
    expect(report.nerves_coverage.file_completeness.status).toBe("pass")
  })

  it("scans subdirectories and skips __tests__, nerves, and reflection", () => {
    const { eventsPath, perTestPath, sourceRoot } = createAuditFixture()

    writeFileSync(eventsPath, JSON.stringify({
      ts: "2026-03-05T00:00:00.000Z",
      level: "info",
      event: "sub.event",
      trace_id: "t1",
      component: "sub",
      message: "msg",
      meta: {},
    }) + "\n", "utf8")

    writeFileSync(perTestPath, JSON.stringify({
      "some test": [{ component: "sub", event: "sub.event" }],
    }), "utf8")

    // Create a subdirectory with a source file
    const subDir = join(sourceRoot, "submod")
    mkdirSync(subDir, { recursive: true })
    writeFileSync(join(subDir, "logic.ts"), `
import { emitNervesEvent } from "../../nerves/runtime"
emitNervesEvent({ component: "sub", event: "sub.event", message: "s" })
`, "utf8")

    // Create __tests__ and nerves dirs that should be skipped
    const testsDir = join(sourceRoot, "__tests__")
    mkdirSync(testsDir, { recursive: true })
    writeFileSync(join(testsDir, "skip.ts"), `
emitNervesEvent({ component: "should", event: "not_scan", message: "" })
`, "utf8")

    const nervesDir = join(sourceRoot, "nerves")
    mkdirSync(nervesDir, { recursive: true })
    writeFileSync(join(nervesDir, "skip.ts"), `
emitNervesEvent({ component: "should", event: "not_scan", message: "" })
`, "utf8")

    // Create reflection dir that should also be skipped (tests mock emitNervesEvent)
    const reflectionDir = join(sourceRoot, "reflection")
    mkdirSync(reflectionDir, { recursive: true })
    writeFileSync(join(reflectionDir, "skip.ts"), `
emitNervesEvent({ component: "should", event: "not_scan_either", message: "" })
`, "utf8")

    const report = auditNervesCoverage({ eventsPath, perTestPath, sourceRoot })
    // Only sub.event should be found, not the skipped dirs
    expect(report.nerves_coverage.source_coverage.declared_keys).toBe(1)
    expect(report.overall_status).toBe("pass")
  })
})
