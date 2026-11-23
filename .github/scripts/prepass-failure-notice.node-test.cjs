const assert = require("node:assert/strict")
const { mkdtempSync, readFileSync, writeFileSync } = require("node:fs")
const { tmpdir } = require("node:os")
const { join } = require("node:path")
const { test } = require("node:test")
const { buildNotice, main } = require("./prepass-failure-notice.cjs")

const preflightLog = [
  "lockfile versions aligned (0.1.0-alpha.1204)",
  "release preflight: FAIL",
  "add a change note for src/a.ts: a new file changes/<short-name>.md saying what changed for the people who use it, one paragraph or bullet per change.",
].join("\n")

test("a missing change note is named with its fix and says the cancels are a result", () => {
  const { annotation, summary } = buildNotice({ step: "Release preflight", log: preflightLog })
  assert.match(annotation, /^::error title=Release preflight failed, so the shards were cancelled::/)
  assert.match(annotation, /add a change note for src\/a\.ts/)
  assert.match(annotation, /Fix: add a new file changes\/<short-name>\.md/)
  assert.doesNotMatch(annotation, /release:bump/)
  assert.match(annotation, /not the cause/)
  assert.match(summary, /^## Release preflight failed/)
})

test("a leftover version bump is named with the drop-bump fix", () => {
  const log = "release preflight: FAIL\npackage.json's version moved from 0.1.0-alpha.1 to 0.1.0-alpha.2, but the release job on main sets the version"
  const { annotation } = buildNotice({ step: "Release preflight", log })
  assert.match(annotation, /Fix: run `npm run release:drop-bump`, then `git push`/)
})

test("another failure keeps its own reason and offers no bump hint; empty output says so", () => {
  const other = buildNotice({ step: "Pre-pass", log: "prepass: pass lint\nprepass: FAIL tsc\nsrc/x.ts(1,1): error TS2322" })
  assert.match(other.annotation, /error TS2322/)
  assert.doesNotMatch(other.annotation, /release:|changes\//)
  assert.match(buildNotice({ step: "Pre-pass", log: "a\nb\nc\nd" }).annotation, /b; c; d/)
  assert.match(buildNotice({ step: "Pre-pass", log: "" }).annotation, /no output was captured/)
})

test("main reads the step log, prints the annotation and appends the summary", () => {
  const dir = mkdtempSync(join(tmpdir(), "notice-"))
  const log = join(dir, "step.log")
  const summary = join(dir, "summary.md")
  writeFileSync(log, preflightLog)
  let out = ""
  main({ PREPASS_LOG: log, FAILED_STEP: "Release preflight", GITHUB_STEP_SUMMARY: summary }, (text) => { out += text })
  assert.match(out, /^::error /)
  assert.match(readFileSync(summary, "utf8"), /Release preflight failed/)
  let bare = ""
  main({}, (text) => { bare += text })
  assert.match(bare, /pre-pass failed/)
})
