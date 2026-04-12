import { mkdirSync, writeFileSync } from "fs"
import { dirname, join, resolve } from "path"

import { auditNervesCoverage } from "./audit"
import { readLatestRun } from "./run-artifacts"

interface CliArgs {
  runDir?: string
  eventsPath?: string
  perTestPath?: string
  sourceRoot?: string
  output?: string
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    const next = argv[i + 1]
    if (!next) continue
    if (token === "--run-dir") args.runDir = next
    if (token === "--events-path") args.eventsPath = next
    if (token === "--per-test-path") args.perTestPath = next
    if (token === "--source-root") args.sourceRoot = next
    if (token === "--output") args.output = next
  }
  return args
}

export function runAuditCli(argv: string[]): number {
  const args = parseArgs(argv)
  const latestRun = readLatestRun()
  const runDir = args.runDir ?? latestRun?.run_dir

  if (!runDir) {
    // eslint-disable-next-line no-console -- meta-tooling: audit error message
    console.error("nerves audit: no run directory found; provide --run-dir")
    return 2
  }

  const eventsPath = args.eventsPath ?? join(runDir, "vitest-events.ndjson")
  const perTestPath = args.perTestPath ?? join(runDir, "vitest-events-per-test.ndjson")
  const sourceRoot = args.sourceRoot ?? resolve("src")
  const outputPath = args.output ?? join(runDir, "nerves-coverage.json")

  const report = auditNervesCoverage({
    eventsPath,
    perTestPath,
    sourceRoot,
  })

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, JSON.stringify(report, null, 2), "utf8")
  // eslint-disable-next-line no-console -- meta-tooling: audit result message
  console.log(`nerves audit: ${report.overall_status} (${outputPath})`)

  return report.overall_status === "pass" ? 0 : 1
}
