import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"

const {
  coverageRunOwner,
  inspectCaptureArtifacts,
} = require(path.resolve(__dirname, "../../../scripts/run-coverage-gate.cjs")) as {
  coverageRunOwner: (cwd: string) => string
  inspectCaptureArtifacts: (runDir: string) => {
    ok: boolean
    eventsPath: string
    perTestPath: string
    problems: string[]
  }
}

let tempDirs: string[] = []

beforeEach(() => {
  emitNervesEvent({
    component: "nerves",
    event: "nerves.coverage_gate_test",
    message: "coverage gate helper test",
    meta: {},
  })
})

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe("coverage gate helpers", () => {
  it("derives stable owner ids from checkout paths", () => {
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).toMatch(/^cwd-[0-9a-f]{12}$/)
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).toBe(coverageRunOwner("/tmp/ouro/worktree-a"))
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).not.toBe(coverageRunOwner("/tmp/ouro/worktree-b"))
  })

  it("reports missing capture artifacts with concrete paths", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-missing-"))
    tempDirs.push(runDir)

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.eventsPath).toBe(path.join(runDir, "vitest-events.ndjson"))
    expect(result.perTestPath).toBe(path.join(runDir, "vitest-events-per-test.ndjson"))
    expect(result.problems).toContain(`missing ${path.join(runDir, "vitest-events.ndjson")}`)
    expect(result.problems).toContain(`missing ${path.join(runDir, "vitest-events-per-test.ndjson")}`)
  })

  it("accepts readable event and per-test capture artifacts", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-ok-"))
    tempDirs.push(runDir)
    writeFileSync(
      path.join(runDir, "vitest-events.ndjson"),
      JSON.stringify({
        ts: "2026-04-12T00:00:00.000Z",
        level: "info",
        event: "test.event",
        trace_id: "trace",
        component: "test",
        message: "ok",
        meta: {},
      }) + "\n",
      "utf8",
    )
    writeFileSync(
      path.join(runDir, "vitest-events-per-test.ndjson"),
      JSON.stringify({
        testName: "coverage gate helpers > accepts readable event and per-test capture artifacts",
        events: [{ component: "tests", event: "test_case_observed" }],
      }) + "\n",
      "utf8",
    )

    expect(inspectCaptureArtifacts(runDir)).toMatchObject({ ok: true, problems: [] })
  })

  it("reports zero-byte per-test capture as an artifact failure", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-empty-"))
    tempDirs.push(runDir)
    writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n", "utf8")
    writeFileSync(path.join(runDir, "vitest-events-per-test.ndjson"), "", "utf8")

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(`empty ${path.join(runDir, "vitest-events-per-test.ndjson")}`)
  })

  it("reports per-test capture with no records as an artifact failure", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-no-records-"))
    tempDirs.push(runDir)
    writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n", "utf8")
    writeFileSync(path.join(runDir, "vitest-events-per-test.ndjson"), "{}", "utf8")

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(`invalid ${path.join(runDir, "vitest-events-per-test.ndjson")}: no per-test records`)
  })

  it("reports malformed per-test capture records", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-bad-records-"))
    tempDirs.push(runDir)
    writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n", "utf8")
    writeFileSync(path.join(runDir, "vitest-events-per-test.ndjson"), "{\"testName\":\"ok\",\"events\":[]}\nnot-json\n", "utf8")

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.problems[0]).toContain(`invalid ${path.join(runDir, "vitest-events-per-test.ndjson")}:`)
  })

  it("reports object per-test capture with non-array values", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-bad-object-"))
    tempDirs.push(runDir)
    writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n", "utf8")
    writeFileSync(path.join(runDir, "vitest-events-per-test.ndjson"), JSON.stringify({ "test A": "bad" }), "utf8")

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(`invalid ${path.join(runDir, "vitest-events-per-test.ndjson")}: expected per-test event arrays`)
  })
})
