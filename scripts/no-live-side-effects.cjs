#!/usr/bin/env node
"use strict"

const fs = require("node:fs")

const RULES = [
  { name: "BlueBubbles send", pattern: /\b(?:sendBlueBubbles|sendMessage)\s*\(/ },
  { name: "AislePlanner live fetch", pattern: /\b(?:fetchAislePlannerLive|fetchAislePlanner)\s*\(/ },
  { name: "vault writes", pattern: /\b(?:writeVaultItem|upsertRuntimeCredentialConfig|mergeRuntimeCredentialConfig)\s*\(/ },
  { name: "launchctl mutation", pattern: /\blaunchctl\b|\bspawnSync\s*\(\s*["']launchctl["']/ },
  { name: "daemon restart", pattern: /\b(?:restartDaemon|startDaemonProcess)\s*\(/ },
  { name: "legacy RSVP save_snapshot", pattern: /\b(?:save_snapshot|saveSnapshot)\s*\(/ },
  { name: "legacy RSVP write_sent_state", pattern: /\b(?:write_sent_state|writeSentState)\s*\(/ },
  { name: "legacy RSVP run_report_pipeline", pattern: /\b(?:run_report_pipeline|runReportPipeline)\s*\(/ },
]

function assertNoLiveSideEffects(input) {
  const files = Array.isArray(input && input.files) ? input.files : []
  for (const file of files) {
    const filePath = typeof file.path === "string" ? file.path : "<unknown>"
    const text = typeof file.text === "string" ? file.text : ""
    for (const rule of RULES) {
      if (rule.pattern.test(text)) {
        throw new Error(`${rule.name} is blocked in replay/shadow tests: ${filePath}`)
      }
    }
  }
  return { ok: true, checked: files.length }
}

function main(argv) {
  const files = argv.map((filePath) => ({
    path: filePath,
    text: fs.readFileSync(filePath, "utf-8"),
  }))
  assertNoLiveSideEffects({ files })
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

module.exports = { assertNoLiveSideEffects }
