import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"

import {
  authorityArtifactDigest,
  canonicalAuthorityJson,
  signAuthorityPayload,
  verifyAuthorityPayload,
} from "../../../heart/daemon/sanctuary-authority-codec"

describe("Sanctuary authority codec", () => {
  it("canonicalizes JSON recursively while preserving array order", () => {
    expect(canonicalAuthorityJson({
      z: [3, { b: true, a: null }],
      a: "value",
    })).toBe('{"a":"value","z":[3,{"a":null,"b":true}]}')
  })

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1.5,
    -0,
    1n,
    () => undefined,
    Symbol("authority"),
    new Date("2026-09-16T00:00:00.000Z"),
    Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 }),
  ])("rejects non-canonical authority values %#", (value) => {
    expect(() => canonicalAuthorityJson(value)).toThrow(/canonical authority JSON/u)
  })

  it("rejects sparse arrays and nested undefined values", () => {
    const sparse: unknown[] = []
    sparse[1] = "value"
    expect(() => canonicalAuthorityJson(sparse)).toThrow(/canonical authority JSON/u)
    expect(() => canonicalAuthorityJson({ nested: undefined })).toThrow(/canonical authority JSON/u)
  })

  it("signs and verifies exact domain-separated payload bytes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519")
    const payload = { permitId: "permit-1", nonce: "a".repeat(64), expiresAt: "2026-09-16T20:00:00.000Z" }
    const artifact = signAuthorityPayload({
      domain: "ouro.sanctuary.host-permit.v1",
      keyId: "sanctuary-root-2026-09-16",
      payload,
      privateKey,
    })

    expect(artifact).toEqual({
      schemaVersion: 1,
      domain: "ouro.sanctuary.host-permit.v1",
      keyId: "sanctuary-root-2026-09-16",
      payload,
      signature: expect.stringMatching(/^[A-Za-z0-9_-]{86}$/u),
    })
    expect(verifyAuthorityPayload({
      artifact,
      expectedDomain: "ouro.sanctuary.host-permit.v1",
      expectedKeyId: "sanctuary-root-2026-09-16",
      publicKey,
    })).toEqual(payload)
    expect(authorityArtifactDigest(artifact.domain, payload)).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })

  it("refuses changed payload, domain, key id, signature, key, or artifact shape", () => {
    const issuer = generateKeyPairSync("ed25519")
    const other = generateKeyPairSync("ed25519")
    const artifact = signAuthorityPayload({
      domain: "ouro.sanctuary.telegram-observation.v1",
      keyId: "issuer-1",
      payload: { updateId: 42, settled: false },
      privateKey: issuer.privateKey,
    })
    const verify = (candidate: unknown, overrides: Partial<Parameters<typeof verifyAuthorityPayload>[0]> = {}) => verifyAuthorityPayload({
      artifact: candidate,
      expectedDomain: "ouro.sanctuary.telegram-observation.v1",
      expectedKeyId: "issuer-1",
      publicKey: issuer.publicKey,
      ...overrides,
    })

    expect(() => verify({ ...artifact, payload: { updateId: 43, settled: false } })).toThrow(/signature/u)
    expect(() => verify(artifact, { expectedDomain: "ouro.sanctuary.host-permit.v1" })).toThrow(/domain/u)
    expect(() => verify(artifact, { expectedKeyId: "issuer-2" })).toThrow(/key id/u)
    const changedSignature = `${artifact.signature.slice(0, -1)}${artifact.signature.endsWith("A") ? "B" : "A"}`
    expect(() => verify({ ...artifact, signature: changedSignature })).toThrow(/signature/u)
    expect(() => verify(artifact, { publicKey: other.publicKey })).toThrow(/signature/u)
    expect(() => verify({ ...artifact, extra: true })).toThrow(/shape/u)
    expect(() => verify({ ...artifact, schemaVersion: 2 })).toThrow(/schema/u)
    expect(() => verify({ ...artifact, signature: "not-base64url" })).toThrow(/signature/u)
    expect(() => verify(null)).toThrow(/shape/u)
    expect(() => verify([])).toThrow(/shape/u)
    expect(() => verify("artifact")).toThrow(/shape/u)
    expect(() => verify({ ...artifact, domain: "" })).toThrow(/domain/u)
    expect(() => verify({ ...artifact, domain: 1 })).toThrow(/domain/u)
    expect(() => verify({ ...artifact, keyId: "" })).toThrow(/key id/u)
    expect(() => verify({ ...artifact, keyId: 1 })).toThrow(/key id/u)
  })

  it("refuses empty signing identities", () => {
    const { privateKey } = generateKeyPairSync("ed25519")
    expect(() => authorityArtifactDigest("", {})).toThrow(/domain/u)
    expect(() => signAuthorityPayload({ domain: "domain", keyId: "", payload: {}, privateKey })).toThrow(/key id/u)
  })
})
