import { createHash } from "crypto"
import { readFileSync } from "fs"
import { pathToFileURL } from "url"
import { join } from "path"

import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()

async function loadTrustAction(name: string) {
  return import(pathToFileURL(join(repoRoot, ".github", "actions", "release-trust", name)).href)
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function inceptionFixture() {
  const implementationMergeSha = "1".repeat(40)
  const authorityMergeSha = "2".repeat(40)
  const carrierCommitSha = "3".repeat(40)
  const treeSha256 = "4".repeat(64)
  const requiredMembers = {
    signingWorkflowSha256: "5".repeat(64),
    signingClosureSha256: "6".repeat(64),
    pairCanaryWorkflowSha256: "7".repeat(64),
    pairCanaryClosureSha256: "8".repeat(64),
    sealWorkflowSha256: "9".repeat(64),
    sealClosureSha256: "a".repeat(64),
    initialPolicySha256: "b".repeat(64),
    pairCanaryPolicySha256: "c".repeat(64),
    foundationSha256: "d".repeat(64),
  }
  const bootstrapEvidenceContent = {
    bootstrapMergeSha: implementationMergeSha,
    bootstrapTreeSha256: treeSha256,
    containsFinalReviewedImplementationAndReleaseScripts: true,
    evidenceKind: "protected-main-implementation-bootstrap-merge-v1",
    githubAuditEvidenceSha256: "e".repeat(64),
    noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffect: true,
    releaseRequestAbsentSoPublishLaneSkipped: true,
    repository: "ourostack/ouroboros",
    repositoryDatabaseId: 1169669354,
    repositoryNodeId: "R_kgDORbe86g",
    schemaVersion: 1,
    subagentReviewReceiptsSha256: "f".repeat(64),
  }
  const bootstrapEvidenceContentBytes = JSON.stringify(bootstrapEvidenceContent)
  const bootstrapEvidence = {
    content: bootstrapEvidenceContent,
    contentSha256: sha256(bootstrapEvidenceContentBytes),
    contentSha256EqualsSha256OfJcsContent: true,
  }
  const bootstrapEvidenceBytes = JSON.stringify(bootstrapEvidence)
  const authority = {
    authorityKind: "one-time-protected-main-trust-inception-v1",
    bootstrapEvidenceSha256: sha256(bootstrapEvidenceBytes),
    bootstrapMergeSha: implementationMergeSha,
    bootstrapTreeSha256: treeSha256,
    createdBeforeAnyDeveloperIdSecretMutation: true,
    initialPolicySha256: requiredMembers.initialPolicySha256,
    noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffectInBootstrap: true,
    pairCanaryExecutionClosureSha256: requiredMembers.pairCanaryClosureSha256,
    pairCanaryFoundationSha256: requiredMembers.foundationSha256,
    pairCanaryTrustPolicySha256: requiredMembers.pairCanaryPolicySha256,
    pairCanaryWorkflowBlobSha256: requiredMembers.pairCanaryWorkflowSha256,
    releaseRequestAbsentSoPublishLaneSkipped: true,
    repository: "ourostack/ouroboros",
    repositoryDatabaseId: 1169669354,
    repositoryNodeId: "R_kgDORbe86g",
    schemaVersion: 1,
    signingExecutionClosureSha256: requiredMembers.signingClosureSha256,
    signingWorkflowBlobSha256: requiredMembers.signingWorkflowSha256,
    inceptionSealExecutionClosureSha256: requiredMembers.sealClosureSha256,
    inceptionSealWorkflowBlobSha256: requiredMembers.sealWorkflowSha256,
  }
  const authorityBytes = JSON.stringify(authority)
  const policyHead = {
    activation: {
      authoritySha256: sha256(authorityBytes),
      kind: "inception",
    },
    activePolicySha256: requiredMembers.initialPolicySha256,
    activePolicyVersion: 1,
    priorHeadSha256: null,
    revision: 1,
    schemaVersion: 1,
  }
  const policyHeadBytes = JSON.stringify(policyHead)
  const authorityMergeAuditBytes = JSON.stringify({
    mergeSha: authorityMergeSha,
    pullRequestNumber: 901,
    treeSha256: "0".repeat(64),
  })
  const sealBody = {
    authorityMergeAuditEvidenceSha256: sha256(authorityMergeAuditBytes),
    authorityMergeSha,
    authoritySha256: sha256(authorityBytes),
    bootstrapEvidenceSha256: sha256(bootstrapEvidenceBytes),
    bootstrapMergeSha: implementationMergeSha,
    headSha256: sha256(policyHeadBytes),
    policySha256: requiredMembers.initialPolicySha256,
    schemaVersion: 1,
  }
  const sealBodyBytes = JSON.stringify(sealBody)
  const sealSignatureBytes = JSON.stringify({
    certificateIdentity: "https://github.com/ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
    oidcIssuer: "https://token.actions.githubusercontent.com",
    subjectSha256: sha256(sealBodyBytes),
  })
  const carrier = {
    body: sealBody,
    bodySha256: sha256(sealBodyBytes),
    signatureSha256: sha256(sealSignatureBytes),
  }
  const carrierBytes = JSON.stringify(carrier)

  return {
    schemaVersion: 1,
    currentHead: null,
    implementationMerge: { sha: implementationMergeSha, treeSha256 },
    bootstrapEvidence: { value: bootstrapEvidence, bytes: bootstrapEvidenceBytes },
    authority: {
      value: authority,
      bytes: authorityBytes,
      introducedByMergeSha: authorityMergeSha,
      describedMergeSha: implementationMergeSha,
    },
    policyHead: { value: policyHead, bytes: policyHeadBytes },
    requiredMembers,
    authorityMerge: { sha: authorityMergeSha, auditBytes: authorityMergeAuditBytes },
    seal: { body: sealBody, bodyBytes: sealBodyBytes, signatureBytes: sealSignatureBytes },
    carrier: {
      value: carrier,
      bytes: carrierBytes,
      introducedByMergeSha: carrierCommitSha,
      selfReference: null,
    },
    externalCarrierReceipt: {
      carrierCommitSha,
      carrierBlobSha256: sha256(carrierBytes),
      exactSealBlobIntroducedByCarrierMerge: true,
    },
  }
}

describe("release trust bootstrap contract", () => {
  it("canonicalizes authority bytes with RFC 8785 semantics", async () => {
    const { canonicalize, sha256Jcs } = await loadTrustAction("canonicalize.mjs")
    const authority = {
      schemaVersion: 1,
      implementationMergeSha: "1".repeat(40),
      evidence: { z: 2, a: 1 },
    }

    const canonical = canonicalize(authority)

    expect(canonical).toBe(
      '{"evidence":{"a":1,"z":2},"implementationMergeSha":"1111111111111111111111111111111111111111","schemaVersion":1}',
    )
    expect(sha256Jcs(authority)).toBe(sha256(canonical))
    expect(() => canonicalize({ invalid: Number.NaN })).toThrow(/finite|RFC 8785/i)
  })

  it("constructs one byte-complete three-merge inception and closes it externally", async () => {
    const { validateInception } = await loadTrustAction("protected-store.mjs")
    const base = inceptionFixture()

    expect(validateInception(base)).toEqual({ ok: true })
    expect(validateInception({ ...base, externalCarrierReceipt: null })).toMatchObject({
      ok: false,
      code: "carrier_receipt_required",
    })
    expect(validateInception({
      ...base,
      externalCarrierReceipt: {
        ...base.externalCarrierReceipt,
        carrierBlobSha256: "0".repeat(64),
      },
    })).toMatchObject({ ok: false, code: "carrier_blob_mismatch" })
  })

  it("rejects a second inception, changed bytes, and authority cycles", async () => {
    const { validateInception } = await loadTrustAction("protected-store.mjs")
    const base = inceptionFixture()

    expect(validateInception({ ...base, currentHead: { revision: 1 } })).toMatchObject({
      ok: false,
      code: "inception_head_exists",
    })
    expect(validateInception({
      ...base,
      authority: { ...base.authority, bytes: `${base.authority.bytes} ` },
    })).toMatchObject({ ok: false, code: "authority_bytes_mismatch" })
    expect(validateInception({
      ...base,
      authority: {
        ...base.authority,
        describedMergeSha: base.authority.introducedByMergeSha,
      },
    })).toMatchObject({ ok: false, code: "authority_self_reference" })
    expect(validateInception({
      ...base,
      carrier: { ...base.carrier, selfReference: base.carrier.introducedByMergeSha },
    })).toMatchObject({ ok: false, code: "carrier_self_reference" })
  })

  it("rejects incomplete evidence, changed audit bytes, and unnamed inception leaves", async () => {
    const { validateInception } = await loadTrustAction("protected-store.mjs")
    const base = inceptionFixture()

    expect(validateInception({
      ...base,
      bootstrapEvidence: {
        ...base.bootstrapEvidence,
        value: {
          ...base.bootstrapEvidence.value,
          content: {
            ...base.bootstrapEvidence.value.content,
            containsFinalReviewedImplementationAndReleaseScripts: false,
          },
        },
      },
    })).toMatchObject({ ok: false, code: "bootstrap_evidence_incomplete" })
    expect(validateInception({
      ...base,
      authorityMerge: {
        ...base.authorityMerge,
        auditBytes: `${base.authorityMerge.auditBytes}\n`,
      },
    })).toMatchObject({ ok: false, code: "authority_audit_bytes_mismatch" })
    expect(validateInception({
      ...base,
      requiredMembers: {
        ...base.requiredMembers,
        foundationSha256: "0".repeat(64),
      },
    })).toMatchObject({ ok: false, code: "inception_member_mismatch" })
  })

  it("requires online immutable-Git and exact keyless-seal evidence for absent-head adoption", async () => {
    const { validateAbsentHeadAdoption } = await loadTrustAction("protected-store.mjs")
    const complete = {
      online: true,
      immutableGitObjectsVerified: true,
      workflowRefVerified: true,
      oidcIdentityVerified: true,
      fulcioChainVerified: true,
      ctLogVerified: true,
      rekorEntryVerified: true,
      carrierBlobVerified: true,
      historicalHeadersUsedAsAuthority: false,
    }

    expect(validateAbsentHeadAdoption(complete)).toEqual({ ok: true })
    expect(validateAbsentHeadAdoption({ ...complete, online: false })).toMatchObject({
      ok: false,
      code: "online_reacquisition_required",
    })
    expect(validateAbsentHeadAdoption({ ...complete, ctLogVerified: false })).toMatchObject({
      ok: false,
      code: "sigstore_evidence_incomplete",
    })
    expect(validateAbsentHeadAdoption({
      ...complete,
      historicalHeadersUsedAsAuthority: true,
    })).toMatchObject({ ok: false, code: "historical_transport_not_authority" })
  })

  it("pins a complete offline Sigstore trust foundation", () => {
    const foundation = JSON.parse(readFileSync(
      join(repoRoot, "release", "trust", "sigstore-foundation.v1.json"),
      "utf8",
    ))

    expect(foundation).toMatchObject({
      schemaVersion: 1,
      fulcioRoots: expect.any(Array),
      ctLogs: expect.any(Array),
      rekorLogs: expect.any(Array),
    })
    expect(foundation.fulcioRoots).not.toHaveLength(0)
    expect(foundation.ctLogs).not.toHaveLength(0)
    expect(foundation.rekorLogs).not.toHaveLength(0)
    expect(JSON.stringify(foundation)).not.toMatch(/https?:\/\//)
  })
})
