// Each program that filters its failure's code line (failure-code.ts) keeps a fixed CARD_CODES list. That list must
// be exactly the codes its cards in ENTRY_POINT_COMMANDS name, or a code would print without a card, or a card would
// name a code that never prints.
import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { ENTRY_POINT_COMMANDS } from "../../../../heart/daemon/cli-commands/entry-points"

const PROGRAMS: Record<string, string> = {
  "src/heart/daemon/container-healthcheck.ts": "node dist/heart/daemon/container-healthcheck.js",
  "src/heart/daemon/sanctuary-authority-root-lifecycle.ts": "node dist/heart/daemon/sanctuary-authority-root-lifecycle.js",
  "src/heart/daemon/sanctuary-host-supervisor-entry.ts": "node dist/heart/daemon/sanctuary-host-supervisor-entry.js",
  "src/heart/daemon/sanctuary-telegram-authority-entry.ts": "node dist/heart/daemon/sanctuary-telegram-authority-entry.js",
  "src/heart/daemon/sanctuary-telegram-test-driver-entry.ts": "node dist/heart/daemon/sanctuary-telegram-test-driver-entry.js",
  "src/mailroom/entry.ts": "node dist/mailroom/entry.js",
  // The probe's own file raises only its steps' usage; the entry file raises missing-mode itself, with no filter.
  "src/senses/sanctuary-health-acceptance-probe.ts": "node dist/senses/sanctuary-health-acceptance-probe-entry.js ",
}

function cardCodes(program: string): string[] {
  const doors = ENTRY_POINT_COMMANDS.filter((d) => program.endsWith(" ") ? d.name.startsWith(program) : d.name === program || d.name.startsWith(`${program} `))
  expect(doors.length).toBeGreaterThan(0)
  return [...new Set(doors.flatMap((d) => d.ax!.errors.map((e) => e.code)))].sort()
}

function listed(file: string): string[] {
  const source = fs.readFileSync(path.resolve(file), "utf8")
  const match = /^const CARD_CODES = \[([^\]]*)\]$/mu.exec(source)
  expect(match, `${file} declares CARD_CODES`).not.toBeNull()
  return [...match![1]!.matchAll(/"([^"]+)"/gu)].map((m) => m[1]!).sort()
}

describe("entry point CARD_CODES", () => {
  it.each(Object.entries(PROGRAMS))("%s filters by exactly its cards' codes", (file, program) => {
    expect(listed(file)).toEqual(cardCodes(program))
  })
})
