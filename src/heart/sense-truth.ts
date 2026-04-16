import { emitNervesEvent } from "../nerves/runtime"
import { DEFAULT_AGENT_SENSES, type AgentSensesConfig, type SenseName } from "./identity"

export type SenseStatus = "disabled" | "not_attached" | "needs_config" | "ready" | "running" | "interactive" | "error"

export interface SenseRuntimeInfo {
  configured?: boolean
  optional?: boolean
  runtime?: "running" | "error"
  detail?: string
}

export interface SenseInventoryEntry {
  sense: SenseName
  label: string
  enabled: boolean
  daemonManaged: boolean
  status: SenseStatus
}

const SENSES: Array<{ sense: SenseName; label: string; daemonManaged: boolean }> = [
  { sense: "cli", label: "CLI", daemonManaged: false },
  { sense: "teams", label: "Teams", daemonManaged: true },
  { sense: "bluebubbles", label: "BlueBubbles", daemonManaged: true },
]

function configuredSenses(senses?: AgentSensesConfig): AgentSensesConfig {
  return senses ?? {
    cli: { ...DEFAULT_AGENT_SENSES.cli },
    teams: { ...DEFAULT_AGENT_SENSES.teams },
    bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
  }
}

function resolveStatus(
  enabled: boolean,
  daemonManaged: boolean,
  runtimeInfo?: SenseRuntimeInfo,
): SenseStatus {
  if (!enabled) {
    return "disabled"
  }
  if (!daemonManaged) {
    return "interactive"
  }
  if (runtimeInfo?.runtime === "error") {
    return "error"
  }
  if (runtimeInfo?.runtime === "running") {
    return "running"
  }
  if (runtimeInfo?.configured === false && runtimeInfo.optional) {
    return "not_attached"
  }
  if (runtimeInfo?.configured === false) {
    return "needs_config"
  }
  return "ready"
}

export function getSenseInventory(
  agent: { senses?: AgentSensesConfig },
  runtime: Partial<Record<SenseName, SenseRuntimeInfo>> = {},
): SenseInventoryEntry[] {
  const senses = configuredSenses(agent.senses)
  const inventory = SENSES.map(({ sense, label, daemonManaged }) => {
    const enabled = senses[sense].enabled
    return {
      sense,
      label,
      enabled,
      daemonManaged,
      status: resolveStatus(enabled, daemonManaged, runtime[sense]),
    }
  })

  emitNervesEvent({
    component: "channels",
    event: "channel.sense_inventory_built",
    message: "built sense inventory",
    meta: {
      senses: inventory.map((entry) => ({
        sense: entry.sense,
        enabled: entry.enabled,
        status: entry.status,
      })),
    },
  })

  return inventory
}
