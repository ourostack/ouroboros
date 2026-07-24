import { execFileSync } from "child_process"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
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

function loadWorkflow(): any {
  const source = readFileSync(workflowPath, "utf8")
  return JSON.parse(execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-e",
    "document = YAML.safe_load(STDIN.read, aliases: true); STDOUT.write(JSON.generate(document))",
  ], { input: source, encoding: "utf8" }))
}

describe("Developer ID pair canary workflow contract", () => {
  it("is a no-environment OIDC workflow with inert secret access", () => {
    const workflow = loadWorkflow()
    const jobs = workflow.jobs

    expect(workflow.name).toBe("developer-id-pair-canary")
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(jobs)).toEqual(["canary"])
    expect(jobs.canary["runs-on"]).toBe("macos-26")
    expect(jobs.canary.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    })
    expect(workflow.environment).toBeUndefined()
    expect(jobs.canary.environment).toBeUndefined()
    expect(jobs.canary.steps.every((step: any) => step.if === undefined)).toBe(true)

    const actionSteps = jobs.canary.steps.filter((step: any) => step.uses)
    expect(actionSteps.length).toBeGreaterThan(0)
    expect(actionSteps.every((step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses))).toBe(true)
    const secretSteps = jobs.canary.steps.filter((step: any) => JSON.stringify(step).includes("${{ secrets."))
    expect(secretSteps).toHaveLength(1)
    expect(secretSteps[0].env).toEqual({
      OURO_DRIVER_FIELD_1: "${{ secrets.OURO_DEVELOPER_ID_P12_B64 }}",
      OURO_DRIVER_FIELD_2: "${{ secrets.OURO_DEVELOPER_ID_P12_PASSWORD }}",
      OURO_DRIVER_FIELD_3: "${{ vars.OURO_DEVELOPER_ID_TEAM_ID }}",
      OURO_DRIVER_FIELD_4: "${{ vars.OURO_DEVELOPER_ID_APPLICATION_CN }}",
    })
    expect(secretSteps[0].run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs frame-native native/developer-id-pair-canary/driver 4",
    )
    expect(secretSteps[0].run).not.toContain("${{")

    const secretStepIndex = jobs.canary.steps.indexOf(secretSteps[0])
    const admissionStep = jobs.canary.steps.find(
      (step: any) => step.name === "Admit exact protected-main canary authority",
    )
    expect(admissionStep).toBeDefined()
    expect(jobs.canary.steps.indexOf(admissionStep)).toBeLessThan(secretStepIndex)
    expect(admissionStep.run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs admit-secret-workflow pair-canary",
    )
    expect(admissionStep.run).not.toContain("${{")
    expect(jobs.canary.steps.filter((step: any) => step.run).every(
      (step: any) => !step.run.includes("${{ inputs."),
    )).toBe(true)

    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("release-trust-inception-head")
    expect(serialized).not.toContain("npm publish")
    expect(serialized).not.toContain("security import")
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
    expect(() => normalizeWorkflowPath(".github/workflows/")).toThrow(/workflow path/i)
    expect(() => normalizeWorkflowPath(".github/workflows/x.yml@refs\/heads\/main")).toThrow(/@main/i)
    expect(() => normalizeWorkflowPath(".github/workflows/x.yml@feature")).toThrow(/@main/i)
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
    for (const invalid of [
      { repository: "missing-slash" },
      { workflowId: 0 },
      { apiVersion: "latest" },
      { requestBytes: null },
    ]) {
      expect(() => buildDispatchIntent({
        repository: "ourostack/ouroboros",
        workflowId: 123456,
        apiVersion: "2026-03-10",
        requestBytes,
        authorityBytes,
        bodyBytes,
        ...invalid,
      })).toThrow(/invalid workflow dispatch authority/i)
    }
  })

  it("preserves exact pagination bytes and enforces the literal 1,000-result ceiling", async () => {
    const { scanWorkflowRuns } = await loadReconciliation()
    const headSha = "f".repeat(40)
    const exactRun = (overrides: Record<string, unknown> = {}) => ({
      id: 11,
      run_attempt: 1,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: headSha,
      workflow_id: 123456,
      path: `${workflowPathValue}@main`,
      display_title: "canary:attempt-7",
      created_at: "2026-07-23T20:05:00Z",
      ...overrides,
    })
    const pages = [
      {
        requestBytes: "GET /actions/runs?per_page=100&page=1 HTTP/1.1\r\n\r\n",
        responseBytes: JSON.stringify({ total_count: 2, workflow_runs: [exactRun()] }),
        linkBytes: '<https://api.github.test/runs?page=2>; rel="next"',
      },
      {
        requestBytes: "GET /actions/runs?per_page=100&page=2 HTTP/1.1\r\n\r\n",
        responseBytes: JSON.stringify({
          total_count: 2,
          workflow_runs: [exactRun({ id: 12, display_title: "other" })],
        }),
        linkBytes: "",
      },
    ]
    const scan = (candidatePages: any[], correlationTitle = "canary:attempt-7") => scanWorkflowRuns({
      pages: candidatePages,
      correlationTitle,
      workflowId: 123456,
      workflowPath: workflowPathValue,
      headSha,
      inclusiveWindow: {
        createdAtOrAfter: "2026-07-23T20:00:00Z",
        createdAtOrBefore: "2026-07-23T20:10:00Z",
      },
    })

    const unique = scan(pages)
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
    expect(scan([{
        requestBytes: pages[0].requestBytes,
        responseBytes: '{"total_count":1001,"workflow_runs":[]}',
        linkBytes: "",
      }], "missing")).toMatchObject({
      state: "ceiling_exceeded",
      ceiling: 1000,
      observedTotal: 1001,
    })
    expect(pages[0].linkBytes).toBe('<https://api.github.test/runs?page=2>; rel="next"')
    expect(scan(pages, "other")).toMatchObject({
      state: "unique",
      runId: 12,
    })
    expect(scan(pages, "missing")).toMatchObject({ state: "none" })
    expect(scan([{
        requestBytes: "request",
        responseBytes: JSON.stringify({
          total_count: 2,
          workflow_runs: [exactRun({ id: 1, display_title: "same" }), exactRun({ id: 2, display_title: "same" })],
        }),
        linkBytes: "",
      }], "same")).toMatchObject({ state: "multiple" })
    for (const impostor of [
      exactRun({ workflow_id: 999 }),
      exactRun({ path: ".github/workflows/other.yml" }),
      exactRun({ event: "push" }),
      exactRun({ head_branch: "feature" }),
      exactRun({ head_sha: "0".repeat(40) }),
      exactRun({ run_attempt: 2 }),
      exactRun({ created_at: "2026-07-23T19:59:59Z" }),
      exactRun({ created_at: "2026-07-23T20:10:01Z" }),
    ]) {
      expect(scan([{
        requestBytes: "request",
        responseBytes: JSON.stringify({ total_count: 1, workflow_runs: [impostor] }),
        linkBytes: "",
      }])).toMatchObject({ state: "none" })
    }
    for (const incompletePages of [
      [],
      [{ requestBytes: null, responseBytes: "{}", linkBytes: "" }],
      [{ requestBytes: "request", responseBytes: "not-json", linkBytes: "" }],
      [{ requestBytes: "request", responseBytes: '{"total_count":-1,"workflow_runs":[]}', linkBytes: "" }],
      [{ requestBytes: "request", responseBytes: '{"total_count":1,"workflow_runs":[]}', linkBytes: "" }],
      [{ requestBytes: "request", responseBytes: '{"total_count":0,"workflow_runs":[]}', linkBytes: "next" }],
      [
        { requestBytes: "one", responseBytes: '{"total_count":1,"workflow_runs":[]}', linkBytes: "next" },
        { requestBytes: "two", responseBytes: '{"total_count":0,"workflow_runs":[]}', linkBytes: "" },
      ],
    ]) {
      expect(scan(incompletePages, "missing")).toMatchObject({
        state: "incomplete",
      })
    }
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
    expect(() => reconcileDispatch({ state: "new" })).toThrow(/persisted dispatch intent/i)
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
    expect(authorizeTerminalSupersession({
      ...valid,
      terminalInspection: { ...valid.terminalInspection, conclusion: "success" },
    })).toMatchObject({ ok: false, code: "terminal_run_required" })
    expect(authorizeTerminalSupersession({
      ...valid,
      artifactInventory: { ...valid.artifactInventory, scans: [valid.artifactInventory.scans[0]] },
    })).toMatchObject({ ok: false, code: "artifact_inventory_incomplete" })
    expect(authorizeTerminalSupersession({
      ...valid,
      artifactInventory: { ...valid.artifactInventory, expiredUnavailableArtifactIds: [99] },
    })).toMatchObject({ ok: false, code: "artifact_inventory_ambiguous" })
  })

  it("frames native fields once, clears the parent values, and fails closed", async () => {
    const { frameFields, runNativeFrame } = await loadReconciliation()
    const environment: Record<string, string> = {
      OURO_DRIVER_FIELD_1: "one",
      OURO_DRIVER_FIELD_2: "two",
    }
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    expect(runNativeFrame("/usr/bin/true", 2, environment, {
      stdout: { write: (value: Buffer) => stdout.push(value) },
      stderr: { write: (value: Buffer) => stderr.push(value) },
    })).toBe(0)
    expect(environment).toEqual({})
    expect(Buffer.concat(stdout)).toHaveLength(0)
    expect(Buffer.concat(stderr)).toHaveLength(0)
    expect(() => runNativeFrame("/usr/bin/true", 0, {}, {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    })).toThrow(/field count/i)
    expect(() => runNativeFrame("/usr/bin/true", 1, {}, {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    })).toThrow(/missing OURO_DRIVER_FIELD_1/i)
    expect(() => frameFields([Buffer.alloc(1048577)])).toThrow(/byte ceiling/i)
    expect(() => runNativeFrame("/definitely/missing", 1, { OURO_DRIVER_FIELD_1: "one" }, {
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    })).toThrow()
    const directory = mkdtempSync(join(tmpdir(), "ouro-signal-driver-"))
    const signaledDriver = join(directory, "driver")
    try {
      writeFileSync(signaledDriver, "#!/bin/sh\nkill -TERM $$\n", { mode: 0o700 })
      chmodSync(signaledDriver, 0o700)
      expect(runNativeFrame(signaledDriver, 1, { OURO_DRIVER_FIELD_1: "one" }, {
        stdout: { write: () => undefined },
        stderr: { write: () => undefined },
      })).toBe(70)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
