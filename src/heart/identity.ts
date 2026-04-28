import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"
import { migrateAgentConfigV1ToV2 } from "./migrate-config"

export type AgentProvider = "azure" | "minimax" | "anthropic" | "openai-codex" | "github-copilot"

/** Single source of truth for per-provider credential field names, env var mappings, and prompt labels. */
export const PROVIDER_CREDENTIALS: Record<AgentProvider, {
  required: string[]
  envVars: Record<string, string>
  promptLabels: Record<string, string>
}> = {
  anthropic:        { required: ["setupToken"],                        envVars: { ANTHROPIC_API_KEY: "setupToken" },                                                                                        promptLabels: { setupToken: "Anthropic setup-token" } },
  "openai-codex":   { required: ["oauthAccessToken"],                  envVars: { OPENAI_API_KEY: "oauthAccessToken" },                                                                                     promptLabels: { oauthAccessToken: "OpenAI Codex OAuth token" } },
  azure:            { required: ["apiKey", "endpoint", "deployment"],   envVars: { AZURE_OPENAI_API_KEY: "apiKey", AZURE_OPENAI_KEY: "apiKey", AZURE_OPENAI_ENDPOINT: "endpoint", AZURE_OPENAI_DEPLOYMENT: "deployment" }, promptLabels: { apiKey: "Azure API key", endpoint: "Azure endpoint", deployment: "Azure deployment" } },
  minimax:          { required: ["apiKey"],                             envVars: { MINIMAX_API_KEY: "apiKey" },                                                                                              promptLabels: { apiKey: "MiniMax API key" } },
  "github-copilot": { required: ["githubToken", "baseUrl"],             envVars: { GH_TOKEN: "githubToken", GITHUB_TOKEN: "githubToken" },                                                                   promptLabels: { githubToken: "GitHub token" } },
}
export type SenseName = "cli" | "teams" | "bluebubbles" | "mail"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogSinkType = "terminal" | "ndjson"
export interface AgentSenseConfig {
  enabled: boolean
}

export interface AgentSensesConfig {
  cli: AgentSenseConfig
  teams: AgentSenseConfig
  bluebubbles: AgentSenseConfig
  mail: AgentSenseConfig
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
  enabled: boolean
  /** @deprecated Use humanFacing/agentFacing instead */
  provider?: AgentProvider
  humanFacing: AgentFacingConfig
  agentFacing: AgentFacingConfig
  context?: {
    maxTokens?: number
    contextMargin?: number
  }
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
  }
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

export const DEFAULT_VAULT_SERVER_URL = "https://vault.ouroboros.bot"
export const LEGACY_VAULT_SERVER_URL_ALIASES = [
  "https://vault.ouro.bot",
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
}

export function normalizeSenses(value: unknown, configFile: string): AgentSensesConfig {
  const defaults: AgentSensesConfig = {
    cli: { ...DEFAULT_AGENT_SENSES.cli },
    teams: { ...DEFAULT_AGENT_SENSES.teams },
    bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
    mail: { ...DEFAULT_AGENT_SENSES.mail },
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
  const senseNames: SenseName[] = ["cli", "teams", "bluebubbles", "mail"]
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
    defaults[senseName] = { enabled }
  }

  return defaults
}

export function buildDefaultAgentTemplate(_agentName: string): AgentConfig {
  return {
    version: 2,
    enabled: true,
    humanFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    agentFacing: { provider: "anthropic", model: "claude-opus-4-6" },
    context: { ...DEFAULT_AGENT_CONTEXT },
    senses: {
      cli: { ...DEFAULT_AGENT_SENSES.cli },
      teams: { ...DEFAULT_AGENT_SENSES.teams },
      bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
      mail: { ...DEFAULT_AGENT_SENSES.mail },
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
    emitNervesEvent({
      event: "identity.resolve",
      component: "config/identity",
      message: "resolved agent name from cache",
      meta: { source: "cache" },
    })
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
    return "slugger"
  }
}

/**
 * Returns the bundle-local runtime state directory: `~/AgentBundles/<agentName>.ouro/state/`
 */
export function getAgentStateRoot(agentName?: string): string {
  return path.join(getAgentRoot(resolveOptionalAgentName(agentName)), "state")
}

export const HARNESS_CANONICAL_REPO_URL = "https://github.com/ouroborosbot/ouroboros.git"

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

const VALID_PROVIDERS: readonly string[] = ["azure", "minimax", "anthropic", "openai-codex", "github-copilot"]

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
 * Reads the file fresh on each call unless an override is set.
 * If the config is v1, auto-migrates to v2 via migrateAgentConfigV1ToV2 and re-reads.
 * Throws descriptive error if file is missing or contains invalid JSON.
 */
export function loadAgentConfig(): AgentConfig {
  if (_agentConfigOverride) {
    return _agentConfigOverride
  }

  const agentRoot = getAgentRoot()
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
    version,
    enabled,
    humanFacing,
    agentFacing,
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
