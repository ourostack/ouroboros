const { appendFileSync, existsSync, readFileSync } = require("node:fs")

const BUMP_HINT = "run `npm run release:bump -- --version <next> --change \"<what changed>\"` (it bumps every version file and the changelog)"

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
  const needsBump = /changelog|version/i.test(detail)
  const hint = needsBump ? ` Fix: ${BUMP_HINT}.` : ""
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
