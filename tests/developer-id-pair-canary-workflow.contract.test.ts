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

const workflowPathValue = ".github/workflows/developer-id-pair-canary.yml"

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
    const { normalizeWorkflowPath, verifyOidcWorkflowRef } = await loadReconciliation()

    expect(normalizeWorkflowPath(".github/workflows/developer-id-pair-canary.yml")).toBe(
      ".github/workflows/developer-id-pair-canary.yml",
    )
    expect(normalizeWorkflowPath(".github/workflows/developer-id-pair-canary.yml@main")).toBe(
      ".github/workflows/developer-id-pair-canary.yml",
    )
    expect(() => normalizeWorkflowPath("@feature")).toThrow(/workflow path/i)
    expect(() => normalizeWorkflowPath(".github/workflows/x.yml@refs\/heads\/main")).toThrow(/@main/i)
    expect(verifyOidcWorkflowRef({
      claim: `ourostack/ouroboros/${workflowPathValue}@refs/heads/main`,
      repository: "ourostack/ouroboros",
      workflowPath: workflowPathValue,
      ref: "refs/heads/main",
    })).toEqual({ ok: true })
    expect(verifyOidcWorkflowRef({
      claim: `ourostack/ouroboros/${workflowPathValue}@main`,
      repository: "ourostack/ouroboros",
      workflowPath: workflowPathValue,
      ref: "refs/heads/main",
    })).toMatchObject({ ok: false, code: "workflow_ref_mismatch" })
  })

  it("binds the exact dispatch wire bytes before POST", async () => {
    const { buildDispatchIntent } = await loadReconciliation()
    const requestBytes = '{"canaryId":"canary-7","schemaVersion":1}'
    const authorityBytes = '{"dispatchCorrelationId":"attempt-7","schemaVersion":1}'
    const bodyBytes = '{"inputs":{"dispatchCorrelationId":"attempt-7"},"ref":"main"}'

    const intent = buildDispatchIntent({
      repository: "ourostack/ouroboros",
      workflowId: 123456,
      apiVersion: "2026-03-10",
      requestBytes,
      authorityBytes,
      bodyBytes,
    })

    expect(intent).toEqual({
      method: "POST",
      url: "https://api.github.com/repos/ourostack/ouroboros/actions/workflows/123456/dispatches",
      headers: {
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2026-03-10",
      },
      requestBytes,
      requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      authorityBytes,
      authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      bodyBytes,
      bodySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      postAllowed: true,
    })
    expect(intent.requestSha256).not.toBe(intent.bodySha256)
  })

  it("preserves exact pagination bytes and enforces the literal 1,000-result ceiling", async () => {
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

    const unique = scanWorkflowRuns({ pages, correlationTitle: "canary:attempt-7" })
    expect(unique).toMatchObject({
      state: "unique",
      runId: 11,
      observedTotal: 2,
      pages: [
        {
          requestBytes: pages[0].requestBytes,
          responseBytes: pages[0].responseBytes,
          linkBytes: pages[0].linkBytes,
          requestSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          responseSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          linkSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        expect.any(Object),
      ],
    })
    expect(scanWorkflowRuns({
      pages: [{
        requestBytes: pages[0].requestBytes,
        responseBytes: '{"total_count":1001,"workflow_runs":[]}',
        linkBytes: "",
      }],
      correlationTitle: "missing",
    })).toMatchObject({
      state: "ceiling_exceeded",
      ceiling: 1000,
      observedTotal: 1001,
    })
    expect(pages[0].linkBytes).toBe('<https://api.github.test/runs?page=2>; rel="next"')
  })

  it("never redispatches after an intent-persisted response loss", async () => {
    const { reconcileDispatch } = await loadReconciliation()
    const result = reconcileDispatch({
      state: "intent-persisted",
      intent: {
        requestBytes: "request-exact-bytes",
        requestSha256: "a".repeat(64),
        bodyBytes: "body-exact-bytes",
        bodySha256: "b".repeat(64),
      },
      responseObserved: false,
      scan: { state: "none" },
    })

    expect(result).toEqual({
      state: "dispatch-outcome-unknown",
      intent: expect.objectContaining({ bodyBytes: "body-exact-bytes" }),
      postAllowed: false,
    })
  })

  it("supersedes only a uniquely bound terminal run with two closed empty artifact scans", async () => {
    const { authorizeTerminalSupersession } = await loadReconciliation()
    const valid = {
      uniqueRunBinding: { runId: 11, runAttempt: 1 },
      terminalInspection: { runId: 11, runAttempt: 1, conclusion: "failure" },
      artifactInventory: {
        scans: [
          { complete: true, artifactSetSha256: "c".repeat(64), validCompleteArtifactIds: [] },
          { complete: true, artifactSetSha256: "c".repeat(64), validCompleteArtifactIds: [] },
        ],
        expiredUnavailableArtifactIds: [],
      },
    }

    expect(authorizeTerminalSupersession(valid)).toEqual({ ok: true })
    expect(authorizeTerminalSupersession({
      ...valid,
      artifactInventory: {
        ...valid.artifactInventory,
        scans: [valid.artifactInventory.scans[0], {
          ...valid.artifactInventory.scans[1],
          validCompleteArtifactIds: [81],
        }],
      },
    })).toMatchObject({ ok: false, code: "valid_artifact_exists" })
    expect(authorizeTerminalSupersession({
      ...valid,
      uniqueRunBinding: null,
    })).toMatchObject({ ok: false, code: "unique_run_required" })
  })
})
