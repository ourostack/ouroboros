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
    expect(result.perTestPath).toBe(path.join(runDir, "vitest-events-per-test.json"))
    expect(result.problems).toContain(`missing ${path.join(runDir, "vitest-events.ndjson")}`)
    expect(result.problems).toContain(`missing ${path.join(runDir, "vitest-events-per-test.json")}`)
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
      path.join(runDir, "vitest-events-per-test.json"),
      JSON.stringify({}),
      "utf8",
    )

    expect(inspectCaptureArtifacts(runDir)).toMatchObject({ ok: true, problems: [] })
  })

  it("reports zero-byte per-test capture as an artifact failure", () => {
    const runDir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-gate-empty-"))
    tempDirs.push(runDir)
    writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n", "utf8")
    writeFileSync(path.join(runDir, "vitest-events-per-test.json"), "", "utf8")

    const result = inspectCaptureArtifacts(runDir)

    expect(result.ok).toBe(false)
    expect(result.problems).toContain(`empty ${path.join(runDir, "vitest-events-per-test.json")}`)
  })
})
