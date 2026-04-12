import { existsSync, mkdtempSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { tmpdir } from "os"

import { afterEach, describe, expect, it, vi } from "vitest"

describe("nerves/coverage cli", () => {
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it("returns code 2 when no run directory is available", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    vi.doMock("../../nerves/coverage/run-artifacts", () => ({
      readLatestRun: () => null,
    }))
    vi.doMock("../../nerves/coverage/audit", () => ({
      auditNervesCoverage: vi.fn(),
    }))

    const { runAuditCli } = await import("../../nerves/coverage/cli")
    expect(runAuditCli([])).toBe(2)
    expect(stderrSpy).toHaveBeenCalledWith("nerves audit: no run directory found; provide --run-dir")
  })

  it("writes report output and returns success/failure codes from audit results", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ouro-observability-cli-"))
    const outputPath = join(runDir, "custom-nerves-coverage.json")
    const eventsPath = join(runDir, "custom-events.ndjson")
    const perTestPath = join(runDir, "custom-per-test.json")
    const sourceRoot = join(runDir, "custom-src")
    const auditSpy = vi.fn()
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => {})

    vi.doMock("../../nerves/coverage/run-artifacts", () => ({
      readLatestRun: () => ({
        repo_slug: "ouroboros-agent-harness",
        run_id: "run-id",
        run_dir: runDir,
        created_at: "2026-03-02T18:00:00.000Z",
      }),
    }))
    vi.doMock("../../nerves/coverage/audit", () => ({
      auditNervesCoverage: auditSpy,
    }))

    const { runAuditCli } = await import("../../nerves/coverage/cli")

    auditSpy.mockReturnValueOnce({
      overall_status: "pass",
      required_actions: [],
      nerves_coverage: {},
    })
    const defaultOutputCode = runAuditCli([
      "--run-dir",
      runDir,
      "--events-path",
      eventsPath,
      "--per-test-path",
      perTestPath,
      "--source-root",
      sourceRoot,
    ])
    expect(defaultOutputCode).toBe(0)
    expect(auditSpy).toHaveBeenCalledWith({
      eventsPath,
      perTestPath,
      sourceRoot,
    })
    expect(existsSync(join(runDir, "nerves-coverage.json"))).toBe(true)

    auditSpy.mockReturnValueOnce({
      overall_status: "pass",
      required_actions: [],
      nerves_coverage: {},
    })
    const passCode = runAuditCli(["--output", outputPath])
    expect(passCode).toBe(0)
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(
      expect.objectContaining({ overall_status: "pass" }),
    )

    auditSpy.mockReturnValueOnce({
      overall_status: "fail",
      required_actions: [{ type: "logging", target: "source-coverage", reason: "missing" }],
      nerves_coverage: {},
    })
    const failCode = runAuditCli(["--run-dir", runDir, "--output", outputPath])
    expect(failCode).toBe(1)
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(
      expect.objectContaining({ overall_status: "fail" }),
    )
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("nerves audit:"))
  })

  it("uses defaults for per-test and source-root when not specified", async () => {
    const runDir = mkdtempSync(join(tmpdir(), "ouro-observability-cli-"))
    const auditSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(() => {})

    vi.doMock("../../nerves/coverage/run-artifacts", () => ({
      readLatestRun: () => null,
    }))
    vi.doMock("../../nerves/coverage/audit", () => ({
      auditNervesCoverage: auditSpy,
    }))

    const { runAuditCli } = await import("../../nerves/coverage/cli")

    auditSpy.mockReturnValueOnce({
      overall_status: "pass",
      required_actions: [],
      nerves_coverage: {},
    })
    runAuditCli(["--run-dir", runDir])
    expect(auditSpy).toHaveBeenCalledWith({
      eventsPath: join(runDir, "vitest-events.ndjson"),
      perTestPath: join(runDir, "vitest-events-per-test.ndjson"),
      sourceRoot: resolve("src"),
    })
  })
})
