import { createHash } from "node:crypto"

import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"

import { emitNervesEvent } from "../nerves/runtime"
import type { JsonObject, JsonValue } from "../heart/approval-store"

const ajv = new Ajv({
  strict: true,
  allErrors: true,
  coerceTypes: false,
  removeAdditional: false,
  useDefaults: false,
})

const validators = new WeakMap<object, ValidateFunction>()

function unsupportedSchemaFeature(value: unknown, seen = new WeakSet<object>()): string | undefined {
  if (value === null) return "null schema values are unsupported"
  if (typeof value !== "object") return undefined
  if (seen.has(value)) return "cyclic schemas are unsupported"
  seen.add(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const reason = unsupportedSchemaFeature(entry, seen)
      if (reason) return reason
    }
    return undefined
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "patternProperties") return "patternProperties is unsupported"
    if (key === "type" && (entry === "null" || (Array.isArray(entry) && entry.includes("null")))) {
      return "null schema types are unsupported"
    }
    const reason = unsupportedSchemaFeature(entry, seen)
    if (reason) return reason
  }
  return undefined
}

function canonicalize(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`).join(",")}}`
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex")
}

function renderErrors(errors: readonly ErrorObject[]): string {
  return errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")
}

export interface ValidatedToolArguments {
  arguments: JsonObject
  canonicalArguments: string
  argumentDigest: string
  schemaDigest: string
}

export type ToolArgumentValidationResult =
  | { ok: true; value: ValidatedToolArguments }
  | { ok: false; reason: string }

export function digestJson(value: JsonValue): string {
  return digest(canonicalize(value))
}

export function validateAdvertisedToolArguments(
  rawArguments: string,
  schema: object,
): ToolArgumentValidationResult {
  const unsupported = unsupportedSchemaFeature(schema)
  if (unsupported) {
    emitNervesEvent({
      level: "error",
      component: "repertoire",
      event: "repertoire.tool_schema_unsupported",
      message: "advertised tool schema used an unsupported feature",
      meta: { reason: unsupported },
    })
    return { ok: false, reason: `advertised schema is unsupported: ${unsupported}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.tool_arguments_invalid_json",
      message: "tool arguments were not valid JSON",
      meta: { rawLength: rawArguments.length },
    })
    return { ok: false, reason: "malformed JSON" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.tool_arguments_non_object",
      message: "tool arguments were not a JSON object",
      meta: { parsedType: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed },
    })
    return { ok: false, reason: "arguments must be a JSON object" }
  }

  let validator = validators.get(schema)
  try {
    validator ??= ajv.compile(schema)
    validators.set(schema, validator)
  } catch (error) {
    const reason = String(error)
    emitNervesEvent({
      level: "error",
      component: "repertoire",
      event: "repertoire.tool_schema_invalid",
      message: "advertised tool schema could not be compiled",
      meta: { reason },
    })
    return { ok: false, reason: `advertised schema is invalid: ${reason}` }
  }

  if (!validator(parsed)) {
    const reason = renderErrors(validator.errors!)
    emitNervesEvent({
      level: "warn",
      component: "repertoire",
      event: "repertoire.tool_arguments_schema_rejected",
      message: "tool arguments failed advertised schema validation",
      meta: { reason },
    })
    return { ok: false, reason }
  }

  const argumentsValue = structuredClone(parsed) as JsonObject
  const canonicalArguments = canonicalize(argumentsValue)
  emitNervesEvent({
    component: "repertoire",
    event: "repertoire.tool_arguments_validated",
    message: "tool arguments passed advertised schema validation",
    meta: { argumentDigest: digest(canonicalArguments) },
  })
  return {
    ok: true,
    value: {
      arguments: argumentsValue,
      canonicalArguments,
      argumentDigest: digest(canonicalArguments),
      schemaDigest: digestJson(schema as JsonValue),
    },
  }
}
