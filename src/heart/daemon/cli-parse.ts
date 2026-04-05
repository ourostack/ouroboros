/**
 * CLI argument parsing — converts argv into OuroCliCommand objects.
 *
 * Pure functions: no side effects, no daemon communication.
 * Each command group has its own parser; parseOuroCommand dispatches.
 */

import type { AgentProvider } from "../identity"
import { isIdentityProvider } from "../../mind/friends/types"
import type { Facing } from "../../mind/friends/channel"
import type { TrustLevel } from "../../mind/friends/types"
import type { HatchCredentialsInput } from "./hatch-flow"
import type { OuroCliCommand } from "./cli-types"

// ── Shared helpers ──

export function extractAgentFlag(args: string[]): { agent?: string; rest: string[] } {
  const idx = args.indexOf("--agent")
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const agent = args[idx + 1]
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { agent, rest }
}

export function extractFacingFlag(args: string[]): { facing?: Facing; rest: string[] } {
  const idx = args.indexOf("--facing")
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const value = args[idx + 1]
  if (value !== "human" && value !== "agent") {
    throw new Error(`--facing must be 'human' or 'agent'`)
  }
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { facing: value, rest }
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "azure" || value === "anthropic" || value === "minimax" || value === "openai-codex" || value === "github-copilot"
}

export function usage(): string {
  return [
    "Usage:",
    "  ouro [up]",
    "  ouro dev [--repo-path <path>] [--clone [--clone-path <path>]]",
    "  ouro stop|down|status|logs|hatch",
    "  ouro outlook [--json]",
    "  ouro -v|--version",
    "  ouro config model --agent <name> <model-name>",
    "  ouro config models --agent <name>",
    "  ouro auth --agent <name> [--provider <provider>]",
    "  ouro auth verify --agent <name> [--provider <provider>]",
    "  ouro auth switch --agent <name> --provider <provider>",
    "  ouro chat <agent>",
    "  ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    "  ouro poke <agent> --task <task-id>",
    "  ouro poke <agent> --habit <name>",
    "  ouro habit list [--agent <name>]",
    "  ouro habit create [--agent <name>] <name> [--cadence <interval>]",
    "  ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>",
    "  ouro task board [<status>] [--agent <name>]",
    "  ouro task create <title> [--type <type>] [--agent <name>]",
    "  ouro task update <id> <status> [--agent <name>]",
    "  ouro task show <id> [--agent <name>]",
    "  ouro task fix [--safe|--all] [<id> [--option <N>]] [--agent <name>]",
    "  ouro task actionable|deps|sessions [--agent <name>]",
    "  ouro reminder create <title> --body <body> [--at <iso>] [--cadence <interval>] [--category <category>] [--agent <name>]",
    "  ouro friend list [--agent <name>]",
    "  ouro friend show <id> [--agent <name>]",
    "  ouro friend create --name <name> [--trust <level>] [--agent <name>]",
    "  ouro friend update <id> --trust <level> [--agent <name>]",
    "  ouro thoughts [--last <n>] [--json] [--follow] [--agent <name>]",
    "  ouro inner [--agent <name>]",
    "  ouro friend link <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro friend unlink <agent> --friend <id> --provider <p> --external-id <eid>",
    "  ouro whoami [--agent <name>]",
    "  ouro session list [--agent <name>]",
    "  ouro mcp list",
    "  ouro mcp call <server> <tool> [--args '{...}']",
    "  ouro rollback [<version>]",
    "  ouro versions",
  ].join("\n")
}

// ── Per-group parsers ──

function parseMessageCommand(args: string[]): OuroCliCommand {
  let to: string | undefined
  let sessionId: string | undefined
  let taskRef: string | undefined
  const messageParts: string[] = []

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--to") {
      to = args[i + 1]
      i += 1
      continue
    }
    if (token === "--session") {
      sessionId = args[i + 1]
      i += 1
      continue
    }
    if (token === "--task") {
      taskRef = args[i + 1]
      i += 1
      continue
    }
    messageParts.push(token)
  }

  const content = messageParts.join(" ").trim()
  if (!to || !content) throw new Error(`Usage\n${usage()}`)

  return {
    kind: "message.send",
    from: "ouro-cli",
    to,
    content,
    sessionId,
    taskRef,
  }
}

function parsePokeCommand(args: string[]): OuroCliCommand {
  const agent = args[0]
  if (!agent) throw new Error(`Usage\n${usage()}`)

  let taskId: string | undefined
  let habitName: string | undefined
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--task") {
      taskId = args[i + 1]
      i += 1
    }
    if (args[i] === "--habit") {
      habitName = args[i + 1]
      i += 1
    }
  }

  // --habit takes priority over --task
  if (habitName) return { kind: "habit.poke", agent, habitName }
  if (!taskId) throw new Error(`Usage\n${usage()}`)
  return { kind: "task.poke", agent, taskId }
}

function parseHabitCommand(args: string[]): OuroCliCommand {
  const { agent, rest } = extractAgentFlag(args)

  const sub = rest[0]
  if (sub === "list") {
    return { kind: "habit.list", ...(agent ? { agent } : {}) }
  }
  if (sub === "create") {
    const nameArgs = rest.slice(1)
    let name: string | undefined
    let cadence: string | undefined
    const positional: string[] = []
    for (let i = 0; i < nameArgs.length; i++) {
      if (nameArgs[i] === "--cadence" && nameArgs[i + 1]) {
        cadence = nameArgs[++i]
        continue
      }
      /* v8 ignore start -- defensive: --agent already extracted by extractAgentFlag; guard prevents regression if parsing flow changes @preserve */
      if (nameArgs[i] === "--agent" && nameArgs[i + 1]) {
        i++ // skip --agent value (already extracted)
        continue
      }
      /* v8 ignore stop */
      positional.push(nameArgs[i])
    }
    name = positional[0]
    if (!name) throw new Error(`Usage\n${usage()}`)
    return { kind: "habit.create", name, ...(agent ? { agent } : {}), ...(cadence ? { cadence } : {}) }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseLinkCommand(args: string[], kind: "friend.link" | "friend.unlink" = "friend.link"): OuroCliCommand {
  const agent = args[0]
  if (!agent) throw new Error(`Usage\n${usage()}`)

  let friendId: string | undefined
  let providerRaw: string | undefined
  let externalId: string | undefined
  for (let i = 1; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--friend") {
      friendId = args[i + 1]
      i += 1
      continue
    }
    if (token === "--provider") {
      providerRaw = args[i + 1]
      i += 1
      continue
    }
    if (token === "--external-id") {
      externalId = args[i + 1]
      i += 1
      continue
    }
  }

  if (!friendId || !providerRaw || !externalId) {
    throw new Error(`Usage\n${usage()}`)
  }
  if (!isIdentityProvider(providerRaw)) {
    throw new Error(`Unknown identity provider '${providerRaw}'. Use aad|local|teams-conversation.`)
  }

  return {
    kind,
    agent,
    friendId,
    provider: providerRaw,
    externalId,
  } as OuroCliCommand
}

function parseHatchCommand(args: string[]): OuroCliCommand {
  let agentName: string | undefined
  let humanName: string | undefined
  let providerRaw: string | undefined
  let migrationPath: string | undefined
  const credentials: HatchCredentialsInput = {}

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--agent") {
      agentName = args[i + 1]
      i += 1
      continue
    }
    if (token === "--human") {
      humanName = args[i + 1]
      i += 1
      continue
    }
    if (token === "--provider") {
      providerRaw = args[i + 1]
      i += 1
      continue
    }
    if (token === "--setup-token") {
      credentials.setupToken = args[i + 1]
      i += 1
      continue
    }
    if (token === "--oauth-token") {
      credentials.oauthAccessToken = args[i + 1]
      i += 1
      continue
    }
    if (token === "--api-key") {
      credentials.apiKey = args[i + 1]
      i += 1
      continue
    }
    if (token === "--endpoint") {
      credentials.endpoint = args[i + 1]
      i += 1
      continue
    }
    if (token === "--deployment") {
      credentials.deployment = args[i + 1]
      i += 1
      continue
    }
    if (token === "--migration-path") {
      migrationPath = args[i + 1]
      i += 1
      continue
    }
  }

  if (providerRaw && !isAgentProvider(providerRaw)) {
    throw new Error("Unknown provider. Use azure|anthropic|minimax|openai-codex|github-copilot.")
  }
  const provider = providerRaw && isAgentProvider(providerRaw) ? providerRaw : undefined

  return {
    kind: "hatch.start",
    agentName,
    humanName,
    provider,
    credentials: Object.keys(credentials).length > 0 ? credentials : undefined,
    migrationPath,
  }
}

function parseTaskCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "board") {
    const status = rest[0]
    return status
      ? { kind: "task.board", status, ...(agent ? { agent } : {}) }
      : { kind: "task.board", ...(agent ? { agent } : {}) }
  }

  if (sub === "create") {
    const title = rest[0]
    if (!title) throw new Error(`Usage\n${usage()}`)
    let type: string | undefined
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--type" && rest[i + 1]) {
        type = rest[i + 1]
        i += 1
      }
    }
    return type
      ? { kind: "task.create", title, type, ...(agent ? { agent } : {}) }
      : { kind: "task.create", title, ...(agent ? { agent } : {}) }
  }

  if (sub === "update") {
    const id = rest[0]
    const status = rest[1]
    if (!id || !status) throw new Error(`Usage\n${usage()}`)
    return { kind: "task.update", id, status, ...(agent ? { agent } : {}) }
  }

  if (sub === "show") {
    const id = rest[0]
    if (!id) throw new Error(`Usage\n${usage()}`)
    return { kind: "task.show", id, ...(agent ? { agent } : {}) }
  }

  if (sub === "actionable") return { kind: "task.actionable", ...(agent ? { agent } : {}) }
  if (sub === "deps") return { kind: "task.deps", ...(agent ? { agent } : {}) }
  if (sub === "sessions") return { kind: "task.sessions", ...(agent ? { agent } : {}) }

  if (sub === "fix") {
    // fix --safe | fix --all | fix <id> [--option N] | fix (dry-run)
    if (rest.length === 0) return { kind: "task.fix", mode: "dry-run", ...(agent ? { agent } : {}) }

    const first = rest[0]
    if (first === "--safe" || first === "--all") {
      return { kind: "task.fix", mode: "safe", ...(agent ? { agent } : {}) }
    }

    // first arg is an issue ID (contains a colon, e.g. schema-missing-kind:one-shots/foo.md)
    const issueId = first
    let option: number | undefined
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--option" && rest[i + 1]) {
        option = parseInt(rest[i + 1], 10)
        i += 1
      }
    }
    return {
      kind: "task.fix",
      mode: "single",
      issueId,
      ...(option !== undefined ? { option } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseAuthCommand(args: string[]): OuroCliCommand {
  const first = args[0]
  // Support both positional (`auth switch`) and flag (`auth --switch`) forms
  if (first === "verify" || first === "switch" || first === "--verify" || first === "--switch") {
    const subcommand = first.replace(/^--/, "")
    const { agent, rest: afterAgent } = extractAgentFlag(args.slice(1))
    const { facing, rest } = extractFacingFlag(afterAgent)
    let provider: AgentProvider | undefined
    /* v8 ignore start -- provider flag parsing: branches tested via CLI parsing tests @preserve */
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === "--provider") {
        const value = rest[i + 1]
        if (!isAgentProvider(value)) throw new Error(`Usage\n${usage()}`)
        provider = value
        i += 1
        continue
      }
    }
    /* v8 ignore stop */
    /* v8 ignore next -- defensive: agent always provided in tests @preserve */
    if (!agent) throw new Error(`Usage\n${usage()}`)
    if (subcommand === "switch") {
      if (!provider) throw new Error(`auth switch requires --provider.\n${usage()}`)
      return facing ? { kind: "auth.switch", agent, provider, facing } : { kind: "auth.switch", agent, provider }
    }
    return provider ? { kind: "auth.verify", agent, provider } : { kind: "auth.verify", agent }
  }
  const { agent, rest } = extractAgentFlag(args)
  let provider: AgentProvider | undefined
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--provider") {
      const value = rest[i + 1]
      if (!isAgentProvider(value)) throw new Error(`Usage\n${usage()}`)
      provider = value
      i += 1
      continue
    }
  }
  if (!agent) {
    throw new Error([
      "Usage:",
      "  ouro auth --agent <name> [--provider <provider>]     Set up credentials",
      "  ouro auth verify --agent <name> [--provider <p>]     Verify credentials work",
      "  ouro auth switch --agent <name> --provider <p>       Switch active provider",
    ].join("\n"))
  }
  return provider ? { kind: "auth.run", agent, provider } : { kind: "auth.run", agent }
}

function parseReminderCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "create") {
    const title = rest[0]
    if (!title) throw new Error(`Usage\n${usage()}`)

    let body: string | undefined
    let scheduledAt: string | undefined
    let cadence: string | undefined
    let category: string | undefined
    let requester: string | undefined

    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--body" && rest[i + 1]) {
        body = rest[i + 1]
        i += 1
      } else if (rest[i] === "--at" && rest[i + 1]) {
        scheduledAt = rest[i + 1]
        i += 1
      } else if (rest[i] === "--cadence" && rest[i + 1]) {
        cadence = rest[i + 1]
        i += 1
      } else if (rest[i] === "--category" && rest[i + 1]) {
        category = rest[i + 1]
        i += 1
      } else if (rest[i] === "--requester" && rest[i + 1]) {
        requester = rest[i + 1]
        i += 1
      }
    }

    if (!body) throw new Error(`Usage\n${usage()}`)
    if (!scheduledAt && !cadence) throw new Error(`Usage\n${usage()}`)

    return {
      kind: "reminder.create" as const,
      title,
      body,
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(cadence ? { cadence } : {}),
      ...(category ? { category } : {}),
      ...(requester ? { requester } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseSessionCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "session.list", ...(agent ? { agent } : {}) }

  throw new Error(`Usage\n${usage()}`)
}

function parseAttentionCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const sub = cleaned[0]
  if (sub === "show" && cleaned[1]) {
    return { kind: "attention.show", id: cleaned[1], ...(agent ? { agent } : {}) }
  }
  if (sub === "history") {
    return { kind: "attention.history", ...(agent ? { agent } : {}) }
  }
  return { kind: "attention.list", ...(agent ? { agent } : {}) }
}

function parseThoughtsCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  let last: number | undefined
  let json = false
  let follow = false
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "--last" && i + 1 < cleaned.length) {
      last = Number.parseInt(cleaned[i + 1], 10)
      i++
    }
    if (cleaned[i] === "--json") json = true
    if (cleaned[i] === "--follow" || cleaned[i] === "-f") follow = true
  }
  return { kind: "thoughts", ...(agent ? { agent } : {}), ...(last ? { last } : {}), ...(json ? { json } : {}), ...(follow ? { follow } : {}) }
}

function parseFriendCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "friend.list", ...(agent ? { agent } : {}) }

  if (sub === "show") {
    const friendId = rest[0]
    if (!friendId) throw new Error(`Usage\n${usage()}`)
    return { kind: "friend.show", friendId, ...(agent ? { agent } : {}) }
  }

  if (sub === "create") {
    let name: string | undefined
    let trustLevel: string | undefined
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--name" && rest[i + 1]) {
        name = rest[i + 1]
        i += 1
      } else if (rest[i] === "--trust" && rest[i + 1]) {
        trustLevel = rest[i + 1]
        i += 1
      }
    }
    if (!name) throw new Error(`Usage\n${usage()}`)
    return {
      kind: "friend.create",
      name,
      ...(trustLevel ? { trustLevel } : {}),
      ...(agent ? { agent } : {}),
    }
  }

  if (sub === "update") {
    const friendId = rest[0]
    if (!friendId) throw new Error(`Usage: ouro friend update <id> --trust <level>`)
    let trustLevel: string | undefined
    /* v8 ignore start -- flag parsing loop: tested via CLI parsing tests @preserve */
    for (let i = 1; i < rest.length; i++) {
      if (rest[i] === "--trust" && rest[i + 1]) {
        trustLevel = rest[i + 1]
        i += 1
      }
    }
    /* v8 ignore stop */
    const VALID_TRUST_LEVELS = new Set(["stranger", "acquaintance", "friend", "family"])
    if (!trustLevel || !VALID_TRUST_LEVELS.has(trustLevel)) {
      throw new Error(`Usage: ouro friend update <id> --trust <stranger|acquaintance|friend|family>`)
    }
    return {
      kind: "friend.update" as const,
      friendId,
      trustLevel: trustLevel as TrustLevel,
      ...(agent ? { agent } : {}),
    }
  }

  if (sub === "link") return parseLinkCommand(rest, "friend.link")
  if (sub === "unlink") return parseLinkCommand(rest, "friend.unlink")

  throw new Error(`Usage\n${usage()}`)
}

function parseConfigCommand(args: string[]): OuroCliCommand {
  const { agent, rest: afterAgent } = extractAgentFlag(args)
  const { facing, rest: cleaned } = extractFacingFlag(afterAgent)
  const [sub, ...rest] = cleaned
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "model") {
    if (!agent) throw new Error("--agent is required for config model")
    const modelName = rest[0]
    if (!modelName) throw new Error(`Usage: ouro config model --agent <name> <model-name>`)
    return facing ? { kind: "config.model", agent, modelName, facing } : { kind: "config.model", agent, modelName }
  }

  if (sub === "models") {
    if (!agent) throw new Error("--agent is required for config models")
    return { kind: "config.models", agent }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseMcpCommand(args: string[]): OuroCliCommand {
  const [sub, ...rest] = args
  if (!sub) throw new Error(`Usage\n${usage()}`)

  if (sub === "list") return { kind: "mcp.list" }

  if (sub === "call") {
    const server = rest[0]
    const tool = rest[1]
    if (!server || !tool) throw new Error(`Usage\n${usage()}`)

    const argsIdx = rest.indexOf("--args")
    const mcpArgs = argsIdx !== -1 && rest[argsIdx + 1] ? rest[argsIdx + 1] : undefined

    return { kind: "mcp.call", server, tool, ...(mcpArgs ? { args: mcpArgs } : {}) }
  }

  throw new Error(`Usage\n${usage()}`)
}

export function parseMcpServeCommand(args: string[]): OuroCliCommand & { socketOverride?: string } {
  let agent: string | undefined
  let friendId: string | undefined
  let socketOverride: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) { agent = args[++i]; continue }
    if (args[i] === "--friend" && args[i + 1]) { friendId = args[++i]; continue }
    if (args[i] === "--socket" && args[i + 1]) { socketOverride = args[++i]; continue }
  }
  if (!agent) throw new Error("mcp-serve requires --agent <name>")
  return { kind: "mcp-serve", agent, ...(friendId ? { friendId } : {}), ...(socketOverride ? { socketOverride } : {}) }
}

function parseSetupCommand(args: string[]): OuroCliCommand {
  let tool: string | undefined
  let agent: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tool" && args[i + 1]) { tool = args[++i]; continue }
    if (args[i] === "--agent" && args[i + 1]) { agent = args[++i]; continue }
  }
  if (!tool) throw new Error("setup requires --tool (claude-code | codex)")
  if (tool !== "claude-code" && tool !== "codex") throw new Error(`Unknown tool: ${tool}. Supported: claude-code, codex`)
  if (!agent) throw new Error("setup requires --agent <name>")
  return { kind: "setup", tool, agent }
}

// ── Main dispatch ──

export function parseOuroCommand(args: string[]): OuroCliCommand {
  const [head, second] = args
  if (!head) return { kind: "daemon.up" }

  if (head === "--agent" && second) {
    return parseOuroCommand(args.slice(2))
  }

  if (head === "hook") {
    const hookArgs = args.slice(1)
    let event: string | undefined
    let hookAgent: string | undefined
    for (let i = 0; i < hookArgs.length; i++) {
      if (hookArgs[i] === "--agent" && hookArgs[i + 1]) { hookAgent = hookArgs[++i]; continue }
      /* v8 ignore start -- false branch: extra positional args after event are ignored */
      if (!event) { event = hookArgs[i] }
      /* v8 ignore stop */
    }
    if (!event) throw new Error("hook requires an event name (session-start, stop, post-tool-use)")
    if (!hookAgent) throw new Error("hook requires --agent <name>")
    return { kind: "hook", event, agent: hookAgent }
  }
  if (head === "up") return { kind: "daemon.up" }
  if (head === "dev") {
    const devArgs = args.slice(1)
    let repoPath: string | undefined
    let clone = false
    let clonePath: string | undefined
    for (let i = 0; i < devArgs.length; i++) {
      if (devArgs[i] === "--repo-path" && devArgs[i + 1]) { repoPath = devArgs[++i]; continue }
      if (devArgs[i] === "--clone") { clone = true; continue }
      if (devArgs[i] === "--clone-path" && devArgs[i + 1]) { clonePath = devArgs[++i]; continue }
    }
    return { kind: "daemon.dev", repoPath, clone, clonePath }
  }
  if (head === "rollback") return { kind: "rollback", ...(second ? { version: second } : {}) }
  if (head === "versions") return { kind: "versions" }
  if (head === "stop" || head === "down") return { kind: "daemon.stop" }
  if (head === "status") return { kind: "daemon.status" }
  if (head === "logs") return { kind: "daemon.logs" }
  if (head === "outlook") return { kind: "outlook", ...(args.includes("--json") ? { json: true } : {}) }
  if (head === "hatch") return parseHatchCommand(args.slice(1))
  if (head === "auth") return parseAuthCommand(args.slice(1))
  if (head === "task") return parseTaskCommand(args.slice(1))
  if (head === "reminder") return parseReminderCommand(args.slice(1))
  if (head === "habit") return parseHabitCommand(args.slice(1))
  if (head === "friend") return parseFriendCommand(args.slice(1))
  if (head === "config") return parseConfigCommand(args.slice(1))
  if (head === "mcp") return parseMcpCommand(args.slice(1))
  if (head === "whoami") {
    const { agent } = extractAgentFlag(args.slice(1))
    return { kind: "whoami", ...(agent ? { agent } : {}) }
  }
  if (head === "session") return parseSessionCommand(args.slice(1))
  if (head === "changelog") {
    const sliced = args.slice(1)
    const { agent, rest: remaining } = extractAgentFlag(sliced)
    let from: string | undefined
    const fromIdx = remaining.indexOf("--from")
    if (fromIdx !== -1 && remaining[fromIdx + 1]) {
      from = remaining[fromIdx + 1]
    }
    return { kind: "changelog", ...(from ? { from } : {}), ...(agent ? { agent } : {}) }
  }
  if (head === "thoughts") return parseThoughtsCommand(args.slice(1))
  if (head === "attention") return parseAttentionCommand(args.slice(1))
  if (head === "inner") {
    const { agent } = extractAgentFlag(args.slice(1))
    return { kind: "inner.status", ...(agent ? { agent } : {}) }
  }
  if (head === "chat") {
    if (!second) throw new Error(`Usage\n${usage()}`)
    return { kind: "chat.connect", agent: second }
  }
  if (head === "msg") return parseMessageCommand(args.slice(1))
  if (head === "poke") return parsePokeCommand(args.slice(1))
  if (head === "link") return parseLinkCommand(args.slice(1))
  if (head === "mcp-serve") return parseMcpServeCommand(args.slice(1))
  if (head === "setup") return parseSetupCommand(args.slice(1))

  throw new Error(`Unknown command '${args.join(" ")}'.\n${usage()}`)
}
