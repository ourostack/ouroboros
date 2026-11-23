const { appendFileSync, existsSync, readFileSync } = require("node:fs")

// Pull requests carry a change note, never a version: the release job on main sets the version and changelog.
const NOTE_HINT = "add a new file changes/<short-name>.md saying what changed for the people who use it, one paragraph per change"
const DROP_BUMP_HINT = "run `npm run release:drop-bump`, then `git push` (it moves an old-style bump's changelog lines into a change note and merges main)"

function hintFor(detail) {
  if (/release:drop-bump|version moved|changelog\.json gains/i.test(detail)) return DROP_BUMP_HINT
  if (/change note/i.test(detail)) return NOTE_HINT
  return ""
}

// The lines that follow the last "FAIL" line of a step's output are its reasons; with no FAIL line, the last few lines are.
function reasonsFrom(log) {
  const lines = log.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const marker = lines.map((line) => /\bFAIL\b/.test(line)).lastIndexOf(true)
  const after = marker === -1 ? [] : lines.slice(marker + 1)
  return after.length > 0 ? after : lines.slice(-3)
}

function buildNotice({ step, log }) {
  const reasons = reasonsFrom(log)
  const detail = reasons.length > 0 ? reasons.join("; ") : "no output was captured; open the step's log"
  const fix = hintFor(detail)
  const hint = fix ? ` Fix: ${fix}.` : ""
  const message = `${step} failed: ${detail}.${hint} The cancelled checks below were stopped because of this failure; they are not the cause.`
  return {
    annotation: `::error title=${step} failed, so the shards were cancelled::${message}`,
    summary: `## ${step} failed\n\n${message}\n`,
  }
}

function main(env, write) {
  const file = env.PREPASS_LOG
  const log = file && existsSync(file) ? readFileSync(file, "utf8") : ""
  const notice = buildNotice({ step: env.FAILED_STEP || "pre-pass", log })
  write(`${notice.annotation}\n`)
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, notice.summary)
  return notice
}

module.exports = { buildNotice, reasonsFrom, main }
/* node:coverage ignore next */
if (require.main === module) main(process.env, (text) => process.stdout.write(text))
