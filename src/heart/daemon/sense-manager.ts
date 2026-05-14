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
// HTTP health probe import intentionally removed — see the comment in
// listHealthProbes() for the 2026-05-11 incident context.
import type { SenseProbe } from "./health-monitor"

export interface DaemonSenseRow {
  agent: string
  sense: SenseName
  label: string
  enabled: boolean
  status: SenseStatus
  detail: string
  proofMethod?: string
  lastProofAt?: string
  proofAgeMs?: number
  lastFailure?: string
  failureLayer?: string
  recoveryAction?: string
  pendingRecoveryCount?: number
  failedRecoveryCount?: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
  activeTurnCount?: number
  stalledTurnCount?: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
}

export interface DaemonSenseManagerLike {
  startAutoStartSenses(): Promise<void>
  triggerAutoStartSenses?(): void
  stopAll(): Promise<void>
  listSenseRows(): DaemonSenseRow[]
  listHealthProbes?(): SenseProbe[]
  listManagedPids?(): number[]
  restartSense?(managedName: string): Promise<void>
  reviveSense?(agent: string, sense: string): Promise<DaemonSenseRow | null>
}

export interface DaemonSenseManagerOptions {
  agents: string[]
  bundlesRoot?: string
  processManager?: {
    startAutoStartAgents(): Promise<void>
    triggerAutoStartAgents?(): void
    startAgent?(agent: string): Promise<void>
    restartAgent?(agent: string): Promise<void>
    resetAgentFailureState?(agent: string): void
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
  proofMethod?: string
  lastProofAt?: string
  proofAgeMs?: number
  lastFailure?: string
  failureLayer?: string
  recoveryAction?: string
  pendingRecoveryCount?: number
  failedRecoveryCount?: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
  activeTurnCount?: number
  stalledTurnCount?: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
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
    voice: { ...DEFAULT_AGENT_SENSES.voice },
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

  for (const sense of ["cli", "teams", "bluebubbles", "mail", "voice"] as SenseName[]) {
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

function booleanField(record: Record<string, unknown> | undefined, key: string): boolean {
  return record?.[key] === true
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
    voice: { configured: false, detail: "not enabled in agent.json" },
  }

  const payload = runtimeConfig.ok ? runtimeConfig.config : {}
  const unavailableDetail = runtimeConfigUnavailableDetail(agent, runtimeConfig)
  const teams = payload.teams as Record<string, unknown> | undefined
  const teamsChannel = payload.teamsChannel as Record<string, unknown> | undefined
  const machinePayload = machineRuntimeConfig.ok ? machineRuntimeConfig.config : {}
  const bluebubbles = machinePayload.bluebubbles as Record<string, unknown> | undefined
  const bluebubblesChannel = machinePayload.bluebubblesChannel as Record<string, unknown> | undefined
  const mailroom = payload.mailroom as Record<string, unknown> | undefined
  const integrations = payload.integrations as Record<string, unknown> | undefined
  const voice = machinePayload.voice as Record<string, unknown> | undefined

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

  if (senses.voice.enabled) {
    const portableVoice = payload.voice as Record<string, unknown> | undefined
    const conversationEngine = (
      textField(voice, "twilioConversationEngine")
      || textField(voice, "conversationEngine")
      || textField(portableVoice, "twilioConversationEngine")
      || textField(portableVoice, "conversationEngine")
      || "cascade"
    ).toLowerCase()
    const twilioTransportMode = (textField(voice, "twilioTransportMode") || "record-play").toLowerCase()
    const twilioPublicUrl = textField(voice, "twilioPublicUrl")
    const hasOpenAIRealtimeKey = !!(
      textField(portableVoice, "openaiRealtimeApiKey")
      || textField(integrations, "openaiApiKey")
      || textField(integrations, "openaiEmbeddingsApiKey")
    )
    const missing: string[] = []
    /* v8 ignore start -- voice setup missing-field matrix is enforced by the voice runtime resolver; sense-manager only renders human-readable readiness facts @preserve */
    if (conversationEngine === "openai-realtime" || conversationEngine === "openai-sip") {
      if (conversationEngine === "openai-realtime" && twilioTransportMode !== "media-stream") {
        missing.push("voice.twilioTransportMode=media-stream")
      }
      if (!hasOpenAIRealtimeKey) {
        missing.push("voice.openaiRealtimeApiKey")
      }
      if (conversationEngine === "openai-sip") {
        if (!textField(portableVoice, "openaiSipProjectId") && !textField(voice, "openaiSipProjectId")) {
          missing.push("voice.openaiSipProjectId")
        }
        const allowUnsignedWebhooks = booleanField(portableVoice, "openaiSipAllowUnsignedWebhooks")
          || booleanField(voice, "openaiSipAllowUnsignedWebhooks")
        if (!allowUnsignedWebhooks && !textField(portableVoice, "openaiSipWebhookSecret") && !textField(voice, "openaiSipWebhookSecret")) {
          missing.push("voice.openaiSipWebhookSecret")
        }
      }
    } else {
      if (!textField(integrations, "elevenLabsApiKey")) missing.push("integrations.elevenLabsApiKey")
      if (!textField(integrations, "elevenLabsVoiceId") && !textField(portableVoice, "elevenLabsVoiceId")) {
        missing.push("integrations.elevenLabsVoiceId")
      }
      if (!textField(voice, "whisperCliPath")) missing.push("voice.whisperCliPath")
      if (!textField(voice, "whisperModelPath")) missing.push("voice.whisperModelPath")
    }
    /* v8 ignore stop */

    base.voice = missing.length === 0
      ? {
          configured: true,
          /* v8 ignore start -- voice detail copy mirrors runtime resolver modes; resolver tests own the matrix @preserve */
          detail: conversationEngine === "openai-sip"
            ? twilioPublicUrl
              ? "OpenAI Realtime SIP speech-to-speech; Twilio phone transport attached"
              : "OpenAI Realtime SIP speech-to-speech"
            : conversationEngine === "openai-realtime"
            ? twilioPublicUrl
              ? "OpenAI Realtime speech-to-speech; Twilio phone transport attached"
              : "OpenAI Realtime speech-to-speech"
            : twilioPublicUrl
            ? "local Whisper.cpp STT + ElevenLabs TTS; Twilio phone transport attached"
            : "local Whisper.cpp STT + ElevenLabs TTS",
          /* v8 ignore stop */
        }
      : {
          configured: false,
          optional: !machineRuntimeConfig.ok && machineRuntimeConfig.reason === "missing",
          detail: !machineRuntimeConfig.ok && machineRuntimeConfig.reason === "missing"
            ? "not attached on this machine"
            : runtimeConfig.ok && machineRuntimeConfig.ok
              ? `missing ${missing.join("/")}`
              : !runtimeConfig.ok
                ? unavailableDetail
                : runtimeConfigUnavailableDetail(agent, machineRuntimeConfig),
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
  if (sense === "voice") {
    return `Agent-runnable: run 'ouro connect voice --agent ${agent}' for config guidance; use voice.twilioConversationEngine=openai-sip with voice.openaiRealtimeApiKey, voice.openaiSipProjectId, and voice.openaiSipWebhookSecret for preferred SIP phone voice; use openai-realtime for Media Streams fallback, or save ElevenLabs and local Whisper.cpp settings for cascade fallback; then run 'ouro up' again.`
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
  if (sense !== "teams" && sense !== "bluebubbles" && sense !== "mail" && sense !== "voice") return null
  return { agent, sense }
}

function runtimeInfoFor(status: string): SenseRuntimeInfo {
  if (status === "running") return { runtime: "running" }
  return { runtime: "error" }
}

function managedSenseEntry(sense: Exclude<SenseName, "cli">): string {
  if (sense === "teams") return "senses/teams-entry.js"
  if (sense === "bluebubbles") return "senses/bluebubbles/entry.js"
  if (sense === "voice") return "senses/voice-entry.js"
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
  const machineId = sense === "bluebubbles" || sense === "voice" ? currentMachineId() : undefined
  const machine = sense === "bluebubbles" || sense === "voice" ? readMachineRuntimeCredentialConfig(agent) : null
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
  proofMethod?: string
  pendingRecoveryCount: number
  failedRecoveryCount: number
  oldestPendingRecoveryAt?: string
  oldestPendingRecoveryAgeMs?: number
  activeTurnCount?: number
  stalledTurnCount?: number
  oldestActiveTurnStartedAt?: string
  oldestActiveTurnAgeMs?: number
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
      proofMethod: typeof parsed.proofMethod === "string" && parsed.proofMethod.trim()
        ? parsed.proofMethod
        : undefined,
      pendingRecoveryCount: typeof parsed.pendingRecoveryCount === "number" && Number.isFinite(parsed.pendingRecoveryCount)
        ? parsed.pendingRecoveryCount
        : 0,
      failedRecoveryCount: typeof parsed.failedRecoveryCount === "number" && Number.isFinite(parsed.failedRecoveryCount)
        ? parsed.failedRecoveryCount
        : 0,
      oldestPendingRecoveryAt: typeof parsed.oldestPendingRecoveryAt === "string" ? parsed.oldestPendingRecoveryAt : undefined,
      oldestPendingRecoveryAgeMs: typeof parsed.oldestPendingRecoveryAgeMs === "number" && Number.isFinite(parsed.oldestPendingRecoveryAgeMs)
        ? parsed.oldestPendingRecoveryAgeMs
        : undefined,
      activeTurnCount: typeof parsed.activeTurnCount === "number" && Number.isFinite(parsed.activeTurnCount)
        ? parsed.activeTurnCount
        : undefined,
      stalledTurnCount: typeof parsed.stalledTurnCount === "number" && Number.isFinite(parsed.stalledTurnCount)
        ? parsed.stalledTurnCount
        : undefined,
      oldestActiveTurnStartedAt: typeof parsed.oldestActiveTurnStartedAt === "string" ? parsed.oldestActiveTurnStartedAt : undefined,
      oldestActiveTurnAgeMs: typeof parsed.oldestActiveTurnAgeMs === "number" && Number.isFinite(parsed.oldestActiveTurnAgeMs)
        ? parsed.oldestActiveTurnAgeMs
        : undefined,
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
  const checkedAtMs = state.lastCheckedAt ? Date.parse(state.lastCheckedAt) : Number.NaN
  const proofFacts = {
    proofMethod: state.proofMethod ?? "bluebubbles.checkHealth",
    lastProofAt: state.lastCheckedAt,
    proofAgeMs: Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : undefined,
    pendingRecoveryCount: state.pendingRecoveryCount,
    failedRecoveryCount: state.failedRecoveryCount,
    oldestPendingRecoveryAt: state.oldestPendingRecoveryAt,
    oldestPendingRecoveryAgeMs: state.oldestPendingRecoveryAgeMs,
    activeTurnCount: state.activeTurnCount,
    stalledTurnCount: state.stalledTurnCount,
    oldestActiveTurnStartedAt: state.oldestActiveTurnStartedAt,
    oldestActiveTurnAgeMs: state.oldestActiveTurnAgeMs,
  }
  if (!blueBubblesRuntimeStateIsFresh(state.lastCheckedAt)) {
    return {
      runtime: snapshot?.runtime,
      lastFailure: state.lastCheckedAt ? "BlueBubbles proof is stale" : undefined,
      failureLayer: state.lastCheckedAt ? "proof_freshness" : undefined,
    }
  }

  if (snapshot?.runtime !== "running") {
    return {
      runtime: "error",
      detail: "BlueBubbles listener is not running",
      ...proofFacts,
      lastFailure: "listener process is not running",
      failureLayer: "listener",
      recoveryAction: "daemon health monitor will restart the BlueBubbles listener when its probe fails",
    }
  }

  if (state.upstreamStatus === "error") {
    return {
      runtime: "error",
      detail: state.detail,
      ...proofFacts,
      lastFailure: state.detail,
      failureLayer: "upstream",
      recoveryAction: "verify BlueBubbles server/app auth and local machine attachment, then retry the listener",
    }
  }

  if (state.pendingRecoveryCount > 0) {
    return {
      runtime: "error",
      detail: state.detail,
      ...proofFacts,
      lastFailure: state.detail,
      failureLayer: "recovery_queue",
      recoveryAction: "queued recovery will retry; inspect BlueBubbles inbound/recovery sidecar logs if age keeps growing",
    }
  }

  if ((state.stalledTurnCount ?? 0) > 0) {
    return {
      runtime: "error",
      detail: state.detail,
      ...proofFacts,
      lastFailure: state.detail,
      failureLayer: "live_turn_stall",
      recoveryAction: "live iMessage turn timeout/watchdog will release the lane and recovery will retry captured messages",
    }
  }

  if (state.upstreamStatus === "ok") {
    return {
      runtime: "running",
      ...proofFacts,
      ...(state.failedRecoveryCount > 0 ? { detail: state.detail } : {}),
      ...(state.failedRecoveryCount > 0 ? {
        lastFailure: state.detail,
        failureLayer: "recovery_quarantine",
        recoveryAction: "inspect quarantined BlueBubbles recovery failures; live transport remains reachable",
      } : {}),
    }
  }

  return { runtime: snapshot?.runtime, ...proofFacts }
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
      return (["teams", "bluebubbles", "mail", "voice"] as Exclude<SenseName, "cli">[])
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
      const machineRefreshed = parsed.sense === "bluebubbles" || parsed.sense === "voice"
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

  private async refreshEnabledSenseConfigs(): Promise<void> {
    const refreshes = [...this.contexts.entries()].map(async ([agent, context]) => {
      const enabledManagedSenses = (["teams", "bluebubbles", "mail", "voice"] as Exclude<SenseName, "cli">[])
        .filter((sense) => context.senses[sense].enabled)
      /* v8 ignore next -- periodic refresh work only exists when a managed background sense is enabled @preserve */
      if (enabledManagedSenses.length === 0) return

      /* v8 ignore start -- periodic freshness refresh uses the same runtime readers covered by startup integration tests @preserve */
      const runtimeConfig = await refreshRuntimeCredentialConfig(agent, { preserveCachedOnFailure: true })
      const needsMachineConfig = enabledManagedSenses.some((sense) => sense === "bluebubbles" || sense === "voice")
      const machineRuntimeConfig = needsMachineConfig
        ? await refreshMachineRuntimeCredentialConfig(agent, currentMachineId(), { preserveCachedOnFailure: true })
        : readMachineRuntimeCredentialConfig(agent)
      /* v8 ignore stop */

      context.facts = senseFactsFromRuntimeConfig(agent, context.senses, runtimeConfig, machineRuntimeConfig)
    })

    await Promise.all(refreshes)
  }

  async startAutoStartSenses(): Promise<void> {
    await this.refreshEnabledSenseConfigs()
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

      // DELIBERATELY no HTTP health probe for BlueBubbles.
      //
      // We used to register `createHttpHealthProbe(...)` here, which GETs the
      // sense's /health endpoint every ~60s with a 5s timeout. On 2026-05-11
      // that caused a death spiral:
      //   1. Sense gets busy with real work (e.g. VLM image describe → 20+s)
      //   2. /health probe times out at 5s
      //   3. Daemon declares the sense "critical" → SIGTERMs it mid-work
      //   4. Sense respawns, recovery loop replays the same inbound message
      //      into the agent's BB session (visible side-effect — slugger saw
      //      the same user text injected 76 times)
      //   5. New sense hits the same VLM call, gets killed at 5s, repeat
      //
      // The probe was redundant supervision: dead processes are already
      // recaptured by `processManager`'s child-process exit handler. The
      // probe specifically caught "alive but hung" cases — but the cost
      // (killing genuinely-busy processes and replaying messages) far
      // outweighed the benefit. For "alive but hung" detection we now
      // rely on the agent's own awareness: BB sense's runtime.json carries
      // pendingRecoveryCount + lastRecoveredAt, surfaced in the agent
      // prompt. If recovery has been wedged for too long, the agent can
      // call `restart_runtime` itself (see alpha.598 / PR #723).
      //
      // The respawn-loop guard in processManager is the backstop: even if
      // something else triggers a tight respawn cycle for any reason, the
      // guard fires and refuses further restarts after N attempts in M
      // minutes, so we can never re-enter the 2026-05-11 spiral.
    }
    return probes
  }

  async restartSense(managedName: string): Promise<void> {
    if (this.processManager.restartAgent) {
      await this.processManager.restartAgent(managedName)
      return
    }
    await this.processManager.startAgent?.(managedName)
  }

  async reviveSense(agent: string, sense: string): Promise<DaemonSenseRow | null> {
    const parsed = parseSenseSnapshotName(`${agent}:${sense}`)
    if (!parsed) return null
    const context = this.contexts.get(parsed.agent)
    if (!context || !context.senses[parsed.sense].enabled) return null

    const managedName = `${parsed.agent}:${parsed.sense}`
    this.processManager.resetAgentFailureState?.(managedName)
    await this.processManager.startAgent?.(managedName)
    return this.listSenseRows().find((row) => row.agent === parsed.agent && row.sense === parsed.sense) ?? null
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
        voice: {
          configured: context.facts.voice.configured,
          optional: context.facts.voice.optional,
          ...(runtime.get(agent)?.voice ?? {}),
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
        ...(entry.sense === "bluebubbles" ? {
          proofMethod: blueBubblesRuntimeFacts.proofMethod,
          lastProofAt: blueBubblesRuntimeFacts.lastProofAt,
          proofAgeMs: blueBubblesRuntimeFacts.proofAgeMs,
          lastFailure: blueBubblesRuntimeFacts.lastFailure,
          failureLayer: blueBubblesRuntimeFacts.failureLayer,
          recoveryAction: blueBubblesRuntimeFacts.recoveryAction,
          pendingRecoveryCount: blueBubblesRuntimeFacts.pendingRecoveryCount,
          failedRecoveryCount: blueBubblesRuntimeFacts.failedRecoveryCount,
          oldestPendingRecoveryAt: blueBubblesRuntimeFacts.oldestPendingRecoveryAt,
          oldestPendingRecoveryAgeMs: blueBubblesRuntimeFacts.oldestPendingRecoveryAgeMs,
          activeTurnCount: blueBubblesRuntimeFacts.activeTurnCount,
          stalledTurnCount: blueBubblesRuntimeFacts.stalledTurnCount,
          oldestActiveTurnStartedAt: blueBubblesRuntimeFacts.oldestActiveTurnStartedAt,
          oldestActiveTurnAgeMs: blueBubblesRuntimeFacts.oldestActiveTurnAgeMs,
        } : {}),
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
