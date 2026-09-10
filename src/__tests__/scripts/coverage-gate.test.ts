import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import * as path from "path"
import { runInNewContext } from "node:vm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { emitNervesEvent } from "../../nerves/runtime"
import * as runArtifacts from "../../nerves/coverage/run-artifacts"

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

function runCoverageCli(argv: string[], failure?: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "ouro-coverage-cli-"))
  tempDirs.push(dir)
  const script = path.resolve(__dirname, "../../../scripts/run-coverage-gate.cjs")
  const ownerRoot = path.join(dir, "ouroboros-test-runs", "ouroboros-agent-harness", coverageRunOwner(dir))
  const calls: string[][] = []
  const fixtureModule = { exports: {} }
  const fixtureExit = Symbol("coverage-cli-exit")
  let exitCode: number | undefined
  const spawnSync = (_command: string, args: string[]) => {
    calls.push(args)
    const stage = args[0]!.endsWith("changelog-gate.cjs") ? "changelog" : args[1]
    if (stage === "test:coverage:vitest" && failure !== "captures") {
      const { run_dir: runDir } = JSON.parse(readFileSync(path.join(ownerRoot, ".active-run.json"), "utf8"))
      writeFileSync(path.join(runDir, "vitest-events.ndjson"), "{}\n")
      writeFileSync(path.join(runDir, "vitest-events-per-test.ndjson"), '{"testName":"fixture","events":[]}\n')
    }
    if (stage === "audit:nerves") {
      writeFileSync(args[args.indexOf("--output") + 1]!, JSON.stringify({
        overall_status: failure === "report" ? "fail" : "pass",
        required_actions: failure === "report" ? [{ type: "logging", target: "fixture", reason: "fixture report failure" }] : [],
      }))
    }
    return { status: stage === failure ? 7 : 0 }
  }
  const fixtureRequire = Object.assign((name: string) => {
    if (name === "child_process") return { spawnSync }
    if (name === "os") return { tmpdir: () => dir }
    return require(name)
  }, { main: fixtureModule })
  try {
    runInNewContext(readFileSync(script, "utf8"), {
      require: fixtureRequire, module: fixtureModule, __dirname: path.dirname(script),
      console: { log: () => undefined },
      process: {
        argv: [process.execPath, script, ...argv], execPath: process.execPath,
        cwd: () => dir, platform: process.platform,
        exit: (code: number) => { exitCode = code; throw fixtureExit },
      },
    }, { filename: script })
  } catch (error) {
    if (error !== fixtureExit) throw error
  }
  if (exitCode === undefined) throw new Error("coverage CLI entry point did not execute")
  const { run_dir: runDir } = JSON.parse(readFileSync(path.join(ownerRoot, "latest-run.json"), "utf8"))
  const summary = JSON.parse(readFileSync(path.join(runDir, "coverage-gate-summary.json"), "utf8"))
  return { exitCode, calls, summary }
}

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
  it.each([
    { argv: [], skip: false },
    { argv: ["--skip-mailbox-ui-install"], skip: true },
    { argv: ["--skip-mailbox-ui-install-extra"], skip: false },
  ])("wires the exact install option through the real CLI without changing gates: $argv", ({ argv, skip }) => {
    const result = runCoverageCli(argv)
    expect(result.exitCode).toBe(0)
    expect(result.summary.overall_status).toBe("pass")
    expect(result.calls.map((args) => args[0]!.endsWith("changelog-gate.cjs") ? "changelog" : args[0] === "install" ? "install" : args[1])).toEqual([
      "lint", "changelog", ...(skip ? [] : ["install"]), "typecheck:mailbox-ui", "test:mailbox-ui", "test:coverage:vitest", "audit:nerves",
    ])
    expect(result.calls.filter((args) => args[0] === "install")).toEqual(skip ? [] : [["install", "--prefix", "packages/mailbox-ui"]])
  })

  it.each(["lint", "changelog", "typecheck:mailbox-ui", "test:mailbox-ui", "test:coverage:vitest", "captures", "audit:nerves", "report"])("keeps %s failures fatal when dependency preparation is skipped", (failure) => {
    const result = runCoverageCli(["--skip-mailbox-ui-install"], failure)
    expect(result.exitCode).toBe(1)
    expect(result.summary.overall_status).toBe("fail")
    if (failure !== "audit:nerves") expect(result.summary.required_actions.length).toBeGreaterThan(0)
    expect(result.calls.some((args) => args[0] === "install")).toBe(false)
    if (["test:coverage:vitest", "audit:nerves", "report"].includes(failure)) {
      expect(result.calls.some((args) => args[1] === "audit:nerves")).toBe(true)
    }
  })

  it("derives stable owner ids from checkout paths", () => {
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).toMatch(/^cwd-[0-9a-f]{12}$/)
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).toBe(coverageRunOwner("/tmp/ouro/worktree-a"))
    expect(coverageRunOwner("/tmp/ouro/worktree-a")).not.toBe(coverageRunOwner("/tmp/ouro/worktree-b"))
    const typescriptOwner = (runArtifacts as typeof runArtifacts & {
      coverageRunOwner?: (cwd: string) => string
    }).coverageRunOwner
    expect(typescriptOwner).toBeTypeOf("function")
    expect(typescriptOwner?.("/tmp/ouro/worktree-a")).toBe(coverageRunOwner("/tmp/ouro/worktree-a"))
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
