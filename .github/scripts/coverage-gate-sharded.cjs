#!/usr/bin/env node
// The coverage gate (scripts/run-coverage-gate.cjs) split across CI runners.
//
//   shard --index i --count N --out DIR
//     Runs shard i/N of the vitest coverage suite with the blob reporter and
//     nerves capture on. DIR gets blob/blob-i-N.json, files.json (the split)
//     and capture/*.ndjson.
//   merge --shards DIR --count N
//     The rest of the gate, in the same order and with the same summary file:
//     lint, changelog gate, mailbox-ui typecheck and tests, then
//     `vitest --merge-reports` with the real coverage thresholds, the nerves
//     capture check and the nerves audit over every shard's capture.
//
// Local runs keep using `npm run test:coverage`; this file only changes how CI
// spreads the same work. Keep the merge steps in step with run-coverage-gate.cjs.
const { spawnSync } = require("child_process")
const { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } = require("fs")
const os = require("os")
const path = require("path")

const { coverageRunOwner, inspectCaptureArtifacts } = require("../../scripts/run-coverage-gate.cjs")
const { checkShardLists } = require("./coverage-shards.cjs")

const REPO_SLUG = "ouroboros-agent-harness"
const ROOT = path.join(os.tmpdir(), "ouroboros-test-runs", REPO_SLUG, coverageRunOwner(process.cwd()))
const CAPTURE_FILES = ["vitest-events.ndjson", "vitest-events-per-test.ndjson"]

function npmCmd() {
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

function runNpm(args, env) {
  return spawnSync(npmCmd(), args, { stdio: "inherit", env: env ? { ...process.env, ...env } : process.env }).status ?? 1
}

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8")
}

function option(argv, name) {
  const index = argv.indexOf(name)
  if (index < 0 || !argv[index + 1]) throw new Error(`missing ${name}`)
  return argv[index + 1]
}

// Same layout as run-coverage-gate.cjs, so the setup file finds the run dir and
// the workflow uploads the same artifact root.
function startRun() {
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const runDir = path.join(ROOT, runId)
  mkdirSync(runDir, { recursive: true })
  const info = { repo_slug: REPO_SLUG, run_owner: path.basename(ROOT), run_id: runId, run_dir: runDir, created_at: new Date().toISOString() }
  writeJson(path.join(ROOT, ".active-run.json"), info)
  writeJson(path.join(ROOT, "latest-run.json"), info)
  return { runId, runDir }
}

function endRun() {
  const activePath = path.join(ROOT, ".active-run.json")
  if (existsSync(activePath)) unlinkSync(activePath)
}

function shard(argv) {
  const index = Number(option(argv, "--index"))
  const count = Number(option(argv, "--count"))
  const out = path.resolve(option(argv, "--out"))
  mkdirSync(path.join(out, "capture"), { recursive: true })
  const { runId, runDir } = startRun()
  const vitestExit = runNpm(
    [
      "run", "test:coverage:vitest", "--",
      "--config", ".github/vitest.shard.config.ts",
      `--shard=${index}/${count}`,
      "--reporter=default", "--reporter=blob",
      `--outputFile.blob=${path.join(out, "blob", `blob-${index}-${count}.json`)}`,
    ],
    { COVERAGE_SHARD_LIST: path.join(out, "files.json") },
  )
  endRun()
  for (const name of CAPTURE_FILES) {
    if (existsSync(path.join(runDir, name))) copyFileSync(path.join(runDir, name), path.join(out, "capture", name))
  }
  const capture = inspectCaptureArtifacts(runDir)
  if (vitestExit === 0 && !capture.ok) {
    console.error(`coverage shard ${index}/${count}: nerves capture artifacts were not produced for run ${runId}; ${capture.problems.join("; ")}`)
    process.exit(1)
  }
  console.log(`coverage shard ${index}/${count}: ${vitestExit === 0 ? "pass" : "fail"}`)
  process.exit(vitestExit === 0 ? 0 : 1)
}

function fail(summaryPath, summary) {
  writeJson(summaryPath, summary)
  console.log(`coverage gate: fail (${summaryPath})`)
  process.exit(1)
}

function merge(argv) {
  const shardsDir = path.resolve(option(argv, "--shards"))
  const count = Number(option(argv, "--count"))
  mkdirSync(ROOT, { recursive: true })
  const { runId, runDir } = startRun()
  endRun() // Nothing in the merge job records nerves events.
  const summaryPath = path.join(runDir, "coverage-gate-summary.json")
  const nervesCoveragePath = path.join(runDir, "nerves-coverage.json")

  if (runNpm(["run", "lint"]) !== 0) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "lint", target: "eslint", reason: "npm run lint failed" }],
    })
  }

  const changelogGate = path.join(__dirname, "../../scripts/changelog-gate.cjs")
  if ((spawnSync(process.execPath, [changelogGate], { stdio: "inherit" }).status ?? 1) !== 0) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "changelog", target: "changelog.json", reason: "changelog gate failed -- add entry for current version" }],
    })
  }

  runNpm(["install", "--prefix", "packages/mailbox-ui"])
  if (runNpm(["run", "typecheck:mailbox-ui"]) !== 0) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "pass" },
      mailbox_ui_typecheck: { status: "fail" },
      mailbox_ui_tests: { status: "skip" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "ui-typecheck", target: "packages/mailbox-ui", reason: "npm run typecheck:mailbox-ui failed" }],
    })
  }

  if (runNpm(["run", "test:mailbox-ui"]) !== 0) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "pass" },
      mailbox_ui_typecheck: { status: "pass" },
      mailbox_ui_tests: { status: "fail" },
      code_coverage: { status: "skip" },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "ui-tests", target: "packages/mailbox-ui", reason: "npm run test:mailbox-ui failed" }],
    })
  }

  // Every test file must have run on exactly one shard, or the merged coverage
  // is not the suite's coverage.
  const shardDirs = readdirSync(shardsDir).map((name) => path.join(shardsDir, name)).filter((dir) => existsSync(path.join(dir, "files.json")))
  const lists = shardDirs.map((dir) => ({ dir, ...JSON.parse(readFileSync(path.join(dir, "files.json"), "utf8")) })).sort((a, b) => a.index - b.index)
  const problems = checkShardLists(lists, count)
  if (problems.length > 0) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "pass" },
      mailbox_ui_typecheck: { status: "pass" },
      mailbox_ui_tests: { status: "pass" },
      code_coverage: { status: "fail", shards: problems },
      nerves_coverage: { status: "skip" },
      required_actions: [{ type: "coverage", target: "coverage-shards", reason: `coverage shards did not cover the suite exactly once: ${problems.slice(0, 5).join("; ")}` }],
    })
  }
  console.log(`coverage shards: ${lists.length} shards ran ${lists[0].all.length} test files, each exactly once`)

  const blobsDir = path.join(shardsDir, ".blobs")
  mkdirSync(blobsDir, { recursive: true })
  for (const list of lists) {
    const blob = path.join(list.dir, "blob", `blob-${list.index}-${count}.json`)
    if (existsSync(blob)) copyFileSync(blob, path.join(blobsDir, path.basename(blob)))
  }
  const vitestExit = runNpm(["run", "test:coverage:vitest", "--", "--merge-reports", blobsDir])
  printCoverageTotals()

  // Each shard appended its own events; together they are the whole run's.
  for (const name of CAPTURE_FILES) {
    for (const list of lists) {
      const part = path.join(list.dir, "capture", name)
      if (existsSync(part)) appendFileSync(path.join(runDir, name), readFileSync(part))
    }
  }
  const captureArtifacts = inspectCaptureArtifacts(runDir)

  if (vitestExit === 0 && !captureArtifacts.ok) {
    fail(summaryPath, {
      overall_status: "fail",
      lint: { status: "pass" },
      changelog: { status: "pass" },
      mailbox_ui_typecheck: { status: "pass" },
      mailbox_ui_tests: { status: "pass" },
      code_coverage: { status: "pass" },
      nerves_coverage: {
        status: "fail",
        capture_artifacts: {
          status: "fail",
          events_path: captureArtifacts.eventsPath,
          per_test_path: captureArtifacts.perTestPath,
          problems: captureArtifacts.problems,
        },
      },
      required_actions: [{
        type: "logging",
        target: "nerves-capture-artifacts",
        reason: `nerves capture artifacts were not produced for run ${runId}; ${captureArtifacts.problems.join("; ")}. Coverage root is ${ROOT}; check each coverage shard's capture.`,
      }],
    })
  }

  const auditExit = runNpm(["run", "audit:nerves", "--", "--run-dir", runDir, "--output", nervesCoveragePath])
  const nervesReport = existsSync(nervesCoveragePath) ? JSON.parse(readFileSync(nervesCoveragePath, "utf8")) : null

  const requiredActions = []
  const codeCoverageStatus = vitestExit === 0 ? "pass" : "fail"
  if (codeCoverageStatus === "fail") {
    requiredActions.push({ type: "coverage", target: "code-coverage", reason: "vitest coverage gate failed" })
  }
  const nervesStatus = nervesReport?.overall_status === "pass" && auditExit === 0 ? "pass" : "fail"
  if (Array.isArray(nervesReport?.required_actions)) {
    requiredActions.push(...nervesReport.required_actions)
  } else if (nervesStatus === "fail") {
    requiredActions.push({ type: "logging", target: "nerves-audit", reason: "nerves audit did not produce a valid report" })
  }
  const overallStatus = codeCoverageStatus === "pass" && nervesStatus === "pass" ? "pass" : "fail"
  writeJson(summaryPath, {
    overall_status: overallStatus,
    lint: { status: "pass" },
    mailbox_ui_typecheck: { status: "pass" },
    mailbox_ui_tests: { status: "pass" },
    code_coverage: { status: codeCoverageStatus },
    nerves_coverage: nervesReport?.nerves_coverage ?? { status: nervesStatus },
    required_actions: requiredActions,
  })
  console.log(`coverage gate: ${overallStatus} (${summaryPath})`)
  process.exit(overallStatus === "pass" ? 0 : 1)
}

// Covered/total counts, so a sharded run can be compared with a single-runner one.
function printCoverageTotals() {
  const summaryPath = path.join("coverage", "coverage-summary.json")
  if (!existsSync(summaryPath)) return
  const { total } = JSON.parse(readFileSync(summaryPath, "utf8"))
  for (const key of ["lines", "statements", "functions", "branches"]) {
    console.log(`merged coverage ${key}: ${total[key].covered}/${total[key].total} (${total[key].pct}%)`)
  }
}

if (require.main === module) {
  const [command, ...argv] = process.argv.slice(2)
  if (command === "shard") shard(argv)
  else if (command === "merge") merge(argv)
  else {
    console.error("usage: coverage-gate-sharded.cjs shard --index i --count N --out DIR | merge --shards DIR --count N")
    process.exit(2)
  }
}
