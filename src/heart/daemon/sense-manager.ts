import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { DEFAULT_AGENT_SENSES, type AgentSensesConfig, type SenseName } from "../identity"
import {
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig,
  refreshRuntimeCredentialConfig,
  type RuntimeCredentialConfigReadResult,
} from "../runtime-credentials"
import { getSenseInventory, type SenseRuntimeInfo, type SenseStatus } from "../sense-truth"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { DaemonProcessManager } from "./process-manager"

export interface DaemonSenseRow {
  agent: string
  sense: SenseName
  label: string
  enabled: boolean
  status: SenseStatus
  detail: string
}

export interface DaemonSenseManagerLike {
  startAutoStartSenses(): Promise<void>
  stopAll(): Promise<void>
  listSenseRows(): DaemonSenseRow[]
  listManagedPids?(): number[]
}

export interface DaemonSenseManagerOptions {
  agents: string[]
  bundlesRoot?: string
  processManager?: {
    startAutoStartAgents(): Promise<void>
    stopAll(): Promise<void>
    listAgentSnapshots(): Array<{ name: string; status: string; pid?: number | null }>
  }
}

interface SenseConfigFacts {
  configured: boolean
  detail: string
  optional?: boolean
}

interface SenseRuntimeFacts {
  runtime?: "running" | "error"
  detail?: string
}

interface AgentSenseContext {
  senses: AgentSensesConfig
  facts: Record<SenseName, SenseConfigFacts>
}

const DEFAULT_TEAMS_PORT = 3978
const DEFAULT_BLUEBUBBLES_PORT = 18790
const DEFAULT_BLUEBUBBLES_WEBHOOK_PATH = "/bluebubbles-webhook"
const BLUEBUBBLES_RUNTIME_FRESHNESS_WINDOW_MS = 90_000

function defaultSenses(): AgentSensesConfig {
  return {
    cli: { ...DEFAULT_AGENT_SENSES.cli },
    teams: { ...DEFAULT_AGENT_SENSES.teams },
    bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
  }
}

function readAgentSenses(agentJsonPath: string): AgentSensesConfig {
  const defaults = defaultSenses()

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(agentJsonPath, "utf-8")) as Record<string, unknown>
  } catch (error) {
    emitNervesEvent({
      level: "warn",
      component: "channels",
      event: "channel.daemon_sense_agent_config_fallback",
      message: "using default senses because agent config could not be read",
      meta: {
        path: agentJsonPath,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    return defaults
  }

  const rawSenses = parsed.senses
  if (!rawSenses || typeof rawSenses !== "object" || Array.isArray(rawSenses)) {
    return defaults
  }

  for (const sense of ["cli", "teams", "bluebubbles"] as SenseName[]) {
    const rawSense = (rawSenses as Record<string, unknown>)[sense]
    if (!rawSense || typeof rawSense !== "object" || Array.isArray(rawSense)) {
      continue
    }
    const enabled = (rawSense as Record<string, unknown>).enabled
    if (typeof enabled === "boolean") {
      defaults[sense] = { enabled }
    }
  }

  return defaults
}

function textField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(record: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function compactRuntimeConfigError(agent: string, error: string): string {
  const compact = error.replace(/\s+/g, " ").trim()
  if (/credential vault is locked|vault locked|vault is locked/i.test(compact)) {
    return `vault locked; run 'ouro vault unlock --agent ${agent}' if you have the saved secret, or 'ouro vault replace --agent ${agent}' if none was saved`
  }
  return compact || "unavailable"
}

function runtimeConfigUnavailableDetail(
  agent: string,
  runtimeConfig: RuntimeCredentialConfigReadResult,
): string {
  if (runtimeConfig.ok) return ""
  const itemName = /^vault:[^:]+:(.+)$/.exec(runtimeConfig.itemPath)?.[1] ?? "runtime/config"
  if (runtimeConfig.reason === "missing") return `missing vault ${itemName} (${agent})`
  return `vault ${itemName} unavailable (${compactRuntimeConfigError(agent, runtimeConfig.error)})`
}

function senseFactsFromRuntimeConfig(
  agent: string,
  senses: AgentSensesConfig,
  runtimeConfig: RuntimeCredentialConfigReadResult,
  machineRuntimeConfig: RuntimeCredentialConfigReadResult = readMachineRuntimeCredentialConfig(agent),
): Record<SenseName, SenseConfigFacts> {
  const base: Record<SenseName, SenseConfigFacts> = {
    cli: { configured: true, detail: "local interactive terminal" },
    teams: { configured: false, detail: "not enabled in agent.json" },
    bluebubbles: { configured: false, detail: "not enabled in agent.json" },
  }

  const payload = runtimeConfig.ok ? runtimeConfig.config : {}
  const unavailableDetail = runtimeConfigUnavailableDetail(agent, runtimeConfig)
  const teams = payload.teams as Record<string, unknown> | undefined
  const teamsChannel = payload.teamsChannel as Record<string, unknown> | undefined
  const machinePayload = machineRuntimeConfig.ok ? machineRuntimeConfig.config : {}
  const bluebubbles = machinePayload.bluebubbles as Record<string, unknown> | undefined
  const bluebubblesChannel = machinePayload.bluebubblesChannel as Record<string, unknown> | undefined

  if (senses.teams.enabled) {
    const missing: string[] = []
    if (!textField(teams, "clientId")) missing.push("teams.clientId")
    if (!textField(teams, "clientSecret")) missing.push("teams.clientSecret")
    if (!textField(teams, "tenantId")) missing.push("teams.tenantId")

    base.teams = missing.length === 0
      ? {
          configured: true,
          detail: `:${numberField(teamsChannel, "port", DEFAULT_TEAMS_PORT)}`,
        }
      : {
          configured: false,
          detail: runtimeConfig.ok
              ? `missing ${missing.join("/")}`
              : unavailableDetail,
        }
  }

  if (senses.bluebubbles.enabled) {
    const missing: string[] = []
    if (!textField(bluebubbles, "serverUrl")) missing.push("bluebubbles.serverUrl")
    if (!textField(bluebubbles, "password")) missing.push("bluebubbles.password")

    base.bluebubbles = missing.length === 0
      ? {
          configured: true,
          detail: `:${numberField(bluebubblesChannel, "port", DEFAULT_BLUEBUBBLES_PORT)} ${textField(bluebubblesChannel, "webhookPath") || DEFAULT_BLUEBUBBLES_WEBHOOK_PATH}`,
        }
      : {
          configured: false,
          optional: !machineRuntimeConfig.ok && machineRuntimeConfig.reason === "missing",
          detail: !machineRuntimeConfig.ok && machineRuntimeConfig.reason === "missing"
            ? "not attached on this machine"
            : machineRuntimeConfig.ok
              ? `missing ${missing.join("/")}`
              : runtimeConfigUnavailableDetail(agent, machineRuntimeConfig),
        }
  }

  return base
}

function senseRepairHint(agent: string, sense: SenseName): string {
  if (sense === "teams") {
    return `Run 'ouro vault config set --agent ${agent} --key teams.clientId', teams.clientSecret, and teams.tenantId; then run 'ouro up' again.`
  }
  return `Run 'ouro connect bluebubbles --agent ${agent}' to attach BlueBubbles on this machine; then run 'ouro up' again.`
}

function currentMachineId(): string {
  return loadOrCreateMachineIdentity({ homeDir: os.homedir() }).machineId
}

function parseSenseSnapshotName(name: string): { agent: string; sense: SenseName } | null {
  const parts = name.split(":")
  if (parts.length !== 2) return null
  const [agent, sense] = parts
  if (sense !== "teams" && sense !== "bluebubbles") return null
  return { agent, sense }
}

function runtimeInfoFor(status: string): SenseRuntimeInfo {
  if (status === "running") return { runtime: "running" }
  return { runtime: "error" }
}

function blueBubblesRuntimeStateIsFresh(lastCheckedAt?: string, now = Date.now()): boolean {
  if (!lastCheckedAt) {
    return false
  }

  const checkedAt = Date.parse(lastCheckedAt)
  if (!Number.isFinite(checkedAt)) {
    return false
  }

  return checkedAt >= now - BLUEBUBBLES_RUNTIME_FRESHNESS_WINDOW_MS
}

// Minimal BlueBubbles runtime state shape — read directly from JSON to avoid
// importing from senses/ (heart must not depend on senses).
interface BlueBubblesRuntimeStateSlice {
  upstreamStatus: "unknown" | "ok" | "error"
  detail: string
  lastCheckedAt?: string
}

function readBlueBubblesRuntimeJson(runtimePath: string): BlueBubblesRuntimeStateSlice {
  try {
    const raw = fs.readFileSync(runtimePath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<BlueBubblesRuntimeStateSlice>
    /* v8 ignore start -- branches: ternary fallbacks for missing/malformed BB runtime fields @preserve */
    return {
      upstreamStatus: parsed.upstreamStatus === "ok" || parsed.upstreamStatus === "error"
        ? parsed.upstreamStatus
        : "unknown",
      detail: typeof parsed.detail === "string" && parsed.detail.trim()
        ? parsed.detail
        : "startup health probe pending",
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : undefined,
    }
    /* v8 ignore stop */
  /* v8 ignore start -- defensive: catch for missing/corrupt BB runtime state file @preserve */
  } catch {
    return { upstreamStatus: "unknown", detail: "startup health probe pending" }
  }
  /* v8 ignore stop */
}

function readBlueBubblesRuntimeFacts(
  agent: string,
  bundlesRoot: string,
  snapshot?: SenseRuntimeInfo,
): SenseRuntimeFacts {
  const agentRoot = path.join(bundlesRoot, `${agent}.ouro`)
  const runtimePath = path.join(agentRoot, "state", "senses", "bluebubbles", "runtime.json")
  if (!fs.existsSync(runtimePath)) {
    return { runtime: snapshot?.runtime }
  }

  const state = readBlueBubblesRuntimeJson(runtimePath)
  if (!blueBubblesRuntimeStateIsFresh(state.lastCheckedAt)) {
    return { runtime: snapshot?.runtime }
  }

  if (state.upstreamStatus === "error") {
    return {
      runtime: "error",
      detail: state.detail,
    }
  }

  if (state.upstreamStatus === "ok") {
    return { runtime: "running" }
  }

  return { runtime: snapshot?.runtime }
}

export class DaemonSenseManager implements DaemonSenseManagerLike {
  private readonly processManager: NonNullable<DaemonSenseManagerOptions["processManager"]>
  private readonly contexts: Map<string, AgentSenseContext>
  private readonly bundlesRoot: string

  constructor(options: DaemonSenseManagerOptions) {
    const bundlesRoot = options.bundlesRoot ?? path.join(os.homedir(), "AgentBundles")
    this.bundlesRoot = bundlesRoot
    this.contexts = new Map(
      options.agents.map((agent) => {
        const senses = readAgentSenses(path.join(bundlesRoot, `${agent}.ouro`, "agent.json"))
        const facts = senseFactsFromRuntimeConfig(agent, senses, readRuntimeCredentialConfig(agent), readMachineRuntimeCredentialConfig(agent))
        return [agent, { senses, facts }]
      }),
    )

    const managedSenseAgents = [...this.contexts.entries()].flatMap(([agent, context]) => {
      return (["teams", "bluebubbles"] as SenseName[])
        .filter((sense) => context.senses[sense].enabled)
        .map((sense) => ({
          name: `${agent}:${sense}`,
          agentArg: agent,
          entry: sense === "teams" ? "senses/teams-entry.js" : "senses/bluebubbles/entry.js",
          channel: sense,
          autoStart: true,
        }))
    })

    this.processManager = options.processManager ?? new DaemonProcessManager({
      agents: managedSenseAgents,
      configCheck: async (name) => {
        const parsed = parseSenseSnapshotName(name)
        if (!parsed) return { ok: true }
        const context = this.contexts.get(parsed.agent)
        if (!context) return { ok: true }
        const refreshed = await refreshRuntimeCredentialConfig(parsed.agent, { preserveCachedOnFailure: true })
        const machineRefreshed = parsed.sense === "bluebubbles"
          ? await refreshMachineRuntimeCredentialConfig(parsed.agent, currentMachineId(), { preserveCachedOnFailure: true })
          : readMachineRuntimeCredentialConfig(parsed.agent)
        context.facts = senseFactsFromRuntimeConfig(parsed.agent, context.senses, refreshed, machineRefreshed)
        const fact = context.facts[parsed.sense]
        if (fact.configured) return { ok: true }
        if (fact.optional) {
          return {
            ok: false,
            skip: true,
            error: `${parsed.sense} is enabled for ${parsed.agent} but not attached on this machine`,
          }
        }
        return {
          ok: false,
          error: `${parsed.sense} is enabled for ${parsed.agent} but runtime credentials are not ready: ${fact.detail}`,
          fix: senseRepairHint(parsed.agent, parsed.sense),
        }
      },
    })

    emitNervesEvent({
      component: "channels",
      event: "channel.daemon_sense_manager_init",
      message: "initialized daemon sense manager",
      meta: {
        agents: options.agents,
        managedSenseProcesses: managedSenseAgents.map((entry) => entry.name),
      },
    })
  }

  async startAutoStartSenses(): Promise<void> {
    await this.processManager.startAutoStartAgents()
  }

  async stopAll(): Promise<void> {
    await this.processManager.stopAll()
  }

  /* v8 ignore start -- pid collection for orphan cleanup pidfile @preserve */
  listManagedPids(): number[] {
    return this.processManager.listAgentSnapshots()
      .map((s) => s.pid)
      .filter((pid): pid is number => pid !== null && pid !== undefined)
  }
  /* v8 ignore stop */

  listSenseRows(): DaemonSenseRow[] {
    const runtime = new Map<string, Partial<Record<SenseName, SenseRuntimeInfo>>>()
    for (const snapshot of this.processManager.listAgentSnapshots()) {
      const parsed = parseSenseSnapshotName(snapshot.name)
      if (!parsed) continue
      const current = runtime.get(parsed.agent) ?? {}
      current[parsed.sense] = runtimeInfoFor(snapshot.status)
      runtime.set(parsed.agent, current)
    }

    const rows = [...this.contexts.entries()].flatMap(([agent, context]) => {
      context.facts = senseFactsFromRuntimeConfig(agent, context.senses, readRuntimeCredentialConfig(agent), readMachineRuntimeCredentialConfig(agent))
      const blueBubblesRuntimeFacts = readBlueBubblesRuntimeFacts(agent, this.bundlesRoot, runtime.get(agent)?.bluebubbles)
      const runtimeInfo: Partial<Record<SenseName, SenseRuntimeInfo>> = {
        cli: { configured: true },
        teams: {
          configured: context.facts.teams.configured,
          ...(runtime.get(agent)?.teams ?? {}),
        },
        bluebubbles: {
          configured: context.facts.bluebubbles.configured,
          optional: context.facts.bluebubbles.optional,
          ...blueBubblesRuntimeFacts,
        },
      }
      const inventory = getSenseInventory({ senses: context.senses }, runtimeInfo)
      return inventory.map((entry) => ({
        agent,
        sense: entry.sense,
        label: entry.label,
        enabled: entry.enabled,
        status: entry.status,
        detail: entry.enabled
          ? entry.sense === "bluebubbles"
            ? blueBubblesRuntimeFacts.detail
              ?? context.facts[entry.sense].detail
            : context.facts[entry.sense].detail
          : "not enabled in agent.json",
      }))
    })

    emitNervesEvent({
      component: "channels",
      event: "channel.daemon_sense_rows_built",
      message: "built daemon sense status rows",
      meta: {
        rows: rows.map((row) => ({
          agent: row.agent,
          sense: row.sense,
          status: row.status,
        })),
      },
    })

    return rows
  }
}
