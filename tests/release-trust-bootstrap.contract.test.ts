import { execFileSync } from "child_process"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { pathToFileURL } from "url"
import { join } from "path"

import { describe, expect, it } from "vitest"

const repoRoot = process.cwd()

async function loadTrustAction(name: string) {
  return import(pathToFileURL(join(repoRoot, ".github", "actions", "release-trust", name)).href)
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

function writeRepoFile(root: string, path: string, bytes: string): void {
  const destination = join(root, path)
  mkdirSync(join(destination, ".."), { recursive: true })
  writeFileSync(destination, bytes)
}

function git(root: string, args: string[], options: { encoding?: BufferEncoding | null } = {}): any {
  return execFileSync("git", args, {
    cwd: root,
    encoding: options.encoding === undefined ? "utf8" : options.encoding,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-24T00:00:00Z",
      GIT_AUTHOR_EMAIL: "fixture@ouro.test",
      GIT_AUTHOR_NAME: "Ouro Fixture",
      GIT_COMMITTER_DATE: "2026-07-24T00:00:00Z",
      GIT_COMMITTER_EMAIL: "fixture@ouro.test",
      GIT_COMMITTER_NAME: "Ouro Fixture",
    },
  })
}

function commitFixture(root: string, message: string): ReturnType<typeof inspectCommit> {
  git(root, ["add", "."])
  git(root, ["commit", "-q", "-m", message])
  return inspectCommit(root)
}

function inspectCommit(root: string, revision = "HEAD"): {
  sha: string
  treeOid: string
  treeSha256: string
  parentShas: string[]
} {
  const sha = git(root, ["rev-parse", revision]).trim()
  const treeOid = git(root, ["rev-parse", `${sha}^{tree}`]).trim()
  const parentShas = git(root, ["show", "-s", "--format=%P", sha]).trim().split(/\s+/).filter(Boolean)
  const tree = git(root, ["ls-tree", "-r", "-z", sha], { encoding: null }) as Buffer
  return { sha, treeOid, treeSha256: createHash("sha256").update(tree).digest("hex"), parentShas }
}

function inspectTreeEntry(root: string, revision: string, path: string): null | {
  path: string
  type: string
  oid: string
} {
  const output = git(root, ["ls-tree", "-z", revision, "--", path], { encoding: null }) as Buffer
  if (output.length === 0) return null
  const match = /^[0-7]{6} ([^ ]+) ([a-f0-9]{40})\t([^\0]+)\0$/.exec(output.toString("utf8"))
  if (!match || match[3] !== path) throw new Error("fixture tree entry is invalid")
  return { path: match[3], type: match[1], oid: match[2] }
}

function githubTree(root: string, revision: string): any {
  const treeOid = git(root, ["rev-parse", `${revision}^{tree}`]).trim()
  const output = git(root, ["ls-tree", "-r", "-z", revision], { encoding: null }) as Buffer
  const entries = output.toString("utf8").split("\0").filter(Boolean).map((line) => {
    const match = /^([0-7]{6}) ([^ ]+) ([a-f0-9]{40})\t(.+)$/.exec(line)
    if (!match) throw new Error("fixture GitHub tree is invalid")
    return { mode: match[1], type: match[2], sha: match[3], path: match[4] }
  })
  return { sha: treeOid, truncated: false, tree: entries }
}

function exchangeBody(exchange: any): any {
  return JSON.parse(Buffer.from(exchange.response.bodyBase64, "base64").toString("utf8"))
}

function mergeFixture(root: string, branch: string, message: string, mutate: () => void): ReturnType<typeof inspectCommit> {
  git(root, ["checkout", "-q", "-b", branch])
  mutate()
  commitFixture(root, `${message} change`)
  git(root, ["checkout", "-q", "main"])
  git(root, ["merge", "-q", "--no-ff", "-m", message, branch])
  return inspectCommit(root)
}

function immutableExchange(url: string, body: any): any {
  const request = {
    method: "GET",
    url,
    accept: "application/vnd.github+json",
    apiVersion: "2026-03-10",
    headersWithoutCredentialsBase64: Buffer.from("accept: application/vnd.github+json\n").toString("base64"),
    bodyBase64: "",
  }
  const response = {
    status: 200,
    headersBase64: Buffer.from("content-type: application/json\n").toString("base64"),
    bodyBase64: Buffer.from(canonicalFixture(body)).toString("base64"),
  }
  return {
    request,
    response,
    requestSha256: sha256(canonicalFixture(request)),
    responseSha256: sha256(canonicalFixture(response)),
    tlsPeerLeafDerSha256: "a".repeat(64),
    tlsPeerSpkiSha256: "b".repeat(64),
    acquiredAt: "2026-07-24T00:00:00.000Z",
  }
}

function githubEvidence(merge: {
  sha: string
  treeOid: string
  parentShas: string[]
  pullRequestNumber: number
}): any {
  const repositoryUrl = "https://api.github.com/repos/ourostack/ouroboros"
  const pullRequestUrl = `${repositoryUrl}/pulls/${merge.pullRequestNumber}`
  const commitUrl = `${repositoryUrl}/commits/${merge.sha}`
  return {
    repositoryIdentity: immutableExchange(repositoryUrl, {
      id: 1169669354,
      node_id: "R_kgDORbe86g",
      full_name: "ourostack/ouroboros",
      default_branch: "main",
      archived: false,
      html_url: "https://github.com/ourostack/ouroboros",
    }),
    pullRequest: immutableExchange(pullRequestUrl, {
      number: merge.pullRequestNumber,
      state: "closed",
      merged: true,
      draft: false,
      merge_commit_sha: merge.sha,
      base: {
        ref: "main",
        repo: {
          id: 1169669354,
          node_id: "R_kgDORbe86g",
          full_name: "ourostack/ouroboros",
          html_url: "https://github.com/ourostack/ouroboros",
        },
      },
      head: {
        sha: merge.parentShas[1],
        repo: {
          id: 1169669354,
          node_id: "R_kgDORbe86g",
          full_name: "ourostack/ouroboros",
          html_url: "https://github.com/ourostack/ouroboros",
        },
      },
      url: pullRequestUrl,
    }),
    mergeCommit: immutableExchange(commitUrl, {
      sha: merge.sha,
      commit: { tree: { sha: merge.treeOid } },
      parents: merge.parentShas.map((sha) => ({ sha, url: `${repositoryUrl}/commits/${sha}` })),
      html_url: `https://github.com/ourostack/ouroboros/commit/${merge.sha}`,
    }),
    reviews: [immutableExchange(`${pullRequestUrl}/reviews?per_page=100&page=1`, [{
      id: merge.pullRequestNumber * 10,
      state: "APPROVED",
      pull_request_url: pullRequestUrl,
      submitted_at: "2026-07-24T00:00:00Z",
      user: { id: 42, login: "independent-reviewer" },
    }])],
    checks: [immutableExchange(`${commitUrl}/check-runs?per_page=100&page=1`, {
      head_sha: merge.sha,
      total_count: 1,
      check_runs: [{
        id: merge.pullRequestNumber * 100,
        name: "required-ci",
        head_sha: merge.sha,
        status: "completed",
        conclusion: "success",
        details_url: `https://github.com/ourostack/ouroboros/actions/runs/${merge.pullRequestNumber}`,
      }],
    })],
    branchProtection: immutableExchange(`${repositoryUrl}/branches/main/protection`, {
      required_pull_request_reviews: { required_approving_review_count: 1 },
      required_status_checks: {
        strict: true,
        contexts: ["required-ci"],
        checks: [{ context: "required-ci", app_id: 15368 }],
      },
      enforce_admins: { enabled: true },
    }),
    pagesCompleteAndContiguous: true,
    everyRequestTargetsRepositoryDatabaseId1169669354AndNodeId: true,
    exactBodiesRetainedNoRedaction: true,
    credentialsExcludedFromRetainedHeaders: true,
  }
}

function canonicalFixture(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalFixture).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalFixture(value[key])}`
  )).join(",")}}`
}

function canonicalBinding(value: any): { value: any; bytes: string } {
  return { value, bytes: canonicalFixture(value) }
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
    const packageManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"))
    const lockfile = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8"))
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
    expect(packageManifest.dependencies["json-canonicalize"]).toBe("2.0.0")
    expect(lockfile.packages["node_modules/json-canonicalize"]).toMatchObject({
      version: "2.0.0",
      integrity: "sha512-yyrnK/mEm6Na3ChbJUWueXdapueW0p380RUyTW87XGb1ww8l8hU0pRrGC3vSWHe9CxrbPHX2fGUOZpNiHR0IIg==",
    })
    expect(canonicalize({
      numbers: [333333333.33333329, 1e30, 4.5, 0.002, 1e-27],
      literals: [null, true, false],
      string: "€$\u000f\nA'B\"\\\"/",
    })).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    )
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

    expect(validateInception(base)).toMatchObject({
      ok: false,
      code: "verification_evidence_required",
    })
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

  it("constructs and freshly verifies an acyclic three-merge inception from exact Git blobs", async () => {
    const {
      constructInceptionAuthority,
      constructInceptionCarrierReceipt,
      constructInceptionSealBody,
      constructInceptionSealCarrier,
      constructInceptionSealStatement,
      validateProtectedMergeSemantics,
      verifyFreshInception,
    } = await loadTrustAction("protected-store.mjs")
    const { buildExecutionClosure } = await loadTrustAction("workflow-closure.mjs")
    const root = mkdtempSync(join(tmpdir(), "ouro-inception-sequence-"))
    try {
      git(root, ["init", "-q", "-b", "main"])
      writeRepoFile(root, ".fixture-root", "root\n")
      commitFixture(root, "fixture root")
      const trustContractPaths = [
        ".github/actions/release-trust/canonicalize.mjs",
        ".github/actions/release-trust/protected-store.mjs",
        ".github/actions/release-trust/run-reconciliation.mjs",
        ".github/actions/release-trust/workflow-closure.mjs",
        "package.json",
        "package-lock.json",
      ]
      const sealWorkflowBytes = readFileSync(
        join(repoRoot, ".github/workflows/release-trust-inception-seal.yml"),
        "utf8",
      )
      const sealClosureBytes = canonicalFixture(buildExecutionClosure({
        workflowPath: ".github/workflows/release-trust-inception-seal.yml",
        workflowBytes: sealWorkflowBytes,
        driverKind: "seal",
        checkedOutFileBytesByPath: Object.fromEntries(
          trustContractPaths.map((path) => [path, readFileSync(join(repoRoot, path))]),
        ),
        systemExecutableEvidenceByCommand: {},
      }))
      const memberFiles: Record<string, string> = {
        ".github/workflows/developer-id-signing.yml": "signing-workflow-v1\n",
        "release/trust/developer-id-signing-execution-closure.v1.json": canonicalFixture({ kind: "signing-closure" }),
        ".github/workflows/developer-id-pair-canary.yml": "pair-canary-workflow-v1\n",
        "release/trust/developer-id-pair-canary-execution-closure.v1.json": canonicalFixture({ kind: "pair-closure" }),
        ".github/workflows/release-trust-inception-seal.yml": sealWorkflowBytes,
        "release/trust/release-trust-inception-seal-execution-closure.v1.json": sealClosureBytes,
        "release/trust/release-trust-policy.v1.json": canonicalFixture({ policyVersion: 1, schemaVersion: 1 }),
        "release/trust/developer-id-pair-canary-trust-policy.v1.json": canonicalFixture({ policyVersion: 1, schemaVersion: 1 }),
        "release/trust/sigstore-foundation.v1.json": canonicalFixture({ foundation: "fixture", schemaVersion: 1 }),
      }
      const implementationMerge = {
        ...mergeFixture(root, "fixture/implementation", "implementation bootstrap", () => {
          for (const [path, bytes] of Object.entries(memberFiles)) writeRepoFile(root, path, bytes)
        }),
        pullRequestNumber: 900,
      }
      const requiredMembers = {
        signingWorkflowSha256: sha256(memberFiles[".github/workflows/developer-id-signing.yml"]),
        signingClosureSha256: sha256(memberFiles["release/trust/developer-id-signing-execution-closure.v1.json"]),
        pairCanaryWorkflowSha256: sha256(memberFiles[".github/workflows/developer-id-pair-canary.yml"]),
        pairCanaryClosureSha256: sha256(memberFiles["release/trust/developer-id-pair-canary-execution-closure.v1.json"]),
        sealWorkflowSha256: sha256(memberFiles[".github/workflows/release-trust-inception-seal.yml"]),
        sealClosureSha256: sha256(memberFiles["release/trust/release-trust-inception-seal-execution-closure.v1.json"]),
        initialPolicySha256: sha256(memberFiles["release/trust/release-trust-policy.v1.json"]),
        pairCanaryPolicySha256: sha256(memberFiles["release/trust/developer-id-pair-canary-trust-policy.v1.json"]),
        foundationSha256: sha256(memberFiles["release/trust/sigstore-foundation.v1.json"]),
      }
      const authorityArtifacts = constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: githubEvidence(implementationMerge),
        subagentReviewReceiptBytes: [Buffer.from("review-one"), Buffer.from("review-two")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })
      const authorityMergeWithoutEvidence = {
        ...mergeFixture(root, "fixture/authority", "inception authority", () => {
          writeRepoFile(
            root,
            "release/trust/release-trust-bootstrap-evidence.v1.json",
            authorityArtifacts.bootstrapEvidence.bytes,
          )
          writeRepoFile(
            root,
            "release/trust/release-trust-inception-authority.v1.json",
            authorityArtifacts.authority.bytes,
          )
          writeRepoFile(
            root,
            "release/trust/release-trust-policy-head.v1.json",
            authorityArtifacts.policyHead.bytes,
          )
        }),
        pullRequestNumber: 901,
      }
      const authorityMerge = {
        ...authorityMergeWithoutEvidence,
        auditEvidence: githubEvidence(authorityMergeWithoutEvidence),
      }
      const protectedMergeSemantics = (merge: any, evidence: any) => ({
        merge,
        repository: exchangeBody(evidence.repositoryIdentity),
        pullRequest: exchangeBody(evidence.pullRequest),
        commit: exchangeBody(evidence.mergeCommit),
        reviews: evidence.reviews.map(exchangeBody),
        checks: evidence.checks.map(exchangeBody),
        protection: exchangeBody(evidence.branchProtection),
      })
      const validSemantics = protectedMergeSemantics(authorityMerge, authorityMerge.auditEvidence)
      expect(validateProtectedMergeSemantics(validSemantics)).toEqual({ ok: true })
      const rejectSemanticMutation = (mutate: (value: any) => void) => {
        const value = JSON.parse(JSON.stringify(validSemantics))
        mutate(value)
        expect(validateProtectedMergeSemantics(value)).toEqual({
          ok: false,
          code: "protected_merge_semantics_invalid",
        })
      }
      for (const mutate of [
        (value: any) => { value.repository.id = 0 },
        (value: any) => { value.repository.node_id = "wrong" },
        (value: any) => { value.repository.full_name = "wrong/repository" },
        (value: any) => { value.repository.default_branch = "trunk" },
        (value: any) => { value.repository.archived = true },
        (value: any) => { value.pullRequest.number += 1 },
        (value: any) => { value.pullRequest.state = "open" },
        (value: any) => { value.pullRequest.merged = false },
        (value: any) => { value.pullRequest.draft = true },
        (value: any) => { value.pullRequest.merge_commit_sha = "0".repeat(40) },
        (value: any) => { value.pullRequest.base.ref = "trunk" },
        (value: any) => { value.pullRequest.base.repo.id = 0 },
        (value: any) => { value.pullRequest.base.repo.node_id = "wrong" },
        (value: any) => { value.pullRequest.base.repo.full_name = "wrong/repository" },
        (value: any) => { value.pullRequest.head.sha = "0".repeat(40) },
        (value: any) => { value.pullRequest.head.repo.id = 0 },
        (value: any) => { value.pullRequest.head.repo.node_id = "wrong" },
        (value: any) => { value.pullRequest.head.repo.full_name = "wrong/repository" },
        (value: any) => { value.commit.sha = "0".repeat(40) },
        (value: any) => { value.commit.commit.tree.sha = "0".repeat(40) },
        (value: any) => { value.commit.parents.reverse() },
        (value: any) => { value.reviews = undefined },
        (value: any) => { value.reviews = [] },
        (value: any) => { value.reviews = [null] },
        (value: any) => { value.reviews = [value.reviews[0], []] },
        (value: any) => { value.reviews = [Array.from({ length: 101 }, (_, id) => ({ id }))] },
        (value: any) => { value.reviews = [[]] },
        (value: any) => { value.reviews[0].push({ ...value.reviews[0][0] }) },
        (value: any) => { value.reviews[0][0].state = "COMMENTED" },
        (value: any) => { value.reviews[0][0].pull_request_url = "https://example.invalid" },
        (value: any) => { value.checks = undefined },
        (value: any) => { value.checks = [] },
        (value: any) => { value.checks[0].head_sha = "0".repeat(40) },
        (value: any) => { value.checks[0].total_count = 1.5 },
        (value: any) => { value.checks[0].check_runs = null },
        (value: any) => { value.checks[0].total_count = 2 },
        (value: any) => { value.checks = [value.checks[0], { ...value.checks[0], check_runs: [] }] },
        (value: any) => {
          value.checks[0].check_runs = Array.from({ length: 101 }, (_, id) => ({ id }))
          value.checks[0].total_count = 101
        },
        (value: any) => { value.checks[0].check_runs = []; value.checks[0].total_count = 0 },
        (value: any) => { value.checks[0].check_runs.push({ ...value.checks[0].check_runs[0] }); value.checks[0].total_count = 2 },
        (value: any) => { value.protection.required_pull_request_reviews.required_approving_review_count = 0.5 },
        (value: any) => { value.protection.required_pull_request_reviews.required_approving_review_count = 0 },
        (value: any) => { value.protection.required_status_checks.strict = false },
        (value: any) => { value.protection.required_status_checks.contexts = [null] },
        (value: any) => {
          value.protection.required_status_checks.contexts = null
          value.protection.required_status_checks.checks = [{ context: "missing-ci" }]
        },
        (value: any) => {
          value.protection.required_status_checks.contexts = ["missing-ci"]
          value.protection.required_status_checks.checks = null
        },
        (value: any) => { value.protection.required_status_checks.contexts = []; value.protection.required_status_checks.checks = [] },
        (value: any) => { value.checks[0].check_runs[0].name = "not-required-ci" },
        (value: any) => { value.checks[0].check_runs[0].head_sha = "0".repeat(40) },
        (value: any) => { value.checks[0].check_runs[0].status = "queued" },
        (value: any) => { value.checks[0].check_runs[0].conclusion = "failure" },
      ]) rejectSemanticMutation(mutate)
      expect(validateProtectedMergeSemantics()).toEqual({
        ok: false,
        code: "protected_merge_semantics_invalid",
      })
      const sealBody = constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts,
        authorityMerge,
        createdAt: "2026-07-24T00:02:00.000Z",
      })
      const { materializeSealInput, verifyInceptionSealSigningAuthority } = await loadTrustAction(
        "run-reconciliation.mjs",
      )
      const evidenceBySha = new Map([
        [implementationMerge.sha, githubEvidence(implementationMerge)],
        [authorityMerge.sha, authorityMerge.auditEvidence],
      ])
      const mergeByTree = new Map([
        [implementationMerge.treeOid, implementationMerge],
        [authorityMerge.treeOid, authorityMerge],
      ])
      const fixtureGitHubResponse = async (path: string): Promise<any> => {
        if (path === "/repos/ourostack/ouroboros") {
          return exchangeBody(authorityMerge.auditEvidence.repositoryIdentity)
        }
        for (const [sha, evidence] of evidenceBySha) {
          const pullRequestNumber = sha === implementationMerge.sha
            ? implementationMerge.pullRequestNumber
            : authorityMerge.pullRequestNumber
          if (path === `/repos/ourostack/ouroboros/pulls/${pullRequestNumber}`) {
            return exchangeBody(evidence.pullRequest)
          }
          if (path === `/repos/ourostack/ouroboros/pulls/${pullRequestNumber}/reviews?per_page=100&page=1`) {
            return exchangeBody(evidence.reviews[0])
          }
          if (path === `/repos/ourostack/ouroboros/commits/${sha}`) {
            return exchangeBody(evidence.mergeCommit)
          }
          if (path === `/repos/ourostack/ouroboros/commits/${sha}/check-runs?per_page=100&page=1`) {
            return exchangeBody(evidence.checks[0])
          }
        }
        for (const [treeOid, merge] of mergeByTree) {
          if (path === `/repos/ourostack/ouroboros/git/trees/${treeOid}?recursive=1`) {
            return githubTree(root, merge.sha)
          }
        }
        throw new Error(`unexpected fixture GitHub path: ${path}`)
      }
      const githubClient = { get: fixtureGitHubResponse }
      const sealEventPath = join(root, ".seal-event.json")
      const materializedBodyPath = join(root, ".materialized-seal-body.json")
      const materializedStatementPath = join(root, ".materialized-seal-statement.json")
      writeFileSync(sealEventPath, JSON.stringify({ inputs: {
        sealBodyBase64: Buffer.from(sealBody.bytes).toString("base64"),
        sealBodySha256: sha256(sealBody.bytes),
      } }))
      const sealEnvironment = {
        GITHUB_EVENT_PATH: sealEventPath,
        GITHUB_REF: "refs/heads/main",
        GITHUB_REPOSITORY: "ourostack/ouroboros",
        GITHUB_REPOSITORY_ID: "1169669354",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_RUN_ID: "7001",
        GITHUB_SHA: authorityMerge.sha,
        GITHUB_WORKFLOW_REF: "ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
        GITHUB_WORKFLOW_SHA: authorityMerge.sha,
      }
      expect(await materializeSealInput(materializedBodyPath, materializedStatementPath, {
        root,
        environment: sealEnvironment,
        githubClient,
      })).toEqual({ ok: true })
      expect(readFileSync(materializedBodyPath, "utf8")).toBe(sealBody.bytes)
      const signingAuthorityInput = {
        body: sealBody.value,
        bytes: Buffer.from(sealBody.bytes),
        environment: sealEnvironment,
        root,
      }
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        githubClient,
      })).toBe(true)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        githubClient: {},
      })).toBe(false)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        environment: { ...sealEnvironment, GITHUB_TOKEN: undefined },
      })).toBe(false)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        body: {
          ...sealBody.value,
          authorityMergeAuditEvidence: {
            ...sealBody.value.authorityMergeAuditEvidence,
            branchProtection: { response: { bodyBase64: "not-base64" } },
          },
        },
        githubClient,
      })).toBe(false)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        githubClient: {
          get: async (path: string) => {
            if (!path.includes("/reviews?")) return fixtureGitHubResponse(path)
            const pullRequestNumber = Number(/pulls\/(\d+)/.exec(path)?.[1])
            return Array.from({ length: 100 }, (_, index) => ({
              id: pullRequestNumber * 1000 + index,
              state: "APPROVED",
              pull_request_url: `https://api.github.com/repos/ourostack/ouroboros/pulls/${pullRequestNumber}`,
            }))
          },
        },
      })).toBe(false)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        githubClient: {
          get: async (path: string) => {
            if (!path.includes("/check-runs?")) return fixtureGitHubResponse(path)
            const sha = /commits\/([a-f0-9]{40})/.exec(path)?.[1]
            const page = Number(/[?&]page=(\d+)/.exec(path)?.[1])
            const count = page === 1 ? 100 : 1
            return {
              head_sha: sha,
              total_count: 101,
              check_runs: Array.from({ length: count }, (_, index) => ({
                id: page * 1000 + index,
                name: "required-ci",
                head_sha: sha,
                status: "completed",
                conclusion: "success",
              })),
            }
          },
        },
      })).toBe(true)

      const clientWith = (mutate: (path: string, response: any) => any) => ({
        get: async (path: string) => mutate(
          path,
          JSON.parse(JSON.stringify(await fixtureGitHubResponse(path))),
        ),
      })
      const expectLiveAuthorityRejected = async (mutate: (path: string, response: any) => any) => {
        expect(await verifyInceptionSealSigningAuthority({
          ...signingAuthorityInput,
          githubClient: clientWith(mutate),
        })).toBe(false)
      }
      await expectLiveAuthorityRejected((path, response) => (
        path.includes("/reviews?") ? null : response
      ))
      await expectLiveAuthorityRejected((path, response) => (
        path.includes("/reviews?") ? Array.from({ length: 101 }, (_, id) => ({ id })) : response
      ))
      await expectLiveAuthorityRejected((path, response) => (
        path.includes("/check-runs?") ? null : response
      ))
      for (const mutateCheck of [
        (response: any) => ({ ...response, total_count: 0 }),
        (response: any) => ({ ...response, total_count: 1001 }),
        (response: any) => ({ ...response, check_runs: null }),
        (response: any) => ({ ...response, check_runs: Array.from({ length: 101 }, (_, id) => ({ id })) }),
        (response: any) => ({ ...response, total_count: 50, check_runs: Array.from({ length: 100 }, (_, id) => ({ id })) }),
        (response: any) => ({ ...response, total_count: 2 }),
      ]) {
        await expectLiveAuthorityRejected((path, response) => (
          path.includes("/check-runs?") ? mutateCheck(response) : response
        ))
      }
      await expectLiveAuthorityRejected((path, response) => {
        if (!path.includes("/git/trees/")) return response
        return { ...response, sha: "0".repeat(40) }
      })
      for (const mutateTree of [
        (response: any) => ({ ...response, truncated: true }),
        (response: any) => ({ ...response, tree: null }),
        (response: any) => ({ ...response, tree: [null] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], path: null }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], path: "" }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], path: "bad\0path" }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], mode: "bad" }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], mode: undefined }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], type: "tag" }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], sha: "bad" }] }),
        (response: any) => ({ ...response, tree: [{ ...response.tree[0], sha: undefined }] }),
        (response: any) => ({ ...response, tree: [response.tree[0], response.tree[0]] }),
      ]) {
        await expectLiveAuthorityRejected((path, response) => (
          path.includes("/git/trees/") ? mutateTree(response) : response
        ))
      }
      await expectLiveAuthorityRejected((path, response) => (
        path.includes(`/commits/${authorityMerge.sha}`)
          && !path.includes("/check-runs?")
          ? { ...response, commit: { ...response.commit, tree: { sha: "bad" } } }
          : response
      ))
      await expectLiveAuthorityRejected((path, response) => (
        path.includes(`/commits/${authorityMerge.sha}`)
          && !path.includes("/check-runs?")
          ? null
          : response
      ))
      await expectLiveAuthorityRejected((path, response) => (
        path === `/repos/ourostack/ouroboros/pulls/${authorityMerge.pullRequestNumber}`
          ? { ...response, state: "open" }
          : response
      ))
      const authorityTreePath = `/repos/ourostack/ouroboros/git/trees/${authorityMerge.treeOid}?recursive=1`
      await expectLiveAuthorityRejected((path, response) => path === authorityTreePath
        ? { ...response, tree: response.tree.filter((entry: any) => (
          entry.path !== "release/trust/release-trust-inception-authority.v1.json"
        )) }
        : response)
      await expectLiveAuthorityRejected((path, response) => path === authorityTreePath
        ? { ...response, tree: response.tree.filter((entry: any) => entry.path !== ".fixture-root") }
        : response)
      await expectLiveAuthorityRejected((path, response) => path === authorityTreePath
        ? { ...response, tree: response.tree.map((entry: any) => (
          entry.path === "release/trust/release-trust-inception-authority.v1.json"
            ? { ...entry, type: "commit" }
            : entry
        )) }
        : response)
      await expectLiveAuthorityRejected((path, response) => path === authorityTreePath
        ? { ...response, tree: [...response.tree, {
          mode: "100644",
          type: "blob",
          sha: "0".repeat(40),
          path: "release/trust/release-trust-inception-seal.v1.json",
        }] }
        : response)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        bytes: Buffer.from(`${sealBody.bytes}\n`),
        githubClient,
      })).toBe(false)
      expect(await verifyInceptionSealSigningAuthority({
        ...signingAuthorityInput,
        environment: { ...sealEnvironment, GITHUB_SHA: implementationMerge.sha },
        githubClient,
      })).toBe(false)
      rmSync(sealEventPath)
      rmSync(materializedBodyPath)
      rmSync(materializedStatementPath)
      const workflowRunId = 7001
      const sealStatement = constructInceptionSealStatement({ sealBody })
      const dsseEnvelope = {
        payload: Buffer.from(sealStatement.bytes).toString("base64"),
        payloadType: "application/vnd.in-toto+json",
        signatures: [{
          keyid: "fixture-key-id",
          sig: Buffer.from("fixture-signature").toString("base64"),
        }],
      }
      const sigstoreBundle = {
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: { certificate: { rawBytes: Buffer.from("fixture-certificate").toString("base64") } },
        dsseEnvelope,
      }
      const signature = {
        schemaVersion: 1,
        subject: {
          kind: "release-trust-inception-seal-body",
          name: "release-trust-inception-seal-body.v1.json",
          sha256: sha256(sealBody.bytes),
        },
        dsseEnvelopeBase64: Buffer.from(canonicalFixture(dsseEnvelope)).toString("base64"),
        sigstoreBundleBase64: Buffer.from(JSON.stringify(sigstoreBundle)).toString("base64"),
        certificateIdentity: "https://github.com/ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
        oidcIssuer: "https://token.actions.githubusercontent.com",
        certificateBuildConfigDigest: authorityMerge.sha,
        certificateRunInvocationUri: `https://github.com/ourostack/ouroboros/actions/runs/${workflowRunId}/attempts/1`,
        workflowRunId,
        workflowRunAttempt: 1,
        workflowHeadSha: authorityMerge.sha,
        signedAt: "2026-07-24T00:03:00.000Z",
      }
      const carrier = constructInceptionSealCarrier({ sealBody, signature })
      const carrierMergeWithoutEvidence = {
        ...mergeFixture(root, "fixture/carrier", "inception seal carrier", () => {
          writeRepoFile(root, "release/trust/release-trust-inception-seal.v1.json", carrier.bytes)
        }),
        pullRequestNumber: 902,
      }
      const carrierMerge = {
        ...carrierMergeWithoutEvidence,
        auditEvidence: githubEvidence(carrierMergeWithoutEvidence),
      }
      const carrierReceipt = constructInceptionCarrierReceipt({
        carrier,
        carrierMerge,
        acquiredAt: "2026-07-24T00:04:00.000Z",
        resolveTreeEntry: (revision: string, path: string) => inspectTreeEntry(root, revision, path),
      })
      const inception = {
        implementationMerge,
        authorityMerge,
        carrierMerge,
        authorityArtifacts,
        sealBody,
        carrier,
        carrierReceipt,
      }

      expect(authorityArtifacts.authority.bytes).not.toContain(authorityMerge.sha)
      expect(authorityArtifacts.authority.bytes).not.toContain(carrierMerge.sha)
      expect(sealBody.bytes).toContain(authorityMerge.sha)
      expect(sealBody.bytes).not.toContain(carrierMerge.sha)
      expect(carrier.bytes).not.toContain(carrierMerge.sha)
      expect(canonicalFixture(carrierReceipt)).toContain(carrierMerge.sha)

      const malformedExchangeEvidence = githubEvidence(implementationMerge)
      malformedExchangeEvidence.repositoryIdentity.requestSha256 = "0".repeat(64)
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: malformedExchangeEvidence,
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      const wrongMergeEvidence = githubEvidence(implementationMerge)
      const wrongMergeBody = {
        ...JSON.parse(Buffer.from(wrongMergeEvidence.pullRequest.response.bodyBase64, "base64").toString("utf8")),
        merge_commit_sha: authorityMerge.sha,
      }
      wrongMergeEvidence.pullRequest.response.bodyBase64 = Buffer.from(canonicalFixture(wrongMergeBody)).toString("base64")
      wrongMergeEvidence.pullRequest.responseSha256 = sha256(canonicalFixture(wrongMergeEvidence.pullRequest.response))
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: wrongMergeEvidence,
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      const missingExchangeFieldEvidence = githubEvidence(implementationMerge)
      delete missingExchangeFieldEvidence.repositoryIdentity.request.accept
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: missingExchangeFieldEvidence,
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      const emptyResponseBodyEvidence = githubEvidence(implementationMerge)
      emptyResponseBodyEvidence.repositoryIdentity.response.bodyBase64 = ""
      emptyResponseBodyEvidence.repositoryIdentity.responseSha256 = sha256(canonicalFixture(
        emptyResponseBodyEvidence.repositoryIdentity.response,
      ))
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: emptyResponseBodyEvidence,
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      const invalidJsonEvidence = githubEvidence(implementationMerge)
      invalidJsonEvidence.repositoryIdentity.response.bodyBase64 = Buffer.from("{not-json").toString("base64")
      invalidJsonEvidence.repositoryIdentity.responseSha256 = sha256(canonicalFixture(
        invalidJsonEvidence.repositoryIdentity.response,
      ))
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: invalidJsonEvidence,
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      expect(() => constructInceptionAuthority()).toThrow(/implementation merge is invalid/)
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: githubEvidence(implementationMerge),
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers: undefined,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/inception members are invalid/)
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: githubEvidence(implementationMerge),
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers: { ...requiredMembers, foundationSha256: undefined },
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/inception members are invalid/)
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: githubEvidence(implementationMerge),
        subagentReviewReceiptBytes: [],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/inception authority input is invalid/)
      expect(() => constructInceptionAuthority({
        implementationMerge,
        githubAuditEvidence: { ...githubEvidence(implementationMerge), inventedAuthority: true },
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/bootstrap audit evidence is invalid/)
      const invalidPayloadEnvelope = { ...dsseEnvelope, payload: "not base64!" }
      const invalidPayloadBundle = { ...sigstoreBundle, dsseEnvelope: invalidPayloadEnvelope }
      for (const signatureMutation of [
        { dsseEnvelopeBase64: "not base64!" },
        { sigstoreBundleBase64: "Zg" },
        { sigstoreBundleBase64: Buffer.from("{not-json").toString("base64") },
        { sigstoreBundleBase64: Buffer.from(JSON.stringify({
          mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
          verificationMaterial: sigstoreBundle.verificationMaterial,
          messageSignature: { messageDigest: { algorithm: "SHA2_256", digest: "AA==" }, signature: "AA==" },
        })).toString("base64") },
        { dsseEnvelopeBase64: Buffer.from(canonicalFixture({
          ...dsseEnvelope,
          payload: Buffer.from("changed").toString("base64"),
        })).toString("base64") },
        {
          dsseEnvelopeBase64: Buffer.from(canonicalFixture(invalidPayloadEnvelope)).toString("base64"),
          sigstoreBundleBase64: Buffer.from(JSON.stringify(invalidPayloadBundle)).toString("base64"),
        },
        { certificateRunInvocationUri: "https://github.com/ourostack/ouroboros/actions/runs/7001/attempts/2" },
        { inventedAuthority: true },
      ]) {
        expect(() => constructInceptionSealCarrier({
          sealBody,
          signature: { ...signature, ...signatureMutation },
        })).toThrow(/inception seal signature is invalid/)
      }
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts,
        authorityMerge: { ...authorityMerge, auditEvidence: malformedExchangeEvidence },
        createdAt: "2026-07-24T00:02:00.000Z",
      })).toThrow(/authority audit evidence is invalid/)
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts,
        authorityMerge: { ...authorityMerge, sha: implementationMerge.sha },
        createdAt: "2026-07-24T00:02:00.000Z",
      })).toThrow(/authority merge is invalid|inception seal body input is invalid/)
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts,
        authorityMerge,
        createdAt: "not-a-time",
      })).toThrow(/inception seal body input is invalid/)
      const wrongMergeAuthorityArtifacts = {
        ...authorityArtifacts,
        authority: canonicalBinding({
          ...authorityArtifacts.authority.value,
          bootstrapTreeSha256: "0".repeat(64),
        }),
      }
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts: wrongMergeAuthorityArtifacts,
        authorityMerge,
        createdAt: "2026-07-24T00:02:00.000Z",
      })).toThrow(/inception authority artifacts are invalid|does not bind the implementation merge/)
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts: {
          ...authorityArtifacts,
          policyHead: canonicalBinding({
            ...authorityArtifacts.policyHead.value,
            revision: 2,
          }),
        },
        authorityMerge,
        createdAt: "2026-07-24T00:02:00.000Z",
      })).toThrow(/inception authority artifacts are invalid/)
      const invalidReceiptAuthorityArtifacts = {
        ...authorityArtifacts,
        bootstrapEvidence: canonicalBinding({
          ...authorityArtifacts.bootstrapEvidence.value,
          content: {
            ...authorityArtifacts.bootstrapEvidence.value.content,
            subagentReviewReceiptBytesBase64: ["not base64!"],
          },
        }),
      }
      expect(() => constructInceptionSealBody({
        implementationMerge,
        authorityArtifacts: invalidReceiptAuthorityArtifacts,
        authorityMerge,
        createdAt: "2026-07-24T00:02:00.000Z",
      })).toThrow(/inception authority artifacts are invalid/)
      expect(() => constructInceptionSealStatement()).toThrow(/statement input is invalid/)
      const nonMergeCommit = {
        ...inspectCommit(root, `${implementationMerge.sha}^2`),
        pullRequestNumber: 903,
      }
      expect(() => constructInceptionAuthority({
        implementationMerge: nonMergeCommit,
        githubAuditEvidence: githubEvidence(nonMergeCommit),
        subagentReviewReceiptBytes: [Buffer.from("review")],
        requiredMembers,
        activatedAt: "2026-07-24T00:01:00.000Z",
      })).toThrow(/implementation merge is invalid/)
      expect(() => constructInceptionCarrierReceipt({
        carrier,
        carrierMerge: { ...carrierMerge, auditEvidence: malformedExchangeEvidence },
        acquiredAt: "2026-07-24T00:04:00.000Z",
        resolveTreeEntry: (revision: string, path: string) => inspectTreeEntry(root, revision, path),
      })).toThrow(/carrier audit evidence is invalid/)
      expect(() => constructInceptionCarrierReceipt({
        carrier: { ...carrier, bytes: `${carrier.bytes}\n` },
        carrierMerge,
        acquiredAt: "2026-07-24T00:04:00.000Z",
        resolveTreeEntry: (revision: string, path: string) => inspectTreeEntry(root, revision, path),
      })).toThrow(/inception carrier receipt input is invalid/)
      const nonSequentialCarrierMerge = {
        ...carrierMerge,
        parentShas: ["f".repeat(40), carrierMerge.parentShas[1]],
      }
      nonSequentialCarrierMerge.auditEvidence = githubEvidence(nonSequentialCarrierMerge)
      expect(() => constructInceptionCarrierReceipt({
        carrier,
        carrierMerge: nonSequentialCarrierMerge,
        acquiredAt: "2026-07-24T00:04:00.000Z",
        resolveTreeEntry: (revision: string, path: string) => inspectTreeEntry(root, revision, path),
      })).toThrow(/does not follow the authority merge/)
      expect(() => constructInceptionCarrierReceipt({
        carrier,
        carrierMerge,
        acquiredAt: "2026-07-24T00:04:00.000Z",
        resolveTreeEntry: () => ({
          path: "release/trust/release-trust-inception-seal.v1.json",
          type: "blob",
          oid: "0".repeat(40),
        }),
      })).toThrow(/not introduced by the carrier merge/)

      const calls: string[] = []
      const dependencies = {
        acquireRepositoryIdentity: () => {
          calls.push("repository")
          return {
            repository: "ourostack/ouroboros",
            repositoryDatabaseId: 1169669354,
            repositoryNodeId: "R_kgDORbe86g",
          }
        },
        acquireCommit: (sha: string) => {
          calls.push(`commit:${sha}`)
          return inspectCommit(root, sha)
        },
        acquireBlob: (sha: string, path: string) => {
          calls.push(`blob:${sha}:${path}`)
          return git(root, ["show", `${sha}:${path}`], { encoding: null }) as Buffer
        },
        acquireTreeEntry: (sha: string, path: string) => {
          calls.push(`tree-entry:${sha}:${path}`)
          return inspectTreeEntry(root, sha, path)
        },
        acquireWorkflowRun: (runId: number, attempt: number) => {
          calls.push(`run:${runId}:${attempt}`)
          return {
            repository: "ourostack/ouroboros",
            repositoryDatabaseId: 1169669354,
            repositoryNodeId: "R_kgDORbe86g",
            workflowRunId,
            workflowRunAttempt: 1,
            event: "workflow_dispatch",
            headBranch: "main",
            headSha: authorityMerge.sha,
            workflowPath: ".github/workflows/release-trust-inception-seal.yml",
            workflowRef: "ourostack/ouroboros/.github/workflows/release-trust-inception-seal.yml@refs/heads/main",
            workflowSha: authorityMerge.sha,
            conclusion: "success",
          }
        },
        acquireSealArtifact: () => {
          calls.push("artifact")
          return {
            name: `release-trust-inception-seal-${workflowRunId}-1`,
            workflowRunId,
            workflowRunAttempt: 1,
            expired: false,
            bodyPath: "release-trust-inception-seal-body.v1.json",
            bodyBytes: Buffer.from(sealBody.bytes),
            sigstoreBundlePath: "release-trust-inception-seal.v1.sigstore.json",
            sigstoreBundleBytes: Buffer.from(signature.sigstoreBundleBase64, "base64"),
            exactlyTwoFilesNoDuplicatesOrExtras: true,
          }
        },
        verifySigstore: (input: any) => {
          calls.push("sigstore")
          expect(input.subjectBytes).toEqual(Buffer.from(sealBody.bytes))
          expect(input.statementBytes).toEqual(Buffer.from(sealStatement.bytes))
          expect(input.signature).toEqual(signature)
          expect(input.foundationBytes).toEqual(Buffer.from(
            memberFiles["release/trust/sigstore-foundation.v1.json"],
          ))
          expect(input.expected).toMatchObject({
            workflowRunId,
            workflowRunAttempt: 1,
            workflowHeadSha: authorityMerge.sha,
          })
          return {
            ok: true,
            fulcioChainVerified: true,
            certificateSctVerified: true,
            rekorEntryVerified: true,
            oidcClaimsVerified: true,
            subjectSha256: sha256(sealBody.bytes),
            dsseEnvelopeSha256: sha256(Buffer.from(signature.dsseEnvelopeBase64, "base64")),
            sigstoreBundleSha256: sha256(Buffer.from(signature.sigstoreBundleBase64, "base64")),
            certificateIdentity: signature.certificateIdentity,
            oidcIssuer: signature.oidcIssuer,
            workflowRunId,
            workflowRunAttempt: 1,
            workflowHeadSha: authorityMerge.sha,
            certificateBuildConfigDigest: authorityMerge.sha,
            certificateRunInvocationUri: signature.certificateRunInvocationUri,
            foundationSha256: requiredMembers.foundationSha256,
          }
        },
      }
      const input = {
        online: true,
        currentHead: null,
        inception,
        workflowRunId,
        workflowRunAttempt: 1,
        historicalHeadersUsedAsAuthority: false,
      }

      expect(verifyFreshInception(input, dependencies)).toEqual({
        ok: true,
        authoritySha256: sha256(authorityArtifacts.authority.bytes),
        headSha256: sha256(authorityArtifacts.policyHead.bytes),
      })
      expect(calls.at(0)).toBe("repository")
      expect(calls.at(-1)).toBe("sigstore")

      expect(verifyFreshInception({ ...input, online: false }, dependencies)).toMatchObject({
        ok: false,
        code: "online_reacquisition_required",
      })
      expect(verifyFreshInception({ ...input, currentHead: { revision: 1 } }, dependencies)).toMatchObject({
        ok: false,
        code: "inception_head_exists",
      })
      expect(verifyFreshInception({ ...input, historicalHeadersUsedAsAuthority: true }, dependencies)).toMatchObject({
        ok: false,
        code: "historical_transport_not_authority",
      })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireBlob: (sha: string, path: string) => path.endsWith("release-trust-policy.v1.json")
          ? Buffer.from("changed")
          : dependencies.acquireBlob(sha, path),
      })).toMatchObject({ ok: false, code: "immutable_git_blob_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireWorkflowRun: () => ({
          ...dependencies.acquireWorkflowRun(workflowRunId, 1),
          workflowSha: implementationMerge.sha,
        }),
      })).toMatchObject({ ok: false, code: "seal_workflow_run_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireBlob: (sha: string, path: string) => path === "release/trust/release-trust-inception-seal.v1.json"
          ? Buffer.from("changed")
          : dependencies.acquireBlob(sha, path),
      })).toMatchObject({ ok: false, code: "carrier_blob_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireTreeEntry: (sha: string, path: string) => sha === authorityMerge.sha
          ? inspectTreeEntry(root, carrierMerge.sha, path)
          : dependencies.acquireTreeEntry(sha, path),
      })).toMatchObject({ ok: false, code: "carrier_blob_preexisted" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireTreeEntry: (sha: string, path: string) => sha === carrierMerge.sha
          ? { path, type: "blob", oid: "0".repeat(40) }
          : dependencies.acquireTreeEntry(sha, path),
      })).toMatchObject({ ok: false, code: "carrier_blob_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        verifySigstore: () => ({ ok: false }),
      })).toMatchObject({ ok: false, code: "sigstore_seal_invalid" })

      const authorityWithExtra = {
        ...authorityArtifacts.authority.value,
        inventedAuthority: true,
      }
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          authorityArtifacts: {
            ...authorityArtifacts,
            authority: canonicalBinding(authorityWithExtra),
          },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_graph_invalid" })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          carrierMerge: { ...carrierMerge, sha: authorityMerge.sha },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_merge_evidence_invalid" })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          authorityMerge: {
            ...authorityMerge,
            parentShas: ["e".repeat(40), authorityMerge.parentShas[1]],
          },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_graph_invalid" })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          implementationMerge: null,
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_merge_evidence_invalid" })
      expect(verifyFreshInception({ ...input, inception: undefined }, dependencies)).toMatchObject({
        ok: false,
        code: "inception_merge_evidence_invalid",
      })
      const invalidReceiptContent = {
        ...authorityArtifacts.bootstrapEvidence.value.content,
        subagentReviewReceiptBytesBase64: ["not base64!"],
      }
      const invalidReceiptEvidence = canonicalBinding({
        content: invalidReceiptContent,
        contentSha256: sha256(canonicalFixture(invalidReceiptContent)),
        contentSha256EqualsSha256OfJcsContent: true,
      })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          authorityArtifacts: {
            ...authorityArtifacts,
            bootstrapEvidence: invalidReceiptEvidence,
          },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_graph_invalid" })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          carrierReceipt: { ...carrierReceipt, inventedAuthority: true },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_graph_invalid" })
      expect(verifyFreshInception({
        ...input,
        inception: {
          ...inception,
          carrierReceipt: { ...carrierReceipt, acquiredAt: "not-a-time" },
        },
      }, dependencies)).toMatchObject({ ok: false, code: "inception_graph_invalid" })
      expect(verifyFreshInception({ ...input, workflowRunId: workflowRunId + 1 }, dependencies)).toMatchObject({
        ok: false,
        code: "seal_workflow_run_mismatch",
      })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireSealArtifact: () => ({
          ...dependencies.acquireSealArtifact(),
          name: "wrong-artifact",
        }),
      })).toMatchObject({ ok: false, code: "seal_artifact_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireRepositoryIdentity: () => ({
          ...dependencies.acquireRepositoryIdentity(),
          repositoryNodeId: "wrong-node",
        }),
      })).toMatchObject({ ok: false, code: "canonical_repository_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireCommit: (sha: string) => ({
          ...dependencies.acquireCommit(sha),
          treeSha256: "0".repeat(64),
        }),
      })).toMatchObject({ ok: false, code: "immutable_git_commit_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireCommit: (sha: string) => ({
          ...dependencies.acquireCommit(sha),
          parentShas: [implementationMerge.sha],
        }),
      })).toMatchObject({ ok: false, code: "immutable_git_commit_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireBlob: (sha: string, path: string) => path === "release/trust/release-trust-inception-authority.v1.json"
          ? Buffer.from("changed")
          : dependencies.acquireBlob(sha, path),
      })).toMatchObject({ ok: false, code: "immutable_git_blob_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireSealArtifact: () => ({
          ...dependencies.acquireSealArtifact(),
          sigstoreBundleBytes: undefined,
        }),
      })).toMatchObject({ ok: false, code: "seal_artifact_mismatch" })
      expect(verifyFreshInception(input, {
        ...dependencies,
        verifySigstore: () => ({
          ...dependencies.verifySigstore({
            subjectBytes: Buffer.from(sealBody.bytes),
            statementBytes: Buffer.from(sealStatement.bytes),
            signature,
            foundationBytes: Buffer.from(memberFiles["release/trust/sigstore-foundation.v1.json"]),
            expected: {
              workflowRunId,
              workflowRunAttempt: 1,
              workflowHeadSha: authorityMerge.sha,
            },
          }),
          certificateRunInvocationUri: "https://github.com/ourostack/ouroboros/actions/runs/7001/attempts/2",
        }),
      })).toMatchObject({ ok: false, code: "sigstore_seal_invalid" })
      expect(verifyFreshInception(input, { ...dependencies, acquireBlob: undefined })).toMatchObject({
        ok: false,
        code: "verification_evidence_required",
      })
      expect(verifyFreshInception(input, {
        ...dependencies,
        acquireRepositoryIdentity: () => { throw new Error("offline") },
      })).toMatchObject({ ok: false, code: "online_reacquisition_failed" })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

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
        rootVersion: 15,
        rootSha256: "73747011d0857ada15479a16c4cae0f3ed03aac698b523b97e1de314ac9d9ca8",
        repositoryCommit: "54ff875ae39f073e0a88703b39b1f4e3b29693ae",
        trustedRootBase64: expect.stringMatching(/^[A-Za-z0-9+/]+={0,2}$/),
        trustedRootSha256: "6494e21ea73fa7ee769f85f57d5a3e6a08725eae1e38c755fc3517c9e6bc0b66",
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
