import { createHash } from "node:crypto"

import { emitNervesEvent } from "../nerves/runtime"

export type SanctuaryGroundingToolName = "unraid_get_system" | "unraid_get_storage"

export interface SanctuaryToolGrounding {
  toolName: SanctuaryGroundingToolName
  resultDigest: string
  groundingDigest: string
  sourceIdentityDigest: string
  observedAt: string
  facts: Record<string, unknown>
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

export function sanctuaryGroundingDigest(facts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(facts)).digest("hex")
}

export function projectSanctuaryGrounding(toolName: string, result: unknown): Record<string, unknown> | null {
  if (toolName !== "unraid_get_system" && toolName !== "unraid_get_storage") return null
  const envelope = object(result, "Sanctuary grounding result")
  if (envelope.ok !== true) throw new Error("Sanctuary grounding result must succeed")
  const data = object(envelope.data, "Sanctuary grounding data")
  if (toolName === "unraid_get_system") {
    const exact = ["apiVersion", "arrayState", "degraded", "serverName", "sourceIdentityDigest", "unraidVersion", "uptimeSeconds"]
    if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(exact)) throw new Error("Sanctuary system grounding shape is invalid")
    for (const key of ["serverName", "unraidVersion", "apiVersion", "arrayState"]) if (typeof data[key] !== "string" || !data[key]) throw new Error("Sanctuary system grounding value is invalid")
    if (typeof data.degraded !== "boolean" || (data.uptimeSeconds !== null && (!Number.isSafeInteger(data.uptimeSeconds) || Number(data.uptimeSeconds) < 0))) throw new Error("Sanctuary system grounding value is invalid")
    return { serverName: data.serverName, unraidVersion: data.unraidVersion, apiVersion: data.apiVersion, arrayState: data.arrayState, degraded: data.degraded }
  }
  const exact = ["array", "shares", "sourceIdentityDigest", "truncated"]
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(exact) || !Array.isArray(data.shares) || typeof data.truncated !== "boolean") throw new Error("Sanctuary storage grounding shape is invalid")
  const array = object(data.array, "Sanctuary storage array grounding")
  if (JSON.stringify(Object.keys(array).sort()) !== JSON.stringify(["degraded", "freeBytes", "state", "usedBytes", "usedPercent"])) throw new Error("Sanctuary storage array grounding shape is invalid")
  if (typeof array.state !== "string" || !array.state || typeof array.degraded !== "boolean"
    || ![array.usedBytes, array.freeBytes].every((value) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0))
    || (array.usedPercent !== null && (typeof array.usedPercent !== "number" || !Number.isFinite(array.usedPercent)))) throw new Error("Sanctuary storage array grounding value is invalid")
  const { sourceIdentityDigest: _sourceIdentityDigest, ...facts } = data
  return structuredClone(facts)
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
}

function systemResponseAccurate(facts: Record<string, unknown>, response: string): boolean {
  if (typeof facts.serverName !== "string" || typeof facts.unraidVersion !== "string" || typeof facts.arrayState !== "string" || typeof facts.degraded !== "boolean") return false
  const pattern = new RegExp(`^${regexEscape(normalized(facts.serverName))} is running unraid ${regexEscape(normalized(facts.unraidVersion))}(?:; the array is| with the array) ${regexEscape(normalized(facts.arrayState))} and (not degraded|healthy|nominal|degraded|unhealthy)\\.?$`, "u")
  const match = pattern.exec(response)
  if (!match) return false
  return facts.degraded ? match[1] === "degraded" || match[1] === "unhealthy" : match[1] === "not degraded" || match[1] === "healthy" || match[1] === "nominal"
}

function byteAmount(amount: string, unit: string): number {
  const divisors: Record<string, number> = { tb: 1_000_000_000_000, tib: 1_099_511_627_776, gb: 1_000_000_000, gib: 1_073_741_824, byte: 1, bytes: 1 }
  return Number(amount) * divisors[unit]!
}

function storageResponseAccurate(facts: Record<string, unknown>, response: string): boolean {
  const array = object(facts.array, "Sanctuary response storage facts")
  if (typeof array.freeBytes !== "number" || typeof array.usedPercent !== "number" || typeof array.state !== "string" || typeof array.degraded !== "boolean") return false
  const pattern = /^(?:there is|about) (\d+(?:\.\d+)?)\s*(tb|tib|gb|gib|bytes?) (?:is )?(?:available|free|left)(?:;|,| and) (?:(?:the array is )(\d+(?:\.\d+)?)\s*%\s*(?:used|full)|(?:usage is )(\d+(?:\.\d+)?)\s*%)\.(?: the array is ([\p{L}\p{N}_-]+) and (not degraded|healthy|nominal|degraded|unhealthy)\.)?$/u
  const match = pattern.exec(response)
  if (!match) return false
  const bytesAccurate = Math.abs(byteAmount(match[1]!, match[2]!) - array.freeBytes) <= Math.max(1, array.freeBytes * 0.025)
  const percentAccurate = Math.abs(Number(match[3] ?? match[4]) - array.usedPercent) <= 0.51
  if (!bytesAccurate || !percentAccurate) return false
  if (match[5] === undefined && match[6] === undefined) return true
  const healthAccurate = array.degraded ? match[6] === "degraded" || match[6] === "unhealthy" : match[6] === "not degraded" || match[6] === "healthy" || match[6] === "nominal"
  return normalized(String(match[5])) === normalized(array.state) && healthAccurate
}

function compactNumber(value: number): string {
  return value.toFixed(2).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1")
}

export function renderSanctuaryGroundedResponse(toolName: SanctuaryGroundingToolName, facts: Record<string, unknown>): string {
  let response: string
  if (toolName === "unraid_get_system") {
    if (typeof facts.serverName !== "string" || typeof facts.unraidVersion !== "string" || typeof facts.arrayState !== "string" || typeof facts.degraded !== "boolean") throw new Error("Sanctuary system response facts are invalid")
    response = `${facts.serverName} is running Unraid ${facts.unraidVersion} with the array ${facts.arrayState} and ${facts.degraded ? "degraded" : "not degraded"}.`
  } else {
    const array = object(facts.array, "Sanctuary storage response facts")
    if (typeof array.freeBytes !== "number" || typeof array.usedPercent !== "number") throw new Error("Sanctuary storage response facts are invalid")
    const units: Array<[number, string]> = [[1_000_000_000_000, "TB"], [1_000_000_000, "GB"], [1, "bytes"]]
    const freeBytes = Number(array.freeBytes)
    const usedPercent = Number(array.usedPercent)
    const [divisor, unit] = units.find(([candidate]) => freeBytes >= candidate) ?? units[units.length - 1]!
    response = `There is ${compactNumber(freeBytes / divisor)} ${unit} free and the array is ${compactNumber(usedPercent)}% used.`
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.sanctuary_grounded_response_rendered",
    message: "Rendered a deterministic Sanctuary response from grounded facts",
    meta: { toolName },
  })
  return response
}

export function sanctuaryGroundedResponseAccurate(toolName: SanctuaryGroundingToolName, facts: Record<string, unknown>, responseText: string): boolean {
  const response = normalized(responseText)
  return toolName === "unraid_get_system" ? systemResponseAccurate(facts, response) : storageResponseAccurate(facts, response)
}
