/**
 * `node dist/eval/interview-grade-entry.js --preregistration <file> --report <file> --request-log <file> [--reduced]`
 * (`--report` and `--request-log` repeat, one pair per run): grades the blind interviews from the runner's private
 * reports and request logs (see `interviews/grader.ts`) and prints the counts-only result. It calls no model.
 */
import fs from "node:fs"
import { emitNervesEvent } from "../nerves/runtime"
import { readAllocation, reducedDesign } from "./interviews/allocation"
import { formatGrade, gradeStudy, readRequestLog, sessionsOf } from "./interviews/grader"
import type { SessionRecord } from "./interviews/runner"

function main(): void {
  const argv = process.argv.slice(2)
  const values = (flag: string): string[] => argv.flatMap((word, i) => (word === flag && argv[i + 1] ? [argv[i + 1]!] : []))
  const [preregistration] = values("--preregistration")
  if (!preregistration) throw new Error("--preregistration is required")
  const reduced = argv.includes("--reduced")
  const { version, sessions: all } = readAllocation(fs.readFileSync(preregistration, "utf8"))
  const records = sessionsOf(version, values("--report").map((file) => JSON.parse(fs.readFileSync(file, "utf8")) as { preregistrationVersion?: number; sessions: SessionRecord[] }))
  const requests = values("--request-log").flatMap((file) => readRequestLog(fs.readFileSync(file, "utf8")))
  const grade = gradeStudy({ design: reduced ? reducedDesign(all) : all, records, requests, reduced })
  process.stdout.write(`${formatGrade(grade, reduced)}\n`)
}

try {
  main()
} catch (error) {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.interview_grade_error", message: "the interview grader failed", meta: { error: String(error) } })
  process.stderr.write(`grade: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
