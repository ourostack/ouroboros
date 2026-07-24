import { execFileSync } from "child_process"
import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import { join } from "path"

import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()

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
    expect(jobs.signing.steps.every((step: any) => step.if !== false && step.if !== "${{ false }}")).toBe(true)
    const actionSteps = jobs.signing.steps.filter((step: any) => step.uses)
    expect(actionSteps.every((step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses))).toBe(true)
    const secretSteps = jobs.signing.steps.filter((step: any) => JSON.stringify(step).includes("${{ secrets."))
    expect(secretSteps).toHaveLength(1)
    expect(secretSteps[0].run).toContain("native/developer-id-signing/driver")
    expect(secretSteps[0].run).toContain("--validate-frame")
    expect(secretSteps[0].run).toContain("env: {}")

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

    expect(verifyPolicyChain(valid)).toEqual({ ok: true })
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
      foundation: { ...valid.foundation, ctLogs: [] },
    })).toMatchObject({ ok: false, code: "foundation_incomplete" })
  })

  it("uses a dedicated keyless workflow to seal authority-merge audit bytes", () => {
    const workflow = loadWorkflow("release-trust-inception-seal.yml")
    const jobs = workflow.jobs

    expect(workflow.name).toBe("release-trust-inception-seal")
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"])
    expect(Object.keys(jobs)).toEqual(["seal"])
    expect(jobs.seal.permissions).toEqual({ contents: "read", "id-token": "write" })
    expect(workflow.environment).toBeUndefined()
    expect(jobs.seal.environment).toBeUndefined()
    expect(jobs.seal.steps.every((step: any) => step.if !== false && step.if !== "${{ false }}")).toBe(true)
    expect(jobs.seal.steps.filter((step: any) => step.uses).every(
      (step: any) => /^[^\s@]+\/[^\s@]+@[a-f0-9]{40}$/.test(step.uses),
    )).toBe(true)
    const serialized = JSON.stringify(workflow)
    expect(serialized).toContain("authority-merge-audit")
    expect(serialized).toContain("cosign")
    expect(serialized).not.toContain("${{ secrets.")
    expect(serialized).not.toContain("Developer ID Application")
  })
})
