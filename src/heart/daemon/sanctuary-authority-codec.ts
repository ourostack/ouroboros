import { createHash, sign, verify, type KeyLike } from "node:crypto"

export interface SignedAuthorityPayload<T> {
  schemaVersion: 1
  domain: string
  keyId: string
  payload: T
  signature: string
}

const ARTIFACT_KEYS = ["domain", "keyId", "payload", "schemaVersion", "signature"] as const
const BASE64URL_SIGNATURE = /^[A-Za-z0-9_-]{86}$/u

function invalidCanonicalJson(): never {
  throw new Error("canonical authority JSON value is invalid")
}

export function canonicalAuthorityJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) return invalidCanonicalJson()
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const entries: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) return invalidCanonicalJson()
      entries.push(canonicalAuthorityJson(value[index]))
    }
    return `[${entries.join(",")}]`
  }
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return invalidCanonicalJson()
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalAuthorityJson(record[key])}`).join(",")}}`
}

function signingBytes(domain: string, payload: unknown): Buffer {
  if (!domain) throw new Error("authority domain is invalid")
  return Buffer.from(`ouro.sanctuary.authority.v1\0${domain}\0${canonicalAuthorityJson(payload)}`, "utf8")
}

export function authorityArtifactDigest(domain: string, payload: unknown): string {
  return `sha256:${createHash("sha256").update(signingBytes(domain, payload)).digest("hex")}`
}

export function signAuthorityPayload<T>(input: {
  domain: string
  keyId: string
  payload: T
  privateKey: KeyLike
}): SignedAuthorityPayload<T> {
  if (!input.keyId) throw new Error("authority key id is invalid")
  return {
    schemaVersion: 1,
    domain: input.domain,
    keyId: input.keyId,
    payload: input.payload,
    signature: sign(null, signingBytes(input.domain, input.payload), input.privateKey).toString("base64url"),
  }
}

function authorityArtifact(value: unknown): SignedAuthorityPayload<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("authority artifact shape is invalid")
  const record = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...ARTIFACT_KEYS])) throw new Error("authority artifact shape is invalid")
  if (record.schemaVersion !== 1) throw new Error("authority artifact schema is invalid")
  if (typeof record.domain !== "string" || !record.domain) throw new Error("authority artifact domain is invalid")
  if (typeof record.keyId !== "string" || !record.keyId) throw new Error("authority artifact key id is invalid")
  if (typeof record.signature !== "string" || !BASE64URL_SIGNATURE.test(record.signature)
    || Buffer.from(record.signature, "base64url").length !== 64
    || Buffer.from(record.signature, "base64url").toString("base64url") !== record.signature) {
    throw new Error("authority artifact signature is invalid")
  }
  canonicalAuthorityJson(record.payload)
  return record as unknown as SignedAuthorityPayload<unknown>
}

export function verifyAuthorityPayload<T>(input: {
  artifact: unknown
  expectedDomain: string
  expectedKeyId: string
  publicKey: KeyLike
}): T {
  const artifact = authorityArtifact(input.artifact)
  if (artifact.domain !== input.expectedDomain) throw new Error("authority artifact domain changed")
  if (artifact.keyId !== input.expectedKeyId) throw new Error("authority artifact key id changed")
  if (!verify(null, signingBytes(artifact.domain, artifact.payload), input.publicKey, Buffer.from(artifact.signature, "base64url"))) {
    throw new Error("authority artifact signature is invalid")
  }
  return artifact.payload as T
}
