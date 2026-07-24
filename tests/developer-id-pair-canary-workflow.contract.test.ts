import { execFileSync, spawnSync } from "child_process"
import { createHash } from "crypto"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { pathToFileURL } from "url"
import { join } from "path"
import { gunzipSync, gzipSync } from "zlib"

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
const reconciliationPath = join(
  repoRoot,
  ".github",
  "actions",
  "release-trust",
  "run-reconciliation.mjs",
)

function canonicalFixture(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalFixture(value[key])}`
  )).join(",")}}`
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

const acceptSyntheticSystemExecutables = () => ({ ok: true })

function createAdmissionFixture(kind: "pair-canary" | "signing") {
  const root = mkdtempSync(join(tmpdir(), `ouro-${kind}-admission-`))
  const write = (path: string, bytes: string | Buffer) => {
    const destination = join(root, path)
    mkdirSync(join(destination, ".."), { recursive: true })
    writeFileSync(destination, bytes)
  }
  const pair = kind === "pair-canary"
  const workflowPath = pair
    ? ".github/workflows/developer-id-pair-canary.yml"
    : ".github/workflows/developer-id-signing.yml"
  const driverPath = pair
    ? "native/developer-id-pair-canary/driver.c"
    : "native/developer-id-signing/driver.c"
  const closurePath = pair
    ? "release/trust/developer-id-pair-canary-execution-closure.v1.json"
    : "release/trust/developer-id-signing-execution-closure.v1.json"
  const policyPath = pair
    ? "release/trust/developer-id-pair-canary-trust-policy.v1.json"
    : "release/trust/release-trust-policy.v1.json"
  const workflowBytes = readFileSync(join(repoRoot, workflowPath), "utf8")
  const driverBytes = readFileSync(join(repoRoot, driverPath))
  const trustTcbPaths = [
    ".github/actions/release-trust/canonicalize.mjs",
    ".github/actions/release-trust/protected-store.mjs",
    ".github/actions/release-trust/run-reconciliation.mjs",
    ".github/actions/release-trust/workflow-closure.mjs",
    "package.json",
    "package-lock.json",
  ]
  const foundationBytes = readFileSync(
    join(repoRoot, "release", "trust", "sigstore-foundation.v1.json"),
    "utf8",
  )
  const policyBytes = canonicalFixture({ policyVersion: 1, schemaVersion: 1 })
  const bootstrapEvidenceBytes = canonicalFixture({
    content: { bootstrapMergeSha: "6".repeat(40), schemaVersion: 1 },
    schemaVersion: 1,
  })
  const closureBase: Record<string, unknown> = {
    allActionsPinnedByFullCommitSha: true,
    allContainersPinnedByDigest: true,
    allDownloadsHashVerifiedBeforeExecution: true,
    entries: [
      {
        commitSha: "d23441a48e516b6c34aea4fa41551a30e30af803",
        kind: "action",
        uses: "actions/checkout",
      },
      {
        commitSha: "249970729cb0ef3589644e2896645e5dc5ba9c38",
        kind: "action",
        uses: "actions/setup-node",
      },
      ...trustTcbPaths.map((path) => ({
        kind: "checked-out-file",
        path,
        role: pair ? "secret-driver-contract" : "signing-driver-contract",
        sha256: sha256(readFileSync(join(repoRoot, path))),
      })),
      {
        kind: "checked-out-file",
        path: driverPath,
        role: pair ? "secret-driver-source" : "signing-driver-source",
        sha256: sha256(driverBytes),
      },
      {
        designatedRequirementSha256: null,
        kind: "system-executable",
        realpath: "/usr/bin/clang",
        sha256: "1".repeat(64),
      },
      {
        designatedRequirementSha256: "3".repeat(64),
        kind: "system-executable",
        realpath: "/usr/local/bin/node",
        sha256: "2".repeat(64),
      },
      {
        designatedRequirementSha256: null,
        kind: "system-executable",
        realpath: "/usr/bin/xcrun",
        sha256: "4".repeat(64),
      },
    ].sort((left, right) => Buffer.compare(
      Buffer.from(`${left.kind}\0${"uses" in left ? left.uses : "path" in left ? left.path : left.realpath}`),
      Buffer.from(`${right.kind}\0${"uses" in right ? right.uses : "path" in right ? right.path : right.realpath}`),
    )),
    entriesUtf8ByteSortedByKindAndIdentity: true,
    noReusableWorkflowOrUndeclaredExecution: true,
    schemaVersion: 1,
    workflowBlobSha256: sha256(workflowBytes),
    workflowPath,
    [pair ? "secretDriverPath" : "signingDriverPath"]: driverPath,
    [pair ? "secretDriverSha256" : "signingDriverSha256"]: sha256(driverBytes),
  }
  const closureBytes = canonicalFixture({
    ...closureBase,
    closureSha256: sha256(canonicalFixture(closureBase)),
  })
  const initialPolicySha256 = pair ? "a".repeat(64) : sha256(policyBytes)
  const authority = {
    authorityKind: "one-time-protected-main-trust-inception-v1",
    bootstrapEvidenceSha256: sha256(bootstrapEvidenceBytes),
    bootstrapMergeSha: "6".repeat(40),
    initialPolicySha256,
    pairCanaryExecutionClosureSha256: pair ? sha256(closureBytes) : "b".repeat(64),
    pairCanaryFoundationSha256: sha256(foundationBytes),
    pairCanaryTrustPolicySha256: pair ? sha256(policyBytes) : "c".repeat(64),
    pairCanaryWorkflowBlobSha256: pair ? sha256(workflowBytes) : "d".repeat(64),
    repository: "ourostack/ouroboros",
    repositoryDatabaseId: 1169669354,
    repositoryNodeId: "R_kgDORbe86g",
    schemaVersion: 1,
    signingExecutionClosureSha256: pair ? "e".repeat(64) : sha256(closureBytes),
    signingWorkflowBlobSha256: pair ? "f".repeat(64) : sha256(workflowBytes),
  }
  const authorityBytes = canonicalFixture(authority)
  const headBytes = canonicalFixture({
    activation: { authoritySha256: sha256(authorityBytes), kind: "inception" },
    activePolicySha256: initialPolicySha256,
    activePolicyVersion: 1,
    priorHeadSha256: null,
    revision: 1,
    schemaVersion: 1,
  })
  write(workflowPath, workflowBytes)
  write(driverPath, driverBytes)
  for (const path of trustTcbPaths) write(path, readFileSync(join(repoRoot, path)))
  write(closurePath, closureBytes)
  write(policyPath, policyBytes)
  write("release/trust/sigstore-foundation.v1.json", foundationBytes)
  write("release/trust/release-trust-bootstrap-evidence.v1.json", bootstrapEvidenceBytes)
  write("release/trust/release-trust-inception-authority.v1.json", authorityBytes)
  write("release/trust/release-trust-policy-head.v1.json", headBytes)

  const correlation = `${kind}-attempt-7`
  const inputs: Record<string, string> = { dispatchCorrelationId: correlation }
  if (pair) {
    const nonceBase64 = "bm9uY2U="
    const commitmentNonceSha256 = sha256(Buffer.from(nonceBase64, "base64"))
    const commitmentBase = {
      attemptId: "attempt-7",
      nonceBase64,
      nonceSha256: commitmentNonceSha256,
      pairGenerationId: "generation-7",
      scheme: "sha256-jcs-one-time-nonce-v1",
      transactionId: "transaction-7",
    }
    const request = canonicalFixture({
      attemptId: commitmentBase.attemptId,
      canaryId: "canary-7",
      commitmentNonceBase64: nonceBase64,
      commitmentNonceSha256,
      p12SecretCommitment: {
        ...commitmentBase,
        digestBase64Url: "A".repeat(43),
        domain: "ouro-developer-id-p12-b64-v1",
      },
      pairGenerationId: commitmentBase.pairGenerationId,
      passwordSecretCommitment: {
        ...commitmentBase,
        digestBase64Url: "B".repeat(43),
        domain: "ouro-developer-id-p12-password-v1",
      },
      schemaVersion: 1,
      transactionId: commitmentBase.transactionId,
    })
    const dispatchAuthority = canonicalFixture({ dispatchCorrelationId: correlation, schemaVersion: 1 })
    inputs.requestBase64 = Buffer.from(request).toString("base64")
    inputs.requestSha256 = sha256(request)
    inputs.dispatchAuthorityBase64 = Buffer.from(dispatchAuthority).toString("base64")
    inputs.dispatchAuthoritySha256 = sha256(dispatchAuthority)
  } else {
    const nonceBase64 = "bm9uY2U="
    const commitmentNonceSha256 = sha256(Buffer.from(nonceBase64, "base64"))
    const commitmentBase = {
      attemptId: "attempt-7",
      nonceBase64,
      nonceSha256: commitmentNonceSha256,
      pairGenerationId: "generation-7",
      scheme: "sha256-jcs-one-time-nonce-v1",
      transactionId: "release-7",
    }
    const p12SecretCommitment = {
      ...commitmentBase,
      digestBase64Url: "A".repeat(43),
      domain: "ouro-developer-id-p12-b64-v1",
    }
    const passwordSecretCommitment = {
      ...commitmentBase,
      digestBase64Url: "B".repeat(43),
      domain: "ouro-developer-id-p12-password-v1",
    }
    const activePair = { pairGenerationId: "generation-7", schemaVersion: 1 }
    const provisioningReceipt = {
      identity: {
        applicationCommonName: "Developer ID Application: Test (TEAM123)",
        teamIdentifier: "TEAM123",
      },
      pairGenerationId: "generation-7",
      schemaVersion: 1,
    }
    const canaryVerification = {
      pairGenerationId: "generation-7",
      p12SecretCommitment,
      passwordSecretCommitment,
      schemaVersion: 1,
    }
    const variableReceipt = {
      pairGenerationId: "generation-7",
      schemaVersion: 1,
      variables: [
        { name: "OURO_DEVELOPER_ID_TEAM_ID", value: "TEAM123" },
        { name: "OURO_DEVELOPER_ID_APPLICATION_CN", value: "Developer ID Application: Test (TEAM123)" },
      ],
    }
    const m0Paths = [
      "developer-id-pair-active-authority.v1.json",
      "developer-id-pair-canary-artifact-acquisition.v1.json",
      "developer-id-pair-canary-dispatch-authority.v1.json",
      "developer-id-pair-canary-dispatch-intent.v1.json",
      "developer-id-pair-canary-dispatch-observation.v1.json",
      "developer-id-pair-canary-receipt-body.v1.json",
      "developer-id-pair-canary-receipt-body.v1.sigstore.json",
      "developer-id-pair-canary-request.v1.json",
      "developer-id-pair-canary-run-binding.v1.json",
      "developer-id-pair-canary-verification.v1.json",
      "developer-id-provisioning-p12-secret-submission-receipt.v1.json",
      "developer-id-provisioning-password-secret-submission-receipt.v1.json",
      "developer-id-provisioning-receipt.v1.json",
      "developer-id-provisioning-variable-submission-receipt.v1.json",
    ]
    const m0Values: Record<string, unknown> = {
      "developer-id-pair-active-authority.v1.json": activePair,
      "developer-id-pair-canary-verification.v1.json": canaryVerification,
      "developer-id-provisioning-receipt.v1.json": provisioningReceipt,
      "developer-id-provisioning-variable-submission-receipt.v1.json": variableReceipt,
    }
    const m0Content = canonicalFixture({
      files: m0Paths.map((path) => ({ path, value: m0Values[path] ?? { schemaVersion: 1 } })),
      schemaVersion: 1,
    })
    const m0 = gzipSync(Buffer.from(m0Content), { level: 9 })
    const handoff = canonicalFixture({
      activePair,
      canaryVerificationSha256: sha256(canonicalFixture(canaryVerification)),
      commitmentNonceSha256,
      dispatchAttemptId: "attempt-7",
      dispatchCorrelationId: correlation,
      intendedNativeAssets: [
        {
          assetPath: "package/assets/host-startup/v1/control-plane",
          requiredArches: ["arm64", "x86_64"],
          signingIdentifier: "bot.ouro.control-plane",
        },
        {
          assetPath: "package/assets/host-startup/v1/unlock-broker",
          requiredArches: ["arm64", "x86_64"],
          signingIdentifier: "bot.ouro.unlock-broker",
        },
      ],
      m0EvidenceBundleContentSha256: sha256(m0Content),
      m0EvidenceBundleGzipSha256: sha256(m0),
      p12SecretCommitment,
      pairGenerationId: "generation-7",
      passwordSecretCommitment,
      provisioningReceiptSha256: sha256(canonicalFixture(provisioningReceipt)),
      schemaVersion: 1,
    })
    const dispatchAuthority = canonicalFixture({
      attemptId: "attempt-7",
      dispatchCorrelationId: correlation,
      dispatchId: "dispatch-7",
      handoffSha256: sha256(handoff),
      pairGenerationId: "generation-7",
      schemaVersion: 1,
      transactionId: "release-7",
    })
    inputs.handoffControlBase64 = Buffer.from(handoff).toString("base64")
    inputs.handoffSha256 = sha256(handoff)
    inputs.m0EvidenceGzipBase64 = m0.toString("base64")
    inputs.m0EvidenceGzipSha256 = sha256(m0)
    inputs.dispatchAttemptAuthorityBase64 = Buffer.from(dispatchAuthority).toString("base64")
    inputs.dispatchAttemptAuthoritySha256 = sha256(dispatchAuthority)
    inputs.dispatchId = "dispatch-7"
  }
  const eventPath = join(root, "event.json")
  writeFileSync(eventPath, JSON.stringify({ inputs }))
  const sha = "1".repeat(40)
  return {
    root,
    eventPath,
    inputs,
    authorityPath: join(root, "release/trust/release-trust-inception-authority.v1.json"),
    bootstrapEvidencePath: join(root, "release/trust/release-trust-bootstrap-evidence.v1.json"),
    closurePath: join(root, closurePath),
    foundationPath: join(root, "release/trust/sigstore-foundation.v1.json"),
    headPath: join(root, "release/trust/release-trust-policy-head.v1.json"),
    policyPath: join(root, policyPath),
    environment: {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_REF: "refs/heads/main",
      GITHUB_REPOSITORY: "ourostack/ouroboros",
      GITHUB_REPOSITORY_ID: "1169669354",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "11",
      GITHUB_SHA: sha,
      GITHUB_WORKFLOW_REF: `ourostack/ouroboros/${workflowPath}@refs/heads/main`,
      GITHUB_WORKFLOW_SHA: sha,
    },
  }
}

function rewritePairRequest(fixture: ReturnType<typeof createAdmissionFixture>, mutate: (request: any) => void) {
  const inputs = { ...fixture.inputs }
  const request = JSON.parse(Buffer.from(inputs.requestBase64, "base64").toString("utf8"))
  mutate(request)
  const bytes = canonicalFixture(request)
  inputs.requestBase64 = Buffer.from(bytes).toString("base64")
  inputs.requestSha256 = sha256(bytes)
  writeFileSync(fixture.eventPath, JSON.stringify({ inputs }))
}

function rewriteSigningInputs(
  fixture: ReturnType<typeof createAdmissionFixture>,
  mutate: (values: { authority: any; handoff: any; m0Content: any; replaceGzip: (value: Buffer) => void }) => void,
) {
  const inputs = { ...fixture.inputs }
  const handoff = JSON.parse(Buffer.from(inputs.handoffControlBase64, "base64").toString("utf8"))
  const authority = JSON.parse(Buffer.from(inputs.dispatchAttemptAuthorityBase64, "base64").toString("utf8"))
  let gzip = Buffer.from(inputs.m0EvidenceGzipBase64, "base64")
  let m0Content = JSON.parse(gunzipSync(gzip).toString("utf8"))
  let gzipReplaced = false
  mutate({
    authority,
    handoff,
    m0Content,
    replaceGzip: (value) => {
      gzip = value
      gzipReplaced = true
    },
  })
  if (!gzipReplaced) {
    const m0Bytes = canonicalFixture(m0Content)
    gzip = gzipSync(Buffer.from(m0Bytes), { level: 9 })
    handoff.m0EvidenceBundleContentSha256 = sha256(m0Bytes)
  }
  handoff.m0EvidenceBundleGzipSha256 = sha256(gzip)
  inputs.m0EvidenceGzipBase64 = gzip.toString("base64")
  inputs.m0EvidenceGzipSha256 = sha256(gzip)
  const handoffBytes = canonicalFixture(handoff)
  inputs.handoffControlBase64 = Buffer.from(handoffBytes).toString("base64")
  inputs.handoffSha256 = sha256(handoffBytes)
  authority.handoffSha256 = inputs.handoffSha256
  const authorityBytes = canonicalFixture(authority)
  inputs.dispatchAttemptAuthorityBase64 = Buffer.from(authorityBytes).toString("base64")
  inputs.dispatchAttemptAuthoritySha256 = sha256(authorityBytes)
  writeFileSync(fixture.eventPath, JSON.stringify({ inputs }))
}

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
    const installStep = jobs.canary.steps.find(
      (step: any) => step.name === "Install pinned release trust dependencies",
    )
    const admissionStep = jobs.canary.steps.find(
      (step: any) => step.name === "Admit exact protected-main canary authority",
    )
    expect(installStep?.run).toBe("npm ci --ignore-scripts")
    expect(admissionStep).toBeDefined()
    expect(jobs.canary.steps.indexOf(installStep)).toBeLessThan(jobs.canary.steps.indexOf(admissionStep))
    expect(jobs.canary.steps.indexOf(admissionStep)).toBeLessThan(secretStepIndex)
    expect(admissionStep.run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs admit-secret-workflow pair-canary",
    )
    expect(admissionStep.run).not.toContain("${{")
    expect(jobs.canary.steps.filter((step: any) => step.run).every(
      (step: any) => !step.run.includes("${{ inputs."),
    )).toBe(true)
    expect(jobs.canary.steps.filter((step: any) => step.run).every(
      (step: any) => !/^xcrun\s/.test(step.run),
    )).toBe(true)
    expect(jobs.canary.steps.filter((step: any) => step.run?.includes(" clang ")).every(
      (step: any) => step.run.startsWith("/usr/bin/xcrun "),
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
    const scan = (
      candidatePages: any[],
      correlationTitle = "canary:attempt-7",
      selfRunId = 11,
    ) => scanWorkflowRuns({
      pages: candidatePages,
      correlationTitle,
      selfRunId,
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
    expect(scan(pages, "other", 12)).toMatchObject({
      state: "unique",
      runId: 12,
    })
    expect(scan(pages, "other")).toMatchObject({ state: "none" })
    expect(scan(pages, "missing")).toMatchObject({ state: "none" })
    expect(scan([{
        requestBytes: "request",
        responseBytes: JSON.stringify({
          total_count: 2,
          workflow_runs: [exactRun({ id: 11, display_title: "same" }), exactRun({ id: 11, display_title: "same" })],
        }),
        linkBytes: "",
      }], "same")).toMatchObject({ state: "multiple" })
    for (const impostor of [
      exactRun({ workflow_id: 999 }),
      exactRun({ path: ".github/workflows/other.yml" }),
      exactRun({ path: "not-a-workflow" }),
      exactRun({ event: "push" }),
      exactRun({ head_branch: "feature" }),
      exactRun({ head_sha: "0".repeat(40) }),
      exactRun({ run_attempt: 2 }),
      exactRun({ id: 12 }),
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
      pages,
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
      expect(scan(incompletePages, "missing", incompletePages === pages ? 0 : 11)).toMatchObject({
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

    expect(authorizeTerminalSupersession(valid)).toMatchObject({
      ok: false,
      code: "verification_evidence_required",
    })
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
    for (const conclusion of ["success", "action_required", "stale"]) {
      expect(authorizeTerminalSupersession({
        ...valid,
        terminalInspection: { ...valid.terminalInspection, conclusion },
      })).toMatchObject({ ok: false, code: "terminal_run_required" })
    }
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

  it("measures live node, xcrun, and resolved clang bytes before admission", async () => {
    const { verifyLiveSystemExecutables } = await loadReconciliation()
    const root = mkdtempSync(join(tmpdir(), "ouro-live-executables-"))
    const paths = {
      node: join(root, "node"),
      xcrun: join(root, "xcrun"),
      clang: join(root, "clang"),
    }
    try {
      for (const [name, path] of Object.entries(paths)) {
        writeFileSync(path, `${name}-bytes`)
        chmodSync(path, 0o700)
      }
      const canonicalPaths = Object.fromEntries(Object.entries(paths).map(([name, path]) => (
        [name, realpathSync.native(path)]
      ))) as typeof paths
      const entries = Object.entries(canonicalPaths).map(([name, realpath]) => ({
        designatedRequirementSha256: null,
        kind: "system-executable",
        realpath,
        sha256: sha256(`${name}-bytes`),
      }))
      const input = {
        entries,
        currentNodeExecutable: canonicalPaths.node,
        resolveClang: () => canonicalPaths.clang,
      }

      expect(verifyLiveSystemExecutables(input)).toEqual({ ok: true })
      expect(() => verifyLiveSystemExecutables({
        ...input,
        currentNodeExecutable: canonicalPaths.xcrun,
      })).toThrow(/node executable identity/i)
      expect(() => verifyLiveSystemExecutables({
        ...input,
        resolveClang: () => canonicalPaths.node,
      })).toThrow(/clang executable identity/i)
      writeFileSync(paths.xcrun, "changed-xcrun-bytes")
      expect(() => verifyLiveSystemExecutables(input)).toThrow(/executable digest/i)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed across malformed, unstable, and unresolved live executable evidence", async () => {
    const { verifyLiveSystemExecutables } = await loadReconciliation()
    const paths = {
      node: "/system/node",
      xcrun: "/system/xcrun",
      clang: "/system/clang",
    }
    const bytes = Object.fromEntries(Object.keys(paths).map((name) => [name, Buffer.from(`${name}-bytes`)]))
    const entries = Object.entries(paths).map(([name, realpath]) => ({
      designatedRequirementSha256: null,
      kind: "system-executable",
      realpath,
      sha256: sha256(bytes[name]),
    }))
    const stableStat = (overrides: Record<string, unknown> = {}) => ({
      ctimeMs: 6,
      dev: 1,
      ino: 2,
      isFile: () => true,
      mode: 0o100700,
      mtimeMs: 5,
      size: 10,
      ...overrides,
    })
    const fileSystem = (overrides: Record<string, unknown> = {}) => ({
      close: () => undefined,
      fstat: () => stableStat(),
      lstat: () => stableStat(),
      open: (path: string) => path,
      read: (descriptor: string) => bytes[descriptor.split("/").at(-1)!],
      realpath: (path: string) => path,
      ...overrides,
    })
    const valid = {
      entries,
      currentNodeExecutable: paths.node,
      fileSystem: fileSystem(),
      resolveClang: () => paths.clang,
    }

    expect(() => verifyLiveSystemExecutables()).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({ ...valid, entries: {} })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({ ...valid, currentNodeExecutable: 1 })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({ ...valid, resolveClang: "xcrun" })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({ ...valid, spawn: "xcrun" })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: [...entries, { ...entries[0] }],
    })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: [{ ...entries[0], realpath: "/system/bash" }, ...entries.slice(1)],
    })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: [{ ...entries[0], realpath: undefined }, ...entries.slice(1)],
    })).toThrow(/evidence is invalid/i)
    expect(() => verifyLiveSystemExecutables({ ...valid, entries: entries.slice(1) })).toThrow(/evidence is incomplete/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ realpath: (path: string) => path === paths.node ? "/other/node" : path }),
    })).toThrow(/node executable identity/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.node ? { ...entry, realpath: "node" } : entry),
      currentNodeExecutable: "node",
    })).toThrow(/realpath is not canonical/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ realpath: (path: string) => path === paths.xcrun ? "/system/xcrun-real" : path }),
    })).toThrow(/realpath is not canonical/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ lstat: () => stableStat({ isFile: () => false }) }),
    })).toThrow(/executable regular file/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ lstat: () => stableStat({ mode: 0o100600 }) }),
    })).toThrow(/executable regular file/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ fstat: () => stableStat({ isFile: () => false }) }),
    })).toThrow(/changed before measurement/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ fstat: () => stableStat({ ino: 3 }) }),
    })).toThrow(/changed before measurement/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({ open: () => { throw new Error("open failed") } }),
    })).toThrow(/open failed/i)

    let fstatCalls = 0
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({
        fstat: () => stableStat(fstatCalls++ === 0 ? {} : { mtimeMs: 9 }),
      }),
    })).toThrow(/changed during measurement/i)
    let lstatCalls = 0
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      fileSystem: fileSystem({
        lstat: () => stableStat(lstatCalls++ === 0 ? {} : { ctimeMs: 9 }),
      }),
    })).toThrow(/changed during measurement/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.node ? { ...entry, sha256: "invalid" } : entry),
    })).toThrow(/digest does not match/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.node ? { ...entry, sha256: undefined } : entry),
    })).toThrow(/digest does not match/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.node ? { ...entry, sha256: "0".repeat(64) } : entry),
    })).toThrow(/digest does not match/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.clang ? { ...entry, sha256: "invalid" } : entry),
    })).toThrow(/digest does not match/i)
    expect(() => verifyLiveSystemExecutables({
      ...valid,
      entries: entries.map((entry) => entry.realpath === paths.clang ? { ...entry, sha256: undefined } : entry),
    })).toThrow(/digest does not match/i)

    const resolveWith = (result: Record<string, unknown>) => verifyLiveSystemExecutables({
      ...valid,
      resolveClang: undefined,
      spawn: () => result,
    })
    expect(() => resolveWith({ error: new Error("missing"), status: null, stdout: "" })).toThrow(/could not be resolved/i)
    expect(() => resolveWith({ status: 1, stdout: paths.clang })).toThrow(/could not be resolved/i)
    expect(() => resolveWith({ status: 0, stdout: Buffer.from(paths.clang) })).toThrow(/could not be resolved/i)
    expect(() => resolveWith({ status: 0, stdout: "clang" })).toThrow(/could not be resolved/i)
    expect(resolveWith({ status: 0, stdout: `${paths.clang}\n` })).toEqual({ ok: true })
  })

  it("measures xcrun before using it to resolve clang", async () => {
    const { verifyLiveSystemExecutables } = await loadReconciliation()
    const paths = { node: "/system/node", xcrun: "/system/xcrun", clang: "/system/clang" }
    const order: string[] = []
    const entries = Object.entries(paths).map(([name, realpath]) => ({
      kind: "system-executable",
      realpath,
      sha256: sha256(`${name}-bytes`),
    }))
    const stat = {
      ctimeMs: 6,
      dev: 1,
      ino: 2,
      isFile: () => true,
      mode: 0o100700,
      mtimeMs: 5,
      size: 10,
    }

    expect(verifyLiveSystemExecutables({
      entries,
      currentNodeExecutable: paths.node,
      resolveClang: (path: string) => {
        order.push(`resolve:${path}`)
        return paths.clang
      },
      fileSystem: {
        close: () => undefined,
        fstat: () => stat,
        lstat: () => stat,
        open: (path: string) => path,
        read: (path: string) => {
          const name = path.split("/").at(-1)!
          order.push(`read:${name}`)
          return Buffer.from(`${name}-bytes`)
        },
        realpath: (path: string) => path,
      },
    })).toEqual({ ok: true })
    expect(order).toEqual(["read:node", "read:xcrun", "resolve:/system/xcrun", "read:clang"])
  })

  it("admits only hash-bound protected-main workflows and safely materializes seal input", async () => {
    const { admitSecretWorkflow, materializeNativePlan, materializeSealInput } = await loadReconciliation()
    const fixtures = [createAdmissionFixture("pair-canary"), createAdmissionFixture("signing")]
    try {
      expect(admitSecretWorkflow("pair-canary", {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toEqual({ ok: true })
      expect(admitSecretWorkflow("signing", {
        root: fixtures[1].root,
        environment: fixtures[1].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toEqual({ ok: true })
      expect(() => admitSecretWorkflow("pair-canary", {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
      })).toThrow(/verification evidence required/i)
      expect(() => admitSecretWorkflow("pair-canary", {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: null,
        trustVerifier: () => true,
      })).toThrow(/live system executable evidence/i)
      expect(() => admitSecretWorkflow("pair-canary", {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: () => ({ ok: false }),
        trustVerifier: () => true,
      })).toThrow(/live system executable evidence/i)
      expect(() => admitSecretWorkflow("unknown", {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
      })).toThrow(/unknown secret workflow/i)
      expect(() => admitSecretWorkflow("pair-canary", {
        root: fixtures[0].root,
        environment: { ...fixtures[0].environment, GITHUB_REF: "refs/heads/feature" },
      })).toThrow(/protected main/i)

      const nativePlanPath = join(fixtures[0].root, "developer-id-pair-canary-native-plan.v1.bin")
      expect(materializeNativePlan("pair-canary", nativePlanPath, {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toEqual({ ok: true })
      const nativePlan = readFileSync(nativePlanPath)
      expect(nativePlan.readUInt32BE(0)).toBe(6)
      expect(() => materializeNativePlan("pair-canary", nativePlanPath, {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toThrow()
      const signingPlanPath = join(fixtures[1].root, "developer-id-signing-native-plan.v1.bin")
      expect(materializeNativePlan("signing", signingPlanPath, {
        root: fixtures[1].root,
        environment: fixtures[1].environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toEqual({ ok: true })
      expect(readFileSync(signingPlanPath).readUInt32BE(0)).toBe(9)
      expect(() => materializeNativePlan("unknown", join(fixtures[0].root, "unknown-plan.bin"), {
        root: fixtures[0].root,
        environment: fixtures[0].environment,
        trustVerifier: () => true,
      })).toThrow(/unknown native plan kind/i)

      const sealEventPath = join(fixtures[0].root, "seal-event.json")
      const auditEvidence = { repositoryIdentitySha256: "9".repeat(64) }
      const sealBytes = canonicalFixture({
        authorityMergeAuditEvidence: auditEvidence,
        authorityMergeAuditEvidenceSha256: sha256(canonicalFixture(auditEvidence)),
        authorityMergePullRequestNumber: 901,
        authorityMergeSha: fixtures[1].environment.GITHUB_SHA,
        authorityMergeTreeSha256: "8".repeat(64),
        authorityPath: "release/trust/release-trust-inception-authority.v1.json",
        authorityReferencesEarlierBootstrapMerge: true,
        authoritySha256: sha256(readFileSync(fixtures[1].authorityPath)),
        bootstrapEvidencePath: "release/trust/release-trust-bootstrap-evidence.v1.json",
        bootstrapEvidenceSha256: sha256(readFileSync(fixtures[1].bootstrapEvidencePath)),
        bootstrapMergeSha: "6".repeat(40),
        bootstrapTreeSha256: "5".repeat(64),
        createdAt: "2026-07-24T00:00:00.000Z",
        headPath: "release/trust/release-trust-policy-head.v1.json",
        headSha256: sha256(readFileSync(fixtures[1].headPath)),
        noSecretSigningPublishOrInstalledRuntimeEffectBeforeSeal: true,
        policyPath: "release/trust/release-trust-policy.v1.json",
        policySha256: sha256(readFileSync(fixtures[1].policyPath)),
        repository: "ourostack/ouroboros",
        repositoryDatabaseId: 1169669354,
        repositoryNodeId: "R_kgDORbe86g",
        schemaVersion: 1,
      })
      writeFileSync(sealEventPath, JSON.stringify({ inputs: {
        sealBodyBase64: Buffer.from(sealBytes).toString("base64"),
        sealBodySha256: sha256(sealBytes),
      } }))
      const sealPath = join(fixtures[1].root, "seal.json")
      const sealEnvironment = {
        ...fixtures[1].environment,
        GITHUB_EVENT_PATH: sealEventPath,
        GITHUB_WORKFLOW_REF: "ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
      }
      expect(materializeSealInput(sealPath, {
        root: fixtures[1].root,
        environment: sealEnvironment,
        trustVerifier: () => true,
      })).toEqual({ ok: true })
      expect(readFileSync(sealPath, "utf8")).toBe(sealBytes)
      expect(() => materializeSealInput(sealPath, {
        root: fixtures[1].root,
        environment: sealEnvironment,
        trustVerifier: () => true,
      })).toThrow()
      expect(() => materializeSealInput(join(fixtures[1].root, "unverified-seal.json"), {
        root: fixtures[1].root,
        environment: sealEnvironment,
      })).toThrow(/verification evidence required/i)
      for (const environment of [
        { ...sealEnvironment, GITHUB_REF: "refs/heads/feature" },
        { ...sealEnvironment, GITHUB_RUN_ATTEMPT: "2" },
        { ...sealEnvironment, GITHUB_WORKFLOW_REF: "ourostack/ouroboros/.github/workflows/other.yml@refs/heads/main" },
      ]) {
        expect(() => materializeSealInput(join(fixtures[1].root, `wrong-seal-run-${environment.GITHUB_RUN_ATTEMPT}.json`), {
          root: fixtures[1].root,
          environment,
          trustVerifier: () => true,
        })).toThrow(/protected main/i)
      }
      const expectSealBodyRejected = (mutate: (body: any) => void, name: string, pattern: RegExp) => {
        const body = JSON.parse(sealBytes)
        mutate(body)
        const bytes = canonicalFixture(body)
        writeFileSync(sealEventPath, JSON.stringify({ inputs: {
          sealBodyBase64: Buffer.from(bytes).toString("base64"),
          sealBodySha256: sha256(bytes),
        } }))
        expect(() => materializeSealInput(join(fixtures[1].root, `${name}.json`), {
          root: fixtures[1].root,
          environment: sealEnvironment,
          trustVerifier: () => true,
        })).toThrow(pattern)
      }
      expectSealBodyRejected((body) => { body.unexpected = true }, "extra-seal-field", /exact authority-merge evidence/i)
      expectSealBodyRejected((body) => { body.authorityPath = "release/trust/other.json" }, "path-drift", /checked-out authority bytes/i)
      expectSealBodyRejected((body) => { body.bootstrapMergeSha = "7".repeat(40) }, "graph-drift", /graph is inconsistent/i)
      writeFileSync(sealEventPath, JSON.stringify({ inputs: {
        sealBodyBase64: Buffer.from(sealBytes).toString("base64"),
        sealBodySha256: "0".repeat(64),
      } }))
      expect(() => materializeSealInput(join(fixtures[1].root, "bad-seal.json"), {
        root: fixtures[1].root,
        environment: sealEnvironment,
        trustVerifier: () => true,
      })).toThrow(/hash mismatch/i)
      writeFileSync(sealEventPath, JSON.stringify({ inputs: {
        sealBodyBase64: Buffer.from(sealBytes).toString("base64"),
      } }))
      expect(() => materializeSealInput(join(fixtures[1].root, "missing-hash-seal.json"), {
        root: fixtures[1].root,
        environment: sealEnvironment,
        trustVerifier: () => true,
      })).toThrow(/hash mismatch/i)
      writeFileSync(sealEventPath, JSON.stringify({ inputs: {
        sealBodyBase64: Buffer.from(sealBytes).toString("base64"),
        sealBodySha256: sha256(sealBytes),
      } }))
      const calls: string[] = []
      expect(() => materializeSealInput(join(fixtures[1].root, "write-failure.json"), {
        root: fixtures[1].root,
        environment: sealEnvironment,
        trustVerifier: () => true,
        fileSystem: {
          open: () => { calls.push("open"); return 7 },
          write: () => { throw new Error("synthetic write failure") },
          fsync: () => calls.push("fsync"),
          close: () => calls.push("close"),
          unlink: () => calls.push("unlink"),
        },
      })).toThrow()
      expect(calls).toEqual(["open", "close", "unlink"])
    } finally {
      for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("rejects malformed commitment, M0, asset, and native-plan authorities", async () => {
    const { materializeNativePlan } = await loadReconciliation()
    const fixtures: Array<ReturnType<typeof createAdmissionFixture>> = []
    const expectRejected = (
      kind: "pair-canary" | "signing",
      mutate: (fixture: ReturnType<typeof createAdmissionFixture>) => void,
      pattern: RegExp,
    ) => {
      const fixture = createAdmissionFixture(kind)
      fixtures.push(fixture)
      mutate(fixture)
      expect(() => materializeNativePlan(kind, join(fixture.root, `${kind}-plan.bin`), {
        root: fixture.root,
        environment: fixture.environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
      })).toThrow(pattern)
    }
    try {
      expectRejected("pair-canary", (fixture) => rewritePairRequest(fixture, (request) => {
        delete request.p12SecretCommitment.digestBase64Url
      }), /pair canary native plan authority/i)
      expectRejected("pair-canary", (fixture) => rewritePairRequest(fixture, (request) => {
        request.transactionId = "not safe"
      }), /pair canary native plan authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ handoff }) => {
        handoff.intendedNativeAssets = [null]
      }), /signing native plan authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ m0Content }) => {
        m0Content.schemaVersion = 2
      }), /signing M0 evidence authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ handoff, m0Content }) => {
        const receipt = m0Content.files.find((file: any) => (
          file.path === "developer-id-provisioning-receipt.v1.json"
        )).value
        receipt.identity.teamIdentifier = "not safe"
        handoff.provisioningReceiptSha256 = sha256(canonicalFixture(receipt))
      }), /signing M0 identity authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ replaceGzip }) => {
        replaceGzip(Buffer.from("not-a-gzip-stream"))
      }), /signing M0 evidence authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ handoff }) => {
        handoff.schemaVersion = 2
      }), /signing native plan authority/i)
      expectRejected("signing", (fixture) => rewriteSigningInputs(fixture, ({ handoff }) => {
        handoff.intendedNativeAssets[1].assetPath = handoff.intendedNativeAssets[0].assetPath
      }), /signing native asset authority/i)

      const unverified = createAdmissionFixture("pair-canary")
      fixtures.push(unverified)
      expect(() => materializeNativePlan("pair-canary", join(unverified.root, "unverified-plan.bin"), {
        root: unverified.root,
        environment: unverified.environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
      })).toThrow(/verification evidence required/i)

      const partial = createAdmissionFixture("pair-canary")
      fixtures.push(partial)
      const calls: string[] = []
      expect(() => materializeNativePlan("pair-canary", join(partial.root, "partial-plan.bin"), {
        root: partial.root,
        environment: partial.environment,
        systemExecutableVerifier: acceptSyntheticSystemExecutables,
        trustVerifier: () => true,
        fileSystem: {
          open: () => { calls.push("open"); return 7 },
          write: () => 0,
          fsync: () => calls.push("fsync"),
          close: () => calls.push("close"),
          unlink: () => calls.push("unlink"),
        },
      })).toThrow(/write was incomplete/i)
      expect(calls).toEqual(["open", "close", "unlink"])
    } finally {
      for (const fixture of fixtures) rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("executes every release-trust CLI command through the covered argv adapter", async () => {
    const { isDirectInvocation, runCli, runDirectInvocation, setProcessExitCode } = await loadReconciliation()
    const fixture = createAdmissionFixture("pair-canary")
    try {
      const drainingDriver = join(fixture.root, "draining-driver")
      writeFileSync(drainingDriver, "#!/bin/sh\ncat >/dev/null\n")
      chmodSync(drainingDriver, 0o700)
      const admitted = spawnSync(process.execPath, [
        reconciliationPath,
        "admit-secret-workflow",
        "pair-canary",
      ], { cwd: fixture.root, env: fixture.environment, encoding: "utf8" })
      expect(admitted.status).toBe(65)
      expect(admitted.stderr).toMatch(/executable identity|system executable|verification evidence required/i)
      const framed = execFileSync(process.execPath, [
        reconciliationPath,
        "frame-native",
        drainingDriver,
        "1",
      ], {
        env: { OURO_DRIVER_FIELD_1: "synthetic" },
        encoding: "utf8",
      })
      expect(framed).toBe("")
      const invalid = spawnSync(process.execPath, [reconciliationPath, "unknown"], { encoding: "utf8" })
      expect(invalid.status).toBe(64)
      expect(invalid.stderr).toMatch(/usage:/i)

      const stdout: string[] = []
      const stderr: string[] = []
      const output = {
        stdout: { write: (value: string) => stdout.push(value) },
        stderr: { write: (value: string) => stderr.push(value) },
      }
      const calls: string[] = []
      const operations = {
        runNativeFrame: () => { calls.push("frame"); return 23 },
        admitSecretWorkflow: () => { calls.push("admit") },
        materializeNativePlan: () => { calls.push("plan") },
        materializeSealInput: () => { calls.push("seal") },
      }
      expect(runCli(["frame-native", "driver", "4"], output, operations)).toBe(23)
      expect(runCli(["admit-secret-workflow", "pair-canary"], output, operations)).toBe(0)
      expect(runCli(["materialize-seal-input", "seal.json"], output, operations)).toBe(0)
      expect(runCli(["materialize-native-plan", "pair-canary", "plan.bin"], output, operations)).toBe(0)
      expect(runCli(["unknown"], output, operations)).toBe(64)
      expect(calls).toEqual(["frame", "admit", "seal", "plan"])
      expect(stderr.join("")).toMatch(/usage:/i)
      expect(runCli(["unknown"], output)).toBe(64)
      expect(runCli(["admit-secret-workflow", "pair-canary"], output, {
        ...operations,
        admitSecretWorkflow: () => { throw new Error("admission failed") },
      })).toBe(65)
      expect(runCli(["materialize-seal-input", "seal.json"], output, {
        ...operations,
        materializeSealInput: () => { throw "non-error failure" },
      })).toBe(65)

      const moduleUrl = pathToFileURL("/tmp/release-trust-cli.mjs").href
      expect(isDirectInvocation(["node", "/tmp/other.mjs"], moduleUrl)).toBe(false)
      expect(isDirectInvocation(["node", "/tmp/release-trust-cli.mjs"], moduleUrl)).toBe(true)
      const exits: number[] = []
      expect(runDirectInvocation(
        ["node", "/tmp/other.mjs"],
        moduleUrl,
        () => 0,
        (code: number) => exits.push(code),
      )).toBe(false)
      expect(runDirectInvocation(
        ["node", "/tmp/release-trust-cli.mjs", "unknown"],
        moduleUrl,
        () => 64,
        (code: number) => exits.push(code),
      )).toBe(true)
      expect(exits).toEqual([64])
      const previousExitCode = process.exitCode
      setProcessExitCode(0)
      expect(process.exitCode).toBe(0)
      process.exitCode = previousExitCode
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it("rejects malformed dispatch and protected-store evidence before secret access", async () => {
    const { admitSecretWorkflow } = await loadReconciliation()
    const expectFailure = (
      kind: "pair-canary" | "signing",
      mutate: (fixture: ReturnType<typeof createAdmissionFixture>) => void,
      pattern: RegExp,
    ) => {
      const fixture = createAdmissionFixture(kind)
      try {
        mutate(fixture)
        expect(() => admitSecretWorkflow(kind, {
          root: fixture.root,
          environment: fixture.environment,
          systemExecutableVerifier: acceptSyntheticSystemExecutables,
        })).toThrow(pattern)
      } finally {
        rmSync(fixture.root, { recursive: true, force: true })
      }
    }
    const rewriteEvent = (
      fixture: ReturnType<typeof createAdmissionFixture>,
      inputs: unknown,
    ) => writeFileSync(fixture.eventPath, JSON.stringify({ inputs }))
    const rebindAuthority = (
      fixture: ReturnType<typeof createAdmissionFixture>,
      changes: Record<string, unknown>,
    ) => {
      const authority = { ...JSON.parse(readFileSync(fixture.authorityPath, "utf8")), ...changes }
      const authorityBytes = canonicalFixture(authority)
      writeFileSync(fixture.authorityPath, authorityBytes)
      const head = JSON.parse(readFileSync(fixture.headPath, "utf8"))
      head.activation.authoritySha256 = sha256(authorityBytes)
      writeFileSync(fixture.headPath, canonicalFixture(head))
    }
    const rebindClosure = (
      fixture: ReturnType<typeof createAdmissionFixture>,
      kind: "pair-canary" | "signing",
      mutate: (closure: Record<string, any>) => void,
    ) => {
      const closure = JSON.parse(readFileSync(fixture.closurePath, "utf8"))
      delete closure.closureSha256
      mutate(closure)
      closure.closureSha256 = sha256(canonicalFixture(closure))
      const closureBytes = canonicalFixture(closure)
      writeFileSync(fixture.closurePath, closureBytes)
      rebindAuthority(fixture, {
        [kind === "pair-canary"
          ? "pairCanaryExecutionClosureSha256"
          : "signingExecutionClosureSha256"]: sha256(closureBytes),
      })
    }

    expectFailure("pair-canary", (fixture) => rewriteEvent(fixture, null), /inputs are missing/i)
    expectFailure("pair-canary", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, requestBase64: "!" })
    }, /canonical base64/i)
    expectFailure("pair-canary", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, requestBase64: "A" })
    }, /canonical base64/i)
    expectFailure("pair-canary", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, requestSha256: "0".repeat(64) })
    }, /hash mismatch/i)
    expectFailure("pair-canary", (fixture) => {
      const { requestSha256: _requestSha256, ...inputs } = fixture.inputs
      rewriteEvent(fixture, inputs)
    }, /hash mismatch/i)
    for (const malformed of ["{", '{"z":1, "a":2}']) {
      expectFailure("pair-canary", (fixture) => {
        rewriteEvent(fixture, {
          ...fixture.inputs,
          requestBase64: Buffer.from(malformed).toString("base64"),
          requestSha256: sha256(malformed),
        })
      }, /not JSON|not exact JCS/i)
    }
    expectFailure("pair-canary", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, dispatchCorrelationId: "" })
    }, /correlation is invalid/i)
    expectFailure("pair-canary", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, dispatchCorrelationId: "different" })
    }, /correlation authority mismatch/i)
    expectFailure("signing", (fixture) => {
      rewriteEvent(fixture, { ...fixture.inputs, dispatchId: "different" })
    }, /identity authority mismatch/i)
    expectFailure("pair-canary", (fixture) => {
      writeFileSync(fixture.authorityPath, "not-json")
    }, /not JSON/i)
    expectFailure("pair-canary", (fixture) => {
      rebindAuthority(fixture, { repository: "attacker/fork" })
    }, /does not bind exact protected bytes/i)
    expectFailure("pair-canary", (fixture) => {
      const head = JSON.parse(readFileSync(fixture.headPath, "utf8"))
      head.revision = 2
      writeFileSync(fixture.headPath, canonicalFixture(head))
    }, /not the sealed inception head/i)
    expectFailure("pair-canary", (fixture) => {
      rebindClosure(fixture, "pair-canary", (closure) => {
        closure.allActionsPinnedByFullCommitSha = false
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      rebindClosure(fixture, "pair-canary", (closure) => {
        closure.entries[0].commitSha = "v6"
        closure.allActionsPinnedByFullCommitSha = true
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      rebindClosure(fixture, "pair-canary", (closure) => {
        closure.entries.push({
          commitSha: "1".repeat(40),
          kind: "action",
          uses: "attacker/action",
        })
        closure.entries.sort((left: any, right: any) => (
          `${left.kind}\0${left.uses ?? left.path}`.localeCompare(
            `${right.kind}\0${right.uses ?? right.path}`,
          )
        ))
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      rebindClosure(fixture, "pair-canary", (closure) => {
        closure.entries = closure.entries.filter((entry: any) => entry.kind !== "checked-out-file")
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      rebindClosure(fixture, "pair-canary", (closure) => {
        closure.entries.reverse()
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      const closure = JSON.parse(readFileSync(fixture.closurePath, "utf8"))
      closure.closureSha256 = "0".repeat(64)
      const closureBytes = canonicalFixture(closure)
      writeFileSync(fixture.closurePath, closureBytes)
      rebindAuthority(fixture, { pairCanaryExecutionClosureSha256: sha256(closureBytes) })
    }, /execution closure is incomplete/i)
    expectFailure("signing", (fixture) => {
      rebindClosure(fixture, "signing", (closure) => {
        closure.entries[2].role = "secret-driver-source"
      })
    }, /execution closure is incomplete/i)
    expectFailure("pair-canary", (fixture) => {
      const foundationBytes = "not-json"
      writeFileSync(fixture.foundationPath, foundationBytes)
      rebindAuthority(fixture, { pairCanaryFoundationSha256: sha256(foundationBytes) })
    }, /foundation is not JSON/i)
    expectFailure("pair-canary", (fixture) => {
      const foundationBytes = JSON.stringify({
        schemaVersion: 1,
        fulcioRoots: [],
        ctLogs: [],
        rekorLogs: [],
      })
      writeFileSync(fixture.foundationPath, foundationBytes)
      rebindAuthority(fixture, { pairCanaryFoundationSha256: sha256(foundationBytes) })
    }, /foundation rejected/i)
  })
})
