import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { emitNervesEvent } from "../nerves/runtime"

export type AgentProvider = "azure" | "minimax" | "anthropic" | "openai-codex" | "github-copilot"
export type SenseName = "cli" | "teams" | "bluebubbles"

export type LogLevel = "debug" | "info" | "warn" | "error"
export type LogSinkType = "terminal" | "ndjson"
export interface AgentSenseConfig {
  enabled: boolean
}

export interface AgentSensesConfig {
  cli: AgentSenseConfig
  teams: AgentSenseConfig
  bluebubbles: AgentSenseConfig
}

export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface AgentConfig {
  version: number
  enabled: boolean
  provider: AgentProvider
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
  phrases: {
    thinking: string[]
    tool: string[]
    followup: string[]
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

export const DEFAULT_AGENT_SENSES: AgentSensesConfig = {
  cli: { enabled: true },
  teams: { enabled: false },
  bluebubbles: { enabled: false },
}

function normalizeSenses(value: unknown, configFile: string): AgentSensesConfig {
  const defaults: AgentSensesConfig = {
    cli: { ...DEFAULT_AGENT_SENSES.cli },
    teams: { ...DEFAULT_AGENT_SENSES.teams },
    bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
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
  const senseNames: SenseName[] = ["cli", "teams", "bluebubbles"]
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
    version: 1,
    enabled: true,
    provider: "anthropic",
    context: { ...DEFAULT_AGENT_CONTEXT },
    senses: {
      cli: { ...DEFAULT_AGENT_SENSES.cli },
      teams: { ...DEFAULT_AGENT_SENSES.teams },
      bluebubbles: { ...DEFAULT_AGENT_SENSES.bluebubbles },
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

export function getAgentToolsRoot(agentName?: string): string {
  return path.join(getAgentStateRoot(resolveOptionalAgentName(agentName)), "tools")
}

/**
 * Returns the conventional secrets path: `~/.agentsecrets/<agentName>/secrets.json`
 */
export function getAgentSecretsPath(agentName: string = getAgentName()): string {
  return path.join(os.homedir(), ".agentsecrets", agentName, "secrets.json")
}

/**
 * Load and parse `<agentRoot>/agent.json`.
 * Reads the file fresh on each call unless an override is set.
 * Throws descriptive error if file is missing or contains invalid JSON.
 */
export function loadAgentConfig(): AgentConfig {
  if (_agentConfigOverride) {
    return _agentConfigOverride
  }

  const agentRoot = getAgentRoot()
  const configFile = path.join(agentRoot, "agent.json")

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

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
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

  const rawProvider = parsed.provider
  if (
    rawProvider !== "azure" &&
    rawProvider !== "minimax" &&
    rawProvider !== "anthropic" &&
    rawProvider !== "openai-codex" &&
    rawProvider !== "github-copilot"
  ) {
    emitNervesEvent({
      level: "error",
      event: "config_identity.error",
      component: "config/identity",
      message: "agent config missing or invalid provider",
      meta: {
        path: configFile,
        provider: rawProvider,
      },
    })
    throw new Error(
      `agent.json at ${configFile} must include provider: "azure", "minimax", "anthropic", "openai-codex", or "github-copilot".`,
    )
  }
  const provider: AgentProvider = rawProvider

  const rawVersion = parsed.version
  const version = rawVersion === undefined ? 1 : rawVersion
  if (
    typeof version !== "number" ||
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
        version: rawVersion,
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

  const config: AgentConfig = {
    version,
    enabled,
    provider,
    context: parsed.context as AgentConfig["context"] | undefined,
    logging: parsed.logging as AgentConfig["logging"] | undefined,
    senses: normalizeSenses(parsed.senses, configFile),
    mcpServers: parsed.mcpServers as Record<string, McpServerConfig> | undefined,
    phrases: parsed.phrases as AgentConfig["phrases"],
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
