#!/usr/bin/env node
const { spawnSync } = require("child_process")
const { mkdirSync, writeFileSync, readFileSync, unlinkSync, existsSync } = require("fs")
const path = require("path")
const os = require("os")

const REPO_SLUG = "ouroboros-agent-harness"
const ROOT = path.join(os.tmpdir(), "ouroboros-test-runs", REPO_SLUG)

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

function runNpm(args) {
  return spawnSync(npmCmd(), args, { stdio: "inherit" })
}

function createRunId() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8")
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"))
}

function main() {
  mkdirSync(ROOT, { recursive: true })
  const runId = createRunId()
  const runDir = path.join(ROOT, runId)
  mkdirSync(runDir, { recursive: true })

  const info = {
    repo_slug: REPO_SLUG,
    run_id: runId,
    run_dir: runDir,
    created_at: new Date().toISOString(),
  }

  const activePath = path.join(ROOT, ".active-run.json")
  const latestPath = path.join(ROOT, "latest-run.json")
  const nervesCoveragePath = path.join(runDir, "nerves-coverage.json")
  const summaryPath = path.join(runDir, "coverage-gate-summary.json")

  writeJson(activePath, info)
  writeJson(latestPath, info)

  const lintExit = runNpm(["run", "lint"]).status ?? 1
  if (lintExit !== 0) {
    const summary = {
      overall_status: "fail",
      lint: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "lint", target: "eslint", reason: "npm run lint failed" }],
    }
    writeJson(summaryPath, summary)
    console.log(`coverage gate: fail (${summaryPath})`)
    process.exit(1)
  }

  const changelogGateExit = spawnSync(process.execPath, [path.join(__dirname, "changelog-gate.cjs")], { stdio: "inherit" }).status ?? 1
  if (changelogGateExit !== 0) {
    const summary = {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "changelog", target: "changelog.json", reason: "changelog gate failed -- add entry for current version" }],
    }
    writeJson(summaryPath, summary)
    console.log(`coverage gate: fail (${summaryPath})`)
    process.exit(1)
  }

  // Install workspace deps before running workspace tests (root npm ci doesn't install them)
  runNpm(["install", "--prefix", "packages/outlook-ui"])
  const outlookUiExit = runNpm(["run", "test:outlook-ui"]).status ?? 1
  if (outlookUiExit !== 0) {
    const summary = {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "pass" },
      outlook_ui_tests: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "ui-tests", target: "packages/outlook-ui", reason: "npm run test:outlook-ui failed" }],
    }
    writeJson(summaryPath, summary)
    console.log(`coverage gate: fail (${summaryPath})`)
    process.exit(1)
  }

  const vitestExit = runNpm(["run", "test:coverage:vitest"]).status ?? 1

  if (existsSync(activePath)) {
    unlinkSync(activePath)
  }

  const auditExit = runNpm([
    "run",
    "audit:nerves",
    "--",
    "--run-dir",
    runDir,
    "--output",
    nervesCoveragePath,
  ]).status ?? 1

  let nervesReport = null
  if (existsSync(nervesCoveragePath)) {
    nervesReport = readJson(nervesCoveragePath)
  }

  const requiredActions = []
  const codeCoverageStatus = vitestExit === 0 ? "pass" : "fail"
  if (codeCoverageStatus === "fail") {
    requiredActions.push({
      type: "coverage",
      target: "code-coverage",
      reason: "vitest coverage gate failed",
    })
  }

  const nervesStatus = nervesReport?.overall_status === "pass" && auditExit === 0
    ? "pass"
    : "fail"

  if (Array.isArray(nervesReport?.required_actions)) {
    requiredActions.push(...nervesReport.required_actions)
  } else if (nervesStatus === "fail") {
    requiredActions.push({
      type: "logging",
      target: "nerves-audit",
      reason: "nerves audit did not produce a valid report",
    })
  }

  const overallStatus =
    codeCoverageStatus === "pass" && nervesStatus === "pass" ? "pass" : "fail"

  const summary = {
    overall_status: overallStatus,
    lint: { status: "pass" },
    outlook_ui_tests: { status: "pass" },
    code_coverage: {
      status: codeCoverageStatus,
    },
    nerves_coverage: nervesReport?.nerves_coverage ?? {
      status: nervesStatus,
    },
    required_actions: requiredActions,
  }

  writeJson(summaryPath, summary)
  console.log(`coverage gate: ${overallStatus} (${summaryPath})`)
  process.exit(overallStatus === "pass" ? 0 : 1)
}

main()
