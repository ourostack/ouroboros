import { createHash } from "node:crypto"
import { canonicalize as canonicalizeJson } from "json-canonicalize"

function assertUnicodeScalarString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError("RFC 8785 strings cannot contain an unpaired surrogate")
      }
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("RFC 8785 strings cannot contain an unpaired surrogate")
    }
  }
}

function assertCanonicalizable(value, ancestors) {
  if (value === null || typeof value === "boolean") return
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("RFC 8785 numbers must be finite")
    }
    return
  }
  if (typeof value === "string") {
    assertUnicodeScalarString(value)
    return
  }
  if (typeof value !== "object") {
    throw new TypeError(`RFC 8785 cannot canonicalize ${typeof value}`)
  }
  if (ancestors.has(value)) {
    throw new TypeError("RFC 8785 cannot canonicalize cyclic values")
  }

  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (const entry of value) assertCanonicalizable(entry, ancestors)
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("RFC 8785 accepts only JSON objects")
    }
    for (const key of Object.keys(value)) {
      assertUnicodeScalarString(key)
      assertCanonicalizable(value[key], ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

export function canonicalize(value) {
  assertCanonicalizable(value, new Set())
  return canonicalizeJson(value)
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex")
}

export function sha256Jcs(value) {
  return sha256Bytes(canonicalize(value))
}
