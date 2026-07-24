import * as fs from "fs"
import * as path from "path"
import { createRequire } from "module"

import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const { inspectPersonalWorkflowOwnership } = require("../../../../scripts/personal-workflow-ownership.cjs") as {
  inspectPersonalWorkflowOwnership(root: string, manifest: unknown): {
    ok: boolean
    violations: Array<{ code: string; path: string; detail: string }>
  }
}

const root = path.resolve(__dirname, "../../../..")
const manifestPath = path.join(root, "tests", "fixtures", "personal-workflow-surface-ownership.v1.json")

describe("personal workflow structural ownership", () => {
  it("uses the frozen protected baseline tree and one disposition per discovered path", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      schemaVersion: number
      baseCommit: string
      baseTree: string
      entries: Array<{ path: string; disposition: string; target?: string }>
    }
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      baseCommit: "41f4e66085107a6f6a5fb249f318ead50a1f622c",
      baseTree: "beb96dc921cf39e1250c2ec43f54860e0029ed7b",
    })
    expect(new Set(manifest.entries.map((entry) => entry.path)).size).toBe(manifest.entries.length)
    expect(manifest.entries.every((entry) => ["delete", "relocate", "modify-shared", "retain-generic"].includes(entry.disposition))).toBe(true)
    expect(manifest.entries.filter((entry) => entry.disposition === "relocate").every((entry) => entry.target)).toBe(true)
  })

  it("requires exact deleted/relocated surfaces and exact import/registration fragments to stay absent", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    const result = inspectPersonalWorkflowOwnership(root, manifest)

    expect(result.violations).toEqual([])
    expect(result.ok).toBe(true)
  })

  it("does not impose a global wording ban on generic or personal fixtures", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"))
    const serialized = JSON.stringify(manifest)
    expect(serialized).not.toContain("forbiddenWords")
    expect(serialized).not.toContain("globalTextScan")
    expect(manifest.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "src/senses/bluebubbles", disposition: "retain-generic" }),
      expect.objectContaining({ path: "src/__tests__/senses/bluebubbles", disposition: "retain-generic" }),
    ]))
  })
})
