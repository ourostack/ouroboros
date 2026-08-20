import { describe, expect, it } from "vitest"

import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"

describe("strict advertised tool arguments", () => {
  it("canonicalizes every JSON value shape deterministically", () => {
    const left = { z: [null, true, 3, "x"], a: { second: 2, first: 1 } }
    const right = { a: { first: 1, second: 2 }, z: [null, true, 3, "x"] }

    expect(digestJson(left)).toBe(digestJson(right))
    expect(digestJson(null)).toMatch(/^[a-f0-9]{64}$/)
    expect(digestJson(false)).not.toBe(digestJson(true))
  })

  it("fails closed when the advertised schema itself is invalid", () => {
    const result = validateAdvertisedToolArguments("{}", { type: "not-a-json-schema-type" })

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("advertised schema is invalid"),
    })
  })

  it.each([
    ["patternProperties", { type: "object", patternProperties: { ".*": { type: "string" } } }],
    ["null literal", { type: "object", properties: { value: null } }],
    ["null type", { type: "object", properties: { value: { type: "null" } } }],
    ["nullable union", { type: "object", properties: { value: { type: ["string", "null"] } } }],
  ])("rejects unsupported %s schemas before argument validation", (_label, schema) => {
    expect(validateAdvertisedToolArguments("{}", schema)).toEqual({
      ok: false,
      reason: expect.stringContaining("unsupported"),
    })
  })

  it("reuses a compiled schema without coercing values", () => {
    const schema = {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    }

    expect(validateAdvertisedToolArguments('{"command":"ok"}', schema)).toMatchObject({ ok: true })
    expect(validateAdvertisedToolArguments('{"command":3}', schema)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("/command"),
    })
  })
})
