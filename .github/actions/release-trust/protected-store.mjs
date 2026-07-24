import { createHash, X509Certificate } from "node:crypto"

import { canonicalize, sha256Bytes } from "./canonicalize.mjs"

const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/
const REPOSITORY = "ourostack/ouroboros"
const REPOSITORY_DATABASE_ID = 1169669354
const REPOSITORY_NODE_ID = "R_kgDORbe86g"
const SEAL_WORKFLOW_PATH = ".github/workflows/release-trust-inception-seal.yml"
const SEAL_CERTIFICATE_IDENTITY = `https://github.com/${REPOSITORY}/${SEAL_WORKFLOW_PATH}@refs/heads/main`
const INCEPTION_MEMBER_PATHS = Object.freeze({
  signingWorkflowSha256: ".github/workflows/developer-id-signing.yml",
  signingClosureSha256: "release/trust/developer-id-signing-execution-closure.v1.json",
  pairCanaryWorkflowSha256: ".github/workflows/developer-id-pair-canary.yml",
  pairCanaryClosureSha256: "release/trust/developer-id-pair-canary-execution-closure.v1.json",
  sealWorkflowSha256: SEAL_WORKFLOW_PATH,
  sealClosureSha256: "release/trust/release-trust-inception-seal-execution-closure.v1.json",
  initialPolicySha256: "release/trust/release-trust-policy.v1.json",
  pairCanaryPolicySha256: "release/trust/developer-id-pair-canary-trust-policy.v1.json",
  foundationSha256: "release/trust/sigstore-foundation.v1.json",
})
const AUTHORITY_PATHS = Object.freeze({
  bootstrapEvidence: "release/trust/release-trust-bootstrap-evidence.v1.json",
  authority: "release/trust/release-trust-inception-authority.v1.json",
  policyHead: "release/trust/release-trust-policy-head.v1.json",
})
const CARRIER_PATH = "release/trust/release-trust-inception-seal.v1.json"
const SEAL_BODY_ARTIFACT_PATH = "release-trust-inception-seal-body.v1.json"
const SEAL_BUNDLE_ARTIFACT_PATH = "release-trust-inception-seal.v1.sigstore.json"
const SEAL_STATEMENT_PREDICATE_TYPE = "https://ouro.bot/attestations/release-trust-inception-seal/v1"

function fail(code, details = {}) {
  return { ok: false, code, ...details }
}

function exactValueBytes(binding) {
  return Boolean(
    binding
      && typeof binding.bytes === "string"
      && binding.bytes === canonicalize(binding.value),
  )
}

function sameValue(left, right) {
  return canonicalize(left) === canonicalize(right)
}

function exactRecordKeys(value, expected) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && sameValue(Object.keys(value).sort(), [...expected].sort()))
}

function canonicalBinding(value) {
  return { value, bytes: canonicalize(value) }
}

function exactIsoTime(value) {
  return typeof value === "string"
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}

function requireMerge(value, label) {
  if (!value || !SHA1.test(value.sha ?? "") || !SHA256.test(value.treeSha256 ?? "")
    || !SHA1.test(value.treeOid ?? "")
    || !Array.isArray(value.parentShas) || value.parentShas.length !== 2
    || new Set(value.parentShas).size !== 2
    || value.parentShas.some((sha) => !SHA1.test(sha) || sha === value.sha)
    || !Number.isSafeInteger(value.pullRequestNumber) || value.pullRequestNumber < 1) {
    throw new TypeError(`${label} is invalid`)
  }
}

function requireMembers(requiredMembers) {
  const actual = Object.keys(requiredMembers ?? {}).sort()
  const expected = Object.keys(INCEPTION_MEMBER_PATHS).sort()
  if (!sameValue(actual, expected)
    || expected.some((key) => !SHA256.test(requiredMembers[key] ?? ""))) {
    throw new TypeError("inception members are invalid")
  }
}

function validCanonicalBase64(value, allowEmpty = false) {
  return value === "" ? allowEmpty : decodeCanonicalBase64(value) !== null
}

function validAuditExchange(value) {
  if (!exactRecordKeys(value, [
    "request",
    "response",
    "requestSha256",
    "responseSha256",
    "tlsPeerLeafDerSha256",
    "tlsPeerSpkiSha256",
    "acquiredAt",
  ]) || !exactRecordKeys(value.request, [
    "method",
    "url",
    "accept",
    "apiVersion",
    "headersWithoutCredentialsBase64",
    "bodyBase64",
  ]) || !exactRecordKeys(value.response, ["status", "headersBase64", "bodyBase64"])) return false
  return value.request.method === "GET"
    && typeof value.request.url === "string" && value.request.url.startsWith("https://")
    && typeof value.request.accept === "string" && value.request.accept.length > 0
    && value.request.apiVersion === "2026-03-10"
    && validCanonicalBase64(value.request.headersWithoutCredentialsBase64, true)
    && value.request.bodyBase64 === ""
    && Number.isInteger(value.response.status)
    && value.response.status >= 100 && value.response.status <= 599
    && validCanonicalBase64(value.response.headersBase64, true)
    && validCanonicalBase64(value.response.bodyBase64, true)
    && value.requestSha256 === sha256Bytes(canonicalize(value.request))
    && value.responseSha256 === sha256Bytes(canonicalize(value.response))
    && SHA256.test(value.tlsPeerLeafDerSha256 ?? "")
    && SHA256.test(value.tlsPeerSpkiSha256 ?? "")
    && exactIsoTime(value.acquiredAt)
}

function parseAuditBody(exchange) {
  const bytes = decodeCanonicalBase64(exchange?.response?.bodyBase64)
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString("utf8"))
  } catch {
    return null
  }
}

function requireProtectedMergeSemantics({ repository, pullRequest, commit, reviews, checks, protection }, merge) {
  const pullRequestUrl = `https://api.github.com/repos/${REPOSITORY}/pulls/${merge?.pullRequestNumber}`
  const reviewEntries = reviews?.flatMap((page) => Array.isArray(page) ? page : []) ?? []
  const checkEntries = checks?.flatMap((page) => Array.isArray(page?.check_runs) ? page.check_runs : []) ?? []
  const requiredCheckCandidates = [
    ...(Array.isArray(protection?.required_status_checks?.contexts)
      ? protection.required_status_checks.contexts
      : []),
    ...(Array.isArray(protection?.required_status_checks?.checks)
      ? protection.required_status_checks.checks.map((check) => check?.context)
      : []),
  ]
  const requiredCheckNames = [...new Set(requiredCheckCandidates)]
  if (repository?.id !== REPOSITORY_DATABASE_ID
    || repository.node_id !== REPOSITORY_NODE_ID
    || repository.full_name !== REPOSITORY
    || repository.default_branch !== "main"
    || repository.archived !== false
    || pullRequest?.number !== merge?.pullRequestNumber
    || pullRequest.state !== "closed"
    || pullRequest.merged !== true
    || pullRequest.draft !== false
    || pullRequest.merge_commit_sha !== merge.sha
    || pullRequest.base?.ref !== "main"
    || pullRequest.base?.repo?.id !== REPOSITORY_DATABASE_ID
    || pullRequest.base?.repo?.node_id !== REPOSITORY_NODE_ID
    || pullRequest.base?.repo?.full_name !== REPOSITORY
    || pullRequest.head?.sha !== merge.parentShas?.[1]
    || pullRequest.head?.repo?.id !== REPOSITORY_DATABASE_ID
    || pullRequest.head?.repo?.node_id !== REPOSITORY_NODE_ID
    || pullRequest.head?.repo?.full_name !== REPOSITORY
    || commit?.sha !== merge.sha
    || commit.commit?.tree?.sha !== merge.treeOid
    || !sameValue(commit.parents?.map((parent) => parent?.sha), merge.parentShas)
    || !Array.isArray(reviews) || reviews.length === 0
    || reviews.some((page) => !Array.isArray(page))
    || reviews.slice(0, -1).some((page) => page.length !== 100)
    || reviews.at(-1)?.length > 100
    || reviewEntries.length === 0
    || new Set(reviewEntries.map((review) => review?.id)).size !== reviewEntries.length
    || !reviewEntries.some((review) => review?.state === "APPROVED"
      && review.pull_request_url === pullRequestUrl)
    || !Array.isArray(checks) || checks.length === 0
    || checks.some((page) => page?.head_sha !== merge.sha
      || !Number.isSafeInteger(page.total_count)
      || !Array.isArray(page.check_runs))
    || checks.some((page) => page.total_count !== checkEntries.length)
    || checks.slice(0, -1).some((page) => page.check_runs.length !== 100)
    || checks.at(-1)?.check_runs?.length > 100
    || checkEntries.length === 0
    || new Set(checkEntries.map((check) => check?.id)).size !== checkEntries.length
    || !Number.isSafeInteger(protection?.required_pull_request_reviews?.required_approving_review_count)
    || protection.required_pull_request_reviews.required_approving_review_count < 1
    || protection?.required_status_checks?.strict !== true
    || requiredCheckCandidates.some((name) => typeof name !== "string" || name.length === 0)
    || requiredCheckNames.length === 0
    || requiredCheckNames.some((name) => !checkEntries.some((check) => (
      check?.name === name
      && check.head_sha === merge.sha
      && check.status === "completed"
      && check.conclusion === "success"
    )))) {
    throw new TypeError("protected merge semantics are invalid")
  }
}

export function validateProtectedMergeSemantics(input) {
  try {
    requireMerge(input?.merge, "protected merge")
    requireProtectedMergeSemantics(input, input.merge)
    return { ok: true }
  } catch {
    return fail("protected_merge_semantics_invalid")
  }
}

function requireAuditEvidence(value, label, merge) {
  const repositoryUrl = `https://api.github.com/repos/${REPOSITORY}`
  const pullRequestUrl = `${repositoryUrl}/pulls/${merge?.pullRequestNumber}`
  const commitUrl = `${repositoryUrl}/commits/${merge?.sha}`
  if (!exactRecordKeys(value, [
    "repositoryIdentity",
    "pullRequest",
    "mergeCommit",
    "reviews",
    "checks",
    "branchProtection",
    "pagesCompleteAndContiguous",
    "everyRequestTargetsRepositoryDatabaseId1169669354AndNodeId",
    "exactBodiesRetainedNoRedaction",
    "credentialsExcludedFromRetainedHeaders",
  ])
    || !validAuditExchange(value.repositoryIdentity)
    || !validAuditExchange(value.pullRequest)
    || !validAuditExchange(value.mergeCommit)
    || !Array.isArray(value.reviews) || value.reviews.length === 0 || !value.reviews.every(validAuditExchange)
    || !Array.isArray(value.checks) || value.checks.length === 0 || !value.checks.every(validAuditExchange)
    || !validAuditExchange(value.branchProtection)
    || value.pagesCompleteAndContiguous !== true
    || value.everyRequestTargetsRepositoryDatabaseId1169669354AndNodeId !== true
    || value.exactBodiesRetainedNoRedaction !== true
    || value.credentialsExcludedFromRetainedHeaders !== true
    || value.repositoryIdentity.request.url !== repositoryUrl
    || value.pullRequest.request.url !== pullRequestUrl
    || value.mergeCommit.request.url !== commitUrl
    || value.reviews.some((exchange, index) => (
      exchange.request.url !== `${pullRequestUrl}/reviews?per_page=100&page=${index + 1}`
    ))
    || value.checks.some((exchange, index) => (
      exchange.request.url !== `${commitUrl}/check-runs?per_page=100&page=${index + 1}`
    ))
    || value.branchProtection.request.url !== `${repositoryUrl}/branches/main/protection`
    || [value.repositoryIdentity, value.pullRequest, value.mergeCommit, ...value.reviews, ...value.checks, value.branchProtection]
      .some((exchange) => exchange.response.status !== 200)) {
    throw new TypeError(`${label} is invalid`)
  }
  const repository = parseAuditBody(value.repositoryIdentity)
  const pullRequest = parseAuditBody(value.pullRequest)
  const commit = parseAuditBody(value.mergeCommit)
  const reviews = value.reviews.map(parseAuditBody)
  const checks = value.checks.map(parseAuditBody)
  const protection = parseAuditBody(value.branchProtection)
  try {
    requireProtectedMergeSemantics({ repository, pullRequest, commit, reviews, checks, protection }, merge)
  } catch {
    throw new TypeError(`${label} is invalid`)
  }
}

export function constructInceptionAuthority({
  implementationMerge,
  githubAuditEvidence,
  subagentReviewReceiptBytes,
  requiredMembers,
  activatedAt,
} = {}) {
  requireMerge(implementationMerge, "implementation merge")
  requireAuditEvidence(githubAuditEvidence, "bootstrap audit evidence", implementationMerge)
  requireMembers(requiredMembers)
  if (!Array.isArray(subagentReviewReceiptBytes) || subagentReviewReceiptBytes.length === 0
    || subagentReviewReceiptBytes.some((bytes) => !Buffer.isBuffer(bytes) || bytes.length === 0)
    || !exactIsoTime(activatedAt)) {
    throw new TypeError("inception authority input is invalid")
  }
  const receiptBase64 = subagentReviewReceiptBytes.map((bytes) => bytes.toString("base64"))
  const content = {
    schemaVersion: 1,
    evidenceKind: "protected-main-implementation-bootstrap-merge-v1",
    repository: REPOSITORY,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    repositoryNodeId: REPOSITORY_NODE_ID,
    bootstrapPullRequestNumber: implementationMerge.pullRequestNumber,
    bootstrapMergeSha: implementationMerge.sha,
    bootstrapTreeSha256: implementationMerge.treeSha256,
    githubAuditEvidence,
    githubAuditEvidenceSha256: sha256Bytes(canonicalize(githubAuditEvidence)),
    subagentReviewReceiptBytesBase64: receiptBase64,
    subagentReviewReceiptsSha256: sha256Bytes(canonicalize(receiptBase64)),
    containsFinalReviewedImplementationAndReleaseScripts: true,
    releaseRequestAbsentSoPublishLaneSkipped: true,
    noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffect: true,
  }
  const bootstrapEvidence = canonicalBinding({
    content,
    contentSha256: sha256Bytes(canonicalize(content)),
    contentSha256EqualsSha256OfJcsContent: true,
  })
  const authority = canonicalBinding({
    schemaVersion: 1,
    authorityKind: "one-time-protected-main-trust-inception-v1",
    repository: REPOSITORY,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    repositoryNodeId: REPOSITORY_NODE_ID,
    bootstrapPullRequestNumber: implementationMerge.pullRequestNumber,
    bootstrapMergeSha: implementationMerge.sha,
    bootstrapTreeSha256: implementationMerge.treeSha256,
    bootstrapEvidencePath: AUTHORITY_PATHS.bootstrapEvidence,
    bootstrapEvidenceSha256: sha256Bytes(bootstrapEvidence.bytes),
    signingWorkflowPath: INCEPTION_MEMBER_PATHS.signingWorkflowSha256,
    signingWorkflowBlobSha256: requiredMembers.signingWorkflowSha256,
    signingExecutionClosureSha256: requiredMembers.signingClosureSha256,
    pairCanaryWorkflowPath: INCEPTION_MEMBER_PATHS.pairCanaryWorkflowSha256,
    pairCanaryWorkflowBlobSha256: requiredMembers.pairCanaryWorkflowSha256,
    pairCanaryExecutionClosureSha256: requiredMembers.pairCanaryClosureSha256,
    inceptionSealWorkflowPath: INCEPTION_MEMBER_PATHS.sealWorkflowSha256,
    inceptionSealWorkflowBlobSha256: requiredMembers.sealWorkflowSha256,
    inceptionSealExecutionClosureSha256: requiredMembers.sealClosureSha256,
    pairCanaryTrustPolicyRef: "developer-id-pair-canary-trust-policy.v1.json",
    pairCanaryTrustPolicySha256: requiredMembers.pairCanaryPolicySha256,
    pairCanaryFoundationSha256: requiredMembers.foundationSha256,
    initialPolicyRef: "release-trust-policy.v1.json",
    initialPolicySha256: requiredMembers.initialPolicySha256,
    initialPolicyVersion: 1,
    releaseRequestAbsentSoPublishLaneSkipped: true,
    noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffectInBootstrap: true,
    createdBeforeAnyDeveloperIdSecretMutation: true,
  })
  const policyHead = canonicalBinding({
    schemaVersion: 1,
    revision: 1,
    priorHeadSha256: null,
    activePolicyVersion: 1,
    activePolicyRef: "release-trust-policy.v1.json",
    activePolicySha256: requiredMembers.initialPolicySha256,
    activation: {
      kind: "inception",
      authorityRef: "release-trust-inception-authority.v1.json",
      authoritySha256: sha256Bytes(authority.bytes),
    },
    activatedAt,
  })
  return { bootstrapEvidence, authority, policyHead, requiredMembers: { ...requiredMembers } }
}

export function constructInceptionSealBody({
  implementationMerge,
  authorityArtifacts,
  authorityMerge,
  createdAt,
} = {}) {
  requireMerge(implementationMerge, "implementation merge")
  requireMerge(authorityMerge, "authority merge")
  requireAuditEvidence(authorityMerge.auditEvidence, "authority audit evidence", authorityMerge)
  if (implementationMerge.sha === authorityMerge.sha || !exactIsoTime(createdAt)
    || authorityMerge.parentShas[0] !== implementationMerge.sha
    || !exactValueBytes(authorityArtifacts?.bootstrapEvidence)
    || !exactValueBytes(authorityArtifacts?.authority)
    || !exactValueBytes(authorityArtifacts?.policyHead)) {
    throw new TypeError("inception seal body input is invalid")
  }
  let expectedAuthorityArtifacts
  try {
    const content = authorityArtifacts.bootstrapEvidence.value.content
    const authority = authorityArtifacts.authority.value
    expectedAuthorityArtifacts = constructInceptionAuthority({
      implementationMerge,
      githubAuditEvidence: content.githubAuditEvidence,
      subagentReviewReceiptBytes: content.subagentReviewReceiptBytesBase64.map((value) => {
        const bytes = decodeCanonicalBase64(value)
        if (!bytes) throw new TypeError("review receipt is invalid")
        return bytes
      }),
      requiredMembers: {
        signingWorkflowSha256: authority.signingWorkflowBlobSha256,
        signingClosureSha256: authority.signingExecutionClosureSha256,
        pairCanaryWorkflowSha256: authority.pairCanaryWorkflowBlobSha256,
        pairCanaryClosureSha256: authority.pairCanaryExecutionClosureSha256,
        sealWorkflowSha256: authority.inceptionSealWorkflowBlobSha256,
        sealClosureSha256: authority.inceptionSealExecutionClosureSha256,
        initialPolicySha256: authority.initialPolicySha256,
        pairCanaryPolicySha256: authority.pairCanaryTrustPolicySha256,
        foundationSha256: authority.pairCanaryFoundationSha256,
      },
      activatedAt: authorityArtifacts.policyHead.value.activatedAt,
    })
  } catch {
    throw new TypeError("inception authority artifacts are invalid")
  }
  if (!sameValue(authorityArtifacts, expectedAuthorityArtifacts)) {
    throw new TypeError("inception authority artifacts are invalid")
  }
  const authority = expectedAuthorityArtifacts.authority.value
  return canonicalBinding({
    schemaVersion: 1,
    repository: REPOSITORY,
    repositoryDatabaseId: REPOSITORY_DATABASE_ID,
    repositoryNodeId: REPOSITORY_NODE_ID,
    bootstrapMergeSha: implementationMerge.sha,
    bootstrapTreeSha256: implementationMerge.treeSha256,
    bootstrapEvidencePath: AUTHORITY_PATHS.bootstrapEvidence,
    bootstrapEvidenceSha256: sha256Bytes(authorityArtifacts.bootstrapEvidence.bytes),
    authorityPath: AUTHORITY_PATHS.authority,
    authoritySha256: sha256Bytes(authorityArtifacts.authority.bytes),
    policyPath: INCEPTION_MEMBER_PATHS.initialPolicySha256,
    policySha256: authority.initialPolicySha256,
    headPath: AUTHORITY_PATHS.policyHead,
    headSha256: sha256Bytes(authorityArtifacts.policyHead.bytes),
    authorityMergePullRequestNumber: authorityMerge.pullRequestNumber,
    authorityMergeSha: authorityMerge.sha,
    authorityMergeTreeSha256: authorityMerge.treeSha256,
    authorityMergeAuditEvidence: authorityMerge.auditEvidence,
    authorityMergeAuditEvidenceSha256: sha256Bytes(canonicalize(authorityMerge.auditEvidence)),
    authorityReferencesEarlierBootstrapMerge: true,
    noSecretSigningPublishOrInstalledRuntimeEffectBeforeSeal: true,
    createdAt,
  })
}

export function constructInceptionSealStatement({ sealBody } = {}) {
  if (!exactValueBytes(sealBody)) {
    throw new TypeError("inception seal statement input is invalid")
  }
  const bodySha256 = sha256Bytes(sealBody.bytes)
  return canonicalBinding({
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: SEAL_BODY_ARTIFACT_PATH,
      digest: { sha256: bodySha256 },
    }],
    predicateType: SEAL_STATEMENT_PREDICATE_TYPE,
    predicate: {
      schemaVersion: 1,
      kind: "release-trust-inception-seal-body",
      bodySha256,
    },
  })
}

function validSealSigstoreBundle(signature, sealBody) {
  const bundleBytes = decodeCanonicalBase64(signature?.sigstoreBundleBase64)
  const envelopeBytes = decodeCanonicalBase64(signature?.dsseEnvelopeBase64)
  let bundle
  try {
    bundle = JSON.parse(bundleBytes.toString("utf8"))
  } catch {
    return false
  }
  if (!exactRecordKeys(bundle, ["mediaType", "verificationMaterial", "dsseEnvelope"])
    || bundle.mediaType !== "application/vnd.dev.sigstore.bundle.v0.3+json"
    || !bundle.verificationMaterial || typeof bundle.verificationMaterial !== "object"
    || Array.isArray(bundle.verificationMaterial)
    || !exactRecordKeys(bundle.dsseEnvelope, ["payload", "payloadType", "signatures"])
    || bundle.dsseEnvelope.payloadType !== "application/vnd.in-toto+json"
    || !Array.isArray(bundle.dsseEnvelope.signatures)
    || bundle.dsseEnvelope.signatures.length !== 1
    || !(exactRecordKeys(bundle.dsseEnvelope.signatures[0], ["sig"])
      || exactRecordKeys(bundle.dsseEnvelope.signatures[0], ["keyid", "sig"]))
    || !validCanonicalBase64(bundle.dsseEnvelope.signatures[0].sig)
    || ("keyid" in bundle.dsseEnvelope.signatures[0]
      && (typeof bundle.dsseEnvelope.signatures[0].keyid !== "string"
        || bundle.dsseEnvelope.signatures[0].keyid.length === 0))
    || canonicalize(bundle.dsseEnvelope) !== envelopeBytes.toString("utf8")) {
    return false
  }
  const payloadBytes = decodeCanonicalBase64(bundle.dsseEnvelope.payload)
  if (!payloadBytes) return false
  const statement = constructInceptionSealStatement({ sealBody })
  return payloadBytes.equals(Buffer.from(statement.bytes))
}

export function constructInceptionSealCarrier({ sealBody, signature } = {}) {
  if (!exactValueBytes(sealBody) || !exactRecordKeys(signature, [
    "schemaVersion",
    "subject",
    "dsseEnvelopeBase64",
    "sigstoreBundleBase64",
    "certificateIdentity",
    "oidcIssuer",
    "certificateBuildConfigDigest",
    "certificateRunInvocationUri",
    "workflowRunId",
    "workflowRunAttempt",
    "workflowHeadSha",
    "signedAt",
  ]) || !exactRecordKeys(signature.subject, ["kind", "name", "sha256"])
    || signature.schemaVersion !== 1
    || signature.subject?.kind !== "release-trust-inception-seal-body"
    || signature.subject.name !== "release-trust-inception-seal-body.v1.json"
    || signature.subject.sha256 !== sha256Bytes(sealBody.bytes)
    || signature.certificateIdentity !== SEAL_CERTIFICATE_IDENTITY
    || signature.oidcIssuer !== "https://token.actions.githubusercontent.com"
    || signature.workflowRunAttempt !== 1
    || signature.workflowHeadSha !== sealBody.value.authorityMergeSha
    || signature.certificateBuildConfigDigest !== sealBody.value.authorityMergeSha
    || !Number.isSafeInteger(signature.workflowRunId) || signature.workflowRunId < 1
    || signature.certificateRunInvocationUri !== `https://github.com/${REPOSITORY}/actions/runs/${signature.workflowRunId}/attempts/1`
    || !validCanonicalBase64(signature.dsseEnvelopeBase64)
    || !validCanonicalBase64(signature.sigstoreBundleBase64)
    || !validSealSigstoreBundle(signature, sealBody)
    || !exactIsoTime(signature.signedAt)) {
    throw new TypeError("inception seal signature is invalid")
  }
  const signatureBytes = canonicalize(signature)
  return canonicalBinding({
    body: sealBody.value,
    bodySha256: sha256Bytes(sealBody.bytes),
    bodySha256EqualsSha256OfJcsBody: true,
    signature,
    signatureSha256: sha256Bytes(signatureBytes),
    carrierPath: CARRIER_PATH,
  })
}

function gitBlobOid(bytes) {
  const content = Buffer.from(bytes)
  return createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex")
}

function expectedCarrierTreeEntry(carrier) {
  return { path: CARRIER_PATH, type: "blob", oid: gitBlobOid(carrier.bytes) }
}

function carrierReceiptValue(carrier, carrierMerge, acquiredAt) {
  return {
    schemaVersion: 1,
    sealPath: CARRIER_PATH,
    sealSha256: sha256Bytes(carrier.bytes),
    carrierPullRequestNumber: carrierMerge.pullRequestNumber,
    carrierMergeSha: carrierMerge.sha,
    carrierTreeSha256: carrierMerge.treeSha256,
    carrierAuditEvidence: carrierMerge.auditEvidence,
    carrierAuditEvidenceSha256: sha256Bytes(canonicalize(carrierMerge.auditEvidence)),
    exactSealBlobIntroducedByCarrierMerge: true,
    noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffect: true,
    acquiredAt,
  }
}

export function constructInceptionCarrierReceipt({
  carrier,
  carrierMerge,
  acquiredAt,
  resolveTreeEntry,
} = {}) {
  requireMerge(carrierMerge, "carrier merge")
  requireAuditEvidence(carrierMerge.auditEvidence, "carrier audit evidence", carrierMerge)
  if (!exactValueBytes(carrier) || !exactIsoTime(acquiredAt) || typeof resolveTreeEntry !== "function") {
    throw new TypeError("inception carrier receipt input is invalid")
  }
  if (carrierMerge.parentShas[0] !== carrier.value.body.authorityMergeSha) {
    throw new TypeError("carrier merge does not follow the authority merge")
  }
  const authorityEntry = resolveTreeEntry(carrier.value.body.authorityMergeSha, CARRIER_PATH)
  const carrierEntry = resolveTreeEntry(carrierMerge.sha, CARRIER_PATH)
  if (authorityEntry !== null || !sameValue(carrierEntry, expectedCarrierTreeEntry(carrier))) {
    throw new TypeError("inception seal blob was not introduced by the carrier merge")
  }
  return carrierReceiptValue(carrier, carrierMerge, acquiredAt)
}

function generatedInceptionStructure(input) {
  const { implementationMerge, authorityMerge, carrierMerge, authorityArtifacts, sealBody, carrier, carrierReceipt } = input ?? {}
  try {
    requireMerge(implementationMerge, "implementation merge")
    requireMerge(authorityMerge, "authority merge")
    requireMerge(carrierMerge, "carrier merge")
  } catch {
    return fail("inception_merge_evidence_invalid")
  }
  if (new Set([implementationMerge.sha, authorityMerge.sha, carrierMerge.sha]).size !== 3
    || authorityMerge.parentShas[0] !== implementationMerge.sha
    || carrierMerge.parentShas[0] !== authorityMerge.sha
    || !exactValueBytes(authorityArtifacts?.bootstrapEvidence)
    || !exactValueBytes(authorityArtifacts?.authority)
    || !exactValueBytes(authorityArtifacts?.policyHead)
    || !exactValueBytes(sealBody)
    || !exactValueBytes(carrier)) {
    return fail("inception_graph_invalid")
  }
  try {
    const content = authorityArtifacts.bootstrapEvidence.value.content
    const authority = authorityArtifacts.authority.value
    const requiredMembers = {
      signingWorkflowSha256: authority.signingWorkflowBlobSha256,
      signingClosureSha256: authority.signingExecutionClosureSha256,
      pairCanaryWorkflowSha256: authority.pairCanaryWorkflowBlobSha256,
      pairCanaryClosureSha256: authority.pairCanaryExecutionClosureSha256,
      sealWorkflowSha256: authority.inceptionSealWorkflowBlobSha256,
      sealClosureSha256: authority.inceptionSealExecutionClosureSha256,
      initialPolicySha256: authority.initialPolicySha256,
      pairCanaryPolicySha256: authority.pairCanaryTrustPolicySha256,
      foundationSha256: authority.pairCanaryFoundationSha256,
    }
    const expectedAuthorityArtifacts = constructInceptionAuthority({
      implementationMerge,
      githubAuditEvidence: content.githubAuditEvidence,
      subagentReviewReceiptBytes: content.subagentReviewReceiptBytesBase64.map((value) => {
        const bytes = decodeCanonicalBase64(value)
        if (!bytes) throw new TypeError("review receipt is invalid")
        return bytes
      }),
      requiredMembers,
      activatedAt: authorityArtifacts.policyHead.value.activatedAt,
    })
    const expectedSealBody = constructInceptionSealBody({
      implementationMerge,
      authorityArtifacts: expectedAuthorityArtifacts,
      authorityMerge,
      createdAt: sealBody.value.createdAt,
    })
    const expectedCarrier = constructInceptionSealCarrier({
      sealBody: expectedSealBody,
      signature: carrier.value.signature,
    })
    requireAuditEvidence(carrierMerge.auditEvidence, "carrier audit evidence", carrierMerge)
    const expectedCarrierReceipt = carrierReceiptValue(expectedCarrier, carrierMerge, carrierReceipt?.acquiredAt)
    if (!exactIsoTime(carrierReceipt?.acquiredAt)) throw new TypeError("carrier receipt time is invalid")
    if (!sameValue(authorityArtifacts, expectedAuthorityArtifacts)
      || !sameValue(sealBody, expectedSealBody)
      || !sameValue(carrier, expectedCarrier)
      || !sameValue(carrierReceipt, expectedCarrierReceipt)
      || new Set([implementationMerge.sha, authorityMerge.sha, carrierMerge.sha]).size !== 3) {
      return fail("inception_graph_invalid")
    }
    return { ok: true }
  } catch {
    return fail("inception_graph_invalid")
  }
}

export function verifyFreshInception(input, dependencies = {}) {
  if (input?.online !== true) return fail("online_reacquisition_required")
  if (input.currentHead !== null) return fail("inception_head_exists")
  if (input.historicalHeadersUsedAsAuthority !== false) return fail("historical_transport_not_authority")
  const structure = generatedInceptionStructure(input.inception)
  if (!structure.ok) return structure
  const requiredFunctions = [
    "acquireRepositoryIdentity",
    "acquireCommit",
    "acquireBlob",
    "acquireTreeEntry",
    "acquireWorkflowRun",
    "acquireSealArtifact",
    "verifySigstore",
  ]
  if (requiredFunctions.some((name) => typeof dependencies[name] !== "function")) {
    return fail("verification_evidence_required")
  }
  const { inception } = input
  try {
    const repository = dependencies.acquireRepositoryIdentity()
    if (!sameValue(repository, {
      repository: REPOSITORY,
      repositoryDatabaseId: REPOSITORY_DATABASE_ID,
      repositoryNodeId: REPOSITORY_NODE_ID,
    })) {
      return fail("canonical_repository_mismatch")
    }
    for (const expected of [inception.implementationMerge, inception.authorityMerge, inception.carrierMerge]) {
      const acquired = dependencies.acquireCommit(expected.sha)
      if (!sameValue(acquired, {
        sha: expected.sha,
        treeOid: expected.treeOid,
        treeSha256: expected.treeSha256,
        parentShas: expected.parentShas,
      })) {
        return fail("immutable_git_commit_mismatch")
      }
    }
    const authority = inception.authorityArtifacts.authority.value
    const implementationHashes = {
      [INCEPTION_MEMBER_PATHS.signingWorkflowSha256]: authority.signingWorkflowBlobSha256,
      [INCEPTION_MEMBER_PATHS.signingClosureSha256]: authority.signingExecutionClosureSha256,
      [INCEPTION_MEMBER_PATHS.pairCanaryWorkflowSha256]: authority.pairCanaryWorkflowBlobSha256,
      [INCEPTION_MEMBER_PATHS.pairCanaryClosureSha256]: authority.pairCanaryExecutionClosureSha256,
      [INCEPTION_MEMBER_PATHS.sealWorkflowSha256]: authority.inceptionSealWorkflowBlobSha256,
      [INCEPTION_MEMBER_PATHS.sealClosureSha256]: authority.inceptionSealExecutionClosureSha256,
      [INCEPTION_MEMBER_PATHS.initialPolicySha256]: authority.initialPolicySha256,
      [INCEPTION_MEMBER_PATHS.pairCanaryPolicySha256]: authority.pairCanaryTrustPolicySha256,
      [INCEPTION_MEMBER_PATHS.foundationSha256]: authority.pairCanaryFoundationSha256,
    }
    const implementationBlobs = new Map()
    for (const [path, expectedSha256] of Object.entries(implementationHashes)) {
      const bytes = Buffer.from(dependencies.acquireBlob(inception.implementationMerge.sha, path))
      if (sha256Bytes(bytes) !== expectedSha256) {
        return fail("immutable_git_blob_mismatch")
      }
      implementationBlobs.set(path, bytes)
    }
    const authorityBlobs = {
      [AUTHORITY_PATHS.bootstrapEvidence]: inception.authorityArtifacts.bootstrapEvidence.bytes,
      [AUTHORITY_PATHS.authority]: inception.authorityArtifacts.authority.bytes,
      [AUTHORITY_PATHS.policyHead]: inception.authorityArtifacts.policyHead.bytes,
    }
    for (const [path, expectedBytes] of Object.entries(authorityBlobs)) {
      if (!Buffer.from(dependencies.acquireBlob(inception.authorityMerge.sha, path)).equals(Buffer.from(expectedBytes))) {
        return fail("immutable_git_blob_mismatch")
      }
    }
    const authorityCarrierEntry = dependencies.acquireTreeEntry(inception.authorityMerge.sha, CARRIER_PATH)
    const carrierEntry = dependencies.acquireTreeEntry(inception.carrierMerge.sha, CARRIER_PATH)
    if (authorityCarrierEntry !== null) return fail("carrier_blob_preexisted")
    if (!sameValue(carrierEntry, expectedCarrierTreeEntry(inception.carrier))) {
      return fail("carrier_blob_mismatch")
    }
    const carrierBlob = dependencies.acquireBlob(inception.carrierMerge.sha, CARRIER_PATH)
    if (!Buffer.from(carrierBlob).equals(Buffer.from(inception.carrier.bytes))) {
      return fail("carrier_blob_mismatch")
    }
    const signature = inception.carrier.value.signature
    if (!Number.isSafeInteger(input.workflowRunId) || input.workflowRunId < 1
      || input.workflowRunAttempt !== 1
      || signature.workflowRunId !== input.workflowRunId
      || signature.workflowRunAttempt !== input.workflowRunAttempt) {
      return fail("seal_workflow_run_mismatch")
    }
    const run = dependencies.acquireWorkflowRun(input.workflowRunId, input.workflowRunAttempt)
    const expectedRun = {
      repository: REPOSITORY,
      repositoryDatabaseId: REPOSITORY_DATABASE_ID,
      repositoryNodeId: REPOSITORY_NODE_ID,
      workflowRunId: input.workflowRunId,
      workflowRunAttempt: 1,
      event: "workflow_dispatch",
      headBranch: "main",
      headSha: inception.authorityMerge.sha,
      workflowPath: SEAL_WORKFLOW_PATH,
      workflowRef: `${REPOSITORY}/${SEAL_WORKFLOW_PATH}@refs/heads/main`,
      workflowSha: inception.authorityMerge.sha,
      conclusion: "success",
    }
    if (!sameValue(run, expectedRun)) return fail("seal_workflow_run_mismatch")
    const artifact = dependencies.acquireSealArtifact(run)
    if (!exactRecordKeys(artifact, [
      "name",
      "workflowRunId",
      "workflowRunAttempt",
      "expired",
      "bodyPath",
      "bodyBytes",
      "sigstoreBundlePath",
      "sigstoreBundleBytes",
      "exactlyTwoFilesNoDuplicatesOrExtras",
    ])
      || artifact.name !== `release-trust-inception-seal-${run.workflowRunId}-1`
      || artifact.workflowRunId !== run.workflowRunId
      || artifact.workflowRunAttempt !== 1
      || artifact.expired !== false
      || artifact.bodyPath !== SEAL_BODY_ARTIFACT_PATH
      || artifact.sigstoreBundlePath !== SEAL_BUNDLE_ARTIFACT_PATH
      || artifact.exactlyTwoFilesNoDuplicatesOrExtras !== true
      || !Buffer.from(artifact.bodyBytes).equals(Buffer.from(inception.sealBody.bytes))
      || !Buffer.from(artifact?.sigstoreBundleBytes ?? "").equals(Buffer.from(
        inception.carrier.value.signature.sigstoreBundleBase64,
        "base64",
      ))) {
      return fail("seal_artifact_mismatch")
    }
    const verification = dependencies.verifySigstore({
      subjectBytes: Buffer.from(inception.sealBody.bytes),
      statementBytes: Buffer.from(constructInceptionSealStatement({ sealBody: inception.sealBody }).bytes),
      signature,
      foundationBytes: implementationBlobs.get(INCEPTION_MEMBER_PATHS.foundationSha256),
      foundationSha256: authority.pairCanaryFoundationSha256,
      expected: {
        certificateIdentity: SEAL_CERTIFICATE_IDENTITY,
        oidcIssuer: "https://token.actions.githubusercontent.com",
        workflowRunId: run.workflowRunId,
        workflowRunAttempt: run.workflowRunAttempt,
        workflowHeadSha: run.headSha,
        workflowRef: run.workflowRef,
        workflowSha: run.workflowSha,
      },
    })
    const expectedVerification = {
      ok: true,
      fulcioChainVerified: true,
      certificateSctVerified: true,
      rekorEntryVerified: true,
      oidcClaimsVerified: true,
      subjectSha256: sha256Bytes(inception.sealBody.bytes),
      dsseEnvelopeSha256: sha256Bytes(Buffer.from(signature.dsseEnvelopeBase64, "base64")),
      sigstoreBundleSha256: sha256Bytes(Buffer.from(signature.sigstoreBundleBase64, "base64")),
      certificateIdentity: signature.certificateIdentity,
      oidcIssuer: signature.oidcIssuer,
      workflowRunId: run.workflowRunId,
      workflowRunAttempt: run.workflowRunAttempt,
      workflowHeadSha: run.headSha,
      certificateBuildConfigDigest: signature.certificateBuildConfigDigest,
      certificateRunInvocationUri: signature.certificateRunInvocationUri,
      foundationSha256: authority.pairCanaryFoundationSha256,
    }
    if (!sameValue(verification, expectedVerification)) {
      return fail("sigstore_seal_invalid")
    }
    return {
      ok: true,
      authoritySha256: sha256Bytes(inception.authorityArtifacts.authority.bytes),
      headSha256: sha256Bytes(inception.authorityArtifacts.policyHead.bytes),
    }
  } catch {
    return fail("online_reacquisition_failed")
  }
}

export function validateInception(input) {
  if (input?.currentHead !== null) {
    return fail("inception_head_exists")
  }
  const content = input?.bootstrapEvidence?.value?.content
  if (!content
    || content.containsFinalReviewedImplementationAndReleaseScripts !== true
    || content.releaseRequestAbsentSoPublishLaneSkipped !== true
    || content.noDeveloperIdSecretSigningPublishInstallOrRuntimeMutationEffect !== true) {
    return fail("bootstrap_evidence_incomplete")
  }
  if (!exactValueBytes(input.bootstrapEvidence)) {
    return fail("bootstrap_evidence_bytes_mismatch")
  }
  if (input.bootstrapEvidence.value.contentSha256 !== sha256Bytes(canonicalize(content))
    || input.bootstrapEvidence.value.contentSha256EqualsSha256OfJcsContent !== true) {
    return fail("bootstrap_evidence_hash_mismatch")
  }
  if (input.authority?.introducedByMergeSha === input.authority?.describedMergeSha) {
    return fail("authority_self_reference")
  }
  if (input.authority?.describedMergeSha !== input.implementationMerge?.sha) {
    return fail("authority_bootstrap_merge_mismatch")
  }
  if (!exactValueBytes(input.authority)) {
    return fail("authority_bytes_mismatch")
  }
  if (input.carrier?.selfReference !== null
    || input.carrier?.introducedByMergeSha === input.carrier?.selfReference) {
    return fail("carrier_self_reference")
  }
  if (!exactValueBytes(input.policyHead) || !exactValueBytes(input.carrier)) {
    return fail("inception_bytes_mismatch")
  }

  const authority = input.authority.value
  if (authority.schemaVersion !== 1
    || authority.authorityKind !== "one-time-protected-main-trust-inception-v1"
    || authority.repository !== "ourostack/ouroboros"
    || authority.repositoryDatabaseId !== 1169669354
    || authority.repositoryNodeId !== "R_kgDORbe86g") {
    return fail("inception_identity_mismatch")
  }
  const expectedMembers = {
    signingWorkflowSha256: authority.signingWorkflowBlobSha256,
    signingClosureSha256: authority.signingExecutionClosureSha256,
    pairCanaryWorkflowSha256: authority.pairCanaryWorkflowBlobSha256,
    pairCanaryClosureSha256: authority.pairCanaryExecutionClosureSha256,
    sealWorkflowSha256: authority.inceptionSealWorkflowBlobSha256,
    sealClosureSha256: authority.inceptionSealExecutionClosureSha256,
    initialPolicySha256: authority.initialPolicySha256,
    pairCanaryPolicySha256: authority.pairCanaryTrustPolicySha256,
    foundationSha256: authority.pairCanaryFoundationSha256,
  }
  if (!sameValue(expectedMembers, input.requiredMembers)) {
    return fail("inception_member_mismatch")
  }
  const evidenceSha256 = sha256Bytes(input.bootstrapEvidence.bytes)
  if (authority.bootstrapMergeSha !== input.implementationMerge.sha
    || authority.bootstrapTreeSha256 !== input.implementationMerge.treeSha256
    || authority.bootstrapEvidenceSha256 !== evidenceSha256) {
    return fail("authority_bootstrap_evidence_mismatch")
  }

  const authoritySha256 = sha256Bytes(input.authority.bytes)
  const policyHeadSha256 = sha256Bytes(input.policyHead.bytes)
  const policyHead = input.policyHead.value
  if (policyHead.revision !== 1
    || policyHead.priorHeadSha256 !== null
    || policyHead.activePolicyVersion !== 1
    || policyHead.activePolicySha256 !== authority.initialPolicySha256
    || policyHead.activation?.kind !== "inception"
    || policyHead.activation.authoritySha256 !== authoritySha256) {
    return fail("inception_head_invalid")
  }

  const sealBody = input.seal?.body
  if (typeof input.seal?.bodyBytes !== "string"
    || input.seal.bodyBytes !== canonicalize(sealBody)) {
    return fail("seal_body_bytes_mismatch")
  }
  if (sealBody.authorityMergeSha !== input.authorityMerge?.sha
    || sealBody.authorityMergeAuditEvidenceSha256 !== sha256Bytes(input.authorityMerge.auditBytes)) {
    return fail("authority_audit_bytes_mismatch")
  }
  if (sealBody.bootstrapMergeSha !== input.implementationMerge.sha
    || sealBody.bootstrapEvidenceSha256 !== evidenceSha256
    || sealBody.authoritySha256 !== authoritySha256
    || sealBody.headSha256 !== policyHeadSha256
    || sealBody.policySha256 !== authority.initialPolicySha256) {
    return fail("seal_body_authority_mismatch")
  }
  if (!sameValue(input.carrier.value.body, sealBody)
    || input.carrier.value.bodySha256 !== sha256Bytes(input.seal.bodyBytes)
    || input.carrier.value.signatureSha256 !== sha256Bytes(input.seal.signatureBytes)) {
    return fail("carrier_seal_mismatch")
  }
  if (!input.externalCarrierReceipt) {
    return fail("carrier_receipt_required")
  }
  if (input.externalCarrierReceipt.carrierCommitSha !== input.carrier.introducedByMergeSha
    || input.externalCarrierReceipt.carrierBlobSha256 !== sha256Bytes(input.carrier.bytes)
    || input.externalCarrierReceipt.exactSealBlobIntroducedByCarrierMerge !== true) {
    return fail("carrier_blob_mismatch")
  }
  return fail("verification_evidence_required")
}

export function validateAbsentHeadAdoption(input) {
  if (input?.online !== true) {
    return fail("online_reacquisition_required")
  }
  if (input.immutableGitObjectsVerified !== true
    || input.workflowRefVerified !== true
    || input.oidcIdentityVerified !== true
    || input.fulcioChainVerified !== true
    || input.ctLogVerified !== true
    || input.rekorEntryVerified !== true
    || input.carrierBlobVerified !== true) {
    return fail("sigstore_evidence_incomplete")
  }
  if (input.historicalHeadersUsedAsAuthority !== false) {
    return fail("historical_transport_not_authority")
  }
  return fail("verification_evidence_required")
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  const decoded = Buffer.from(value, "base64")
  return decoded.length > 0 && decoded.toString("base64") === value ? decoded : null
}

function validTimeRange(range) {
  return Boolean(range
    && typeof range.start === "string"
    && typeof range.end === "string"
    && Number.isFinite(Date.parse(range.start))
    && Number.isFinite(Date.parse(range.end))
    && Date.parse(range.start) < Date.parse(range.end))
}

function validFoundationEntry(entry) {
  const publicKey = decodeCanonicalBase64(entry?.publicKeyDerBase64)
  return Boolean(publicKey
    && SHA256.test(entry.keyId ?? "")
    && SHA256.test(entry.publicKeySha256 ?? "")
    && sha256Bytes(publicKey) === entry.publicKeySha256
    && validTimeRange(entry.validFor))
}

function normalizedLogEntry(log) {
  const publicKey = Buffer.from(log.publicKey.rawBytes, "base64")
  return {
    keyId: Buffer.from(log.logId.keyId, "base64").toString("hex"),
    publicKeyDerBase64: publicKey.toString("base64"),
    publicKeySha256: sha256Bytes(publicKey),
    validFor: {
      start: log.publicKey.validFor.start,
      end: log.publicKey.validFor.end ?? "9999-12-31T23:59:59.999Z",
    },
  }
}

function normalizedFulcioEntries(authorities) {
  return authorities.flatMap((authority) => authority.certChain.certificates.map((certificate) => {
    const certificateDer = Buffer.from(certificate.rawBytes, "base64")
    const parsed = new X509Certificate(certificateDer)
    const publicKey = parsed.publicKey.export({ format: "der", type: "spki" })
    return {
      keyId: sha256Bytes(publicKey),
      publicKeyDerBase64: publicKey.toString("base64"),
      publicKeySha256: sha256Bytes(publicKey),
      validFor: {
        start: new Date(parsed.validFrom).toISOString(),
        end: new Date(parsed.validTo).toISOString(),
      },
    }
  }))
}

export function validateFoundation(foundation) {
  const collections = [foundation?.fulcioRoots, foundation?.ctLogs, foundation?.rekorLogs]
  if (foundation?.schemaVersion !== 1 || collections.some((entries) => !Array.isArray(entries) || entries.length === 0)) {
    return fail("foundation_incomplete")
  }
  for (const entries of collections) {
    const seen = new Set()
    for (const entry of entries) {
      if (!validFoundationEntry(entry)) {
        return fail("foundation_entry_invalid")
      }
      if (seen.has(entry.keyId)) {
        return fail("foundation_entry_duplicate")
      }
      seen.add(entry.keyId)
    }
  }

  const source = foundation.source
  const rootBytes = decodeCanonicalBase64(source?.rootBase64)
  const trustedRootBytes = decodeCanonicalBase64(source?.trustedRootBase64)
  if (!rootBytes || !trustedRootBytes
    || !Number.isInteger(source.rootVersion) || source.rootVersion < 1
    || !SHA1.test(source.repositoryCommit ?? "")
    || sha256Bytes(rootBytes) !== source.rootSha256
    || sha256Bytes(trustedRootBytes) !== source.trustedRootSha256) {
    return fail("foundation_source_invalid")
  }
  let root
  let trustedRoot
  try {
    root = JSON.parse(rootBytes.toString("utf8"))
    trustedRoot = JSON.parse(trustedRootBytes.toString("utf8"))
  } catch {
    return fail("foundation_source_invalid")
  }
  if (root?.signed?.version !== source.rootVersion) {
    return fail("foundation_source_invalid")
  }
  const projected = {
    fulcioRoots: normalizedFulcioEntries(trustedRoot.certificateAuthorities ?? []),
    ctLogs: (trustedRoot.ctlogs ?? []).map(normalizedLogEntry),
    rekorLogs: (trustedRoot.tlogs ?? []).map(normalizedLogEntry),
  }
  if (!sameValue(projected, {
    fulcioRoots: foundation.fulcioRoots,
    ctLogs: foundation.ctLogs,
    rekorLogs: foundation.rekorLogs,
  })) {
    return fail("foundation_projection_mismatch")
  }
  return { ok: true }
}
