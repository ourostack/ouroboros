import * as fs from "fs"
import * as path from "path"
import {
  loadAgentConfig,
  getAgentRoot,
  getAgentSecretsPath,
  DEFAULT_AGENT_CONTEXT,
} from "./identity"
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

export interface IntegrationsConfig {
  perplexityApiKey: string
  openaiEmbeddingsApiKey: string
}

export interface OuroborosConfig {
  providers: {
    azure: AzureProviderConfig
    minimax: MinimaxProviderConfig
    anthropic: AnthropicProviderConfig
    "openai-codex": OpenAICodexProviderConfig
    "github-copilot": GithubCopilotProviderConfig
  }
  teams: TeamsConfig
  teamsSecondary: TeamsConfig
  oauth: OAuthConfig
  context: ContextConfig
  teamsChannel: TeamsChannelConfig
  bluebubbles: BlueBubblesConfig
  bluebubblesChannel: BlueBubblesChannelConfig
  integrations: IntegrationsConfig
}

const DEFAULT_SECRETS_TEMPLATE: Omit<OuroborosConfig, "context"> = {
  providers: {
    azure: {
      apiKey: "",
      endpoint: "",
      deployment: "",
      apiVersion: "2025-04-01-preview",
      managedIdentityClientId: "",
    },
    minimax: {
      apiKey: "",
    },
    anthropic: {
      setupToken: "",
    },
    "openai-codex": {
      oauthAccessToken: "",
    },
    "github-copilot": {
      githubToken: "",
      baseUrl: "",
    },
  },
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
  integrations: {
    perplexityApiKey: "",
    openaiEmbeddingsApiKey: "",
  },
}

function defaultRuntimeConfig(): OuroborosConfig {
  return {
    providers: {
      azure: { ...DEFAULT_SECRETS_TEMPLATE.providers.azure },
      minimax: { ...DEFAULT_SECRETS_TEMPLATE.providers.minimax },
      anthropic: { ...DEFAULT_SECRETS_TEMPLATE.providers.anthropic },
      "openai-codex": { ...DEFAULT_SECRETS_TEMPLATE.providers["openai-codex"] },
      "github-copilot": { ...DEFAULT_SECRETS_TEMPLATE.providers["github-copilot"] },
    },
    teams: { ...DEFAULT_SECRETS_TEMPLATE.teams },
    teamsSecondary: { ...DEFAULT_SECRETS_TEMPLATE.teamsSecondary },
    oauth: { ...DEFAULT_SECRETS_TEMPLATE.oauth },
    context: { ...DEFAULT_AGENT_CONTEXT },
    teamsChannel: { ...DEFAULT_SECRETS_TEMPLATE.teamsChannel },
    bluebubbles: { ...DEFAULT_SECRETS_TEMPLATE.bluebubbles },
    bluebubblesChannel: { ...DEFAULT_SECRETS_TEMPLATE.bluebubblesChannel },
    integrations: { ...DEFAULT_SECRETS_TEMPLATE.integrations },
  }
}

let _runtimeConfigOverride: DeepPartial<OuroborosConfig> | null = null
let _testContextOverride: ContextConfig | null = null

function resolveConfigPath(): string {
  return getAgentSecretsPath()
}

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

export function loadConfig(): OuroborosConfig {
  const configPath = resolveConfigPath()

  // Auto-create config directory if it doesn't exist
  const configDir = path.dirname(configPath)
  fs.mkdirSync(configDir, { recursive: true })

  let fileData: Record<string, unknown> = {}
  try {
    const raw = fs.readFileSync(configPath, "utf-8")
    fileData = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    const errorCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof (error as NodeJS.ErrnoException).code === "string"
        ? (error as NodeJS.ErrnoException).code
        : undefined

    if (errorCode === "ENOENT") {
      try {
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_SECRETS_TEMPLATE, null, 2) + "\n", "utf-8")
      } catch (writeError) {
        emitNervesEvent({
          level: "warn",
          event: "config_identity.error",
          component: "config/identity",
          message: "failed writing default secrets config",
          meta: {
            phase: "loadConfig",
            path: configPath,
            reason: writeError instanceof Error ? writeError.message : String(writeError),
          },
        })
      }
    }

    emitNervesEvent({
      level: "warn",
      event: "config_identity.error",
      component: "config/identity",
      message: "config read failed; defaults applied",
      meta: {
        phase: "loadConfig",
        reason: error instanceof Error ? error.message : String(error),
      },
    })
    // ENOENT or parse error -- use defaults
  }

  const sanitizedFileData = { ...fileData }
  if ("context" in sanitizedFileData) {
    delete sanitizedFileData.context
    emitNervesEvent({
      level: "warn",
      event: "config_identity.error",
      component: "config/identity",
      message: "ignored legacy context block in secrets config",
      meta: {
        phase: "loadConfig",
        path: configPath,
      },
    })
  }

  const mergedConfig = deepMerge(
    defaultRuntimeConfig() as unknown as Record<string, unknown>,
    sanitizedFileData,
  ) as unknown as OuroborosConfig
  const config = _runtimeConfigOverride
    ? deepMerge(
      mergedConfig as unknown as Record<string, unknown>,
      _runtimeConfigOverride as unknown as Record<string, unknown>,
    ) as unknown as OuroborosConfig
    : mergedConfig
  emitNervesEvent({
    event: "config.load",
    component: "config/identity",
    message: "config loaded from disk",
    meta: {
      source: "disk",
      used_defaults_only: Object.keys(fileData).length === 0,
      override_applied: _runtimeConfigOverride !== null,
    },
  })
  return config
}

export function resetConfigCache(): void {
  _runtimeConfigOverride = null
  _testContextOverride = null
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P]
}

export function patchRuntimeConfig(partial: DeepPartial<OuroborosConfig>): void {
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
    partial as unknown as Record<string, unknown>,
  ) as unknown as DeepPartial<OuroborosConfig>
}

export function getAzureConfig(): AzureProviderConfig {
  const config = loadConfig()
  return { ...config.providers.azure }
}

export function getMinimaxConfig(): MinimaxProviderConfig {
  const config = loadConfig()
  return { ...config.providers.minimax }
}

export function getAnthropicConfig(): AnthropicProviderConfig {
  const config = loadConfig()
  return { ...config.providers.anthropic }
}

export function getOpenAICodexConfig(): OpenAICodexProviderConfig {
  const config = loadConfig()
  return { ...config.providers["openai-codex"] }
}

export function getGithubCopilotConfig(): GithubCopilotProviderConfig {
  const config = loadConfig()
  return { ...config.providers["github-copilot"] }
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
    throw new Error("bluebubbles.serverUrl is required in secrets.json to run the BlueBubbles sense.")
  }
  if (!password.trim()) {
    throw new Error("bluebubbles.password is required in secrets.json to run the BlueBubbles sense.")
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
