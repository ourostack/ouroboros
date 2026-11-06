import * as fs from "fs"
import * as path from "path"
import type { AgentProvider } from "../../heart/identity"
import type { ProviderLane } from "../../heart/provider-lanes"

export interface AgentProviderSelectionBindingFixture {
  provider: AgentProvider
  model: string
  source?: string
  updatedAt?: string
}

export interface AgentProviderSelectionFixture {
  lanes: Record<ProviderLane, AgentProviderSelectionBindingFixture>
  readiness?: Partial<Record<ProviderLane, unknown>>
}

const DEFAULT_PHRASES = { thinking: ["working"], tool: ["running tool"], followup: ["processing"] }

function defaultConfig(): Record<string, unknown> {
  return {
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    phrases: DEFAULT_PHRASES,
  }
}

function configPathFor(agentRoot: string): string {
  return path.join(agentRoot, "agent.json")
}

function readConfig(agentRoot: string): Record<string, unknown> {
  const configPath = configPathFor(agentRoot)
  if (!fs.existsSync(configPath)) return defaultConfig()
  return JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>
}

export function writeAgentProviderSelectionFixture(
  agentRoot: string,
  selection: AgentProviderSelectionFixture,
): void {
  fs.mkdirSync(agentRoot, { recursive: true })
  const config = readConfig(agentRoot)
  config.humanFacing = {
    ...((config.humanFacing as Record<string, unknown> | undefined) ?? {}),
    provider: selection.lanes.outward.provider,
    model: selection.lanes.outward.model,
  }
  config.agentFacing = {
    ...((config.agentFacing as Record<string, unknown> | undefined) ?? {}),
    provider: selection.lanes.inner.provider,
    model: selection.lanes.inner.model,
  }
  if (!config.phrases) config.phrases = DEFAULT_PHRASES
  fs.writeFileSync(configPathFor(agentRoot), `${JSON.stringify(config, null, 2)}\n`, "utf-8")
}

export function readAgentProviderSelectionFixture(agentRoot: string): {
  ok: true
  state: AgentProviderSelectionFixture
} {
  const config = readConfig(agentRoot)
  const outward = (config.humanFacing as { provider: AgentProvider; model: string })
  const inner = (config.agentFacing as { provider: AgentProvider; model: string })
  return {
    ok: true,
    state: {
      lanes: {
        outward: { provider: outward.provider, model: outward.model, source: "agent.json" },
        inner: { provider: inner.provider, model: inner.model, source: "agent.json" },
      },
      readiness: {},
    },
  }
}
