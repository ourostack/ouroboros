import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import { join } from "path"

import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()
const workflowPath = join(repoRoot, ".github", "workflows", "developer-id-pair-canary.yml")

async function loadReconciliation() {
  return import(pathToFileURL(join(
    repoRoot,
    ".github",
    "actions",
    "release-trust",
    "run-reconciliation.mjs",
  )).href)
}

describe("Developer ID pair canary workflow contract", () => {
  it("is a no-environment OIDC workflow with inert secret access", () => {
    const workflow = readFileSync(workflowPath, "utf8")

    expect(workflow).toContain("name: developer-id-pair-canary")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("contents: read")
    expect(workflow).not.toMatch(/^\s*environment:/m)
    expect(workflow).not.toContain("npm publish")
    expect(workflow).not.toContain("security import")
    expect(workflow).not.toContain("security add-generic-password")
    expect(workflow).toContain("release-trust-inception-head")
  })

  it("normalizes only bare workflow paths and literal @main suffixes", async () => {
    const { normalizeWorkflowPath } = await loadReconciliation()

    expect(normalizeWorkflowPath(".github/workflows/developer-id-pair-canary.yml")).toBe(
      ".github/workflows/developer-id-pair-canary.yml",
    )
    expect(normalizeWorkflowPath(".github/workflows/developer-id-pair-canary.yml@main")).toBe(
      ".github/workflows/developer-id-pair-canary.yml",
    )
    expect(() => normalizeWorkflowPath("@feature")).toThrow(/workflow path/i)
    expect(() => normalizeWorkflowPath(".github/workflows/x.yml@refs\/heads\/main")).toThrow(/@main/i)
  })

  it("preserves exact pagination bytes and enforces the 1,000-result ceiling", async () => {
    const { scanWorkflowRuns } = await loadReconciliation()
    const pages = [
      {
        requestBytes: "GET /actions/runs?per_page=100&page=1 HTTP/1.1\r\n\r\n",
        responseBytes: '{"total_count":2,"workflow_runs":[{"id":11,"display_title":"canary:attempt-7"}]}',
        linkBytes: '<https://api.github.test/runs?page=2>; rel="next"',
      },
      {
        requestBytes: "GET /actions/runs?per_page=100&page=2 HTTP/1.1\r\n\r\n",
        responseBytes: '{"total_count":2,"workflow_runs":[{"id":12,"display_title":"other"}]}',
        linkBytes: "",
      },
    ]

    expect(scanWorkflowRuns({ pages, correlationTitle: "canary:attempt-7", ceiling: 1000 })).toMatchObject({
      state: "unique",
      runId: 11,
      observedTotal: 2,
    })
    expect(scanWorkflowRuns({ pages, correlationTitle: "missing", ceiling: 1 })).toMatchObject({
      state: "ceiling_exceeded",
    })
    expect(pages[0].linkBytes).toBe('<https://api.github.test/runs?page=2>; rel="next"')
  })

  it("never redispatches after an intent-persisted response loss", async () => {
    const { reconcileDispatch } = await loadReconciliation()
    const result = reconcileDispatch({
      state: "intent-persisted",
      requestSha256: "a".repeat(64),
      responseObserved: false,
      scan: { state: "none" },
    })

    expect(result).toEqual({ state: "dispatch-outcome-unknown", postAllowed: false })
  })
})
