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

function canonicalFixture(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalFixture(value[key])}`
  )).join(",")}}`
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
  const bootstrapEvidenceContentBytes = canonicalFixture(bootstrapEvidenceContent)
  const bootstrapEvidence = {
    content: bootstrapEvidenceContent,
    contentSha256: sha256(bootstrapEvidenceContentBytes),
    contentSha256EqualsSha256OfJcsContent: true,
  }
  const bootstrapEvidenceBytes = canonicalFixture(bootstrapEvidence)
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
  const authorityBytes = canonicalFixture(authority)
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
  const policyHeadBytes = canonicalFixture(policyHead)
  const authorityMergeAuditBytes = canonicalFixture({
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
  const sealBodyBytes = canonicalFixture(sealBody)
  const sealSignatureBytes = canonicalFixture({
    certificateIdentity: "https://github.com/ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
    oidcIssuer: "https://token.actions.githubusercontent.com",
    subjectSha256: sha256(sealBodyBytes),
  })
  const carrier = {
    body: sealBody,
    bodySha256: sha256(sealBodyBytes),
    signatureSha256: sha256(sealSignatureBytes),
  }
  const carrierBytes = canonicalFixture(carrier)

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

  it("rejects every non-I-JSON canonicalization shape", async () => {
    const { canonicalize } = await loadTrustAction("canonicalize.mjs")
    const cyclic: any = {}
    cyclic.self = cyclic
    const nullPrototype = Object.create(null)
    nullPrototype.ok = true

    expect(canonicalize(null)).toBe("null")
    expect(canonicalize(false)).toBe("false")
    expect(canonicalize([0, "\ud83d\ude00"])).toBe('[0,"😀"]')
    expect(canonicalize(nullPrototype)).toBe('{"ok":true}')
    expect(() => canonicalize(undefined)).toThrow(/cannot canonicalize/i)
    expect(() => canonicalize(new Date(0))).toThrow(/JSON objects/i)
    expect(() => canonicalize(cyclic)).toThrow(/cyclic/i)
    expect(() => canonicalize("\ud800")).toThrow(/surrogate/i)
    expect(() => canonicalize("\udc00")).toThrow(/surrogate/i)
    expect(() => canonicalize({ "\ud800": true })).toThrow(/surrogate/i)
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
    const wrongRepositoryAuthority = {
      ...base.authority.value,
      repository: "attacker/fork",
    }
    expect(validateInception({
      ...base,
      authority: {
        ...base.authority,
        value: wrongRepositoryAuthority,
        bytes: canonicalFixture(wrongRepositoryAuthority),
      },
    })).toMatchObject({ ok: false, code: "inception_identity_mismatch" })
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
    expect(validateInception({
      ...base,
      bootstrapEvidence: { ...base.bootstrapEvidence, bytes: `${base.bootstrapEvidence.bytes}\n` },
    })).toMatchObject({ ok: false, code: "bootstrap_evidence_bytes_mismatch" })
    expect(validateInception({
      ...base,
      bootstrapEvidence: {
        value: { ...base.bootstrapEvidence.value, contentSha256: "0".repeat(64) },
        bytes: canonicalFixture({ ...base.bootstrapEvidence.value, contentSha256: "0".repeat(64) }),
      },
    })).toMatchObject({ ok: false, code: "bootstrap_evidence_hash_mismatch" })
    expect(validateInception({
      ...base,
      authority: { ...base.authority, describedMergeSha: "f".repeat(40) },
    })).toMatchObject({ ok: false, code: "authority_bootstrap_merge_mismatch" })
    expect(validateInception({
      ...base,
      policyHead: { ...base.policyHead, bytes: `${base.policyHead.bytes} ` },
    })).toMatchObject({ ok: false, code: "inception_bytes_mismatch" })
    expect(validateInception({
      ...base,
      authority: {
        ...base.authority,
        value: { ...base.authority.value, bootstrapTreeSha256: "0".repeat(64) },
        bytes: canonicalFixture({ ...base.authority.value, bootstrapTreeSha256: "0".repeat(64) }),
      },
    })).toMatchObject({ ok: false, code: "authority_bootstrap_evidence_mismatch" })
    expect(validateInception({
      ...base,
      policyHead: {
        value: { ...base.policyHead.value, revision: 2 },
        bytes: canonicalFixture({ ...base.policyHead.value, revision: 2 }),
      },
    })).toMatchObject({ ok: false, code: "inception_head_invalid" })
    expect(validateInception({
      ...base,
      seal: { ...base.seal, bodyBytes: `${base.seal.bodyBytes} ` },
    })).toMatchObject({ ok: false, code: "seal_body_bytes_mismatch" })
    expect(validateInception({
      ...base,
      seal: {
        ...base.seal,
        body: { ...base.seal.body, authoritySha256: "0".repeat(64) },
        bodyBytes: canonicalFixture({ ...base.seal.body, authoritySha256: "0".repeat(64) }),
      },
    })).toMatchObject({ ok: false, code: "seal_body_authority_mismatch" })
    expect(validateInception({
      ...base,
      carrier: {
        ...base.carrier,
        value: { ...base.carrier.value, signatureSha256: "0".repeat(64) },
        bytes: canonicalFixture({ ...base.carrier.value, signatureSha256: "0".repeat(64) }),
      },
    })).toMatchObject({ ok: false, code: "carrier_seal_mismatch" })
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

    expect(validateAbsentHeadAdoption(complete)).toMatchObject({
      ok: false,
      code: "verification_evidence_required",
    })
    expect(validateAbsentHeadAdoption({ ...complete, online: false })).toMatchObject({
      ok: false,
      code: "online_reacquisition_required",
    })
    for (const field of [
      "immutableGitObjectsVerified",
      "workflowRefVerified",
      "oidcIdentityVerified",
      "fulcioChainVerified",
      "ctLogVerified",
      "rekorEntryVerified",
      "carrierBlobVerified",
    ]) {
      expect(validateAbsentHeadAdoption({ ...complete, [field]: false })).toMatchObject({
        ok: false,
        code: "sigstore_evidence_incomplete",
      })
    }
    expect(validateAbsentHeadAdoption({
      ...complete,
      historicalHeadersUsedAsAuthority: true,
    })).toMatchObject({ ok: false, code: "historical_transport_not_authority" })
  })

  it("pins a complete offline Sigstore trust foundation", async () => {
    const { validateFoundation } = await loadTrustAction("protected-store.mjs")
    const foundation = JSON.parse(readFileSync(
      join(repoRoot, "release", "trust", "sigstore-foundation.v1.json"),
      "utf8",
    ))

    expect(validateFoundation(foundation)).toEqual({ ok: true })
    expect(foundation).toMatchObject({
      schemaVersion: 1,
      source: {
        rootVersion: expect.any(Number),
        rootSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        repositoryCommit: expect.stringMatching(/^[a-f0-9]{40}$/),
        trustedRootBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
        trustedRootSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    })
    expect(createHash("sha256").update(Buffer.from(
      foundation.source.trustedRootBase64,
      "base64",
    )).digest("hex")).toBe(foundation.source.trustedRootSha256)
    for (const entry of [...foundation.fulcioRoots, ...foundation.ctLogs, ...foundation.rekorLogs]) {
      expect(entry).toMatchObject({
        keyId: expect.stringMatching(/^[a-f0-9]{64}$/),
        publicKeyDerBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
        publicKeySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        validFor: { start: expect.any(String), end: expect.any(String) },
      })
    }
    expect(JSON.stringify(foundation)).not.toMatch(/https?:\/\//)
    expect(validateFoundation({
      ...foundation,
      ctLogs: [...foundation.ctLogs, foundation.ctLogs[0]],
    })).toMatchObject({ ok: false, code: "foundation_entry_duplicate" })
    expect(validateFoundation({
      ...foundation,
      rekorLogs: [{ ...foundation.rekorLogs[0], publicKeySha256: null }],
    })).toMatchObject({ ok: false, code: "foundation_entry_invalid" })
    expect(validateFoundation({
      ...foundation,
      fulcioRoots: [{ ...foundation.fulcioRoots[0], publicKeyDerBase64: "not base64!" }],
    })).toMatchObject({ ok: false, code: "foundation_entry_invalid" })
    expect(validateFoundation({ ...foundation, fulcioRoots: [] })).toMatchObject({
      ok: false,
      code: "foundation_incomplete",
    })
    expect(validateFoundation({
      ...foundation,
      source: { ...foundation.source, rootSha256: "0".repeat(64) },
    })).toMatchObject({ ok: false, code: "foundation_source_invalid" })
    expect(validateFoundation({
      ...foundation,
      source: { ...foundation.source, rootVersion: foundation.source.rootVersion + 1 },
    })).toMatchObject({ ok: false, code: "foundation_source_invalid" })
    const invalidRootBytes = Buffer.from("{not-json", "utf8")
    expect(validateFoundation({
      ...foundation,
      source: {
        ...foundation.source,
        rootBase64: invalidRootBytes.toString("base64"),
        rootSha256: createHash("sha256").update(invalidRootBytes).digest("hex"),
      },
    })).toMatchObject({ ok: false, code: "foundation_source_invalid" })
    const emptyTrustedRootBytes = Buffer.from("{}", "utf8")
    expect(validateFoundation({
      ...foundation,
      source: {
        ...foundation.source,
        trustedRootBase64: emptyTrustedRootBytes.toString("base64"),
        trustedRootSha256: createHash("sha256").update(emptyTrustedRootBytes).digest("hex"),
      },
    })).toMatchObject({ ok: false, code: "foundation_projection_mismatch" })
    expect(validateFoundation({
      ...foundation,
      rekorLogs: [{ ...foundation.rekorLogs[0], publicKeyDerBase64: "A" }],
    })).toMatchObject({ ok: false, code: "foundation_entry_invalid" })
    expect(validateFoundation({
      ...foundation,
      ctLogs: [{ ...foundation.ctLogs[0], keyId: "0".repeat(64) }, ...foundation.ctLogs.slice(1)],
    })).toMatchObject({ ok: false, code: "foundation_projection_mismatch" })
  })
})
