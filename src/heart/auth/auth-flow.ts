import { spawnSync as defaultSpawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentBundlesRoot, normalizeSenses, PROVIDER_CREDENTIALS, type AgentConfig, type AgentProvider } from "../identity"
import { migrateAgentConfigV1ToV2 } from "../migrate-config"
import { resolveModelForProviderSelection } from "../provider-models"
import type { Facing } from "../../mind/friends/channel"
import type { HatchCredentialsInput } from "../hatch/hatch-flow"
import {
  providerCredentialItemName,
  refreshProviderCredentialPool,
  splitProviderCredentialFields,
  upsertProviderCredential,
} from "../provider-credentials"
import { vaultUnlockReplaceRecoverFix } from "../../repertoire/vault-unlock"

const ANTHROPIC_SETUP_TOKEN_PREFIX = "sk-ant-oat01-"
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80

export interface RuntimeAuthInput {
  agentName: string
  provider: AgentProvider
  promptInput?: (question: string) => Promise<string>
  onProgress?: (message: string) => void
}

export interface RuntimeAuthDeps {
  bundlesRoot?: string
  homeDir?: string
  spawnSync?: typeof defaultSpawnSync
}

export interface RuntimeAuthResult {
  agentName: string
  provider: AgentProvider
  message: string
  credentialPath: string
  credentials: HatchCredentialsInput
}

export interface HatchCredentialResolutionInput {
  agentName: string
  provider: AgentProvider
  credentials?: HatchCredentialsInput
  promptInput?: (question: string) => Promise<string>
  runAuthFlow?: (input: RuntimeAuthInput) => Promise<RuntimeAuthResult>
  onProgress?: (message: string) => void
}

function assertPersistentProviderCredentialsAllowed(agentName: string): void {
  if (agentName === "SerpentGuide") {
    throw new Error("SerpentGuide uses provider credentials in memory during hatch bootstrap; persistent SerpentGuide auth is not supported.")
  }
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

  // Spread-with-validation: same pattern as loadAgentConfig to eliminate
  // the unvalidated-pass-through bug class. The spread carries through
  // every field present in parsed; senses goes through the same
  // normalization as loadAgentConfig so the two entry points return
  // equivalent configs for the same file.
  const config: AgentConfig = {
    ...(parsed as unknown as AgentConfig),
    senses: normalizeSenses(parsed.senses, configPath),
  }

  return {
    configPath,
    config,
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
  const previousFacing = config[facingKey]
  const resolved = resolveModelForProviderSelection(provider, previousFacing.model)
  const nextConfig = {
    ...config,
    [facingKey]: { ...previousFacing, provider, model: resolved.model },
  }
  fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8")
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_provider_selected",
    message: "updated agent provider selection after auth flow",
    meta: {
      agentName,
      facing,
      provider,
      previousProvider: previousFacing.provider,
      previousModel: previousFacing.model,
      model: resolved.model,
      preservedModel: resolved.preserved,
      configPath,
    },
  })
  return configPath
}

export async function storeProviderCredentials(
  agentName: string,
  provider: AgentProvider,
  credentials: HatchCredentialsInput,
  deps: { now?: Date } = {},
): Promise<{ credentialPath: string }> {
  assertPersistentProviderCredentialsAllowed(agentName)
  const split = splitProviderCredentialFields(provider, credentials as Record<string, unknown>)
  await upsertProviderCredential({
    agentName,
    provider,
    credentials: split.credentials,
    config: split.config,
    provenance: { source: "auth-flow" },
    now: deps.now,
  })
  return { credentialPath: providerCredentialItemName(provider) }
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

function writeAuthProgress(input: { onProgress?: (message: string) => void }, message: string): void {
  input.onProgress?.(message)
}

function isVaultStoreUnlockError(message: string): boolean {
  return (
    message.includes("bw CLI could not use the local Bitwarden session because it is locked, missing, or expired") ||
    message.includes("bw CLI rejected the saved vault unlock secret for this machine")
  )
}

function formatVaultStoreError(agentName: string, provider: AgentProvider, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("credential stored in vault, but the local provider snapshot could not be refreshed:")) {
    return new Error(
      `provider authentication succeeded and ${provider} credentials were stored in ${agentName}'s vault, ` +
      `but the local provider snapshot refresh failed: ${message.replace("credential stored in vault, but the local provider snapshot could not be refreshed: ", "")}`,
    )
  }
  const retry = `Then retry 'ouro auth --agent ${agentName} --provider ${provider}'.`
  if (isVaultStoreUnlockError(message)) {
    return new Error(
      `provider authentication succeeded, but storing ${provider} credentials in ${agentName}'s vault failed: ${message}\n` +
      vaultUnlockReplaceRecoverFix(agentName, retry),
    )
  }
  return new Error(
    `provider authentication succeeded, but storing ${provider} credentials in ${agentName}'s vault failed: ${message}\n${retry}`,
  )
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
      writeAuthProgress(input, "checking GitHub CLI credentials...")
      const result = spawnSync("gh", ["auth", "token"], { encoding: "utf8" })
      token = (result.status === 0 && result.stdout ? result.stdout.trim() : "")
    }
    if (!token) {
      writeAuthProgress(input, "starting GitHub login...")
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
    writeAuthProgress(input, "checking GitHub Copilot access...")
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
    writeAuthProgress(input, "starting openai-codex browser login...")
    const result = spawnSync("codex", ["login"], { stdio: "inherit" })
    if (result.error) {
      throw new Error(`Failed to run 'codex login': ${result.error.message}`)
    }
    if (result.status !== 0) {
      throw new Error(`'codex login' exited with status ${result.status}.`)
    }
    writeAuthProgress(input, "openai-codex login complete; reading local Codex token...")
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
    writeAuthProgress(input, "starting anthropic setup-token flow...")
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
      writeAuthProgress(input, "exchanging anthropic setup token...")
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
      onProgress: input.onProgress,
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

export async function runRuntimeAuthFlow(
  input: RuntimeAuthInput,
  deps: RuntimeAuthDeps = {},
): Promise<RuntimeAuthResult> {
  assertPersistentProviderCredentialsAllowed(input.agentName)
  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_flow_start",
    message: "starting runtime auth flow",
    meta: { agentName: input.agentName, provider: input.provider },
  })

  writeAuthProgress(input, `checking ${input.agentName}'s vault access...`)
  const vault = await refreshProviderCredentialPool(input.agentName)
  if (!vault.ok && vault.reason === "unavailable") {
    throw new Error(`${vault.error}\n${vaultUnlockReplaceRecoverFix(input.agentName, `Then retry 'ouro auth --agent ${input.agentName} --provider ${input.provider}'.`)}`)
  }

  const credentials = await collectRuntimeAuthCredentials(input, deps)
  writeAuthProgress(input, `${input.provider} credentials collected; storing in ${input.agentName}'s vault...`)
  let credentialPath: string
  try {
    ;({ credentialPath } = await storeProviderCredentials(input.agentName, input.provider, credentials))
  } catch (error) {
    throw formatVaultStoreError(input.agentName, input.provider, error)
  }
  writeAuthProgress(input, `credentials stored at ${credentialPath}; local provider snapshot refreshed.`)

  emitNervesEvent({
    component: "daemon",
    event: "daemon.auth_flow_end",
    message: "completed runtime auth flow",
    meta: { agentName: input.agentName, provider: input.provider, credentialPath },
  })

  return {
    agentName: input.agentName,
    provider: input.provider,
    credentialPath,
    message: `authenticated ${input.agentName} with ${input.provider}`,
    credentials,
  }
}
