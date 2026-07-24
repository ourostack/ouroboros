import { createHash, X509Certificate } from "node:crypto"

import { canonicalize, sha256Bytes } from "./canonicalize.mjs"

const SHA256 = /^[a-f0-9]{64}$/
const SHA1 = /^[a-f0-9]{40}$/

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
