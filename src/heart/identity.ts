import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { migrateAgentConfigV1ToV2 } from "./migrate-config"
import { DEFAULT_HABIT_PAID_TURNS_PER_DAY, normalizeHabitPaidTurnsPerDay } from "./autonomy-budget"
import { validateAgentDisplayName } from "../senses/shepherd/agent-presentation"
import { normalizeShepherdCheckInMinutes } from "../senses/shepherd/checkin-config"
import type { AccountPoolSettings } from "./providers/account-pool"

export { normalizeHabitPaidTurnsPerDay } from "./autonomy-budget"

export type AgentProvider = "azure" | "minimax" | "anthropic" | "openai-codex" | "github-copilot" | "openai-compatible" | "openai-compatible-gemini"

/** Single source of truth for per-provider credential field names, env var mappings, and prompt labels. */
export const PROVIDER_CREDENTIALS: Record<AgentProvider, {
  required: string[]
  /** Other complete field sets that satisfy the provider instead of `required` (anthropic: an API key instead of a setup-token). */
  alternativeRequired?: string[][]
  envVars: Record<string, string>
  promptLabels: Record<string, string>
}> = {
  anthropic:        { required: ["setupToken"], alternativeRequired: [["apiKey"]], envVars: { ANTHROPIC_API_KEY: "setupToken" },                                                                                        promptLabels: { setupToken: "Anthropic setup-token" } },
  "openai-codex":   { required: ["oauthAccessToken"],                  envVars: { OPENAI_API_KEY: "oauthAccessToken" },                                                                                     promptLabels: { oauthAccessToken: "OpenAI Codex OAuth token" } },
  azure:            { required: ["apiKey", "endpoint", "deployment"],   envVars: { AZURE_OPENAI_API_KEY: "apiKey", AZURE_OPENAI_KEY: "apiKey", AZURE_OPENAI_ENDPOINT: "endpoint", AZURE_OPENAI_DEPLOYMENT: "deployment" }, promptLabels: { apiKey: "Azure API key", endpoint: "Azure endpoint", deployment: "Azure deployment" } },
  minimax:          { required: ["apiKey"],                             envVars: { MINIMAX_API_KEY: "apiKey" },                                                                                              promptLabels: { apiKey: "MiniMax API key" } },
  "github-copilot": { required: ["githubToken", "baseUrl"],             envVars: { GH_TOKEN: "githubToken", GITHUB_TOKEN: "githubToken" },                                                                   promptLabels: { githubToken: "GitHub token" } },
  "openai-compatible": { required: ["apiKey", "baseUrl"], envVars: {}, promptLabels: { apiKey: "Z.ai API key", baseUrl: "Z.ai canonical base URL" } },
  "openai-compatible-gemini": { required: ["apiKey", "baseUrl"], envVars: {}, promptLabels: { apiKey: "Gemini API key", baseUrl: "Gemini canonical base URL" } },
}
export type SenseName = "cli" | "teams" | "bluebubbles" | "mail" | "voice" | "a2a" | "telegram" | "workbench" | "shepherd" | "app-sessions"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogSinkType = "terminal" | "ndjson"
export interface AgentSenseConfig {
  enabled: boolean
  /**
   * BlueBubbles only: the macOS account signed in to the agent's own Apple ID,
   * which must run the BlueBubbles server. The sense does not start without it,
   * every send first confirms the server runs under it, and BlueBubbles server
   * setup only targets it.
   */
  hostUsername?: string
  /**
   * Shepherd only: which judged returns the owner hears about directly, as a plain message on their
   * channel with no model turn. "off" (the default: the agent judges each return in its private turn and tells the
   * owner what matters), "needs-me" (gates, finished work and a tripped loop guard), or "every".
   */
  notify?: ShepherdNoticePolicy
  checkInMinutes?: number
  /**
   * app-sessions only: Copilot app sessions that drain a GitHub repository's issues. The sense polls each repository
   * (no model turn) and messages the session when an issue is new or changed.
   */
  issueDrains?: IssueDrainConfig[]
  /** app-sessions only: minutes between issue polls (default 5). */
  issuePollMinutes?: number
}

export interface IssueDrainConfig {
  /** `owner/name` on github.com. */
  repo: string
  /** The Copilot app session (full id) that drains the repository. */
  session: string
  /** The signed-in GitHub login to poll as (`gh auth token --user`); omitted, the CLI's active account. */
  account?: string
  /**
   * Trailer keys (`Active-at`, `Waiting-for`) whose `Key: value` lines in an issue body are plan data the lanes rewrite
   * on a schedule. A body edit that changes only those lines does not wake the drain.
   */
  ignoredBodyTrailers?: string[]
}

export type ShepherdNoticePolicy = "every" | "needs-me" | "off"
export const SHEPHERD_NOTICE_POLICIES: readonly ShepherdNoticePolicy[] = ["every", "needs-me", "off"]

export interface AgentSensesConfig {
  cli: AgentSenseConfig
  teams: AgentSenseConfig
  bluebubbles: AgentSenseConfig
  mail: AgentSenseConfig
  voice: AgentSenseConfig
  a2a: AgentSenseConfig
  telegram: AgentSenseConfig
  workbench: AgentSenseConfig
  shepherd: AgentSenseConfig
  /** This machine's GitHub Copilot app sessions: list, read and write them, and hear back from the ones the agent writes to. */
  "app-sessions": AgentSenseConfig
}

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export interface AgentFacingConfig {
  provider: AgentProvider
  model: string
}

export interface AgentConfig {
  version: number
  /** Human-facing identity; does not change the bundle/routing identifier. */
  displayName?: string
  enabled: boolean
  /** @deprecated Use humanFacing/agentFacing instead */
  provider?: AgentProvider
  humanFacing: AgentFacingConfig
  agentFacing: AgentFacingConfig
  context?: {
    maxTokens?: number
    contextMargin?: number
  }
  habitPaidTurnsPerDay?: number
  logging?: {
    level?: LogLevel
    sinks?: LogSinkType[]
  }
  senses?: AgentSensesConfig
  mcpServers?: Record<string, McpServerConfig>
  shell?: {
    defaultTimeout?: number
  }
  phrases: {
    thinking: string[]
    tool: string[]
    followup: string[]
  }
  vault?: {
    email: string
    serverUrl?: string  // Vaultwarden URL, omit for Bitwarden Cloud
  }
  sync?: {
    enabled?: boolean
    remote?: string
    branch?: string
  }
  /**
   * Plugins this agent has enabled. Plugins are machine-installed at
   * ~/.ouro-cli/plugins/<plugin-id>/ via `ouro plugin install`; this list
   * declares which of them apply to this agent. Added 2026-05-18 to support
   * generalizing the bundle layout so external plugins can ship reusable
   * work-organization workspaces (the desk plugin is the first such use case).
   */
  plugins?: PluginConfig[]
  /**
   * Bill model calls across a discovered pool of Copilot accounts (github-copilot only). `ouro auth`
   * discovers the accounts; the runtime moves between them by quota tranche and on a 402 or 429.
   */
  accountPool?: AccountPoolSettings
}

export interface PluginConfig {
  /** Plugin identifier; matches the directory name under ~/.ouro-cli/plugins/. */
  id: string
  /** When false, the plugin is installed-but-disabled for this agent. */
  enabled: boolean
  /** Plugin source URL (e.g. github:ourostack/desk:plugins/desk). Optional; informational. */
  source?: string
  /** Plugin version this agent expects. Optional. */
  version?: string
}

export const DEFAULT_AGENT_CONTEXT = {
  maxTokens: 80000,
  contextMargin: 20,
} as const

export const DEFAULT_AGENT_PHRASES: AgentConfig["phrases"] = {
  thinking: ["working"],
  tool: ["running tool"],
  followup: ["processing"],
}

export const DEFAULT_VAULT_SERVER_URL = "https://vault.ouro.bot"
export const LEGACY_VAULT_SERVER_URL_ALIASES = [
  "https://vault.ouroboros.bot",
  "https://ouro-vault.gentleflower-74452a1e.eastus2.azurecontainerapps.io",
] as const

export function normalizeVaultServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim()
  const withoutTrailingSlash = trimmed.replace(/\/+$/, "")
  if (!withoutTrailingSlash) {
    return DEFAULT_VAULT_SERVER_URL
  }
  if (LEGACY_VAULT_SERVER_URL_ALIASES.includes(withoutTrailingSlash as typeof LEGACY_VAULT_SERVER_URL_ALIASES[number])) {
    return DEFAULT_VAULT_SERVER_URL
  }
  return withoutTrailingSlash
}

export function getVaultServerUrlCandidates(serverUrl: string): string[] {
  const raw = serverUrl.trim()
  const withoutTrailingSlash = raw.replace(/\/+$/, "")
  const normalized = normalizeVaultServerUrl(serverUrl)
  const candidates = [normalized]

  for (const candidate of [withoutTrailingSlash, raw]) {
    if (candidate && !candidates.includes(candidate)) {
      candidates.push(candidate)
    }
  }

  if (normalized === DEFAULT_VAULT_SERVER_URL) {
    for (const alias of LEGACY_VAULT_SERVER_URL_ALIASES) {
      if (!candidates.includes(alias)) {
        candidates.push(alias)
      }
    }
  }

  return candidates
}

export function defaultStableVaultEmail(agentName: string): string {
  const local = agentName
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent"
  return `${local}@ouro.bot`
}

/**
 * Resolve the vault config for an agent, applying defaults.
 * If vault is not configured in agent.json, returns default values.
 */
export function resolveVaultConfig(agentName: string, config?: AgentConfig["vault"]): { email: string; serverUrl: string } {
  return {
    email: config?.email ?? defaultStableVaultEmail(agentName),
    serverUrl: normalizeVaultServerUrl(config?.serverUrl ?? DEFAULT_VAULT_SERVER_URL),
  }
}

export const DEFAULT_AGENT_SENSES: AgentSensesConfig = {
  cli: { enabled: true },
  teams: { enabled: false },
  bluebubbles: { enabled: false },
  mail: { enabled: false },
  voice: { enabled: false },
  a2a: { enabled: false },
  telegram: { enabled: false },
  workbench: { enabled: false },
  shepherd: { enabled: false },
  "app-sessions": { enabled: false },
}

/** What agent.json carries for senses: Workbench is injected at runtime, so bundles need no `workbench` entry. */
export type PersistedAgentSensesConfig = Omit<AgentSensesConfig, "workbench"> & { workbench?: AgentSenseConfig }

/** Drops the disabled Workbench default before senses are written back to agent.json. */
export function persistedSenses(senses: AgentSensesConfig): PersistedAgentSensesConfig {
  const { workbench, ...rest } = senses
  return workbench.enabled ? { ...rest, workbench } : rest
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/**
 * True when agent.json still carries a legacy Workbench registration that
 * `ouro connect workbench` should clean: `mcpServers.ouro_workbench`, or a
 * `senses.workbench` entry other than an explicit `{ enabled: false }`.
 */
export function hasStaleWorkbenchBundleEntry(rawSenses: unknown, rawMcpServers: unknown): boolean {
  if (isPlainRecord(rawMcpServers) && Object.prototype.hasOwnProperty.call(rawMcpServers, "ouro_workbench")) return true
  if (!isPlainRecord(rawSenses) || !Object.prototype.hasOwnProperty.call(rawSenses, "workbench")) return false
  const rawWorkbench = rawSenses.workbench
  return !(isPlainRecord(rawWorkbench) && rawWorkbench.enabled === false)
}

export function normalizeIssueDrains(rawSense: Record<string, unknown>, configFile: string): Pick<AgentSenseConfig, "issueDrains" | "issuePollMinutes"> {
  function fail(what: string): never {
    emitNervesEvent({ level: "error", event: "config_identity.error", component: "config/identity", message: "agent config has invalid issue drains", meta: { path: configFile } })
    throw new Error(`agent.json at ${configFile}: senses.app-sessions.${what}.`)
  }
  const { issueDrains, issuePollMinutes } = rawSense
  const result: Pick<AgentSenseConfig, "issueDrains" | "issuePollMinutes"> = {}
  if (issueDrains !== undefined) {
    if (!Array.isArray(issueDrains)) fail("issueDrains must be an array")
    const seen = new Set<string>()
    result.issueDrains = (issueDrains as unknown[]).map((entry, index) => {
      const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>
      const { repo, session, account, ignoredBodyTrailers } = item
      if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo)) fail(`issueDrains[${index}].repo must be "owner/name"`)
      if (typeof session !== "string" || !session.trim()) fail(`issueDrains[${index}].session must be a Copilot app session id`)
      if (account !== undefined && (typeof account !== "string" || !account.trim())) fail(`issueDrains[${index}].account must be a GitHub login`)
      if (ignoredBodyTrailers !== undefined && (!Array.isArray(ignoredBodyTrailers) || ignoredBodyTrailers.some(key => typeof key !== "string" || !/^[\w][\w -]*$/.test(key.trim())))) {
        fail(`issueDrains[${index}].ignoredBodyTrailers must be an array of trailer keys such as "Active-at"`)
      }
      if (seen.has(repo as string)) fail(`issueDrains[${index}].repo ${repo as string} is listed twice`)
      seen.add(repo as string)
      return {
        repo: repo as string,
        session: (session as string).trim(),
        ...(account !== undefined ? { account: (account as string).trim() } : {}),
        ...(ignoredBodyTrailers !== undefined ? { ignoredBodyTrailers: (ignoredBodyTrailers as string[]).map(key => key.trim()) } : {}),
      }
    })
  }
  if (issuePollMinutes !== undefined) {
    if (typeof issuePollMinutes !== "number" || !Number.isFinite(issuePollMinutes) || issuePollMinutes < 1) fail("issuePollMinutes must be a number of at least 1")
    result.issuePollMinutes = issuePollMinutes
  }
  return result
}

export function normalizeSenses(value: unknown, configFile: string): AgentSensesConfig {
  const defaults: AgentSensesConfig = {
    cli: { ...DEFAULT_AGENT_SENSES.cli },
    teams: { ...DEFAULT_AGENT_SENSES.teams },
    bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
    mail: { ...DEFAULT_AGENT_SENSES.mail },
    voice: { ...DEFAULT_AGENT_SENSES.voice },
    a2a: { ...DEFAULT_AGENT_SENSES.a2a },
    telegram: { ...DEFAULT_AGENT_SENSES.telegram },
    workbench: { ...DEFAULT_AGENT_SENSES.workbench },
    shepherd: { ...DEFAULT_AGENT_SENSES.shepherd },
    "app-sessions": { ...DEFAULT_AGENT_SENSES["app-sessions"] },
  }

  if (value === undefined) {
    return defaults
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "agent config has invalid senses block",
      meta: { path: configFile },
    })
    throw new Error(`agent.json at ${configFile} must include senses as an object when present.`)
  }

  const raw = value as Record<string, unknown>
  const senseNames: SenseName[] = ["cli", "teams", "bluebubbles", "mail", "voice", "a2a", "telegram", "workbench", "shepherd", "app-sessions"]
  for (const senseName of senseNames) {
    const rawSense = raw[senseName]
    if (rawSense === undefined) {
      continue
    }
    if (!rawSense || typeof rawSense !== "object" || Array.isArray(rawSense)) {
      emitNervesEvent({
        level: "error",
        event: "config_identity.error",
        component: "config/identity",
        message: "agent config has invalid sense config",
        meta: { path: configFile, sense: senseName },
      })
      throw new Error(`agent.json at ${configFile} has invalid senses.${senseName} config.`)
    }
    const enabled = (rawSense as Record<string, unknown>).enabled
    if (typeof enabled !== "boolean") {
      emitNervesEvent({
        level: "error",
        event: "config_identity.error",
        component: "config/identity",
        message: "agent config has invalid sense enabled flag",
        meta: { path: configFile, sense: senseName, enabled: enabled ?? null },
      })
      throw new Error(`agent.json at ${configFile} must include senses.${senseName}.enabled as boolean.`)
    }
    const hostUsername = (rawSense as Record<string, unknown>).hostUsername
    if (senseName === "bluebubbles" && hostUsername !== undefined) {
      if (typeof hostUsername !== "string" || hostUsername.trim().length === 0) {
        emitNervesEvent({
          level: "error",
          event: "config_identity.error",
          component: "config/identity",
          message: "agent config has invalid BlueBubbles host username",
          meta: { path: configFile, sense: senseName },
        })
        throw new Error(`agent.json at ${configFile}: senses.bluebubbles.hostUsername must be a non-empty string.`)
      }
      defaults[senseName] = { enabled, hostUsername: hostUsername.trim() }
      continue
    }
    if (senseName === "shepherd") {
      const notify = (rawSense as Record<string, unknown>).notify
      if (notify !== undefined && !SHEPHERD_NOTICE_POLICIES.includes(notify as ShepherdNoticePolicy)) {
        emitNervesEvent({
          level: "error",
          event: "config_identity.error",
          component: "config/identity",
          message: "agent config has invalid Shepherd notice policy",
          meta: { path: configFile, sense: senseName },
        })
        throw new Error(`agent.json at ${configFile}: senses.shepherd.notify must be one of ${SHEPHERD_NOTICE_POLICIES.join(", ")}.`)
      }
      const checkInMinutes = (rawSense as Record<string, unknown>).checkInMinutes
      const normalizedCheckInMinutes = normalizeShepherdCheckInMinutes(checkInMinutes)
      defaults[senseName] = {
        enabled,
        ...(notify !== undefined ? { notify: notify as ShepherdNoticePolicy } : {}),
        ...(checkInMinutes !== undefined ? { checkInMinutes: normalizedCheckInMinutes } : {}),
      }
      continue
    }
    if (senseName === "app-sessions") {
      defaults[senseName] = { enabled, ...normalizeIssueDrains(rawSense as Record<string, unknown>, configFile) }
      continue
    }
    defaults[senseName] = { enabled }
  }

  return defaults
}

export type AgentConfigTemplate = Omit<AgentConfig, "senses"> & { senses: PersistedAgentSensesConfig }

export function buildDefaultAgentTemplate(_agentName: string): AgentConfigTemplate {
  return {
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude-opus-5-5" },
    agentFacing: { provider: "anthropic", model: "claude-opus-5-5" },
    context: { ...DEFAULT_AGENT_CONTEXT },
    habitPaidTurnsPerDay: DEFAULT_HABIT_PAID_TURNS_PER_DAY,
    senses: {
      cli: { ...DEFAULT_AGENT_SENSES.cli },
      teams: { ...DEFAULT_AGENT_SENSES.teams },
      bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
      mail: { ...DEFAULT_AGENT_SENSES.mail },
      voice: { ...DEFAULT_AGENT_SENSES.voice },
      a2a: { ...DEFAULT_AGENT_SENSES.a2a },
      telegram: { ...DEFAULT_AGENT_SENSES.telegram },
      shepherd: { ...DEFAULT_AGENT_SENSES.shepherd },
      "app-sessions": { ...DEFAULT_AGENT_SENSES["app-sessions"] },
    },
    phrases: {
      thinking: [...DEFAULT_AGENT_PHRASES.thinking],
      tool: [...DEFAULT_AGENT_PHRASES.tool],
      followup: [...DEFAULT_AGENT_PHRASES.followup],
    },
  }
}

let _cachedAgentName: string | null = null
let _agentConfigOverride: AgentConfig | null = null

/**
 * Parse `--agent <name>` from process.argv.
 * Caches the result after first parse.
 * Throws if --agent is missing or has no value.
 */
export function getAgentName(): string {
  if (_cachedAgentName) {
    return _cachedAgentName
  }

  const idx = process.argv.indexOf("--agent")
  if (idx === -1 || idx + 1 >= process.argv.length) {
    throw new Error(
      "Missing required --agent <name> argument. Usage: node cli-entry.js --agent ouroboros"
    )
  }

  _cachedAgentName = process.argv[idx + 1]
  emitNervesEvent({
    event: "identity.resolve",
    component: "config/identity",
    message: "resolved agent name from argv",
    meta: { source: "argv" },
  })
  return _cachedAgentName
}

/**
 * Resolve repo root from __dirname.
 * In dev (tsx): __dirname is `<repo>/src/heart`, so repo root is two levels up.
 * In compiled (node dist/): __dirname is `<repo>/dist/heart`, so repo root is two levels up.
 */
export function getRepoRoot(): string {
  return path.resolve(__dirname, "../..")
}

/**
 * Returns the shared bundle root directory: `~/AgentBundles/`
 */
export function getAgentBundlesRoot(): string {
  const homeBase = process.env.WEBSITE_SITE_NAME ? "/home" : os.homedir()
  return path.join(homeBase, "AgentBundles")
}

/**
 * Returns the agent-specific bundle directory: `~/AgentBundles/<agentName>.ouro/`
 */
export function getAgentRoot(agentName: string = getAgentName()): string {
  return path.join(getAgentBundlesRoot(), `${agentName}.ouro`)
}

function resolveOptionalAgentName(agentName?: string): string {
  if (agentName && agentName.trim().length > 0) return agentName.trim()
  try {
    return getAgentName()
  } catch {
    return "default"
  }
}

/**
 * Returns the bundle-local runtime state directory: `~/AgentBundles/<agentName>.ouro/state/`
 */
export function getAgentStateRoot(agentName?: string): string {
  return path.join(getAgentRoot(resolveOptionalAgentName(agentName)), "state")
}

export const HARNESS_CANONICAL_REPO_URL = "https://github.com/ourostack/ouroboros.git"

export function getAgentRepoWorkspacesRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "workspaces")
}

export function getAgentDaemonStateRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "daemon")
}

export function getAgentDaemonLogsDir(agentName?: string): string {
  return path.join(getAgentDaemonStateRoot(resolveOptionalAgentName(agentName)), "logs")
}

export function getAgentDaemonLoggingConfigPath(agentName?: string): string {
  return path.join(getAgentDaemonStateRoot(resolveOptionalAgentName(agentName)), "logging.json")
}

export function getAgentMessagesRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "messages")
}

export function getAgentMailroomRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "mailroom")
}

export function getAgentToolsRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "tools")
}

const VALID_PROVIDERS: readonly string[] = ["azure", "minimax", "anthropic", "openai-codex", "github-copilot", "openai-compatible", "openai-compatible-gemini"]

function isValidProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" && VALID_PROVIDERS.includes(value)
}

function readAndParseAgentJson(configFile: string): Record<string, unknown> {
  let raw: string
  try {
    raw = fs.readFileSync(configFile, "utf-8")
  } catch (error) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "failed reading agent.json",
      meta: {
        path: configFile,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    throw new Error(
      `Cannot read agent.json at ${configFile}. Does the agent directory exist?`
    )
  }

  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "invalid agent.json syntax",
      meta: {
        path: configFile,
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    throw new Error(
      `Invalid JSON in agent.json at ${configFile}. Check syntax.`
    )
  }
}

function validateFacingConfig(
  parsed: Record<string, unknown>,
  facingName: "humanFacing" | "agentFacing",
  configFile: string,
): AgentFacingConfig {
  const raw = parsed[facingName]
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: `agent config missing or invalid ${facingName}`,
      meta: { path: configFile, [facingName]: raw ?? null },
    })
    throw new Error(
      `agent.json at ${configFile} must include ${facingName} as { provider, model }.`,
    )
  }
  const facing = raw as Record<string, unknown>
  if (!isValidProvider(facing.provider)) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: `agent config has invalid provider in ${facingName}`,
      meta: { path: configFile, provider: facing.provider ?? null },
    })
    throw new Error(
      `agent.json at ${configFile} ${facingName}.provider must be one of: ${VALID_PROVIDERS.join(", ")}.`,
    )
  }
  if (typeof facing.model !== "string") {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: `agent config has invalid model in ${facingName}`,
      meta: { path: configFile, model: facing.model ?? null },
    })
    throw new Error(
      `agent.json at ${configFile} ${facingName}.model must be a string.`,
    )
  }
  return { provider: facing.provider, model: facing.model }
}

/**
 * Load and parse `<agentRoot>/agent.json`.
 * Reads the explicit owner's file fresh, or preserves the legacy ambient override when no owner is supplied.
 * If the config is v1, auto-migrates to v2 via migrateAgentConfigV1ToV2 and re-reads.
 * Throws descriptive error if file is missing or contains invalid JSON.
 */
export function loadAgentConfig(owner?: Readonly<{ agentName: string; agentRoot: string }>): AgentConfig {
  if (owner !== undefined && (
    typeof owner !== "object" || owner === null
    || typeof owner.agentName !== "string" || owner.agentName.length === 0
    || typeof owner.agentRoot !== "string" || !path.isAbsolute(owner.agentRoot)
  )) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "invalid agent configuration owner",
      meta: { reason: "explicit owner requires an agent name and absolute root" },
    })
    throw new Error("invalid agent configuration owner")
  }
  if (owner === undefined && _agentConfigOverride) {
    return _agentConfigOverride
  }

  const agentRoot = owner === undefined ? getAgentRoot() : owner.agentRoot
  const configFile = path.join(agentRoot, "agent.json")

  let parsed = readAndParseAgentJson(configFile)

  // Inline migration: v1 -> v2
  const rawVersion = parsed.version
  const initialVersion = typeof rawVersion === "number" ? rawVersion : 1
  if (initialVersion < 2) {
    migrateAgentConfigV1ToV2(agentRoot)
    parsed = readAndParseAgentJson(configFile)
  }

  const existingPhrases = parsed.phrases as Partial<AgentConfig["phrases"]> | undefined
  const needsFill = !existingPhrases ||
    !existingPhrases.thinking ||
    !existingPhrases.tool ||
    !existingPhrases.followup

  if (needsFill) {
    const filled = {
      thinking: existingPhrases?.thinking ?? DEFAULT_AGENT_PHRASES.thinking,
      tool: existingPhrases?.tool ?? DEFAULT_AGENT_PHRASES.tool,
      followup: existingPhrases?.followup ?? DEFAULT_AGENT_PHRASES.followup,
    }
    parsed.phrases = filled
    emitNervesEvent({
      level: "warn",
      event: "config_identity.error",
      component: "config/identity",
      message: "agent config missing phrase pools; placeholders applied",
      meta: { path: configFile },
    })
    fs.writeFileSync(configFile, JSON.stringify(parsed, null, 2) + "\n", "utf-8")
  }

  // Validate v2 facing configs
  const humanFacing = validateFacingConfig(parsed, "humanFacing", configFile)
  const agentFacing = validateFacingConfig(parsed, "agentFacing", configFile)

  const version = typeof parsed.version === "number" ? parsed.version : 1
  if (
    !Number.isInteger(version) ||
    version < 1
  ) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "agent config missing or invalid version",
      meta: {
        path: configFile,
        version: parsed.version,
      },
    })
    throw new Error(
      `agent.json at ${configFile} must include version as integer >= 1.`,
    )
  }

  const rawEnabled = parsed.enabled
  const enabled = rawEnabled === undefined ? true : rawEnabled
  if (typeof enabled !== "boolean") {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "agent config has invalid enabled flag",
      meta: {
        path: configFile,
        enabled: rawEnabled,
      },
    })
    throw new Error(
      `agent.json at ${configFile} must include enabled as boolean.`,
    )
  }

  // Tolerate deprecated provider field for backward compatibility
  const rawProvider = parsed.provider
  const provider = isValidProvider(rawProvider) ? rawProvider : undefined

  // Spread parsed first so any field present in AgentConfig is carried
  // through by default, then explicitly override the fields that need
  // validation or normalization. This eliminates the field-drop bug class
  // that caused the `sync` block (and previously `shell`) to be silently
  // omitted from the returned config. Regression-guarded by the
  // Required<AgentConfig> contract test in identity-contract.test.ts.
  const config: AgentConfig = {
    ...(parsed as unknown as AgentConfig),
    displayName: validateAgentDisplayName(parsed.displayName),
    version,
    enabled,
    humanFacing,
    agentFacing,
    habitPaidTurnsPerDay: normalizeHabitPaidTurnsPerDay(owner === undefined ? getAgentName() : owner.agentName, parsed.habitPaidTurnsPerDay, configFile),
    senses: normalizeSenses(parsed.senses, configFile),
    phrases: parsed.phrases as AgentConfig["phrases"],
  }
  if (provider !== undefined) {
    config.provider = provider
  } else {
    delete config.provider
  }
  emitNervesEvent({
    event: "identity.resolve",
    component: "config/identity",
    message: "loaded agent config from disk",
    meta: { source: "disk" },
  })
  return config
}

/**
 * Prime the agent name cache explicitly.
 * Used when agent name is known via parameter (e.g., `ouro` CLI routing)
 * rather than `--agent` argv. All downstream calls to `getAgentName()`
 * will return this value until `resetIdentity()` is called.
 */
export function setAgentName(name: string): void {
  _cachedAgentName = name
}

/**
 * Override the agent config returned by loadAgentConfig().
 * When set to a non-null AgentConfig, loadAgentConfig() returns the override
 * instead of reading from disk. When set to null, normal disk-based loading resumes.
 */
export function setAgentConfigOverride(config: AgentConfig | null): void {
  _agentConfigOverride = config
}

/**
 * Preserve the compatibility hook for callers that previously cleared cached
 * disk-backed agent config. Agent config is now read fresh on every call.
 */
export function resetAgentConfigCache(): void {
  // No-op: disk-backed agent config is no longer memoized in-process.
}

/**
 * Clear all cached identity state.
 * Used in tests and when switching agent context.
 */
export function resetIdentity(): void {
  _cachedAgentName = null
  _agentConfigOverride = null
}
