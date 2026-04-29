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
  type RuntimeCredentialConfig,
} from "../runtime-credentials"
import { readProviderCredentialPool, type ProviderCredentialRecord } from "../provider-credentials"
import { getSenseInventory, type SenseRuntimeInfo, type SenseStatus } from "../sense-truth"
import { loadOrCreateMachineIdentity } from "../machine-identity"
import { DaemonProcessManager } from "./process-manager"
import { createHttpHealthProbe } from "./http-health-probe"
import type { SenseProbe } from "./health-monitor"

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
  triggerAutoStartSenses?(): void
  stopAll(): Promise<void>
  listSenseRows(): DaemonSenseRow[]
  listHealthProbes?(): SenseProbe[]
  listManagedPids?(): number[]
}

export interface DaemonSenseManagerOptions {
  agents: string[]
  bundlesRoot?: string
  processManager?: {
    startAutoStartAgents(): Promise<void>
    triggerAutoStartAgents?(): void
    startAgent?(agent: string): Promise<void>
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
    mail: { ...DEFAULT_AGENT_SENSES.mail },
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

  for (const sense of ["cli", "teams", "bluebubbles", "mail"] as SenseName[]) {
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
    mail: { configured: false, detail: "not enabled in agent.json" },
  }

  const payload = runtimeConfig.ok ? runtimeConfig.config : {}
  const unavailableDetail = runtimeConfigUnavailableDetail(agent, runtimeConfig)
  const teams = payload.teams as Record<string, unknown> | undefined
  const teamsChannel = payload.teamsChannel as Record<string, unknown> | undefined
  const machinePayload = machineRuntimeConfig.ok ? machineRuntimeConfig.config : {}
  const bluebubbles = machinePayload.bluebubbles as Record<string, unknown> | undefined
  const bluebubblesChannel = machinePayload.bluebubblesChannel as Record<string, unknown> | undefined
  const mailroom = payload.mailroom as Record<string, unknown> | undefined

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

  if (senses.mail.enabled) {
    const privateKeys = mailroom?.privateKeys
    const hasPrivateKeys = !!privateKeys && typeof privateKeys === "object" && !Array.isArray(privateKeys) && Object.values(privateKeys).some((value) => typeof value === "string" && value.trim().length > 0)
    const mailboxAddress = textField(mailroom, "mailboxAddress")
    const missing: string[] = []
    if (!mailboxAddress) missing.push("mailroom.mailboxAddress")
    if (!hasPrivateKeys) missing.push("mailroom.privateKeys")

    base.mail = missing.length === 0
      ? { configured: true, detail: mailboxAddress }
      : {
          configured: false,
          detail: runtimeConfig.ok
            ? `missing ${missing.join("/")}`
            : unavailableDetail,
        }
  }

  return base
}

function senseRepairHint(agent: string, sense: SenseName): string {
  if (sense === "teams") {
    return `Run 'ouro vault config set --agent ${agent} --key teams.clientId', teams.clientSecret, and teams.tenantId; then run 'ouro up' again.`
  }
  if (sense === "mail") {
    return `Agent-runnable: provision Mailroom access with 'ouro connect mail --agent ${agent}', then restart with 'ouro up'.`
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
  if (sense !== "teams" && sense !== "bluebubbles" && sense !== "mail") return null
  return { agent, sense }
}

function runtimeInfoFor(status: string): SenseRuntimeInfo {
  if (status === "running") return { runtime: "running" }
  return { runtime: "error" }
}

function managedSenseEntry(sense: Exclude<SenseName, "cli">): string {
  if (sense === "teams") return "senses/teams-entry.js"
  if (sense === "bluebubbles") return "senses/bluebubbles/entry.js"
  return "senses/mail-entry.js"
}

function runtimeCredentialBootstrapFor(agent: string, sense: Exclude<SenseName, "cli">): {
  agentName: string
  runtimeConfig?: RuntimeCredentialConfig
  machineRuntimeConfig?: RuntimeCredentialConfig
  machineId?: string
  providerCredentialRecords?: ProviderCredentialRecord[]
} | null {
  const runtime = readRuntimeCredentialConfig(agent)
  const machineId = sense === "bluebubbles" ? currentMachineId() : undefined
  const machine = sense === "bluebubbles" ? readMachineRuntimeCredentialConfig(agent) : null
  const providerPool = readProviderCredentialPool(agent)
  const providerCredentialRecords = providerPool.ok
    ? Object.values(providerPool.pool.providers).filter((record): record is ProviderCredentialRecord => !!record)
    : []
  const bootstrap = {
    agentName: agent,
    runtimeConfig: runtime.ok ? runtime.config : undefined,
    machineRuntimeConfig: machine?.ok ? machine.config : undefined,
    machineId,
    providerCredentialRecords: providerCredentialRecords.length > 0 ? providerCredentialRecords : undefined,
  }
  if (!bootstrap.runtimeConfig && !bootstrap.machineRuntimeConfig && !bootstrap.providerCredentialRecords) return null
  return bootstrap
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
  pendingRecoveryCount: number
  failedRecoveryCount: number
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
      pendingRecoveryCount: typeof parsed.pendingRecoveryCount === "number" && Number.isFinite(parsed.pendingRecoveryCount)
        ? parsed.pendingRecoveryCount
        : 0,
      failedRecoveryCount: typeof parsed.failedRecoveryCount === "number" && Number.isFinite(parsed.failedRecoveryCount)
        ? parsed.failedRecoveryCount
        : 0,
    }
    /* v8 ignore stop */
  /* v8 ignore start -- defensive: catch for missing/corrupt BB runtime state file @preserve */
  } catch {
    return { upstreamStatus: "unknown", detail: "startup health probe pending", pendingRecoveryCount: 0, failedRecoveryCount: 0 }
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

  if (snapshot?.runtime !== "running") {
    return {
      runtime: "error",
      detail: "BlueBubbles listener is not running",
    }
  }

  if (state.upstreamStatus === "error") {
    return {
      runtime: "error",
      detail: state.detail,
    }
  }

  if (state.pendingRecoveryCount > 0) {
    return {
      runtime: "error",
      detail: state.detail,
    }
  }

  if (state.upstreamStatus === "ok") {
    return {
      runtime: "running",
      ...(state.failedRecoveryCount > 0 ? { detail: state.detail } : {}),
    }
  }

  return { runtime: snapshot?.runtime }
}

export class DaemonSenseManager implements DaemonSenseManagerLike {
  private readonly processManager: NonNullable<DaemonSenseManagerOptions["processManager"]>
  private readonly contexts: Map<string, AgentSenseContext>
  private readonly pendingConfigRefreshes = new Set<string>()
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
      return (["teams", "bluebubbles", "mail"] as Exclude<SenseName, "cli">[])
        .filter((sense) => context.senses[sense].enabled)
        .map((sense) => ({
          name: `${agent}:${sense}`,
          agentArg: agent,
          entry: managedSenseEntry(sense),
          channel: sense,
          autoStart: true,
          getRuntimeCredentialBootstrap: () => runtimeCredentialBootstrapFor(agent, sense),
        }))
    })

    this.processManager = options.processManager ?? new DaemonProcessManager({
      agents: managedSenseAgents,
      configCheck: async (name) => {
        const parsed = parseSenseSnapshotName(name)
        if (!parsed) return { ok: true }
        const context = this.contexts.get(parsed.agent)
        if (!context) return { ok: true }
        context.facts = senseFactsFromRuntimeConfig(
          parsed.agent,
          context.senses,
          readRuntimeCredentialConfig(parsed.agent),
          readMachineRuntimeCredentialConfig(parsed.agent),
        )
        const fact = context.facts[parsed.sense]
        if (fact.configured) return { ok: true }
        this.scheduleSenseConfigRefresh(name, parsed)
        if (fact.optional) {
          return {
            ok: false,
            skip: true,
            error: `${parsed.sense} is enabled for ${parsed.agent} but not attached on this machine`,
          }
        }
        return {
          ok: false,
          skip: true,
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

  private scheduleSenseConfigRefresh(name: string, parsed: { agent: string; sense: SenseName }): void {
    if (this.pendingConfigRefreshes.has(name)) return
    this.pendingConfigRefreshes.add(name)
    void this.refreshSenseConfigAndRetry(name, parsed)
  }

  private async refreshSenseConfigAndRetry(name: string, parsed: { agent: string; sense: SenseName }): Promise<void> {
    try {
      const refreshed = await refreshRuntimeCredentialConfig(parsed.agent, { preserveCachedOnFailure: true })
      const machineRefreshed = parsed.sense === "bluebubbles"
        ? await refreshMachineRuntimeCredentialConfig(parsed.agent, currentMachineId(), { preserveCachedOnFailure: true })
        : readMachineRuntimeCredentialConfig(parsed.agent)
      const context = this.contexts.get(parsed.agent)
      /* v8 ignore next -- defensive: config refreshes are only scheduled for known agent contexts @preserve */
      if (!context) return
      context.facts = senseFactsFromRuntimeConfig(parsed.agent, context.senses, refreshed, machineRefreshed)
      if (!context.facts[parsed.sense].configured) return
      setTimeout(() => {
        void this.processManager.startAgent?.(name).catch((error) => {
          emitNervesEvent({
            level: "error",
            component: "channels",
            event: "channel.daemon_sense_autostart_error",
            message: "sense autostart failed",
            /* v8 ignore next -- defensive: process manager rejects with Error instances in normal use @preserve */
            meta: { error: error instanceof Error ? error.message : String(error) },
          })
        })
      }, 0)
    } catch (error) {
      emitNervesEvent({
        level: "error",
        component: "channels",
        event: "channel.daemon_sense_autostart_error",
        message: "sense config refresh failed",
        /* v8 ignore next -- defensive: runtime credential refresh rejects with Error instances in normal use @preserve */
        meta: { error: error instanceof Error ? error.message : String(error) },
      })
    } finally {
      this.pendingConfigRefreshes.delete(name)
    }
  }

  async startAutoStartSenses(): Promise<void> {
    await this.processManager.startAutoStartAgents()
  }

  triggerAutoStartSenses(): void {
    if (this.processManager.triggerAutoStartAgents) {
      this.processManager.triggerAutoStartAgents()
      return
    }
    void this.processManager.startAutoStartAgents().catch((error) => {
        emitNervesEvent({
          level: "error",
          component: "channels",
          event: "channel.daemon_sense_autostart_error",
          message: "sense autostart failed",
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
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

  listHealthProbes(): SenseProbe[] {
    const probes: SenseProbe[] = []
    for (const [agent, context] of this.contexts.entries()) {
      const runtimeConfig = readRuntimeCredentialConfig(agent)
      const machineRuntimeConfig = readMachineRuntimeCredentialConfig(agent)
      context.facts = senseFactsFromRuntimeConfig(agent, context.senses, runtimeConfig, machineRuntimeConfig)
      if (!context.senses.bluebubbles.enabled || !context.facts.bluebubbles.configured || !machineRuntimeConfig.ok) {
        continue
      }

      const machinePayload = machineRuntimeConfig.config
      const bluebubblesChannel = machinePayload.bluebubblesChannel as Record<string, unknown> | undefined
      const port = numberField(bluebubblesChannel, "port", DEFAULT_BLUEBUBBLES_PORT)
      probes.push(createHttpHealthProbe(`bluebubbles:${agent}`, port))
    }
    return probes
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
        mail: {
          configured: context.facts.mail.configured,
          ...(runtime.get(agent)?.mail ?? {}),
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
