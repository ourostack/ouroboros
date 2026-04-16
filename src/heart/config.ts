import * as fs from "fs"
import * as path from "path"
import {
  loadAgentConfig,
  getAgentRoot,
  DEFAULT_AGENT_CONTEXT,
  getAgentName,
  type AgentProvider,
} from "./identity"
import {
  cacheProviderCredentialRecords,
  createProviderCredentialRecord,
  readCachedProviderCredentialRecord,
  resetProviderCredentialCache,
  splitProviderCredentialFields,
} from "./provider-credentials"
import {
  cacheMachineRuntimeCredentialConfig,
  cacheRuntimeCredentialConfig,
  readMachineRuntimeCredentialConfig,
  readRuntimeCredentialConfig,
  resetRuntimeCredentialConfigCache,
  type RuntimeCredentialConfig,
} from "./runtime-credentials"
import { emitNervesEvent } from "../nerves/runtime"

export interface AzureProviderConfig {
  apiKey?: string
  endpoint: string
  deployment: string
  apiVersion: string
  managedIdentityClientId?: string
}

export interface MinimaxProviderConfig {
  apiKey: string
}

export interface AnthropicProviderConfig {
  setupToken: string
}

export interface OpenAICodexProviderConfig {
  oauthAccessToken: string
}

export interface GithubCopilotProviderConfig {
  githubToken: string
  baseUrl: string
}

export interface TeamsConfig {
  clientId: string
  clientSecret: string
  tenantId: string
  managedIdentityClientId: string
}

export interface OAuthConfig {
  graphConnectionName: string
  adoConnectionName: string
  githubConnectionName: string
  tenantOverrides?: Record<string, { graphConnectionName?: string, adoConnectionName?: string, githubConnectionName?: string }>
}

export interface ContextConfig {
  maxTokens: number
  contextMargin: number
}

export interface TeamsChannelConfig {
  skipConfirmation: boolean
  flushIntervalMs?: number
  port: number
}

export interface BlueBubblesConfig {
  serverUrl: string
  password: string
  accountId: string
}

export interface BlueBubblesChannelConfig {
  port: number
  webhookPath: string
  requestTimeoutMs: number
}

export interface VaultSecretsConfig {
  masterPassword: string
  adminToken?: string    // Vaultwarden admin token
  clientId?: string      // Bitwarden API key client_id
  clientSecret?: string  // Bitwarden API key client_secret
}

export interface IntegrationsConfig {
  perplexityApiKey: string
  openaiEmbeddingsApiKey: string
}

export interface OuroborosConfig {
  teams: TeamsConfig
  teamsSecondary: TeamsConfig
  oauth: OAuthConfig
  context: ContextConfig
  teamsChannel: TeamsChannelConfig
  bluebubbles: BlueBubblesConfig
  bluebubblesChannel: BlueBubblesChannelConfig
  vault: VaultSecretsConfig
  integrations: IntegrationsConfig
}

type ProviderConfigPatch = Partial<Record<AgentProvider, Record<string, unknown>>>

type RuntimeConfigPatch = DeepPartial<OuroborosConfig> & {
  /**
   * Test/runtime injection for provider credentials. Production provider
   * credentials live in the agent vault; this patch shape seeds the same
   * in-memory provider credential cache instead of resurrecting providers in
   * runtime config.
   */
  providers?: ProviderConfigPatch
}

const DEFAULT_LOCAL_RUNTIME_CONFIG: Omit<OuroborosConfig, "context"> = {
  teams: {
    clientId: "",
    clientSecret: "",
    tenantId: "",
    managedIdentityClientId: "",
  },
  oauth: {
    graphConnectionName: "graph",
    adoConnectionName: "ado",
    githubConnectionName: "",
  },
  teamsSecondary: {
    clientId: "",
    clientSecret: "",
    tenantId: "",
    managedIdentityClientId: "",
  },
  teamsChannel: {
    skipConfirmation: true,
    port: 3978,
  },
  bluebubbles: {
    serverUrl: "",
    password: "",
    accountId: "default",
  },
  bluebubblesChannel: {
    port: 18790,
    webhookPath: "/bluebubbles-webhook",
    requestTimeoutMs: 30000,
  },
  vault: {
    masterPassword: "",
  },
  integrations: {
    perplexityApiKey: "",
    openaiEmbeddingsApiKey: "",
  },
}

function defaultRuntimeConfig(): OuroborosConfig {
  return {
    teams: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.teams },
    teamsSecondary: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.teamsSecondary },
    oauth: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.oauth },
    context: { ...DEFAULT_AGENT_CONTEXT },
    teamsChannel: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.teamsChannel },
    bluebubbles: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.bluebubbles },
    bluebubblesChannel: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.bluebubblesChannel },
    vault: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.vault },
    integrations: { ...DEFAULT_LOCAL_RUNTIME_CONFIG.integrations },
  }
}

let _runtimeConfigOverride: DeepPartial<OuroborosConfig> | null = null
let _testContextOverride: ContextConfig | null = null
let _providerConfigOverride: ProviderConfigPatch | null = null

function deepMerge(defaults: Record<string, unknown>, partial: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...defaults }
  for (const key of Object.keys(partial)) {
    if (
      partial[key] !== null &&
      typeof partial[key] === "object" &&
      !Array.isArray(partial[key]) &&
      typeof defaults[key] === "object" &&
      defaults[key] !== null
    ) {
      result[key] = deepMerge(defaults[key] as Record<string, unknown>, partial[key] as Record<string, unknown>)
    } else {
      result[key] = partial[key]
    }
  }
  return result
}

function localRuntimeFields(config: RuntimeCredentialConfig): RuntimeCredentialConfig {
  const { providers: _providers, context: _context, ...localFields } = config
  return localFields
}

export function loadConfig(): OuroborosConfig {
  const agentName = getAgentName()
  const runtimeResult = readRuntimeCredentialConfig(agentName)
  const machineRuntimeResult = readMachineRuntimeCredentialConfig(agentName)
  const vaultData = runtimeResult.ok ? localRuntimeFields(runtimeResult.config) : {}
  const machineVaultData = machineRuntimeResult.ok ? localRuntimeFields(machineRuntimeResult.config) : {}

  const mergedConfig = deepMerge(
    defaultRuntimeConfig() as unknown as Record<string, unknown>,
    vaultData as Record<string, unknown>,
  ) as unknown as OuroborosConfig
  const mergedWithMachineConfig = deepMerge(
    mergedConfig as unknown as Record<string, unknown>,
    machineVaultData as Record<string, unknown>,
  ) as unknown as OuroborosConfig
  const config = _runtimeConfigOverride
    ? deepMerge(
      mergedWithMachineConfig as unknown as Record<string, unknown>,
      _runtimeConfigOverride as unknown as Record<string, unknown>,
    ) as unknown as OuroborosConfig
    : mergedWithMachineConfig
  emitNervesEvent({
    event: "config.load",
    component: "config/identity",
    message: "config loaded from runtime credential cache",
    meta: {
      source: runtimeResult.ok ? "vault-cache" : "defaults",
      used_defaults_only: !runtimeResult.ok,
      machine_runtime_credentials: machineRuntimeResult.ok ? "available" : machineRuntimeResult.reason,
      override_applied: _runtimeConfigOverride !== null,
      runtime_credentials: runtimeResult.ok ? "available" : runtimeResult.reason,
    },
  })
  return config
}

export function resetConfigCache(): void {
  _runtimeConfigOverride = null
  _testContextOverride = null
  _providerConfigOverride = null
  resetProviderCredentialCache()
  resetRuntimeCredentialConfigCache()
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export function cacheRuntimeConfigForTests(agentName: string, config: RuntimeCredentialConfig): void {
  cacheRuntimeCredentialConfig(agentName, config, new Date(0))
}

export function cacheMachineRuntimeConfigForTests(agentName: string, config: RuntimeCredentialConfig): void {
  cacheMachineRuntimeCredentialConfig(agentName, config, new Date(0), "machine_test")
}

function seedProviderCredentialCache(providers?: ProviderConfigPatch): void {
  if (!providers) return
  _providerConfigOverride = deepMerge(
    (_providerConfigOverride ?? {}) as Record<string, unknown>,
    providers as Record<string, unknown>,
  ) as ProviderConfigPatch
  const records = Object.entries(_providerConfigOverride).map(([provider, rawConfig]) => {
    const split = splitProviderCredentialFields(provider as AgentProvider, rawConfig)
    return createProviderCredentialRecord({
      provider: provider as AgentProvider,
      credentials: split.credentials,
      config: split.config,
      provenance: { source: "manual" },
      now: new Date(0),
    })
  })
  cacheProviderCredentialRecords(getAgentName(), records, new Date(0))
}

export function patchRuntimeConfig(partial: RuntimeConfigPatch): void {
  const { providers, ...runtimePartial } = partial
  seedProviderCredentialCache(providers)
  const contextPatch = partial.context as Partial<ContextConfig> | undefined
  if (contextPatch) {
    const base = _testContextOverride ?? DEFAULT_AGENT_CONTEXT
    _testContextOverride = deepMerge(
      base as unknown as Record<string, unknown>,
      contextPatch as unknown as Record<string, unknown>,
    ) as unknown as ContextConfig
  }
  _runtimeConfigOverride = deepMerge(
    (_runtimeConfigOverride ?? {}) as unknown as Record<string, unknown>,
    runtimePartial as unknown as Record<string, unknown>,
  ) as unknown as DeepPartial<OuroborosConfig>
}

function readProviderConfig(provider: AgentProvider): Record<string, string | number> {
  const cached = readCachedProviderCredentialRecord(getAgentName(), provider)
  return cached.ok ? { ...cached.record.config, ...cached.record.credentials } : {}
}

export function getAzureConfig(): AzureProviderConfig {
  const raw = readProviderConfig("azure")
  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "",
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : "",
    deployment: typeof raw.deployment === "string" ? raw.deployment : "",
    apiVersion: typeof raw.apiVersion === "string" ? raw.apiVersion : "2025-04-01-preview",
    managedIdentityClientId: typeof raw.managedIdentityClientId === "string" ? raw.managedIdentityClientId : "",
  }
}

export function getMinimaxConfig(): MinimaxProviderConfig {
  const raw = readProviderConfig("minimax")
  return { apiKey: typeof raw.apiKey === "string" ? raw.apiKey : "" }
}

export function getAnthropicConfig(): AnthropicProviderConfig {
  const raw = readProviderConfig("anthropic")
  return { setupToken: typeof raw.setupToken === "string" ? raw.setupToken : "" }
}

export function getOpenAICodexConfig(): OpenAICodexProviderConfig {
  const raw = readProviderConfig("openai-codex")
  return { oauthAccessToken: typeof raw.oauthAccessToken === "string" ? raw.oauthAccessToken : "" }
}

export function getGithubCopilotConfig(): GithubCopilotProviderConfig {
  const raw = readProviderConfig("github-copilot")
  return {
    githubToken: typeof raw.githubToken === "string" ? raw.githubToken : "",
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : "",
  }
}

export function getTeamsConfig(): TeamsConfig {
  const config = loadConfig()
  return { ...config.teams }
}

export function getTeamsSecondaryConfig(): TeamsConfig {
  const config = loadConfig()
  return { ...config.teamsSecondary }
}

export function getContextConfig(): ContextConfig {
  if (_testContextOverride) {
    return { ..._testContextOverride }
  }
  const defaults = DEFAULT_AGENT_CONTEXT
  const agentContext = loadAgentConfig().context
  if (!agentContext || typeof agentContext !== "object") {
    return { ...defaults }
  }
  return {
    maxTokens: typeof agentContext.maxTokens === "number" ? agentContext.maxTokens : defaults.maxTokens,
    contextMargin: typeof agentContext.contextMargin === "number"
      ? agentContext.contextMargin
      : defaults.contextMargin,
  }
}

export function getOAuthConfig(): OAuthConfig {
  const config = loadConfig()
  return { ...config.oauth }
}

/** Resolve OAuth connection names for a specific tenant, falling back to defaults. */
export function resolveOAuthForTenant(tenantId?: string): Omit<OAuthConfig, "tenantOverrides"> {
  const base = getOAuthConfig()
  const overrides = tenantId ? base.tenantOverrides?.[tenantId] : undefined
  return {
    graphConnectionName: overrides?.graphConnectionName ?? base.graphConnectionName,
    adoConnectionName: overrides?.adoConnectionName ?? base.adoConnectionName,
    githubConnectionName: overrides?.githubConnectionName ?? base.githubConnectionName,
  }
}

export function getTeamsChannelConfig(): TeamsChannelConfig {
  const config = loadConfig()
  const { skipConfirmation, flushIntervalMs, port } = config.teamsChannel
  return { skipConfirmation, flushIntervalMs, port }
}

export function getBlueBubblesConfig(): BlueBubblesConfig {
  const config = loadConfig()
  const { serverUrl, password, accountId } = config.bluebubbles

  if (!serverUrl.trim()) {
    throw new Error("bluebubbles.serverUrl is required in this machine's agent-vault runtime config. Run `ouro connect bluebubbles --agent <agent>`.")
  }
  if (!password.trim()) {
    throw new Error("bluebubbles.password is required in this machine's agent-vault runtime config. Run `ouro connect bluebubbles --agent <agent>`.")
  }

  return {
    serverUrl: serverUrl.trim(),
    password: password.trim(),
    accountId: accountId.trim() || "default",
  }
}

export function getBlueBubblesChannelConfig(): BlueBubblesChannelConfig {
  const config = loadConfig()
  const { port, webhookPath, requestTimeoutMs } = config.bluebubblesChannel
  return { port, webhookPath, requestTimeoutMs }
}

export function getIntegrationsConfig(): IntegrationsConfig {
  const config = loadConfig()
  return { ...config.integrations }
}

export interface SyncConfig {
  enabled: boolean
  remote: string
}

export function getSyncConfig(): SyncConfig {
  try {
    const agentConfig = loadAgentConfig()
    return {
      enabled: agentConfig.sync?.enabled ?? false,
      remote: agentConfig.sync?.remote ?? "origin",
    }
  } catch {
    /* v8 ignore next -- defensive: loadAgentConfig failure in test/bootstrap @preserve */
    return { enabled: false, remote: "origin" }
  }
}

export function getOpenAIEmbeddingsApiKey(): string {
  return getIntegrationsConfig().openaiEmbeddingsApiKey
}

export function getLogsDir(): string {
  return path.join(getAgentRoot(), "state", "logs")
}


export function sanitizeKey(key: string): string {
  return key.replace(/[/:]/g, "_")
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

export function resolveSessionPath(
  friendId: string,
  channel: string,
  key: string,
  options?: { ensureDir?: boolean },
): string {
  const dir = path.join(getAgentRoot(), "state", "sessions", friendId, channel)
  if (options?.ensureDir) {
    fs.mkdirSync(dir, { recursive: true })
  }
  return path.join(dir, sanitizeKey(key) + ".json")
}

export function sessionPath(friendId: string, channel: string, key: string): string {
  return resolveSessionPath(friendId, channel, key, { ensureDir: true })
}

export function logPath(channel: string, key: string): string {
  return path.join(getLogsDir(), channel, sanitizeKey(key) + ".ndjson")
}
