import type { AgentConfig } from "../../heart/identity"
import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

export interface AgentPresentation {
  name: string
  aliases: string[]
}

export function validateAgentDisplayName(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string" || !value.length || value.length > 80 || value.trim() !== value ||
    /[<>\[\]\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.agent_display_name_invalid",
      message: "configured agent displayName is invalid", meta: { field: "displayName" } })
    throw new Error("agent.json displayName must be 1–80 characters without markup, controls or surrounding whitespace")
  }
  return value
}

export function agentPresentation(agent: string, config: Pick<AgentConfig, "displayName">): AgentPresentation {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agent) || agent.includes("..")) {
    throw new Error("agent presentation requires a safe configured identifier")
  }
  const name = validateAgentDisplayName(config.displayName) ?? agent
  emitNervesEvent({ component: "senses", event: "senses.agent_presentation_resolved",
    message: "resolved explicit agent presentation", meta: { configured: config.displayName !== undefined } })
  return { name, aliases: [...new Set([name, agent])] }
}

export function readAgentPresentation(agent: string, root: string): AgentPresentation {
  let encoded: string
  try { encoded = fs.readFileSync(path.join(root, "agent.json"), "utf8") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.agent_presentation_missing",
      message: "agent presentation config is missing; using its routing identifier", meta: { configured: false } })
    return agentPresentation(agent, {})
  }
  const config: unknown = JSON.parse(encoded)
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("agent.json presentation must be an object")
  return agentPresentation(agent, { displayName: validateAgentDisplayName((config as Record<string, unknown>).displayName) })
}

export function agentAddressPattern(aliases: readonly string[]): string {
  if (!aliases.length) return "(?!)"
  return `^@(?:${aliases.map(alias => alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?:\\s+|$)`
}

export function stripAgentAddress(message: string, aliases: readonly string[]): string {
  return message.replace(new RegExp(agentAddressPattern(aliases), "iu"), "")
}
