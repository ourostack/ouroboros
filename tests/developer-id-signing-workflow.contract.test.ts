import { execFileSync } from "child_process"
import { createHash } from "crypto"
import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import { join } from "path"

import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

async function loadClosure() {
  return import(pathToFileURL(join(
    repoRoot,
    ".github",
    "actions",
    "release-trust",
    "workflow-closure.mjs",
  )).href)
}

function loadWorkflow(name: string): any {
  const source = readFileSync(join(repoRoot, ".github", "workflows", name), "utf8")
  return JSON.parse(execFileSync("ruby", [
    "-ryaml",
    "-rjson",
    "-e",
    "document = YAML.safe_load(STDIN.read, aliases: true); STDOUT.write(JSON.generate(document))",
  ], { input: source, encoding: "utf8" }))
}

describe("Developer ID signing workflow contract", () => {
  it("keeps signing secrets out of environments and binds immutable authority inputs", () => {
    const workflow = loadWorkflow("developer-id-signing.yml")
    const jobs = workflow.jobs

    expect(workflow.name).toBe("developer-id-signing")
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual([
      "handoffControlBase64",
      "handoffSha256",
      "m0EvidenceGzipBase64",
      "m0EvidenceGzipSha256",
      "dispatchAttemptAuthorityBase64",
      "dispatchAttemptAuthoritySha256",
      "dispatchId",
      "dispatchCorrelationId",
    ])
    expect(Object.keys(jobs)).toEqual(["signing"])
    expect(jobs.signing["runs-on"]).toBe("macos-26")
    expect(jobs.signing.permissions).toEqual({
      actions: "read",
      contents: "read",
      "id-token": "write",
    })
    expect(workflow.environment).toBeUndefined()
    expect(jobs.signing.environment).toBeUndefined()
    expect(jobs.signing.steps.every((step: any) => step.if === undefined)).toBe(true)
    const actionSteps = jobs.signing.steps.filter((step: any) => step.uses)
    expect(actionSteps.every((step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses))).toBe(true)
    const secretSteps = jobs.signing.steps.filter((step: any) => JSON.stringify(step).includes("${{ secrets."))
    expect(secretSteps).toHaveLength(1)
    expect(secretSteps[0].env).toEqual({
      OURO_DRIVER_FIELD_1: "${{ secrets.OURO_DEVELOPER_ID_P12_B64 }}",
      OURO_DRIVER_FIELD_2: "${{ secrets.OURO_DEVELOPER_ID_P12_PASSWORD }}",
    })
    expect(secretSteps[0].run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs frame-native native/developer-id-signing/driver 2",
    )
    expect(secretSteps[0].run).not.toContain("${{")
    const secretStepIndex = jobs.signing.steps.indexOf(secretSteps[0])
    const installStep = jobs.signing.steps.find(
      (step: any) => step.name === "Install pinned release trust dependencies",
    )
    const admissionStep = jobs.signing.steps.find(
      (step: any) => step.name === "Admit exact protected-main signing authority",
    )
    expect(installStep?.run).toBe("npm ci --ignore-scripts")
    expect(admissionStep).toBeDefined()
    expect(jobs.signing.steps.indexOf(installStep)).toBeLessThan(jobs.signing.steps.indexOf(admissionStep))
    expect(jobs.signing.steps.indexOf(admissionStep)).toBeLessThan(secretStepIndex)
    expect(admissionStep.run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs admit-secret-workflow signing",
    )
    const planStep = jobs.signing.steps.find(
      (step: any) => step.name === "Materialize exact public identity and asset signing plan",
    )
    expect(planStep?.run).toBe(
      "node .github/actions/release-trust/run-reconciliation.mjs materialize-native-plan signing developer-id-signing-native-plan.v1.bin",
    )
    expect(jobs.signing.steps.indexOf(planStep)).toBeGreaterThan(jobs.signing.steps.indexOf(admissionStep))
    expect(jobs.signing.steps.indexOf(planStep)).toBeLessThan(secretStepIndex)
    expect(jobs.signing.steps.filter((step: any) => step.run).every(
      (step: any) => !step.run.includes("${{ inputs."),
    )).toBe(true)
    expect(jobs.signing.steps.filter((step: any) => step.run).every(
      (step: any) => !/^xcrun\s/.test(step.run),
    )).toBe(true)
    expect(jobs.signing.steps.filter((step: any) => step.run?.includes(" clang ")).every(
      (step: any) => step.run.startsWith("/usr/bin/xcrun "),
    )).toBe(true)

    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("attempt-authority")
    expect(serialized).toContain("active-pair-authority")
    expect(serialized).toContain("workflow_ref")
    expect(serialized).toContain("release-trust-inception-head")
    expect(serialized).not.toContain("GITHUB_ENV")
  })

  it("requires every workflow, policy, foundation, and driver leaf in its closure", async () => {
    const { verifyWorkflowClosure } = await loadClosure()
    const requiredPaths = [
      ".github/workflows/developer-id-pair-canary.yml",
      ".github/workflows/developer-id-signing.yml",
      ".github/workflows/release-trust-inception-seal.yml",
      "release/trust/sigstore-foundation.v1.json",
      "native/developer-id-pair-canary/driver.c",
      "native/developer-id-signing/driver.c",
    ]
    const members = requiredPaths.map((path, index) => ({
      path,
      sha256: String(index + 1).repeat(64),
    }))

    expect(verifyWorkflowClosure({ requiredPaths, members })).toEqual({ ok: true })
    expect(verifyWorkflowClosure({ requiredPaths, members: members.slice(1) })).toMatchObject({
      ok: false,
      code: "closure_member_missing",
      path: requiredPaths[0],
    })
    expect(verifyWorkflowClosure({ requiredPaths, members: [...members, members[0]] })).toMatchObject({
      ok: false,
      code: "closure_member_duplicate",
      path: requiredPaths[0],
    })
    expect(verifyWorkflowClosure({ requiredPaths: null, members })).toMatchObject({
      ok: false,
      code: "closure_invalid",
    })
    expect(verifyWorkflowClosure({ requiredPaths: [...requiredPaths, requiredPaths[0]], members })).toMatchObject({
      ok: false,
      code: "closure_required_path_duplicate",
    })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members: [{ path: requiredPaths[0], sha256: "wrong" }, ...members.slice(1)],
    })).toMatchObject({ ok: false, code: "closure_member_invalid" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members: [{ path: requiredPaths[0], sha256: null }, ...members.slice(1)],
    })).toMatchObject({ ok: false, code: "closure_member_invalid" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members: [...members.slice(0, -1), { path: "unexpected", sha256: "f".repeat(64) }],
    })).toMatchObject({ ok: false, code: "closure_member_unexpected", path: "unexpected" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members: [...members].reverse(),
    })).toMatchObject({ ok: false, code: "closure_member_order_invalid" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "action", identity: "actions/checkout", ref: "v6" }],
    })).toMatchObject({ ok: false, code: "closure_action_unpinned" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "action", identity: "actions/checkout" }],
    })).toMatchObject({ ok: false, code: "closure_action_unpinned" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "reusable-workflow", identity: "owner/repo/.github/workflows/x.yml", ref: "a".repeat(40) }],
    })).toMatchObject({ ok: false, code: "closure_execution_forbidden" })
    expect(verifyWorkflowClosure({ requiredPaths, members, execution: null })).toMatchObject({
      ok: false,
      code: "closure_execution_invalid",
    })
    expect(verifyWorkflowClosure({ requiredPaths, members, execution: [{}] })).toMatchObject({
      ok: false,
      code: "closure_execution_invalid",
    })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "container", identity: "node", digest: "latest" }],
    })).toMatchObject({ ok: false, code: "closure_container_unpinned" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "container", identity: "node" }],
    })).toMatchObject({ ok: false, code: "closure_container_unpinned" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "download", identity: "tool", sha256: "wrong" }],
    })).toMatchObject({ ok: false, code: "closure_download_unverified" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "download", identity: "tool" }],
    })).toMatchObject({ ok: false, code: "closure_download_unverified" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [{ kind: "shell", identity: "inline" }],
    })).toMatchObject({ ok: false, code: "closure_execution_forbidden" })
    expect(verifyWorkflowClosure({
      requiredPaths,
      members,
      execution: [
        { kind: "action", identity: "actions/checkout", ref: "a".repeat(40) },
        { kind: "container", identity: "node", digest: `sha256:${"b".repeat(64)}` },
        { kind: "download", identity: "tool", sha256: "c".repeat(64) },
        { kind: "local", identity: "native/driver.c" },
      ],
    })).toEqual({ ok: true })
  })

  it("derives normative execution closures from workflow and entry bytes", async () => {
    const { buildExecutionClosure, validateExecutionClosure } = await loadClosure()
    const workflowPath = ".github/workflows/developer-id-signing.yml"
    const driverPath = "native/developer-id-signing/driver.c"
    const workflowBytes = readFileSync(join(repoRoot, workflowPath), "utf8")
    const driverBytes = readFileSync(join(repoRoot, driverPath))
    const contractPaths = [
      ".github/actions/release-trust/canonicalize.mjs",
      ".github/actions/release-trust/protected-store.mjs",
      ".github/actions/release-trust/run-reconciliation.mjs",
      ".github/actions/release-trust/workflow-closure.mjs",
      "package.json",
      "package-lock.json",
    ]
    const checkedOutFileBytesByPath = Object.fromEntries([
      ...contractPaths.map((path) => [path, readFileSync(join(repoRoot, path))]),
      [driverPath, driverBytes],
    ])
    const systemExecutableEvidenceByCommand = {
      clang: {
        realpath: "/usr/bin/clang",
        sha256: "1".repeat(64),
        designatedRequirementSha256: null,
      },
      node: {
        realpath: "/usr/local/bin/node",
        sha256: "2".repeat(64),
        designatedRequirementSha256: "3".repeat(64),
      },
      xcrun: {
        realpath: "/usr/bin/xcrun",
        sha256: "4".repeat(64),
        designatedRequirementSha256: null,
      },
    }
    const input = {
      workflowPath,
      workflowBytes,
      driverPath,
      driverBytes,
      driverKind: "signing",
      checkedOutFileBytesByPath,
      systemExecutableEvidenceByCommand,
    }

    const closure = buildExecutionClosure(input)
    expect(closure).toMatchObject({
      schemaVersion: 1,
      workflowPath,
      workflowBlobSha256: sha256(workflowBytes),
      signingDriverPath: driverPath,
      signingDriverSha256: sha256(driverBytes),
      closureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    expect(closure.entries.map((entry: any) => entry.kind)).toEqual([
      "action",
      "action",
      "checked-out-file",
      "checked-out-file",
      "checked-out-file",
      "checked-out-file",
      "checked-out-file",
      "checked-out-file",
      "checked-out-file",
      "system-executable",
      "system-executable",
      "system-executable",
    ])
    expect(validateExecutionClosure({ ...input, closure })).toEqual({ ok: true })
    expect(validateExecutionClosure({
      ...input,
      closure: { ...closure, allDownloadsHashVerifiedBeforeExecution: false },
    })).toMatchObject({ ok: false, code: "execution_closure_mismatch" })
    expect(validateExecutionClosure({ ...input, closure: null })).toMatchObject({
      ok: false,
      code: "execution_closure_mismatch",
    })
    expect(validateExecutionClosure({
      ...input,
      checkedOutFileBytesByPath: null,
      closure,
    })).toMatchObject({ ok: false, code: "execution_closure_mismatch" })

    const invalidInputs = [
      { workflowPath: null },
      { workflowPath: "workflow.yml" },
      { workflowBytes: null },
      { driverPath: null },
      { driverPath: "" },
      { driverBytes: {} },
      { driverKind: "other" },
      { checkedOutFileBytesByPath: null },
      { checkedOutFileBytesByPath: [] },
      { systemExecutableEvidenceByCommand: null },
      { systemExecutableEvidenceByCommand: [] },
    ]
    for (const invalid of invalidInputs) {
      expect(() => buildExecutionClosure({ ...input, ...invalid })).toThrow(/generator input/i)
    }

    expect(() => buildExecutionClosure({
      ...input,
      workflowBytes: "steps:\n  - name: checkout\n    uses: actions/checkout@v6\n",
    })).toThrow(/immutable action/i)
    expect(() => buildExecutionClosure({
      ...input,
      workflowBytes: `steps:\n  - name: reusable\n    uses: owner/repo/.github/workflows/x.yml@${"1".repeat(40)}\n`,
    })).toThrow(/immutable action/i)
    expect(() => buildExecutionClosure({ ...input, workflowBytes: "steps: []\n" })).toThrow(/workflow|action/i)
    expect(() => buildExecutionClosure({
      ...input,
      workflowPath: ".github/workflows/developer-id-pair-canary.yml",
    })).toThrow(/workflow plan mismatch/i)
    expect(() => buildExecutionClosure({
      ...input,
      driverPath: "native/developer-id-signing/other.c",
    })).toThrow(/workflow plan mismatch/i)
    expect(() => buildExecutionClosure({
      ...input,
      workflowBytes: workflowBytes.replace("admit-secret-workflow signing", "admit-secret-workflow pair-canary"),
    })).toThrow(/commands do not match/i)
    expect(() => buildExecutionClosure({
      ...input,
      driverBytes: Buffer.from("substituted-driver"),
    })).toThrow(/does not bind the driver source/i)
    expect(() => buildExecutionClosure({
      ...input,
      checkedOutFileBytesByPath: Object.fromEntries(
        Object.entries(checkedOutFileBytesByPath).filter(([path]) => path !== driverPath),
      ),
    })).toThrow(/checked-out evidence/i)
    expect(() => buildExecutionClosure({
      ...input,
      checkedOutFileBytesByPath: { ...checkedOutFileBytesByPath, "extra.mjs": Buffer.from("extra") },
    })).toThrow(/unexpected checked-out evidence/i)
    expect(() => buildExecutionClosure({
      ...input,
      systemExecutableEvidenceByCommand: {
        node: systemExecutableEvidenceByCommand.node,
        xcrun: systemExecutableEvidenceByCommand.xcrun,
      },
    })).toThrow(/system executable evidence/i)
    expect(() => buildExecutionClosure({
      ...input,
      systemExecutableEvidenceByCommand: {
        ...systemExecutableEvidenceByCommand,
        shell: systemExecutableEvidenceByCommand.xcrun,
      },
    })).toThrow(/unexpected system executable evidence/i)
    for (const evidence of [
      { ...systemExecutableEvidenceByCommand, node: { ...systemExecutableEvidenceByCommand.node, realpath: "bin/node" } },
      { ...systemExecutableEvidenceByCommand, node: { ...systemExecutableEvidenceByCommand.node, realpath: "/bin/not-node" } },
      { ...systemExecutableEvidenceByCommand, node: { ...systemExecutableEvidenceByCommand.node, sha256: "bad" } },
      { ...systemExecutableEvidenceByCommand, node: { ...systemExecutableEvidenceByCommand.node, designatedRequirementSha256: undefined } },
      { ...systemExecutableEvidenceByCommand, node: { ...systemExecutableEvidenceByCommand.node, designatedRequirementSha256: "bad" } },
    ]) {
      expect(() => buildExecutionClosure({
        ...input,
        systemExecutableEvidenceByCommand: evidence,
      })).toThrow(/system executable evidence/i)
    }
  })

  it("rejects incomplete rotation chains and stale-pair supersession", async () => {
    const { verifyPolicyChain } = await loadClosure()
    const requiredInceptionMembers = {
      workflowSha256: "1".repeat(64),
      closureSha256: "2".repeat(64),
      policySha256: "3".repeat(64),
      foundationSha256: "4".repeat(64),
    }
    const valid = {
      inceptionHead: "a".repeat(64),
      activeHead: "c".repeat(64),
      requiredInceptionMembers,
      inceptionAuthority: { namedMembers: requiredInceptionMembers },
      foundation: {
        fulcioRoots: [{ sha256: "5".repeat(64) }],
        ctLogs: [{ publicKeySha256: "6".repeat(64) }],
        rekorLogs: [{ publicKeySha256: "7".repeat(64) }],
      },
      transitions: [
        {
          prior: "a".repeat(64),
          successor: "b".repeat(64),
          predecessorPolicySha256: "8".repeat(64),
          signingPolicySha256: "8".repeat(64),
          predecessorSignatureVerified: true,
        },
        {
          prior: "b".repeat(64),
          successor: "c".repeat(64),
          predecessorPolicySha256: "9".repeat(64),
          signingPolicySha256: "9".repeat(64),
          predecessorSignatureVerified: true,
        },
      ],
      freshPairAuthority: true,
      terminalNoValidArtifactListing: true,
    }

    expect(verifyPolicyChain(valid)).toMatchObject({
      ok: false,
      code: "verification_evidence_required",
    })
    expect(verifyPolicyChain({ ...valid, transitions: [valid.transitions[1]] })).toMatchObject({
      ok: false,
      code: "rotation_chain_incomplete",
    })
    expect(verifyPolicyChain({ ...valid, freshPairAuthority: false })).toMatchObject({
      ok: false,
      code: "fresh_pair_required",
    })
    expect(verifyPolicyChain({ ...valid, terminalNoValidArtifactListing: false })).toMatchObject({
      ok: false,
      code: "terminal_artifact_authority_required",
    })
    expect(verifyPolicyChain({
      ...valid,
      transitions: [
        valid.transitions[0],
        {
          ...valid.transitions[1],
          signingPolicySha256: "0".repeat(64),
          predecessorSignatureVerified: true,
        },
      ],
    })).toMatchObject({ ok: false, code: "successor_self_authorized" })
    expect(verifyPolicyChain({
      ...valid,
      inceptionAuthority: {
        namedMembers: { ...requiredInceptionMembers, workflowSha256: "0".repeat(64) },
      },
    })).toMatchObject({ ok: false, code: "inception_member_mismatch" })
    expect(verifyPolicyChain({
      ...valid,
      requiredInceptionMembers: null,
    })).toMatchObject({ ok: false, code: "inception_member_mismatch" })
    expect(verifyPolicyChain({
      ...valid,
      inceptionAuthority: { namedMembers: null },
    })).toMatchObject({ ok: false, code: "inception_member_mismatch" })
    expect(verifyPolicyChain({
      ...valid,
      foundation: { ...valid.foundation, ctLogs: [] },
    })).toMatchObject({ ok: false, code: "foundation_incomplete" })
    expect(verifyPolicyChain(null)).toMatchObject({ ok: false, code: "inception_member_mismatch" })
    expect(verifyPolicyChain({ ...valid, foundation: null })).toMatchObject({
      ok: false,
      code: "foundation_incomplete",
    })
    expect(verifyPolicyChain({
      ...valid,
      foundation: { ...valid.foundation, fulcioRoots: [] },
    })).toMatchObject({ ok: false, code: "foundation_incomplete" })
    expect(verifyPolicyChain({
      ...valid,
      foundation: { ...valid.foundation, rekorLogs: [] },
    })).toMatchObject({ ok: false, code: "foundation_incomplete" })
    expect(verifyPolicyChain({ ...valid, transitions: null })).toMatchObject({
      ok: false,
      code: "rotation_chain_invalid",
    })
    expect(verifyPolicyChain({
      ...valid,
      transitions: [{ ...valid.transitions[0], predecessorSignatureVerified: false }, valid.transitions[1]],
    })).toMatchObject({ ok: false, code: "rotation_chain_incomplete" })
    expect(verifyPolicyChain({ ...valid, activeHead: "d".repeat(64) })).toMatchObject({
      ok: false,
      code: "rotation_chain_incomplete",
    })
  })

  it("uses a dedicated keyless workflow to seal the canonical inception body", () => {
    const workflow = loadWorkflow("release-trust-inception-seal.yml")
    const jobs = workflow.jobs

    expect(workflow.name).toBe("release-trust-inception-seal")
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(jobs)).toEqual(["seal"])
    expect(jobs.seal.permissions).toEqual({ contents: "read", "id-token": "write" })
    expect(workflow.environment).toBeUndefined()
    expect(jobs.seal.environment).toBeUndefined()
    expect(jobs.seal.steps.every((step: any) => step.if === undefined)).toBe(true)
    expect(jobs.seal.steps.filter((step: any) => step.uses).every(
      (step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses),
    )).toBe(true)
    const installStep = jobs.seal.steps.find(
      (step: any) => step.name === "Install pinned release trust dependencies",
    )
    const materializeStep = jobs.seal.steps.find(
      (step: any) => step.name === "Reconstruct exact inception seal body bytes",
    )
    expect(installStep?.run).toBe("npm ci --ignore-scripts")
    expect(jobs.seal.steps.indexOf(installStep)).toBeLessThan(jobs.seal.steps.indexOf(materializeStep))
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("sealBodyBase64")
    expect(serialized).toContain("release-trust-inception-seal-body.v1.json")
    expect(serialized).toContain("cosign")
    expect(serialized).not.toContain("${{ secrets.")
    expect(serialized).not.toContain("Developer ID Application")
    expect(jobs.seal.steps.filter((step: any) => step.run).every(
      (step: any) => !step.run.includes("${{ inputs."),
    )).toBe(true)
  })
})
