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
  hidden?: boolean
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
    example: "ouro hatch --agent Sprout --human <your-name> --provider anthropic",
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
  mailbox: {
    category: "Agents",
    description: "Show the agent's current mailbox overview",
    usage: "ouro mailbox [--json]",
    example: "ouro mailbox --json",
  },
  outlook: {
    category: "Agents",
    description: "Deprecated alias for `ouro mailbox`",
    usage: "ouro outlook [--json]",
    example: "ouro outlook --json",
    hidden: true,
  },
  whoami: {
    category: "Agents",
    description: "Show current agent identity info",
    usage: "ouro whoami [--agent <name>]",
    example: "ouro whoami",
  },
  config: {
    category: "Agents",
    description: "Legacy model compatibility helpers; prefer `ouro use` and `ouro check`",
    usage: "ouro config <subcommand> [--agent <name>]",
    example: "ouro config models",
    subcommands: ["model", "models"],
    hidden: true,
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
  event: {
    category: "Tasks",
    description: "Submit a verified external event to an owning agent and optionally wake its private runtime",
    usage: "ouro event submit --agent <agent> --source <source> --type <event-type> --id <provider-id> [--summary <text>] [--evidence <path>] [--payload <path>] [--priority high|normal|low] [--no-wake]",
    example: "ouro event submit --agent slugger --source app-store-connect --type feedback.created --id evt_123 --evidence /tmp/feedback",
    subcommands: ["submit"],
  },
  poke: {
    category: "Tasks",
    description: "Poke an agent about a task or habit",
    usage: "ouro poke <agent> --task <task-id> | --habit <name> [--trigger poke|launchd|cron|overdue|manual]",
    example: "ouro poke ouroboros --task abc123",
  },
  habit: {
    category: "Habits",
    description: "Manage agent habits",
    usage: "ouro habit <subcommand> [--agent <name>]",
    example: "ouro habit list",
    subcommands: ["list", "create", "runs", "inspect", "summary", "poke"],
  },
  rsvp: {
    category: "Habits",
    description: "AislePlanner-backed RSVP habit operations, triage, receipts, ledgers, migration checks, refreshes, and smoke tests",
    usage: "ouro rsvp <doctor|incident|cutover|legacy-render|replay|config|habit|import-legacy|refresh|compare|smoke> ...",
    example: "ouro rsvp doctor --agent slugger --json",
    subcommands: [
      "doctor",
      "incident",
      "cutover",
      "legacy-render",
      "replay",
      "config import-legacy",
      "habit stage",
      "import-legacy",
      "refresh",
      "compare",
      "smoke",
    ],
  },
  desk: {
    category: "Tasks",
    description: "Manage the agent's desk — tasks, tracks, friction, lessons, search, and recall (routes through the desk MCP server).",
    usage: "ouro desk <task|track|friction|lesson|search|recall|reindex|thread> ...",
    example: "ouro desk task list",
    subcommands: ["task", "track", "friction", "lesson", "search", "recall", "reindex", "thread"],
  },
  task: {
    category: "Tasks",
    description: "Alias for `ouro desk task ...`.",
    usage: "ouro task <list|new|done|archive|show> [...]",
    example: "ouro task list",
    subcommands: ["list", "new", "done", "archive", "show"],
  },
  work: {
    category: "Tasks",
    description: "Show durable Arc work state, recovery Sentinel state, or run the context-loss gauntlet.",
    usage: "ouro work card|gauntlet|sentinel [refresh] [--agent <name>] [--format text|json|--json]",
    example: "ouro work sentinel --agent slugger --format json",
    subcommands: ["card", "gauntlet", "sentinel"],
  },
  "nerves-review": {
    category: "Internal",
    description: "Read-only review of recent nerves events from an agent log stream",
    usage: "ouro nerves-review [--agent <name>] [--process <name>] [--component <substr>] [--event <substr>] [--level <level>] [--since <duration>] [--limit <n>] [--json]",
    example: "ouro nerves-review --agent slugger --component daemon --event habit --since 30m --json",
  },
  "work card": {
    category: "Tasks",
    description: "Show the agent's durable Work Card compiled from arc records.",
    usage: "ouro work card [--agent <name>] [--format text|json|--json]",
    example: "ouro work card --agent slugger --format json",
    hidden: true,
  },
  "work gauntlet": {
    category: "Tasks",
    description: "Score whether durable Arc, flight recorder, and Desk state can recover after context loss.",
    usage: "ouro work gauntlet [--agent <name>] [--format text|json|--json]",
    example: "ouro work gauntlet --agent slugger --format json",
    hidden: true,
  },
  "work sentinel": {
    category: "Tasks",
    description: "Show read-only Arc Sentinel recovery state, or explicitly refresh it.",
    usage: "ouro work sentinel [refresh] [--agent <name>] [--format text|json|--json]",
    example: "ouro work sentinel refresh --agent slugger --format json",
    hidden: true,
  },
  "migrate-to-desk": {
    category: "Tasks",
    description: "Migrate a legacy `tasks/` tree into the new `desk/` shape (copy semantics — source untouched).",
    usage: "ouro migrate-to-desk --agent <name> [--root <path>] [--force] [--dry-run]",
    example: "ouro migrate-to-desk --agent <agent> --dry-run",
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
    description: "Set up or verify agent credentials",
    usage: "ouro auth [verify] [--agent <name>] [--provider <provider>]",
    example: "ouro auth",
    subcommands: ["verify"],
  },
  account: {
    category: "Auth",
    description: "Ensure the agent's vault-backed work substrate account, including Mailroom setup",
    usage: "ouro account ensure [--agent <name>]",
    example: "ouro account ensure --agent <agent>",
    subcommands: ["ensure"],
  },
  connect: {
    category: "Auth",
    description: "Set up providers, portable integrations, and local senses from one guided screen",
    usage: "ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail|voice|a2a|workbench] [--agent <name>]",
    example: "ouro connect",
    subcommands: ["providers", "perplexity", "embeddings", "teams", "bluebubbles", "mail", "voice", "a2a", "workbench"],
  },
  a2a: {
    category: "Friends",
    description: "Publish A2A cards, onboard agent peers, and run the A2A sense server",
    usage: "ouro a2a <card|onboard|serve> [--agent <name>]",
    example: "ouro a2a card --agent <agent> --base-url https://agent.example",
    subcommands: ["card", "onboard", "serve"],
  },
  mail: {
    category: "Auth",
    description: "Import delegated mail and repair hosted Mailroom mailbox indexes",
    usage: "ouro mail <import-mbox|backfill-indexes> [--agent <name>]",
    example: "ouro mail import-mbox --discover --owner-email you@example.com --source hey --agent <agent>",
    subcommands: ["import-mbox", "backfill-indexes"],
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
    usage: "ouro vault <create|replace|recover|unlock|status|config|item|ops> [--agent <name>]",
    example: "ouro vault status",
    subcommands: ["create", "replace", "recover", "unlock", "status", "config set", "config status", "vault item set", "vault item status", "vault item list", "vault ops porkbun set", "vault ops porkbun status"],
  },
  thoughts: {
    category: "Internal",
    description: "View private runtime transcript turns",
    usage: "ouro thoughts [--last <n>] [--json] [--follow] [--agent <name>]",
    example: "ouro thoughts --last 5 --follow",
  },
  private: {
    category: "Internal",
    description: "Inspect private-runtime status and policy decisions",
    usage: "ouro private status|decisions [--agent <name>] [--limit <n>] [--json]",
    example: "ouro private status --agent ouroboros",
    subcommands: ["status", "decisions"],
  },
  inner: {
    category: "Internal",
    description: "Legacy alias for `ouro private status`",
    usage: "ouro inner [--agent <name>]",
    example: "ouro inner",
    hidden: true,
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
    example: "ouro mcp canary --agent ouroboros",
    subcommands: ["list", "call", "canary"],
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
    usage: [
      "ouro bluebubbles replay [--agent <name>] --message-guid <guid> [--event-type <type>] [--json]",
      "ouro bluebubbles context-smoke [--agent <name>] --message-guid <guid> [--persist] [--json]",
    ].join("\n"),
    example: "ouro bluebubbles context-smoke --agent slugger --message-guid abc123 --persist --json",
    subcommands: ["replay", "context-smoke"],
  },
}

const SUBCOMMAND_HELP: Record<string, CommandHelp> = {
  "private decisions": {
    description: "Read recent private-runtime allow/deny decisions from the policy ledger",
    usage: "ouro private decisions [--agent <name>] [--limit <n>] [--json]",
    example: "ouro private decisions --agent ouroboros --json",
  },
  "private status": {
    description: "Show private-runtime status from local agent state",
    usage: "ouro private status [--agent <name>] [--json]",
    example: "ouro private status --agent ouroboros --json",
  },
  "auth verify": {
    description: "Verify agent provider credentials without changing provider/model lanes",
    usage: "ouro auth verify [--agent <name>] [--provider <provider>]",
    example: "ouro auth verify --provider openai-codex",
  },
  "auth switch": {
    description: "Deprecated compatibility wrapper; use `ouro use` for provider/model lane selection",
    usage: "ouro auth switch [--agent <name>] --provider <provider> [--facing human|agent]",
    example: "ouro use --agent ouroboros --lane outward --provider minimax --model MiniMax-M2.5",
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
    description: "Connect portable embeddings for note search and diary consultation; travels with this agent",
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
    usage: "ouro connect mail [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]",
    example: "ouro connect mail --agent <agent> --owner-email you@example.com --source hey",
  },
  "connect a2a": {
    description: "Enable the agent-to-agent A2A sense",
    usage: "ouro connect a2a [--agent <name>]",
    example: "ouro connect a2a --agent <agent>",
  },
  "connect workbench": {
    description: "Verify native Ouro Workbench runtime injection and clean stale bundle entries",
    usage: "ouro connect workbench [--agent <name>]",
    example: "ouro connect workbench --agent <agent>",
  },
  "a2a card": {
    description: "Print this agent's A2A Agent Card",
    usage: "ouro a2a card [--agent <name>] [--base-url <url>] [--json]",
    example: "ouro a2a card --agent <agent> --base-url https://agent.example --json",
  },
  "a2a onboard": {
    description: "Onboard an A2A peer into the existing friend model",
    usage: "ouro a2a onboard [--agent <name>] --card-url <url> [--trust <level>] [--name <name>]",
    example: "ouro a2a onboard --agent <agent> --card-url https://peer.example/.well-known/agent-card.json --trust friend",
  },
  "a2a serve": {
    description: "Run this agent's local A2A JSON-RPC sense server",
    usage: "ouro a2a serve [--agent <name>] [--host <host>] [--port <port>] [--base-url <url>] [--path <path>]",
    example: "ouro a2a serve --agent <agent> --base-url https://agent.example",
  },
  "account ensure": {
    description: "Idempotently prepare an agent's vault-backed work substrate account and private Mailroom mailbox",
    usage: "ouro account ensure [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]",
    example: "ouro account ensure --agent <agent> --owner-email you@example.com --source hey",
  },
  "habit summary": {
    description: "Read a habit run summary from receipts and session artifacts without contacting the daemon",
    usage: "ouro habit summary [--agent <name>] (--run-id <id>|--habit <name>|--operation-id <id>) [--which latest|previous|latest-success|latest-failure] [--json]",
    example: "ouro habit summary --agent slugger --operation-id habit:standup --which latest --json",
  },
  "rsvp doctor": {
    description: "Check native RSVP configuration, credentials, BlueBubbles attachment, ledgers, receipts, and migration readiness without sending messages; use --json --strict in triage",
    usage: "ouro rsvp doctor [--agent <name>] [--strict] [--output <path>] [--json]",
    example: "ouro rsvp doctor --agent slugger --strict --json",
  },
  "rsvp incident": {
    description: "Collect a redacted local RSVP diagnostic incident bundle with doctor status, receipts, and ledger pointers without contacting the daemon",
    usage: "ouro rsvp incident [--agent <name>] [--output <path>] [--json]",
    example: "ouro rsvp incident --agent slugger --output /tmp/rsvp-incident.json",
  },
  "rsvp cutover": {
    description: "Inspect or retire legacy RSVP sender state before native live send",
    usage: "ouro rsvp cutover [--agent <name>] --legacy-root <path> --action check|quarantine-launchd|retire-legacy-send-config [--yes] [--output <path>] [--json]",
    example: "ouro rsvp cutover --agent slugger --legacy-root ~/Projects/rsvp-tracker --action check --json",
  },
  "rsvp legacy-render": {
    description: "Render the legacy RSVP script's local snapshot/report shape for comparison without mutating native state",
    usage: "ouro rsvp legacy-render --legacy-root <path> [--agent <name>] [--output <path>] [--json]",
    example: "ouro rsvp legacy-render --legacy-root ~/Projects/rsvp-tracker --output /tmp/legacy.json",
  },
  "rsvp replay": {
    description: "Replay an offline fixture through deterministic native RSVP report/query logic without live BlueBubbles or AislePlanner access",
    usage: "ouro rsvp replay [--agent <name>] --fixture <path> [--output <path>] [--json]",
    example: "ouro rsvp replay --agent slugger --fixture /tmp/rsvp-replay.json --json",
  },
  "rsvp config import-legacy": {
    description: "Import legacy RSVP coordinates into native config and vault-backed runtime/config; mutates only with --yes",
    usage: "ouro rsvp config import-legacy [--agent <name>] --legacy-root <path> --mode shadow|live [--yes] [--output <path>] [--json]",
    example: "ouro rsvp config import-legacy --agent slugger --legacy-root ~/Projects/rsvp-tracker --mode shadow --yes",
  },
  "rsvp habit stage": {
    description: "Stage the daily RSVP refresh habit with a fixed cron cadence, usually the 10 AM dogfood run",
    usage: "ouro rsvp habit stage [--agent <name>] --mode shadow|live --cadence '<cron>' [--output <path>] [--json]",
    example: "ouro rsvp habit stage --agent slugger --mode shadow --cadence '0 10 * * *'",
  },
  "rsvp import-legacy": {
    description: "Compatibility alias for `ouro rsvp config import-legacy`; mutates only with --yes",
    usage: "ouro rsvp import-legacy [--agent <name>] --legacy-root <path> --mode shadow|live [--yes] [--output <path>] [--json]",
    example: "ouro rsvp import-legacy --agent slugger --legacy-root ~/Projects/rsvp-tracker --mode shadow --yes",
  },
  "rsvp refresh": {
    description: "Run the native RSVP refresh path and write receipts; defaults to dry-run behavior unless --allow-send is explicit",
    usage: "ouro rsvp refresh [--agent <name>] --mode shadow|live [--no-send|--allow-send] [--output <path>] [--json]",
    example: "ouro rsvp refresh --agent slugger --mode shadow --no-send --json",
  },
  "rsvp compare": {
    description: "Compare native and legacy RSVP render outputs for migration verification",
    usage: "ouro rsvp compare [--agent <name>] --native <path> --legacy <path> [--output <path>] [--json]",
    example: "ouro rsvp compare --agent slugger --native /tmp/native.json --legacy /tmp/legacy.json",
  },
  "rsvp smoke": {
    description: "Smoke-test RSVP follow-up behavior through a target sense; preflight is no-send and live mode requires --allow-send",
    usage: "ouro rsvp smoke [--agent <name>] --mode preflight|live --surface bluebubbles [--question <text>] [--allow-send] [--output <path>] [--replay-output <path>] [--json]",
    example: "ouro rsvp smoke --agent slugger --mode preflight --surface bluebubbles --question 'who is pending?'",
  },
  "mail import-mbox": {
    description: "Import a HEY or other MBOX export into an existing delegated Mailroom source grant",
    usage: "ouro mail import-mbox (--file <path>|--discover) [--owner-email <email>] [--source <label>] [--agent <name>] [--foreground]",
    example: "ouro mail import-mbox --discover --owner-email you@example.com --source hey --agent <agent>",
  },
  "mail backfill-indexes": {
    description: "Rebuild hosted blob mailbox indexes for faster recent-mail reads after large legacy imports or drift repair.",
    usage: "ouro mail backfill-indexes [--agent <name>] [--foreground]",
    example: "ouro mail backfill-indexes --agent <agent>",
  },
  "provider refresh": {
    description: "Reload this agent's provider credentials from its vault into the running daemon",
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
  "vault item set": {
    description: "Store an ordinary vault item / credential with no assumed use. Prompts for hidden secret fields, stores optional public fields and notes, and secret values are not printed.",
    usage: "ouro vault item set [--agent <name>] --item <path> (--secret-field <name>...|--template <template>) [--public-field <key=value>] [--note <text>]",
    example: "ouro vault item set --agent <agent> --item ops/porkbun/you@example.com --template porkbun-api",
  },
  "vault item status": {
    description: "Show metadata for an ordinary vault item without printing secret values",
    usage: "ouro vault item status [--agent <name>] --item <path>",
    example: "ouro vault item status --agent <agent> --item ops/porkbun/you@example.com",
  },
  "vault item list": {
    description: "List ordinary vault item names and metadata without printing secret values",
    usage: "ouro vault item list [--agent <name>] [--prefix <path-prefix>]",
    example: "ouro vault item list --agent <agent> --prefix ops/",
  },
  "vault ops porkbun set": {
    description: "deprecated compatibility alias for `ouro vault item set --template porkbun-api`; stores an ordinary vault item, not a special credential kind",
    usage: "ouro vault ops porkbun set [--agent <name>] --account <account>",
    example: "ouro vault ops porkbun set --agent <agent> --account you@example.com",
  },
  "vault ops porkbun status": {
    description: "deprecated compatibility alias for checking the ordinary vault item used by the Porkbun API template",
    usage: "ouro vault ops porkbun status [--agent <name>] [--account <account>]",
    example: "ouro vault ops porkbun status --agent <agent> --account you@example.com",
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
    if (COMMAND_REGISTRY[name].hidden) continue
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
      if (entry.hidden) continue
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
