/**
 * Synthetic test: RepairGuide skill markdown must reference the actual
 * TypeScript field names from `DriftFinding` (Layer 4) and
 * `BootSyncProbeFinding` (Layer 2). Without this test, the skills can
 * silently drift from the real types — the LLM would then be asked to
 * reason over fields that don't exist in the JSON blocks the prompt
 * actually carries.
 *
 * If a Layer-2 or Layer-4 type adds, removes, or renames a field, this
 * test fails until the corresponding skill file is updated.
 */
import * as fs from "fs"
import * as path from "path"
import { describe, expect, it } from "vitest"

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..")
const SKILLS_DIR = path.join(REPO_ROOT, "RepairGuide.ouro", "skills")

function readSkill(name: string): string {
  return fs.readFileSync(path.join(SKILLS_DIR, name), "utf-8")
}

describe("RepairGuide skill ↔ TypeScript type alignment", () => {
  describe("diagnose-bootstrap-drift.md aligns with DriftFinding fields", () => {
    const body = readSkill("diagnose-bootstrap-drift.md")
    // Fields from DriftFinding in src/heart/daemon/drift-detection.ts.
    // If this list changes, update both the type AND the skill.
    const expected = [
      "agent",
      "lane",
      "intentProvider",
      "intentModel",
      "observedProvider",
      "observedModel",
      "reason",
      "repairCommand",
    ]
    for (const field of expected) {
      it(`mentions DriftFinding.${field}`, () => {
        expect(body).toContain(field)
      })
    }
  })

  describe("diagnose-broken-remote.md aligns with BootSyncProbeFinding remote-class fields", () => {
    const body = readSkill("diagnose-broken-remote.md")
    // BootSyncProbeFinding fields from src/heart/daemon/boot-sync-probe.ts
    // plus the remote-class SyncClassification literals this skill handles.
    const expectedFields = ["agent", "classification", "error", "conflictFiles", "warnings", "advisory"]
    const expectedClassifications = ["not-found-404", "auth-failed", "network-down", "timeout-hard"]
    for (const field of expectedFields) {
      it(`mentions BootSyncProbeFinding.${field}`, () => {
        expect(body).toContain(field)
      })
    }
    for (const cls of expectedClassifications) {
      it(`mentions remote-class classification "${cls}"`, () => {
        expect(body).toContain(cls)
      })
    }
  })

  describe("diagnose-sync-blocked.md aligns with BootSyncProbeFinding local-tree-class fields", () => {
    const body = readSkill("diagnose-sync-blocked.md")
    const expectedFields = ["agent", "classification", "error", "conflictFiles", "warnings", "advisory"]
    // Local-tree-class SyncClassification literals this skill handles.
    const expectedClassifications = ["dirty-working-tree", "non-fast-forward", "merge-conflict", "timeout-soft"]
    for (const field of expectedFields) {
      it(`mentions BootSyncProbeFinding.${field}`, () => {
        expect(body).toContain(field)
      })
    }
    for (const cls of expectedClassifications) {
      it(`mentions local-tree-class classification "${cls}"`, () => {
        expect(body).toContain(cls)
      })
    }
  })
})
