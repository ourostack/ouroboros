import { emitNervesEvent } from "../nerves/runtime"

export interface ConfigRegistryEntry {
  path: string
  tier: "self" | "managed"
  description: string
  default: unknown
  effects: string
  topics: string[]
  validate?: (value: unknown) => string | undefined
}

// --- Validation helpers ---

const KNOWN_PROVIDERS = ["anthropic", "azure", "minimax", "openai-codex", "github-copilot"] as const

function validateNumber(value: unknown): string | undefined {
  if (typeof value !== "number") return `expected number, got ${typeof value}`
  return undefined
}

function validateBoolean(value: unknown): string | undefined {
  if (typeof value !== "boolean") return `expected boolean, got ${typeof value}`
  return undefined
}

function validateString(value: unknown): string | undefined {
  if (typeof value !== "string") return `expected string, got ${typeof value}`
  return undefined
}

function validateStringEnum(allowed: readonly string[]) {
  return (value: unknown): string | undefined => {
    if (typeof value !== "string") return `expected string, got ${typeof value}`
    if (!allowed.includes(value)) return `expected one of [${allowed.join(", ")}], got "${value}"`
    return undefined
  }
}

function validateInteger(min: number, max: number) {
  return (value: unknown): string | undefined => {
    if (typeof value !== "number") return `expected number, got ${typeof value}`
    if (!Number.isInteger(value)) return `expected integer, got ${value}`
    if (value < min || value > max) return `expected integer between ${min} and ${max}, got ${value}`
    return undefined
  }
}

function validateStringArray(value: unknown): string | undefined {
  if (!Array.isArray(value)) return `expected array, got ${typeof value}`
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== "string") return `expected string at index ${i}, got ${typeof value[i]}`
  }
  return undefined
}

function validateStringEnumArray(allowed: readonly string[]) {
  return (value: unknown): string | undefined => {
    if (!Array.isArray(value)) return `expected array, got ${typeof value}`
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== "string") return `expected string at index ${i}, got ${typeof value[i]}`
      if (!allowed.includes(value[i] as string)) return `expected one of [${allowed.join(", ")}] at index ${i}, got "${value[i]}"`
    }
    return undefined
  }
}

function validateObject(requiredFields: Record<string, (v: unknown) => string | undefined>) {
  return (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return `expected object, got ${Array.isArray(value) ? "array" : typeof value}`
    }
    const obj = value as Record<string, unknown>
    for (const [field, validator] of Object.entries(requiredFields)) {
      if (!(field in obj)) return `missing required field "${field}"`
      const err = validator(obj[field])
      if (err) return `field "${field}": ${err}`
    }
    return undefined
  }
}

const registryData: ConfigRegistryEntry[] = [
  // --- Managed: harness-only ---
  {
    path: "version",
    tier: "managed",
    description: "Agent config schema version. Managed by the harness. Must be an integer >= 1.",
    default: 2,
    effects: "Controls which config migrations apply on load. Changing incorrectly can corrupt config.",
    topics: ["schema", "migration"],
    validate: validateNumber,
  },
  {
    path: "enabled",
    tier: "managed",
    description: "Whether the agent is enabled. Managed by the harness. When false, the agent refuses to start.",
    default: true,
    effects: "Disables all agent functionality when set to false.",
    topics: ["lifecycle", "activation"],
    validate: validateBoolean,
  },

  // --- Self: agent-configurable ---
  {
    path: "mcpServers",
    tier: "self",
    description: "MCP server configurations. Maps server name to command, args, and env. The agent can add or remove MCP servers.",
    default: undefined,
    effects: "Adds or removes MCP tool servers.",
    topics: ["tools", "mcp", "servers", "extensions"],
  },
  {
    path: "humanFacing.provider",
    tier: "self",
    description: "Provider for human-facing interactions (CLI, Teams, BlueBubbles).",
    default: "anthropic",
    effects: "Changes the LLM provider used for all human-facing conversations. Affects quality, latency, and cost.",
    topics: ["model", "provider", "llm", "human"],
    validate: validateStringEnum(KNOWN_PROVIDERS),
  },
  {
    path: "humanFacing.model",
    tier: "self",
    description: "Model name for human-facing interactions.",
    default: "claude-opus-4-6",
    effects: "Changes the specific model used for human-facing conversations.",
    topics: ["model", "provider", "llm", "human"],
    validate: validateString,
  },
  {
    path: "agentFacing.provider",
    tier: "self",
    description: "Provider for agent-facing interactions (inner dialog, delegation).",
    default: "anthropic",
    effects: "Changes the LLM provider used for inner dialog and agent-to-agent communication.",
    topics: ["model", "provider", "llm", "agent", "inner-dialog"],
    validate: validateStringEnum(KNOWN_PROVIDERS),
  },
  {
    path: "agentFacing.model",
    tier: "self",
    description: "Model name for agent-facing interactions.",
    default: "claude-opus-4-6",
    effects: "Changes the specific model used for inner dialog and agent-to-agent communication.",
    topics: ["model", "provider", "llm", "agent", "inner-dialog"],
    validate: validateString,
  },
  {
    path: "context.maxTokens",
    tier: "self",
    description: "Maximum context window size in tokens.",
    default: 80000,
    effects: "Larger values allow more context but increase cost and latency. Must match model capability.",
    topics: ["context", "tokens", "notes", "performance"],
    validate: validateInteger(1000, 1000000),
  },
  {
    path: "senses.cli",
    tier: "self",
    description: "CLI sense configuration. Controls whether the CLI interface is enabled.",
    default: { enabled: true },
    effects: "Enables or disables the CLI (terminal) interaction channel.",
    topics: ["senses", "cli", "channels", "interface"],
    validate: validateObject({ enabled: validateBoolean }),
  },
  {
    path: "senses.teams",
    tier: "self",
    description: "Teams sense configuration. Controls whether the Teams interface is enabled.",
    default: { enabled: false },
    effects: "Enables or disables the Microsoft Teams interaction channel.",
    topics: ["senses", "teams", "channels", "interface"],
    validate: validateObject({ enabled: validateBoolean }),
  },
  {
    path: "senses.bluebubbles",
    tier: "self",
    description: "BlueBubbles sense configuration. Controls whether the iMessage interface is enabled.",
    default: { enabled: false },
    effects: "Enables or disables the BlueBubbles (iMessage) interaction channel.",
    topics: ["senses", "bluebubbles", "imessage", "channels", "interface"],
    validate: validateObject({ enabled: validateBoolean }),
  },
  {
    path: "sync.enabled",
    tier: "self",
    description: "Whether git-based bundle sync is enabled.",
    default: false,
    effects: "Enables automatic synchronization of agent state via git. Requires sync.remote to be configured.",
    topics: ["sync", "git", "state", "backup"],
    validate: validateBoolean,
  },
  {
    path: "sync.remote",
    tier: "self",
    description: "Git remote name used for bundle sync.",
    default: "origin",
    effects: "Controls which git remote is used when sync is enabled.",
    topics: ["sync", "git", "remote"],
    validate: validateString,
  },

  {
    path: "context.contextMargin",
    tier: "self",
    description: "Percentage of context window reserved as margin before compaction triggers.",
    default: 20,
    effects: "Higher values trigger compaction earlier, preserving more headroom. Lower values use more context.",
    topics: ["context", "compaction", "notes", "performance"],
    validate: validateInteger(0, 100),
  },
  {
    path: "phrases.thinking",
    tier: "self",
    description: "Array of phrases displayed while the agent is thinking.",
    default: ["working"],
    effects: "Changes the thinking indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
    validate: validateStringArray,
  },
  {
    path: "phrases.tool",
    tier: "self",
    description: "Array of phrases displayed while the agent is running a tool.",
    default: ["running tool"],
    effects: "Changes the tool-use indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
    validate: validateStringArray,
  },
  {
    path: "phrases.followup",
    tier: "self",
    description: "Array of phrases displayed during follow-up processing.",
    default: ["processing"],
    effects: "Changes the follow-up indicator text shown to users. Purely cosmetic.",
    topics: ["phrases", "ux", "display", "personality"],
    validate: validateStringArray,
  },
  {
    path: "shell.defaultTimeout",
    tier: "self",
    description: "Default timeout in milliseconds for shell command execution.",
    default: undefined,
    effects: "Controls how long shell commands run before timing out. Undefined uses system default.",
    topics: ["shell", "timeout", "execution", "tools"],
    validate: validateInteger(1000, 600000),
  },
  {
    path: "logging.level",
    tier: "self",
    description: "Minimum log level: debug, info, warn, or error.",
    default: undefined,
    effects: "Controls verbosity of runtime logging. Lower levels produce more output.",
    topics: ["logging", "debug", "diagnostics"],
    validate: validateStringEnum(["debug", "info", "warn", "error"]),
  },
  {
    path: "logging.sinks",
    tier: "self",
    description: "Array of log sink types: 'terminal' and/or 'ndjson'.",
    default: undefined,
    effects: "Controls where log output is directed. Terminal shows in console, ndjson writes structured logs.",
    topics: ["logging", "output", "diagnostics"],
    validate: validateStringEnumArray(["terminal", "ndjson"]),
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

export function getRegistryEntriesByTier(tier: "self" | "managed"): ConfigRegistryEntry[] {
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
