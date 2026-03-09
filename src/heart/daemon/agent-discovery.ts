import * as fs from "fs"
import * as path from "path"
import { getAgentBundlesRoot } from "../identity"
import { emitNervesEvent } from "../../nerves/runtime"

type Readdir = (target: string, options: { withFileTypes: true }) => fs.Dirent[]
type ReadText = (target: string, encoding: "utf-8") => string

export interface AgentDiscoveryOptions {
  bundlesRoot?: string
  readdirSync?: Readdir
  readFileSync?: ReadText
}

export function listEnabledBundleAgents(options: AgentDiscoveryOptions = {}): string[] {
  const bundlesRoot = options.bundlesRoot ?? getAgentBundlesRoot()
  const readdirSync = options.readdirSync ?? fs.readdirSync
  const readFileSync = options.readFileSync ?? fs.readFileSync

  let entries: fs.Dirent[]
  try {
    entries = readdirSync(bundlesRoot, { withFileTypes: true })
  } catch {
    emitNervesEvent({
      level: "warn",
      component: "daemon",
      event: "daemon.agent_discovery_failed",
      message: "failed to read bundle root for daemon agent discovery",
      meta: { bundlesRoot },
    })
    return []
  }

  const discovered: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".ouro")) continue
    const agentName = entry.name.slice(0, -5)
    const configPath = path.join(bundlesRoot, entry.name, "agent.json")
    let enabled = true
    try {
      const raw = readFileSync(configPath, "utf-8")
      const parsed = JSON.parse(raw) as { enabled?: unknown }
      if (typeof parsed.enabled === "boolean") {
        enabled = parsed.enabled
      }
    } catch {
      continue
    }
    if (enabled) {
      discovered.push(agentName)
    }
  }

  return discovered.sort((left, right) => left.localeCompare(right))
}
