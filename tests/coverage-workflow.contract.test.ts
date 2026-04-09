import { readFileSync } from "fs"
import { join } from "path"

import { describe, expect, it } from "vitest"

describe("coverage workflow contract", () => {
  it("uploads run artifacts from the temp-run root and tolerates fast-fail skips", () => {
    const workflow = readFileSync(
      join(process.cwd(), ".github", "workflows", "coverage.yml"),
      "utf8",
    )

    expect(workflow).toContain("Resolve Coverage Artifact Root")
    expect(workflow).toContain("join(tmpdir(), 'ouroboros-test-runs', 'ouroboros-agent-harness')")
    expect(workflow).toContain("path: ${{ env.COVERAGE_ARTIFACT_ROOT }}")
    expect(workflow).toContain("if-no-files-found: ignore")
    expect(workflow).not.toContain("${{ env.HOME }}/.agentstate/test-runs/ouroboros-agent-harness")
  })
})
