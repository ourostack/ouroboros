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

describe("Developer ID signing workflow contract", () => {
  it("keeps signing secrets out of environments and binds immutable authority inputs", () => {
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "developer-id-signing.yml"),
      "utf8",
    )

    expect(workflow).toContain("name: developer-id-signing")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("contents: read")
    expect(workflow).not.toMatch(/^\s*environment:/m)
    expect(workflow).toContain("attempt-authority")
    expect(workflow).toContain("active-pair-authority")
    expect(workflow).toContain("workflow_ref")
    expect(workflow).toContain("release-trust-inception-head")
    expect(workflow).not.toContain("GITHUB_ENV")
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
    const workflow = readFileSync(
      join(repoRoot, ".github", "workflows", "release-trust-inception-seal.yml"),
      "utf8",
    )

    expect(workflow).toContain("name: release-trust-inception-seal")
    expect(workflow).toContain("id-token: write")
    expect(workflow).toContain("authority-merge-audit")
    expect(workflow).toContain("cosign")
    expect(workflow).not.toMatch(/^\s*environment:/m)
    expect(workflow).not.toContain("Developer ID Application")
  })
})
