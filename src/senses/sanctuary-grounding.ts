import { createHash } from "node:crypto"

export type SanctuaryGroundingToolName = "unraid_get_system" | "unraid_get_storage"

export interface SanctuaryToolGrounding {
  toolName: SanctuaryGroundingToolName
  resultDigest: string
  groundingDigest: string
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
    const exact = ["apiVersion", "arrayState", "degraded", "serverName", "unraidVersion", "uptimeSeconds"]
    if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(exact)) throw new Error("Sanctuary system grounding shape is invalid")
    for (const key of ["serverName", "unraidVersion", "apiVersion", "arrayState"]) if (typeof data[key] !== "string" || !data[key]) throw new Error("Sanctuary system grounding value is invalid")
    if (typeof data.degraded !== "boolean" || (data.uptimeSeconds !== null && (!Number.isSafeInteger(data.uptimeSeconds) || Number(data.uptimeSeconds) < 0))) throw new Error("Sanctuary system grounding value is invalid")
    return { serverName: data.serverName, unraidVersion: data.unraidVersion, apiVersion: data.apiVersion, arrayState: data.arrayState, degraded: data.degraded }
  }
  const exact = ["array", "shares", "truncated"]
  if (JSON.stringify(Object.keys(data).sort()) !== JSON.stringify(exact) || !Array.isArray(data.shares) || typeof data.truncated !== "boolean") throw new Error("Sanctuary storage grounding shape is invalid")
  const array = object(data.array, "Sanctuary storage array grounding")
  if (JSON.stringify(Object.keys(array).sort()) !== JSON.stringify(["degraded", "freeBytes", "state", "usedBytes", "usedPercent"])) throw new Error("Sanctuary storage array grounding shape is invalid")
  if (typeof array.state !== "string" || !array.state || typeof array.degraded !== "boolean"
    || ![array.usedBytes, array.freeBytes].every((value) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0))
    || (array.usedPercent !== null && (typeof array.usedPercent !== "number" || !Number.isFinite(array.usedPercent)))) throw new Error("Sanctuary storage array grounding value is invalid")
  return structuredClone(data)
}

function normalized(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
}

function numericTokens(value: number, divisors: Array<[number, string[]]>): string[] {
  const tokens = new Set([String(value)])
  for (const [divisor, units] of divisors) {
    const amount = value / divisor
    for (const precision of [0, 1, 2]) {
      const rendered = amount.toFixed(precision).replace(/\.0+$/u, "").replace(/(\.\d*?)0+$/u, "$1")
      for (const unit of units) tokens.add(`${rendered} ${unit}`)
    }
  }
  return [...tokens]
}

export function sanctuaryGroundedResponseAccurate(toolName: SanctuaryGroundingToolName, facts: Record<string, unknown>, responseText: string): boolean {
  const response = normalized(responseText)
  if (toolName === "unraid_get_system") {
    return [facts.serverName, facts.unraidVersion, facts.arrayState].every((value) => typeof value === "string" && response.includes(normalized(value)))
  }
  const array = object(facts.array, "Sanctuary response storage facts")
  if (typeof array.freeBytes !== "number" || typeof array.usedPercent !== "number") return false
  const freeTokens = numericTokens(array.freeBytes, [[1_000_000_000_000, ["tb"]], [1_099_511_627_776, ["tib"]], [1_000_000_000, ["gb"]], [1_073_741_824, ["gib"]]])
  const percentTokens = [String(array.usedPercent), array.usedPercent.toFixed(1), String(Math.round(array.usedPercent))].map((value) => `${value.replace(/\.0$/u, "")}%`)
  return freeTokens.some((token) => response.includes(normalized(token))) && percentTokens.some((token) => response.includes(token))
}
