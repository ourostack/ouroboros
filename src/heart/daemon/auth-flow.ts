import { spawnSync as defaultSpawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot, getAgentSecretsPath, type AgentConfig, type AgentProvider } from "../identity"
import type { HatchCredentialsInput } from "./hatch-flow"

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
    }
    "openai-codex": {
      model: string
      oauthAccessToken: string
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
      model: "minimax-text-01",
      apiKey: "",
    },
    anthropic: {
      model: "claude-opus-4-6",
      setupToken: "",
    },
    "openai-codex": {
      model: "gpt-5.4",
      oauthAccessToken: "",
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
  const configPath = path.join(bundlesRoot, `${agentName}.ouro`, "agent.json")
  const parsed = readJsonRecord(configPath, "agent config")
  const provider = parsed.provider
  if (
    provider !== "azure" &&
    provider !== "anthropic" &&
    provider !== "minimax" &&
    provider !== "openai-codex"
  ) {
    throw new Error(`agent.json at ${configPath} has unsupported provider '${String(provider)}'`)
  }
  return {
    configPath,
    config: parsed as unknown as AgentConfig,
  }
}

export function writeAgentProviderSelection(
  agentName: string,
  provider: AgentProvider,
  bundlesRoot = getAgentBundlesRoot(),
): string {
  const { configPath, config } = readAgentConfigForAgent(agentName, bundlesRoot)
  const nextConfig = { ...config, provider }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_provider_selected",
    message: "updated agent provider selection after auth flow",
    meta: { agentName, provider, configPath },
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

function readCodexAccessToken(homeDir: string): string {
  const authPath = path.join(homeDir, ".codex", "auth.json")
  try {
    const raw = fs.readFileSync(authPath, "utf8")
    const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown } }
    const token = parsed?.tokens?.access_token
    return typeof token === "string" ? token.trim() : ""
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

  if (input.provider === "openai-codex") {
    let token = readCodexAccessToken(homeDir)
    if (!token) {
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
      token = readCodexAccessToken(homeDir)
      if (!token) {
        throw new Error("Codex login completed but no token was found in ~/.codex/auth.json. Re-run `codex login` and try again.")
      }
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
    return { setupToken }
  }

  if (input.provider === "minimax") {
    const prompt = ensurePromptInput(input.promptInput, input.provider)
    const apiKey = (await prompt("MiniMax API key: ")).trim()
    if (!apiKey) throw new Error("MiniMax API key is required.")
    return { apiKey }
  }

  const prompt = ensurePromptInput(input.promptInput, input.provider)
  const apiKey = (await prompt("Azure API key: ")).trim()
  const endpoint = (await prompt("Azure endpoint: ")).trim()
  const deployment = (await prompt("Azure deployment: ")).trim()
  if (!apiKey || !endpoint || !deployment) {
    throw new Error("Azure API key, endpoint, and deployment are required.")
  }
  return { apiKey, endpoint, deployment }
}

export async function resolveHatchCredentials(
  input: HatchCredentialResolutionInput,
): Promise<HatchCredentialsInput> {
  const prompt = input.promptInput
  const credentials: HatchCredentialsInput = { ...(input.credentials ?? {}) }

  if (input.provider === "anthropic" && !credentials.setupToken && input.runAuthFlow) {
    const result = await input.runAuthFlow({
      agentName: input.agentName,
      provider: "anthropic",
      promptInput: prompt,
    })
    Object.assign(credentials, result.credentials)
  }
  if (input.provider === "anthropic" && !credentials.setupToken && prompt) {
    credentials.setupToken = await prompt("Anthropic setup-token: ")
  }

  if (input.provider === "openai-codex" && !credentials.oauthAccessToken && input.runAuthFlow) {
    const result = await input.runAuthFlow({
      agentName: input.agentName,
      provider: "openai-codex",
      promptInput: prompt,
    })
    Object.assign(credentials, result.credentials)
  }
  if (input.provider === "openai-codex" && !credentials.oauthAccessToken && prompt) {
    credentials.oauthAccessToken = await prompt("OpenAI Codex OAuth token: ")
  }

  if (input.provider === "minimax" && !credentials.apiKey && prompt) {
    credentials.apiKey = await prompt("MiniMax API key: ")
  }

  if (input.provider === "azure") {
    if (!credentials.apiKey && prompt) credentials.apiKey = await prompt("Azure API key: ")
    if (!credentials.endpoint && prompt) credentials.endpoint = await prompt("Azure endpoint: ")
    if (!credentials.deployment && prompt) credentials.deployment = await prompt("Azure deployment: ")
  }

  return credentials
}

function applyCredentials(
  secrets: SecretsTemplate,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
): void {
  if (provider === "anthropic") {
    secrets.providers.anthropic.setupToken = credentials.setupToken!.trim()
    return
  }
  if (provider === "openai-codex") {
    secrets.providers["openai-codex"].oauthAccessToken = credentials.oauthAccessToken!.trim()
    return
  }
  if (provider === "minimax") {
    secrets.providers.minimax.apiKey = credentials.apiKey!.trim()
    return
  }
  secrets.providers.azure.apiKey = credentials.apiKey!.trim()
  secrets.providers.azure.endpoint = credentials.endpoint!.trim()
  secrets.providers.azure.deployment = credentials.deployment!.trim()
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
