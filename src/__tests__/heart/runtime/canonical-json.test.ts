import { createHash } from "crypto"
import { describe, expect, it } from "vitest"

import {
  JCS_IMPLEMENTATION,
  canonicalizeJson,
  parseCanonicalJson,
  sha256CanonicalJson,
} from "../../../heart/runtime/canonical-json"

describe("canonical JSON authority", () => {
  it("uses the pinned RFC 8785 implementation", () => {
    expect(JCS_IMPLEMENTATION).toEqual({
      package: "json-canonicalize",
      version: "2.0.0",
      integrity: "sha512-yyrnK/mEm6Na3ChbJUWueXdapueW0p380RUyTW87XGb1ww8l8hU0pRrGC3vSWHe9CxrbPHX2fGUOZpNiHR0IIg==",
    })
  })

  it("matches the RFC 8785 serialization sample", () => {
    const value = {
      numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    }

    expect(canonicalizeJson(value)).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
    )
  })

  it("matches the RFC 8785 UTF-16 property-ordering sample", () => {
    const value = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    }

    expect(canonicalizeJson(value)).toBe(
      "{\"\\r\":\"Carriage Return\",\"1\":\"One\",\"\":\"Control\",\"ö\":\"Latin Small Letter O With Diaeresis\",\"€\":\"Euro Sign\",\"😀\":\"Emoji: Grinning Face\",\"דּ\":\"Hebrew Letter Dalet With Dagesh\"}",
    )
  })

  it("rejects values outside the I-JSON data model before canonicalization", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const sparse = [1, 2]
    delete sparse[0]

    for (const value of [
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      BigInt(1),
      Symbol("value"),
      () => undefined,
      { missing: undefined },
      [undefined],
      sparse,
      circular,
      Object.create({ inherited: true }),
      { toJSON: () => ({ substituted: true }) },
      "\ud800x",
      "\udc00",
      { "\ud800x": true },
    ]) {
      expect(() => canonicalizeJson(value)).toThrow(/RFC 8785|I-JSON|canonical/i)
    }
  })

  it("rejects malformed JSON and non-UTF-8 bytes", () => {
    expect(() => parseCanonicalJson("{")) .toThrow(/malformed/i)
    expect(() => parseCanonicalJson(Buffer.from([0xff]))).toThrow(/UTF-8/i)
  })

  it("rejects parseable ad hoc serializations instead of blessing them as authority", () => {
    const canonical = "{\"a\":0.002,\"nested\":{\"a\":1,\"z\":2},\"z\":1}"
    const adHoc = "{\"a\":2e-3,\"nested\":{\"z\":2,\"a\":1},\"z\":1}"

    expect(parseCanonicalJson(canonical)).toEqual({ a: 0.002, nested: { a: 1, z: 2 }, z: 1 })
    expect(() => parseCanonicalJson(adHoc)).toThrow(/not canonical/i)
  })

  it("hashes the exact UTF-8 canonical bytes", () => {
    const value = { z: "€", a: [3, 2, 1] }
    const expected = createHash("sha256").update(Buffer.from(canonicalizeJson(value), "utf8")).digest("hex")

    expect(sha256CanonicalJson(value)).toBe(expected)
    expect(sha256CanonicalJson(value)).toMatch(/^[a-f0-9]{64}$/)
  })
})
