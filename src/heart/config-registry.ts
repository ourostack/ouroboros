import { emitNervesEvent } from "../nerves/runtime"

export interface ConfigRegistryEntry {
  path: string
  tier: 1 | 2 | 3
  description: string
  default: unknown
  effects: string
  topics: string[]
}

const registryData: ConfigRegistryEntry[] = [
  // --- Tier 3: Operator-only ---
  {
    path: "version",
    tier: 3,
    description: "Agent config schema version. Must be an integer >= 1.",
    default: 2,
    effects: "Controls which config migrations apply on load. Changing incorrectly can corrupt config.",
    topics: ["schema", "migration"],
  },
  {
    path: "enabled",
    tier: 3,
    description: "Whether the agent is enabled. When false, the agent refuses to start.",
    default: true,
    effects: "Disables all agent functionality when set to false.",
    topics: ["lifecycle", "activation"],
  },
  {
    path: "mcpServers",
    tier: 3,
    description: "MCP server configurations. Maps server name to command, args, and env.",
    default: undefined,
    effects: "Adds or removes MCP tool servers. Incorrect config can expose the agent to untrusted tool sources.",
    topics: ["tools", "mcp", "servers", "extensions"],
  },

  // --- Tier 2: Proposal ---
  {
    path: "humanFacing",
    tier: 2,
    description: "Provider and model for human-facing interactions (CLI, Teams, BlueBubbles).",
    default: { provider: "anthropic", model: "claude-opus-4-6" },
    effects: "Changes the LLM used for all human-facing conversations. Affects quality, latency, and cost.",
    topics: ["model", "provider", "llm", "human"],
  },
  {
    path: "agentFacing",
    tier: 2,
    description: "Provider and model for agent-facing interactions (inner dialog, delegation).",
    default: { provider: "anthropic", model: "claude-opus-4-6" },
    effects: "Changes the LLM used for inner dialog and agent-to-agent communication.",
    topics: ["model", "provider", "llm", "agent", "inner-dialog"],
  },
  {
    path: "context.maxTokens",
    tier: 2,
    description: "Maximum context window size in tokens.",
    default: 80000,
    effects: "Larger values allow more context but increase cost and latency. Must match model capability.",
    topics: ["context", "tokens", "memory", "performance"],
  },
  {
    path: "senses.cli",
    tier: 2,
    description: "CLI sense configuration. Controls whether the CLI interface is enabled.",
    default: { enabled: true },
    effects: "Enables or disables the CLI (terminal) interaction channel.",
    topics: ["senses", "cli", "channels", "interface"],
  },
  {
    path: "senses.teams",
    tier: 2,
    description: "Teams sense configuration. Controls whether the Teams interface is enabled.",
    default: { enabled: false },
    effects: "Enables or disables the Microsoft Teams interaction channel.",
    topics: ["senses", "teams", "channels", "interface"],
  },
  {
    path: "senses.bluebubbles",
    tier: 2,
    description: "BlueBubbles sense configuration. Controls whether the iMessage interface is enabled.",
    default: { enabled: false },
    effects: "Enables or disables the BlueBubbles (iMessage) interaction channel.",
    topics: ["senses", "bluebubbles", "imessage", "channels", "interface"],
  },
  {
    path: "sync.enabled",
    tier: 2,
    description: "Whether git-based bundle sync is enabled.",
    default: false,
    effects: "Enables automatic synchronization of agent state via git. Requires sync.remote to be configured.",
    topics: ["sync", "git", "state", "backup"],
  },
  {
    path: "sync.remote",
    tier: 2,
    description: "Git remote name used for bundle sync.",
    default: "origin",
    effects: "Controls which git remote is used when sync is enabled.",
    topics: ["sync", "git", "remote"],
  },

  // --- Tier 1: Self-service ---
  {
    path: "context.contextMargin",
    tier: 1,
    description: "Percentage of context window reserved as margin before compaction triggers.",
    default: 20,
    effects: "Higher values trigger compaction earlier, preserving more headroom. Lower values use more context.",
    topics: ["context", "compaction", "memory", "performance"],
  },
  {
    path: "phrases.thinking",
    tier: 1,
    description: "Array of phrases displayed while the agent is thinking.",
    default: ["working"],
    effects: "Changes the thinking indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
  },
  {
    path: "phrases.tool",
    tier: 1,
    description: "Array of phrases displayed while the agent is running a tool.",
    default: ["running tool"],
    effects: "Changes the tool-use indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
  },
  {
    path: "phrases.followup",
    tier: 1,
    description: "Array of phrases displayed during follow-up processing.",
    default: ["processing"],
    effects: "Changes the follow-up indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
  },
  {
    path: "shell.defaultTimeout",
    tier: 1,
    description: "Default timeout in milliseconds for shell command execution.",
    default: undefined,
    effects: "Controls how long shell commands run before timing out. Undefined uses system default.",
    topics: ["shell", "timeout", "execution", "tools"],
  },
  {
    path: "logging.level",
    tier: 1,
    description: "Minimum log level: debug, info, warn, or error.",
    default: undefined,
    effects: "Controls verbosity of runtime logging. Lower levels produce more output.",
    topics: ["logging", "debug", "diagnostics"],
  },
  {
    path: "logging.sinks",
    tier: 1,
    description: "Array of log sink types: 'terminal' and/or 'ndjson'.",
    default: undefined,
    effects: "Controls where log output is directed. Terminal shows in console, ndjson writes structured logs.",
    topics: ["logging", "output", "diagnostics"],
  },
]

export const CONFIG_REGISTRY: ReadonlyMap<string, ConfigRegistryEntry> = new Map(
  registryData.map((entry) => [entry.path, entry]),
)

export function getRegistryEntries(): ConfigRegistryEntry[] {
  emitNervesEvent({
    component: "heart",
    event: "config_registry.access",
    message: "listing all registry entries",
    meta: { count: CONFIG_REGISTRY.size },
  })
  return [...CONFIG_REGISTRY.values()]
}

export function getRegistryEntriesByTier(tier: 1 | 2 | 3): ConfigRegistryEntry[] {
  emitNervesEvent({
    component: "heart",
    event: "config_registry.access",
    message: `filtering registry entries by tier ${tier}`,
    meta: { tier },
  })
  return [...CONFIG_REGISTRY.values()].filter((entry) => entry.tier === tier)
}

export function getRegistryEntriesByTopic(topic: string): ConfigRegistryEntry[] {
  const needle = topic.toLowerCase()
  emitNervesEvent({
    component: "heart",
    event: "config_registry.access",
    message: `filtering registry entries by topic "${topic}"`,
    meta: { topic },
  })
  return [...CONFIG_REGISTRY.values()].filter((entry) =>
    entry.topics.some((t) => t.toLowerCase().includes(needle)),
  )
}

export function getRegistryEntry(path: string): ConfigRegistryEntry | undefined {
  emitNervesEvent({
    component: "heart",
    event: "config_registry.access",
    message: `looking up registry entry for "${path}"`,
    meta: { path },
  })
  return CONFIG_REGISTRY.get(path)
}
