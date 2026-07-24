import { createHash } from "crypto"
import { TextDecoder } from "util"
import { canonicalize } from "json-canonicalize"
import { emitNervesEvent } from "../../nerves/runtime"

export const JCS_IMPLEMENTATION = {
  package: "json-canonicalize",
  version: "2.0.0",
  integrity: "sha512-yyrnK/mEm6Na3ChbJUWueXdapueW0p380RUyTW87XGb1ww8l8hU0pRrGC3vSWHe9CxrbPHX2fGUOZpNiHR0IIg==",
} as const

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

const utf8Decoder = new TextDecoder("utf-8", { fatal: true })

function assertUnicodeScalarString(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = value.charCodeAt(index + 1)
      if (low < 0xdc00 || low > 0xdfff) throw new Error("RFC 8785 requires valid Unicode scalar strings")
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new Error("RFC 8785 requires valid Unicode scalar strings")
    }
  }
}

function assertJsonValue(value: unknown, seen: Set<object>): asserts value is JsonValue {
  if (value === null || typeof value === "boolean") return
  if (typeof value === "string") {
    assertUnicodeScalarString(value)
    return
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("RFC 8785 requires finite I-JSON numbers")
    return
  }
  if (typeof value !== "object") throw new Error("RFC 8785 authority accepts only I-JSON values")
  if (seen.has(value)) throw new Error("RFC 8785 authority rejects circular values")

  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype) {
    throw new Error("RFC 8785 authority accepts only plain I-JSON objects")
  }
  if (Object.prototype.hasOwnProperty.call(value, "toJSON")) {
    throw new Error("RFC 8785 authority rejects value-substituting toJSON hooks")
  }

  seen.add(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new Error("RFC 8785 authority rejects sparse arrays")
      }
      assertJsonValue(value[index], seen)
    }
  } else {
    for (const [key, child] of Object.entries(value)) {
      assertUnicodeScalarString(key)
      assertJsonValue(child, seen)
    }
  }
  seen.delete(value)
}

export function canonicalizeJson(value: unknown): string {
  assertJsonValue(value, new Set())
  const encoded = canonicalize(value)
  emitNervesEvent({
    component: "heart",
    event: "heart.runtime_json_canonicalized",
    message: "canonicalized RFC 8785 JSON authority",
    meta: { bytes: Buffer.byteLength(encoded, "utf8") },
  })
  return encoded
}

export function parseCanonicalJson(input: string | Buffer): JsonValue {
  let text: string
  try {
    text = typeof input === "string" ? input : utf8Decoder.decode(input)
  } catch {
    throw new Error("canonical JSON is not valid UTF-8")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("canonical JSON is malformed")
  }
  assertJsonValue(parsed, new Set())
  const canonical = canonicalizeJson(parsed)
  if (canonical !== text) throw new Error("JSON bytes are not canonical RFC 8785 encoding")
  return parsed
}

export function sha256CanonicalJson(value: unknown): string {
  return createHash("sha256").update(Buffer.from(canonicalizeJson(value), "utf8")).digest("hex")
}
