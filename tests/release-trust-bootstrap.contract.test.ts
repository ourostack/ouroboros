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

  it("accepts exactly one absent-head inception and rejects circular authority", async () => {
    const { validateInception } = await loadTrustAction("protected-store.mjs")
    const implementationMergeSha = "1".repeat(40)
    const authorityMergeSha = "2".repeat(40)
    const carrierCommitSha = "3".repeat(40)
    const base = {
      schemaVersion: 1,
      currentHead: null,
      implementationMergeSha,
      authorityMergeSha,
      carrierCommitSha,
      authority: {
        implementationMergeSha,
        evidenceMergeSha: implementationMergeSha,
        authorityMergeSha: null,
        carrierCommitSha: null,
      },
      sealBody: {
        authorityMergeSha,
        carrierCommitSha: null,
      },
      carrier: {
        authorityMergeSha,
        sealBodySha256: "a".repeat(64),
        sealSignatureSha256: "b".repeat(64),
        carrierCommitSha: null,
      },
      externalCarrierReceipt: {
        carrierCommitSha,
        carrierBlobSha256: "c".repeat(64),
      },
    }

    expect(validateInception(base)).toEqual({ ok: true })
    expect(validateInception({ ...base, currentHead: { revision: 1 } })).toMatchObject({
      ok: false,
      code: "inception_head_exists",
    })
    expect(validateInception({
      ...base,
      authority: { ...base.authority, authorityMergeSha },
    })).toMatchObject({ ok: false, code: "authority_self_reference" })
    expect(validateInception({
      ...base,
      carrier: { ...base.carrier, carrierCommitSha },
    })).toMatchObject({ ok: false, code: "carrier_self_reference" })
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
