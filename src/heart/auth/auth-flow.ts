import { spawnSync as defaultSpawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot, getAgentSecretsPath, PROVIDER_CREDENTIALS, type AgentConfig, type AgentProvider } from "../identity"
import { migrateAgentConfigV1ToV2 } from "../migrate-config"
import type { Facing } from "../../mind/friends/channel"
import type { HatchCredentialsInput } from "../hatch/hatch-flow"

const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-"
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80

interface SecretsTemplate {
  providers: {
    azure: {
      modelName: string
      apiKey: string
      endpoint: string
      deployment: string
      apiVersion: string
    }
    minimax: {
      model: string
      apiKey: string
    }
    anthropic: {
      model: string
      setupToken: string
      refreshToken?: string
      expiresAt?: number
    }
    "openai-codex": {
      model: string
      oauthAccessToken: string
    }
    "github-copilot": {
      model: string
      githubToken: string
      baseUrl: string
    }
  }
  teams: {
    clientId: string
    clientSecret: string
    tenantId: string
  }
  oauth: {
    graphConnectionName: string
    adoConnectionName: string
    githubConnectionName: string
  }
  teamsChannel: {
    skipConfirmation: boolean
    port: number
  }
  vault: {
    masterPassword: string
    adminToken?: string
    clientId?: string
    clientSecret?: string
  }
  integrations: {
    perplexityApiKey: string
    openaiEmbeddingsApiKey: string
  }
}

const DEFAULT_SECRETS_TEMPLATE: SecretsTemplate = {
  providers: {
    azure: {
      modelName: "gpt-4o-mini",
      apiKey: "",
      endpoint: "",
      deployment: "",
      apiVersion: "2025-04-01-preview",
    },
    minimax: {
      model: "MiniMax-M2.7",
      apiKey: "",
    },
    anthropic: {
      model: "claude-opus-4-6",
      setupToken: "",
      refreshToken: "",
      expiresAt: 0,
    },
    "openai-codex": {
      model: "gpt-5.4",
      oauthAccessToken: "",
    },
    "github-copilot": {
      model: "claude-sonnet-4.6",
      githubToken: "",
      baseUrl: "",
    },
  },
  teams: {
    clientId: "",
    clientSecret: "",
    tenantId: "",
  },
  oauth: {
    graphConnectionName: "graph",
    adoConnectionName: "ado",
    githubConnectionName: "",
  },
  teamsChannel: {
    skipConfirmation: true,
    port: 3978,
  },
  vault: {
    masterPassword: "",
  },
  integrations: {
    perplexityApiKey: "",
    openaiEmbeddingsApiKey: "",
  },
}

export interface RuntimeAuthInput {
  agentName: string
  provider: AgentProvider
  promptInput?: (question: string) => Promise<string>
}

export interface RuntimeAuthDeps {
  bundlesRoot?: string
  homeDir?: string
  spawnSync?: typeof defaultSpawnSync
}

export interface ProviderSecretsDeps {
  homeDir?: string
  secretsRoot?: string
}

export interface RuntimeAuthResult {
  agentName: string
  provider: AgentProvider
  message: string
  secretsPath: string
  credentials: HatchCredentialsInput
}

export interface HatchCredentialResolutionInput {
  agentName: string
  provider: AgentProvider
  credentials?: HatchCredentialsInput
  promptInput?: (question: string) => Promise<string>
  runAuthFlow?: (input: RuntimeAuthInput) => Promise<RuntimeAuthResult>
}

function deepMerge<T>(defaults: T, partial: Record<string, unknown>): T {
  const result = { ...(defaults as Record<string, unknown>) }
  for (const key of Object.keys(partial)) {
    const left = result[key]
    const right = partial[key]
    if (
      right !== null &&
      typeof right === "object" &&
      !Array.isArray(right) &&
      left !== null &&
      typeof left === "object" &&
      !Array.isArray(left)
    ) {
      result[key] = deepMerge(left as Record<string, unknown>, right as Record<string, unknown>)
      continue
    }
    result[key] = right
  }
  return result as T
}

function readJsonRecord(filePath: string, label: string): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object")
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`Failed to read ${label} at ${filePath}: ${String(error)}`)
  }
}

export function readAgentConfigForAgent(
  agentName: string,
  bundlesRoot = getAgentBundlesRoot(),
): { configPath: string; config: AgentConfig } {
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  const configPath = path.join(agentRoot, "agent.json")
  let parsed = readJsonRecord(configPath, "agent config")

  // Inline migration: v1 -> v2
  const version = typeof parsed.version === "number" ? parsed.version : 1
  if (version < 2) {
    migrateAgentConfigV1ToV2(agentRoot)
    parsed = readJsonRecord(configPath, "agent config")
  }

  // Validate v2 required facing fields
  const humanFacing = parsed.humanFacing as Record<string, unknown> | undefined
  const agentFacing = parsed.agentFacing as Record<string, unknown> | undefined
  if (!humanFacing || typeof humanFacing !== "object") {
    throw new Error(`agent.json at ${configPath} has unsupported provider '${String(parsed.provider)}'`)
  }
  const provider = humanFacing.provider
  if (
    provider !== "azure" &&
    provider !== "anthropic" &&
    provider !== "minimax" &&
    provider !== "openai-codex" &&
    provider !== "github-copilot"
  ) {
    throw new Error(`agent.json at ${configPath} has unsupported provider '${String(provider)}'`)
  }
  if (!agentFacing || typeof agentFacing !== "object") {
    throw new Error(`agent.json at ${configPath} has unsupported provider '${String(parsed.provider)}'`)
  }

  return {
    configPath,
    config: parsed as unknown as AgentConfig,
  }
}

export function writeAgentProviderSelection(
  agentName: string,
  facing: Facing,
  provider: AgentProvider,
  bundlesRoot = getAgentBundlesRoot(),
): string {
  const { configPath, config } = readAgentConfigForAgent(agentName, bundlesRoot)
  const facingKey = facing === "human" ? "humanFacing" : "agentFacing"
  const nextConfig = {
    ...config,
    [facingKey]: { ...config[facingKey], provider },
  }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_provider_selected",
    message: "updated agent provider selection after auth flow",
    meta: { agentName, facing, provider, configPath },
  })
  return configPath
}

function resolveAgentSecretsPath(agentName: string, deps: ProviderSecretsDeps = {}): string {
  if (deps.secretsRoot) return path.join(deps.secretsRoot, agentName, "secrets.json")
  const homeDir = deps.homeDir ?? os.homedir()
  return getAgentSecretsPath(agentName).replace(os.homedir(), homeDir)
}

export function loadAgentSecrets(
  agentName: string,
  deps: ProviderSecretsDeps = {},
): { secretsPath: string; secrets: SecretsTemplate } {
  const secretsPath = resolveAgentSecretsPath(agentName, deps)
  const secretsDir = path.dirname(secretsPath)
  fs.mkdirSync(secretsDir, { recursive: true })

  let onDisk: Record<string, unknown> = {}
  try {
    onDisk = readJsonRecord(secretsPath, "secrets config")
  } catch (error) {
    const message = (error as Error).message
    if (!message.includes("ENOENT")) throw error
  }

  return {
    secretsPath,
    secrets: deepMerge(DEFAULT_SECRETS_TEMPLATE, onDisk),
  }
}

function writeSecrets(secretsPath: string, secrets: SecretsTemplate): void {
  fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8")
}

export function writeProviderCredentials(
  agentName: string,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
  deps: ProviderSecretsDeps = {},
): { secretsPath: string; secrets: SecretsTemplate } {
  const { secretsPath, secrets } = loadAgentSecrets(agentName, deps)
  applyCredentials(secrets, provider, credentials)
  writeSecrets(secretsPath, secrets)
  return { secretsPath, secrets }
}

export function writeAgentModel(
  agentName: string,
  facing: Facing,
  modelName: string,
  deps: { bundlesRoot?: string } = {},
): { configPath: string; provider: AgentProvider; previousModel: string } {
  const { configPath, config } = readAgentConfigForAgent(agentName, deps.bundlesRoot)
  const facingKey = facing === "human" ? "humanFacing" : "agentFacing"
  const facingBlock = config[facingKey]
  const previousModel = facingBlock.model
  const provider = facingBlock.provider
  const nextConfig = {
    ...config,
    [facingKey]: { ...facingBlock, model: modelName },
  }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  emitNervesEvent({
    component: "daemon",
    event: "daemon.config_model_updated",
    message: "updated agent model in agent.json",
    meta: { agentName, facing, provider, modelName, previousModel, configPath },
  })
  return { configPath, provider, previousModel }
}

function readCodexAccessToken(homeDir: string): string {
  const authPath = path.join(homeDir, ".codex", "auth.json")
  try {
    const raw = fs.readFileSync(authPath, "utf8")
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } }
    const token = parsed?.tokens?.access_token
    return typeof token === "string" ? token.trim() : /* v8 ignore next -- defensive: codex login always writes a string token @preserve */ ""
  } catch {
    return ""
  }
}

function ensurePromptInput(promptInput: RuntimeAuthInput["promptInput"], provider: AgentProvider): (question: string) => Promise<string> {
  if (promptInput) return promptInput
  throw new Error(`No prompt input is available for ${provider} authentication.`)
}

function validateAnthropicToken(token: string): string {
  const trimmed = token.trim()
  if (!trimmed) {
    throw new Error("No Anthropic setup token was provided.")
  }
  if (!trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    throw new Error(`Invalid Anthropic setup token format. Expected prefix ${ANTHROPIC_SETUP_TOKEN_PREFIX}.`)
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    throw new Error("Anthropic setup token looks too short.")
  }
  return trimmed
}

export async function collectRuntimeAuthCredentials(
  input: RuntimeAuthInput,
  deps: RuntimeAuthDeps,
): Promise<HatchCredentialsInput> {
  const spawnSync = deps.spawnSync ?? defaultSpawnSync
  const homeDir = deps.homeDir ?? os.homedir()

  if (input.provider === "github-copilot") {
    let token = process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || ""
    if (!token) {
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" })
      token = (result.status === 0 && result.stdout ? result.stdout.trim() : "")
    }
    if (!token) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.auth_gh_login_start",
        message: "starting gh auth login for runtime auth",
        meta: { agentName: input.agentName },
      })
      const loginResult = spawnSync("gh", ["auth", "login"], { stdio: "inherit" })
      if (loginResult.status !== 0) {
        throw new Error("'gh auth login' failed. Install the GitHub CLI (gh) and try again.")
      }
      const retryResult = spawnSync("gh", ["auth", "token"], { encoding: "utf8" })
      /* v8 ignore next -- branch: retry after login always succeeds in tests @preserve */
      token = (retryResult.status === 0 && retryResult.stdout ? retryResult.stdout.trim() : "")
      /* v8 ignore next -- defensive: gh auth login succeeded but token still missing @preserve */
      if (!token) {
        throw new Error("gh auth login completed but no token was found. Run `gh auth login` and try again.")
      }
    }
    const response = await fetch("https://api.github.com/copilot_internal/user", {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!response.ok) {
      throw new Error(`GitHub Copilot endpoint discovery failed (HTTP ${response.status}). Ensure your GitHub account has Copilot access.`)
    }
    const body = await response.json() as { endpoints?: { api?: string } }
    const baseUrl = body?.endpoints?.api
    /* v8 ignore next -- defensive: valid response but missing endpoints field @preserve */
    if (!baseUrl) {
      throw new Error("GitHub Copilot endpoint discovery returned no endpoints.api. Ensure your GitHub account has Copilot access.")
    }
    return { githubToken: token, baseUrl }
  }

  if (input.provider === "openai-codex") {
    // Always run codex login when auth is explicitly requested — stale tokens
    // are indistinguishable from valid ones without an API call, and the user
    // is asking to re-authenticate.
    emitNervesEvent({
      component: "daemon",
      event: "daemon.auth_codex_login_start",
      message: "starting codex login for runtime auth",
      meta: { agentName: input.agentName },
    })
    const result = spawnSync("codex", ["login"], { stdio: "inherit" })
    if (result.error) {
      throw new Error(`Failed to run 'codex login': ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`'codex login' exited with status ${result.status}.`)
    }
    const token = readCodexAccessToken(homeDir)
    if (!token) {
      throw new Error("Codex login completed but no token was found in ~/.codex/auth.json. Re-run `codex login` and try again.")
    }
    return { oauthAccessToken: token }
  }

  if (input.provider === "anthropic") {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.auth_claude_setup_start",
      message: "starting claude setup-token for runtime auth",
      meta: { agentName: input.agentName },
    })
    const result = spawnSync("claude", ["setup-token"], { stdio: "inherit" })
    if (result.error) {
      throw new Error(`Failed to run 'claude setup-token': ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`'claude setup-token' exited with status ${result.status}.`)
    }
    const prompt = ensurePromptInput(input.promptInput, input.provider)
    const setupToken = validateAnthropicToken(await prompt("Paste the setup token from `claude setup-token`: "))

    // Exchange the setup token for an access+refresh token pair so auto-refresh works.
    // The setup token IS the initial access token — we use it as a refresh token to
    // get back a proper token pair from the OAuth endpoint.
    /* v8 ignore start -- token exchange: requires live Anthropic OAuth endpoint @preserve */
    try {
      const { refreshAnthropicToken } = await import("../providers/anthropic-token")
      const tokenState = await refreshAnthropicToken(setupToken)
      if (tokenState) {
        return {
          setupToken: tokenState.accessToken,
          refreshToken: tokenState.refreshToken,
          expiresAt: tokenState.expiresAt,
        } as HatchCredentialsInput
      }
    } catch {
      // Exchange failed — use the raw setup token as-is (it'll work until expiry)
    }
    /* v8 ignore stop */
    return { setupToken }
  }

  // Generic prompt-for-fields fallback (minimax, azure, any future simple providers)
  const prompt = ensurePromptInput(input.promptInput, input.provider)
  const desc = PROVIDER_CREDENTIALS[input.provider]
  const creds: HatchCredentialsInput = {}
  for (const field of desc.required) {
    /* v8 ignore next -- fallback: all current providers define promptLabels for required fields @preserve */
    const label = desc.promptLabels[field] ?? field
    const value = (await prompt(`${label}: `)).trim()
    if (!value) throw new Error(`${label} is required.`)
    ;(creds as Record<string, string>)[field] = value
  }
  return creds
}

export async function resolveHatchCredentials(
  input: HatchCredentialResolutionInput,
): Promise<HatchCredentialsInput> {
  const credentials: HatchCredentialsInput = { ...(input.credentials ?? {}) }

  // If all required fields are already provided, return as-is
  const cred = credentials as Record<string, unknown>
  const missing = PROVIDER_CREDENTIALS[input.provider].required.some((key) => !cred[key])
  if (!missing) return credentials

  // Try the full auth flow (wraps collectRuntimeAuthCredentials + writes secrets)
  if (input.runAuthFlow) {
    const result = await input.runAuthFlow({
      agentName: input.agentName,
      provider: input.provider,
      promptInput: input.promptInput,
    })
    Object.assign(credentials, result.credentials)
    /* v8 ignore next 3 -- branch: auth flow always fills all required fields in production @preserve */
    if (!PROVIDER_CREDENTIALS[input.provider].required.some((key) => !(credentials as Record<string, unknown>)[key])) {
      return credentials
    }
  }

  // Prompt for any still-missing required fields
  /* v8 ignore next -- guard: no promptInput means we can't collect remaining fields @preserve */
  if (input.promptInput) {
    const desc = PROVIDER_CREDENTIALS[input.provider]
    for (const field of desc.required) {
      if (!(cred as Record<string, string>)[field]) {
        const label = desc.promptLabels[field] ?? field
        ;(cred as Record<string, string>)[field] = await input.promptInput(`${label}: `)
      }
    }
  }

  return credentials
}

function applyCredentials(
  secrets: SecretsTemplate,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
): void {
  const target = secrets.providers[provider] as Record<string, unknown>
  // Copy all non-empty credential fields to the provider's secrets block
  for (const [key, value] of Object.entries(credentials)) {
    /* v8 ignore next -- guard: skip null/empty fields from partial credential objects @preserve */
    if (value != null && value !== "") {
      target[key] = typeof value === "string" ? value.trim() : value
    }
  }
}

export async function runRuntimeAuthFlow(
  input: RuntimeAuthInput,
  deps: RuntimeAuthDeps = {},
): Promise<RuntimeAuthResult> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_flow_start",
    message: "starting runtime auth flow",
    meta: { agentName: input.agentName, provider: input.provider },
  })

  const homeDir = deps.homeDir ?? os.homedir()
  const credentials = await collectRuntimeAuthCredentials(input, deps)
  const { secretsPath } = writeProviderCredentials(input.agentName, input.provider, credentials, { homeDir })

  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_flow_end",
    message: "completed runtime auth flow",
    meta: { agentName: input.agentName, provider: input.provider, secretsPath },
  })

  return {
    agentName: input.agentName,
    provider: input.provider,
    secretsPath,
    message: `authenticated ${input.agentName} with ${input.provider}`,
    credentials,
  }
}
