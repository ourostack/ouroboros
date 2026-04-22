/**
 * CLI help system — command registry, grouped help output, and per-command help.
 *
 * Pure data + formatting: no side effects, no daemon communication.
 */

// ── Types ──

export interface CommandHelp {
  description: string
  usage: string
  example?: string
  subcommands?: string[]
}

export type CommandCategory =
  | "Lifecycle"
  | "Agents"
  | "Chat"
  | "Tasks"
  | "Habits"
  | "Friends"
  | "Auth"
  | "Internal"
  | "System"

// ── Registry ──

export const COMMAND_REGISTRY: Record<string, CommandHelp & { category: CommandCategory }> = {
  up: {
    category: "Lifecycle",
    description: "Start and check Ouro: bring up the background runtime, refresh what this machine needs, and show anything that still needs attention. In a human TTY, bare `ouro` opens the home screen instead; noninteractive shells still route bare `ouro` to `ouro up`.",
    usage: "ouro [up] [--no-repair]",
    example: "ouro up --no-repair",
  },
  stop: {
    category: "Lifecycle",
    description: "Stop the running daemon",
    usage: "ouro stop",
    example: "ouro stop",
  },
  down: {
    category: "Lifecycle",
    description: "Stop the running daemon (alias for stop)",
    usage: "ouro down",
    example: "ouro down",
  },
  status: {
    category: "Lifecycle",
    description: "Show Ouro status for this machine",
    usage: "ouro status",
    example: "ouro status",
  },
  logs: {
    category: "Lifecycle",
    description: "View or prune daemon logs",
    usage: "ouro logs [prune]",
    example: "ouro logs",
    subcommands: ["prune"],
  },
  dev: {
    category: "Lifecycle",
    description: "Start daemon in development mode from a local repo",
    usage: "ouro dev [--repo-path <path>] [--clone [--clone-path <path>]]",
    example: "ouro dev --repo-path ~/code/ouroboros",
  },
  hatch: {
    category: "Lifecycle",
    description: "Create a new agent",
    usage: "ouro hatch [--agent <name>] [--human <name>] [--provider <provider>]",
    example: "ouro hatch --agent Sprout --human Ari --provider anthropic",
  },
  rollback: {
    category: "Lifecycle",
    description: "Roll back to a previous CLI version",
    usage: "ouro rollback [<version>]",
    example: "ouro rollback 0.1.0-alpha.250",
  },
  versions: {
    category: "Lifecycle",
    description: "List installed CLI versions",
    usage: "ouro versions",
    example: "ouro versions",
  },
  clone: {
    category: "Lifecycle",
    description: "Clone an existing agent bundle from a git remote onto this machine",
    usage: "ouro clone <remote> [--agent <name>]",
    example: "ouro clone https://github.com/user/myagent.ouro.git",
  },
  doctor: {
    category: "Lifecycle",
    description: "Run diagnostic checks on the ouro installation",
    usage: "ouro doctor",
    example: "ouro doctor",
  },
  outlook: {
    category: "Agents",
    description: "Show the agent's current outlook",
    usage: "ouro outlook [--json]",
    example: "ouro outlook --json",
  },
  whoami: {
    category: "Agents",
    description: "Show current agent identity info",
    usage: "ouro whoami [--agent <name>]",
    example: "ouro whoami",
  },
  config: {
    category: "Agents",
    description: "View or change agent configuration",
    usage: "ouro config <subcommand> [--agent <name>]",
    example: "ouro config models",
    subcommands: ["model", "models"],
  },
  changelog: {
    category: "Agents",
    description: "View the agent changelog",
    usage: "ouro changelog [--from <version>] [--agent <name>]",
    example: "ouro changelog --from 0.1.0-alpha.250",
  },
  chat: {
    category: "Chat",
    description: "Open an interactive chat session with an agent",
    usage: "ouro chat <agent>",
    example: "ouro chat ouroboros",
  },
  msg: {
    category: "Chat",
    description: "Send a single message to an agent",
    usage: "ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    example: "ouro msg --to ouroboros hello there",
  },
  task: {
    category: "Tasks",
    description: "Manage agent tasks",
    usage: "ouro task <subcommand> [--agent <name>]",
    example: "ouro task board",
    subcommands: ["board", "create", "update", "show", "actionable", "deps", "sessions", "fix"],
  },
  poke: {
    category: "Tasks",
    description: "Poke an agent about a task or habit",
    usage: "ouro poke <agent> --task <task-id> | --habit <name>",
    example: "ouro poke ouroboros --task abc123",
  },
  reminder: {
    category: "Tasks",
    description: "Create reminders for an agent",
    usage: "ouro reminder create <title> --body <body> [--at <iso>] [--cadence <interval>]",
    example: "ouro reminder create standup --body 'daily standup' --cadence '1d'",
    subcommands: ["create"],
  },
  habit: {
    category: "Habits",
    description: "Manage agent habits",
    usage: "ouro habit <subcommand> [--agent <name>]",
    example: "ouro habit list",
    subcommands: ["list", "create", "poke"],
  },
  friend: {
    category: "Friends",
    description: "Manage agent friends and identity links",
    usage: "ouro friend <subcommand> [--agent <name>]",
    example: "ouro friend list",
    subcommands: ["list", "show", "create", "update", "link", "unlink"],
  },
  link: {
    category: "Friends",
    description: "Link an external identity to an agent friend",
    usage: "ouro link <agent> --friend <id> --provider <provider> --external-id <eid>",
    example: "ouro link ouroboros --friend f1 --provider aad --external-id user@example.com",
  },
  auth: {
    category: "Auth",
    description: "Set up, verify, or switch agent credentials",
    usage: "ouro auth [verify|switch] [--agent <name>] [--provider <provider>]",
    example: "ouro auth",
    subcommands: ["verify", "switch"],
  },
  account: {
    category: "Auth",
    description: "Ensure the agent's vault-backed work substrate account, including Mailroom setup",
    usage: "ouro account ensure [--agent <name>]",
    example: "ouro account ensure --agent slugger",
    subcommands: ["ensure"],
  },
  connect: {
    category: "Auth",
    description: "Set up providers, portable integrations, and local senses from one guided screen",
    usage: "ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail] [--agent <name>]",
    example: "ouro connect",
    subcommands: ["providers", "perplexity", "embeddings", "teams", "bluebubbles", "mail"],
  },
  mail: {
    category: "Auth",
    description: "Import delegated mail into the agent Mailroom substrate",
    usage: "ouro mail import-mbox --file <path> [--owner-email <email>] [--source <label>] [--agent <name>]",
    example: "ouro mail import-mbox --file ~/Downloads/hey.mbox --owner-email ari@mendelow.me --source hey --agent slugger",
    subcommands: ["import-mbox"],
  },
  use: {
    category: "Auth",
    description: "Choose this machine's provider/model lane for an agent",
    usage: "ouro use [--agent <name>] --lane outward|inner --provider <provider> --model <model> [--force]",
    example: "ouro use --agent ouroboros --lane outward --provider minimax --model MiniMax-M2.5",
  },
  check: {
    category: "Auth",
    description: "Run a live check for this machine's selected provider/model lane",
    usage: "ouro check [--agent <name>] --lane outward|inner",
    example: "ouro check --agent ouroboros --lane outward",
  },
  repair: {
    category: "Auth",
    description: "Guide vault and provider readiness repair without invoking AI diagnosis for known issues",
    usage: "ouro repair [--agent <name>]",
    example: "ouro repair --agent ouroboros",
  },
  provider: {
    category: "Auth",
    description: "Refresh daemon provider credentials from an agent vault",
    usage: "ouro provider refresh [--agent <name>]",
    example: "ouro provider refresh --agent ouroboros",
    subcommands: ["refresh"],
  },
  vault: {
    category: "Auth",
    description: "Create, replace, recover, unlock, inspect, and populate the agent credential vault",
    usage: "ouro vault <create|replace|recover|unlock|status|config> [--agent <name>]",
    example: "ouro vault status",
    subcommands: ["create", "replace", "recover", "unlock", "status", "config set", "config status"],
  },
  thoughts: {
    category: "Internal",
    description: "View agent inner dialog thoughts",
    usage: "ouro thoughts [--last <n>] [--json] [--follow] [--agent <name>]",
    example: "ouro thoughts --last 5 --follow",
  },
  inner: {
    category: "Internal",
    description: "Show inner dialog status",
    usage: "ouro inner [--agent <name>]",
    example: "ouro inner",
  },
  attention: {
    category: "Internal",
    description: "View agent attention items",
    usage: "ouro attention [show <id>|history] [--agent <name>]",
    example: "ouro attention history",
    subcommands: ["show", "history"],
  },
  session: {
    category: "Internal",
    description: "Manage agent sessions",
    usage: "ouro session list [--agent <name>]",
    example: "ouro session list",
    subcommands: ["list"],
  },
  mcp: {
    category: "System",
    description: "Interact with MCP servers",
    usage: "ouro mcp <subcommand>",
    example: "ouro mcp list",
    subcommands: ["list", "call"],
  },
  "mcp-serve": {
    category: "System",
    description: "Start an MCP server for dev tool integration",
    usage: "ouro mcp-serve --agent <name> [--friend <id>]",
    example: "ouro mcp-serve --agent ouroboros",
  },
  setup: {
    category: "System",
    description: "Register MCP server and hooks for a dev tool",
    usage: "ouro setup --tool <claude-code|codex> [--agent <name>]",
    example: "ouro setup --tool claude-code",
  },
  hook: {
    category: "System",
    description: "Fire a dev tool lifecycle hook",
    usage: "ouro hook <event> --agent <name>",
    example: "ouro hook session-start --agent ouroboros",
  },
  bluebubbles: {
    category: "System",
    description: "BlueBubbles integration commands",
    usage: "ouro bluebubbles replay [--agent <name>] --message-guid <guid> [--event-type <type>] [--json]",
    example: "ouro bluebubbles replay --message-guid abc123",
    subcommands: ["replay"],
  },
}

const SUBCOMMAND_HELP: Record<string, CommandHelp> = {
  "auth verify": {
    description: "Verify agent provider credentials without changing provider/model lanes",
    usage: "ouro auth verify [--agent <name>] [--provider <provider>]",
    example: "ouro auth verify --provider openai-codex",
  },
  "auth switch": {
    description: "Switch local provider/model lanes after credentials are available",
    usage: "ouro auth switch [--agent <name>] --provider <provider> [--facing human|agent]",
    example: "ouro auth switch --provider minimax",
  },
  "connect perplexity": {
    description: "Connect portable Perplexity search that travels with this agent",
    usage: "ouro connect perplexity [--agent <name>]",
    example: "ouro connect perplexity",
  },
  "connect providers": {
    description: "Open provider setup from the connections screen without remembering the auth command",
    usage: "ouro connect providers [--agent <name>]",
    example: "ouro connect providers",
  },
  "connect embeddings": {
    description: "Connect portable memory embeddings that travel with this agent",
    usage: "ouro connect embeddings [--agent <name>]",
    example: "ouro connect embeddings",
  },
  "connect teams": {
    description: "Connect portable Microsoft Teams credentials and enable the Teams sense",
    usage: "ouro connect teams [--agent <name>]",
    example: "ouro connect teams",
  },
  "connect bluebubbles": {
    description: "Attach BlueBubbles iMessage to this machine only; it does not travel with the agent",
    usage: "ouro connect bluebubbles [--agent <name>]",
    example: "ouro connect bluebubbles",
  },
  "connect mail": {
    description: "Provision portable Agent Mail / Mailroom access and enable the Mail sense",
    usage: "ouro connect mail [--agent <name>]",
    example: "ouro connect mail",
  },
  "account ensure": {
    description: "Idempotently prepare an agent's vault-backed work substrate account and private Mailroom mailbox",
    usage: "ouro account ensure [--agent <name>]",
    example: "ouro account ensure --agent slugger",
  },
  "mail import-mbox": {
    description: "Import a HEY or other MBOX export into an existing delegated Mailroom source grant",
    usage: "ouro mail import-mbox --file <path> [--owner-email <email>] [--source <label>] [--agent <name>]",
    example: "ouro mail import-mbox --file ~/Downloads/hey.mbox --owner-email ari@mendelow.me --source hey --agent slugger",
  },
  "provider refresh": {
    description: "Reload this agent's provider credentials from its vault into daemon memory",
    usage: "ouro provider refresh [--agent <name>]",
    example: "ouro provider refresh",
  },
  "vault create": {
    description: "Create an agent credential vault and store local unlock material",
    usage: "ouro vault create [--agent <name>] --email <email> [--server <url>] [--store <store>]",
    example: "ouro vault create --email ouroboros@ouro.bot",
  },
  "vault replace": {
    description: "Create an empty agent vault at the stable agent email when no unlock secret or JSON export exists",
    usage: "ouro vault replace [--agent <name>] [--email <email>] [--server <url>] [--store <store>]",
    example: "ouro vault replace",
  },
  "vault recover": {
    description: "Create an agent vault at the stable agent email and import local JSON credential exports",
    usage: "ouro vault recover [--agent <name>] --from <json> [--from <json> ...] [--email <email>] [--server <url>] [--store <store>]",
    example: "ouro vault recover --from ./credentials.json",
  },
  "vault unlock": {
    description: "Unlock an existing agent credential vault on this machine",
    usage: "ouro vault unlock [--agent <name>] [--store <store>]",
    example: "ouro vault unlock",
  },
  "vault status": {
    description: "Show whether this machine can unlock an agent credential vault",
    usage: "ouro vault status [--agent <name>] [--store <store>]",
    example: "ouro vault status",
  },
  "vault config set": {
    description: "Write runtime configuration into the agent credential vault without printing values",
    usage: "ouro vault config set [--agent <name>] --key <path> [--value <value>] [--scope agent|machine]",
    example: "ouro vault config set --key teams.clientSecret",
  },
  "vault config status": {
    description: "List runtime configuration keys stored in the agent credential vault",
    usage: "ouro vault config status [--agent <name>] [--scope agent|machine|all]",
    example: "ouro vault config status --scope all",
  },
}

// ── Levenshtein distance ──

export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const matrix: number[][] = []

  for (let i = 0; i <= a.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= b.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,      // deletion
        matrix[i][j - 1] + 1,      // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      )
    }
  }

  return matrix[a.length][b.length]
}

// ── Command suggestion ──

export function suggestCommand(input: string): string | null {
  if (!input) return null

  let bestMatch: string | null = null
  let bestDistance = Infinity

  for (const name of Object.keys(COMMAND_REGISTRY)) {
    const distance = levenshteinDistance(input, name)
    if (distance < bestDistance) {
      bestDistance = distance
      bestMatch = name
    }
  }

  return bestDistance <= 2 ? bestMatch : null
}

// ── Category display order ──

const CATEGORY_ORDER: CommandCategory[] = [
  "Lifecycle",
  "Agents",
  "Chat",
  "Tasks",
  "Habits",
  "Friends",
  "Auth",
  "Internal",
  "System",
]

// ── Grouped help output ──

export function getGroupedHelp(): string {
  const lines: string[] = ["Usage: ouro <command> [options]", ""]

  for (const category of CATEGORY_ORDER) {
    lines.push(`  ${category}:`)
    for (const [name, entry] of Object.entries(COMMAND_REGISTRY)) {
      if (entry.category === category) {
        lines.push(`    ${name.padEnd(16)} ${entry.description}`)
      }
    }
    lines.push("")
  }

  lines.push("Run 'ouro help <command>' for details on a specific command.")
  return lines.join("\n")
}

// ── Per-command help ──

export function getCommandHelp(name: string): string | null {
  const entry = SUBCOMMAND_HELP[name] ?? COMMAND_REGISTRY[name]
  if (!entry) return null

  const lines: string[] = [
    `${name} - ${entry.description}`,
    "",
    `Usage: ${entry.usage}`,
  ]

  if (entry.subcommands && entry.subcommands.length > 0) {
    lines.push("")
    lines.push("Subcommands:")
    for (const sub of entry.subcommands) {
      lines.push(`  ${sub}`)
    }
  }

  if (entry.example) {
    lines.push("")
    lines.push(`Example: ${entry.example}`)
  }

  return lines.join("\n")
}
