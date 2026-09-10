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

  it.each(["fragment", "absolute"])("keeps %s self-references valid across independently cloned schemas", (reference) => {
    const id = `urn:ouro:test:tool-arguments:${reference}`
    const schema = {
      $id: id,
      type: "object",
      definitions: { value: { type: "integer", minimum: 1 } },
      properties: { value: { $ref: `${reference === "absolute" ? id : ""}#/definitions/value` } },
      required: ["value"],
      additionalProperties: false,
    }
    const cloned = structuredClone(schema)

    expect(validateAdvertisedToolArguments('{"value":1}', schema)).toMatchObject({ ok: true })
    expect(validateAdvertisedToolArguments('{"value":1}', cloned)).toMatchObject({ ok: true })
    expect(validateAdvertisedToolArguments('{"value":"1"}', cloned)).toMatchObject({ ok: false, reason: expect.stringContaining("/value") })
    expect(validateAdvertisedToolArguments('{"value":0}', cloned)).toMatchObject({ ok: false, reason: expect.stringContaining("/value") })
    expect(validateAdvertisedToolArguments('{"value":1,"extra":true}', cloned)).toMatchObject({ ok: false, reason: expect.stringContaining("additional") })
  })

  it("does not resolve a tool's external reference from another tool's compiled schema", () => {
    const schema = {
      $id: "urn:ouro:test:tool-arguments:independent",
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    }
    expect(validateAdvertisedToolArguments('{"value":"own"}', schema)).toMatchObject({ ok: true })
    expect(validateAdvertisedToolArguments('{"value":"own"}', { $ref: schema.$id })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("advertised schema is invalid"),
    })
  })

  it("does not retain a schema ID after failed compilation", () => {
    const id = "urn:ouro:test:tool-arguments:failed-compilation"
    expect(validateAdvertisedToolArguments("{}", { $id: id, type: "not-a-json-schema-type" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("advertised schema is invalid"),
    })
    expect(validateAdvertisedToolArguments("{}", { $id: id, type: "object" })).toMatchObject({ ok: true })
  })

  it("keeps built-in meta-schema aliases available for fresh schema snapshots", () => {
    const schema = { $schema: "http://json-schema.org/schema#", type: "object" }
    for (let turn = 0; turn < 2; turn++) {
      expect(validateAdvertisedToolArguments("{}", structuredClone(schema))).toMatchObject({ ok: true })
    }
  })

  it("allows shared subschemas that are reused without forming a cycle", () => {
    const reusableProperty = { type: "string" }
    const schema = {
      type: "object",
      properties: {
        first: reusableProperty,
        second: reusableProperty,
      },
      required: ["first", "second"],
      additionalProperties: false,
    }

    expect(validateAdvertisedToolArguments(
      '{"first":"one","second":"two"}',
      schema,
    )).toMatchObject({ ok: true })
  })

  it("rejects cycles reached through object properties and array entries", () => {
    const objectCycle: Record<string, unknown> = { type: "object" }
    objectCycle.properties = { self: objectCycle }
    expect(validateAdvertisedToolArguments("{}", objectCycle)).toEqual({
      ok: false,
      reason: expect.stringContaining("cyclic schemas are unsupported"),
    })

    const arrayCycle: unknown[] = []
    arrayCycle.push(arrayCycle)
    expect(validateAdvertisedToolArguments("{}", arrayCycle)).toEqual({
      ok: false,
      reason: expect.stringContaining("cyclic schemas are unsupported"),
    })
  })
})
