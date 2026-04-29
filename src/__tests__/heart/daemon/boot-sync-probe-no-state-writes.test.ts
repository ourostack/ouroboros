/**
 * Layer 2 — Unit 7: meta-test enforcing the no-state-writes invariant.
 *
 * The boot sync probe and its primitives (sync-classification.ts and
 * timeouts.ts) MUST NOT write to `state/` (gitignored, per-machine).
 * The probe is purely a read-and-classify path; writing state from here
 * would create cross-machine drift (the gitignored file persists, the
 * probe re-fires next boot, etc).
 *
 * This test scans the source files for filesystem-write API calls and
 * fails if any are present. It's a meta-test — it doesn't exercise
 * runtime behaviour. It catches accidental regressions where someone
 * adds a `writePendingSync` or similar call to the new code paths.
 */
import { readFileSync } from "fs"
import { describe, expect, it } from "vitest"
import { join } from "path"

const REPO_ROOT = join(__dirname, "..", "..", "..", "..")

const FILES_UNDER_GUARD = [
  "src/heart/sync-classification.ts",
  "src/heart/timeouts.ts",
  "src/heart/daemon/boot-sync-probe.ts",
]

// `state/` references — file-system writes targeting the gitignored
// per-machine state directory.
const STATE_PATH_RE = /["']state\//

// Filesystem write APIs — any of these in the new files is a regression.
const WRITE_API_RE =
  /\b(writeFileSync|writeFile\b|appendFileSync|appendFile\b|mkdirSync|renameSync|unlinkSync|rmSync|rmdirSync|chmodSync|symlinkSync|copyFileSync)\b/

describe("Unit 7: boot sync probe must not write to state/", () => {
  for (const relPath of FILES_UNDER_GUARD) {
    it(`${relPath} contains no state/ path string literals`, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf-8")
      const lines = source.split("\n")
      const offending = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => STATE_PATH_RE.test(line))
        // Allow doc comments that explicitly reference state/ as forbidden.
        .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      expect(offending).toEqual([])
    })

    it(`${relPath} uses no filesystem write APIs`, () => {
      const source = readFileSync(join(REPO_ROOT, relPath), "utf-8")
      const lines = source.split("\n")
      const offending = lines
        .map((line, idx) => ({ line, idx }))
        .filter(({ line }) => WRITE_API_RE.test(line))
        // Allow comment lines that explicitly mention these APIs as forbidden.
        .filter(({ line }) => !line.trim().startsWith("*") && !line.trim().startsWith("//"))
      expect(offending).toEqual([])
    })
  }
})
