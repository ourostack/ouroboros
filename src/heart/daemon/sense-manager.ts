import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { readBlueBubblesRuntimeState } from "../../senses/bluebubbles-runtime-state"
import { DEFAULT_AGENT_SENSES, type AgentSensesConfig, type SenseName } from "../identity"
import { getSenseInventory, type SenseRuntimeInfo, type SenseStatus } from "../sense-truth"
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
}

export interface DaemonSenseManagerOptions {
  agents: string[]
  bundlesRoot?: string
  secretsRoot?: string
  processManager?: {
    startAutoStartAgents(): Promise<void>
    stopAll(): Promise<void>
    listAgentSnapshots(): Array<{ name: string; status: string }>
  }
}

interface SenseConfigFacts {
  configured: boolean
  detail: string
}

interface SenseRuntimeFacts {
  runtime?: "running" | "error"
  detail?: string
}

interface AgentSenseContext {
  senses: AgentSensesConfig
  facts: Record<SenseName, SenseConfigFacts>
}

type SecretsPayload = Record<string, unknown>

const DEFAULT_TEAMS_PORT = 3978
const DEFAULT_BLUEBUBBLES_PORT = 18790
const DEFAULT_BLUEBUBBLES_WEBHOOK_PATH = "/bluebubbles-webhook"

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

function readSecretsPayload(secretsPath: string): { payload: SecretsPayload; error: string | null } {
  try {
    const raw = fs.readFileSync(secretsPath, "utf-8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { payload: {}, error: "invalid secrets.json object" }
    }
    return { payload: parsed as SecretsPayload, error: null }
  } catch (error) {
    return {
      payload: {},
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function textField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(record: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const value = record?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function senseFactsFromSecrets(
  agent: string,
  senses: AgentSensesConfig,
  secretsPath: string,
): Record<SenseName, SenseConfigFacts> {
  const base: Record<SenseName, SenseConfigFacts> = {
    cli: { configured: true, detail: "local interactive terminal" },
    teams: { configured: false, detail: "not enabled in agent.json" },
    bluebubbles: { configured: false, detail: "not enabled in agent.json" },
  }

  const { payload, error } = readSecretsPayload(secretsPath)
  const teams = payload.teams as Record<string, unknown> | undefined
  const teamsChannel = payload.teamsChannel as Record<string, unknown> | undefined
  const bluebubbles = payload.bluebubbles as Record<string, unknown> | undefined
  const bluebubblesChannel = payload.bluebubblesChannel as Record<string, unknown> | undefined

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
          detail: error && !fs.existsSync(secretsPath)
            ? `missing secrets.json (${agent})`
            : `missing ${missing.join("/")}`,
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
          detail: error && !fs.existsSync(secretsPath)
            ? `missing secrets.json (${agent})`
            : `missing ${missing.join("/")}`,
        }
  }

  return base
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

function readBlueBubblesRuntimeFacts(
  agent: string,
  bundlesRoot: string,
  snapshot?: SenseRuntimeInfo,
): SenseRuntimeFacts {
  const agentRoot = path.join(bundlesRoot, `${agent}.ouro`)
  const runtimePath = path.join(agentRoot, "state", "senses", "bluebubbles", "runtime.json")
  if (snapshot?.runtime !== "running" || !fs.existsSync(runtimePath)) {
    return { runtime: snapshot?.runtime }
  }

  const state = readBlueBubblesRuntimeState(agent, agentRoot)
  if (state.upstreamStatus === "error") {
    return {
      runtime: "error",
      detail: state.detail,
    }
  }

  return { runtime: snapshot.runtime }
}

export class DaemonSenseManager implements DaemonSenseManagerLike {
  private readonly processManager: NonNullable<DaemonSenseManagerOptions["processManager"]>
  private readonly contexts: Map<string, AgentSenseContext>
  private readonly bundlesRoot: string

  constructor(options: DaemonSenseManagerOptions) {
    const bundlesRoot = options.bundlesRoot ?? path.join(os.homedir(), "AgentBundles")
    const secretsRoot = options.secretsRoot ?? path.join(os.homedir(), ".agentsecrets")
    this.bundlesRoot = bundlesRoot
    this.contexts = new Map(
      options.agents.map((agent) => {
        const senses = readAgentSenses(path.join(bundlesRoot, `${agent}.ouro`, "agent.json"))
        const facts = senseFactsFromSecrets(agent, senses, path.join(secretsRoot, agent, "secrets.json"))
        return [agent, { senses, facts }]
      }),
    )

    const managedSenseAgents = [...this.contexts.entries()].flatMap(([agent, context]) => {
      return (["teams", "bluebubbles"] as SenseName[])
        .filter((sense) => context.senses[sense].enabled && context.facts[sense].configured)
        .map((sense) => ({
          name: `${agent}:${sense}`,
          agentArg: agent,
          entry: sense === "teams" ? "senses/teams-entry.js" : "senses/bluebubbles-entry.js",
          channel: sense,
          autoStart: true,
        }))
    })

    this.processManager = options.processManager ?? new DaemonProcessManager({
      agents: managedSenseAgents,
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
      const blueBubblesRuntimeFacts = readBlueBubblesRuntimeFacts(agent, this.bundlesRoot, runtime.get(agent)?.bluebubbles)
      const runtimeInfo: Partial<Record<SenseName, SenseRuntimeInfo>> = {
        cli: { configured: true },
        teams: {
          configured: context.facts.teams.configured,
          ...(runtime.get(agent)?.teams ?? {}),
        },
        bluebubbles: {
          configured: context.facts.bluebubbles.configured,
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
