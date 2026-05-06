/**
 * CLI argument parsing — converts argv into OuroCliCommand objects.
 *
 * Pure functions: no side effects, no daemon communication.
 * Each command group has its own parser; parseOuroCommand dispatches.
 */

import type { AgentProvider } from "../identity"
import type { ProviderLane } from "../provider-lanes"
import type { VaultUnlockStoreKind } from "../../repertoire/vault-unlock"
import { isIdentityProvider } from "../../mind/friends/types"
import type { Facing } from "../../mind/friends/channel"
import type { TrustLevel } from "../../mind/friends/types"
import type { HatchCredentialsInput } from "../hatch/hatch-flow"
import type { DnsWorkflowAction, OuroCliCommand } from "./cli-types"
import type { VaultItemTemplate } from "./vault-items"
import { suggestCommand } from "./cli-help"
import {
  isVaultItemTemplate,
  normalizePorkbunOpsAccount,
  normalizeVaultItemFieldName,
  normalizeVaultItemName,
  PORKBUN_OPS_COMPATIBILITY_ALIAS,
  PORKBUN_OPS_CREDENTIAL_PREFIX,
  porkbunOpsCredentialItemName,
} from "./vault-items"

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

export function facingToProviderLane(facing: Facing): ProviderLane {
  return facing === "human" ? "outward" : "inner"
}

function isProviderLane(value: unknown): value is ProviderLane {
  return value === "outward" || value === "inner"
}

function helpCommandName(args: string[]): string | undefined {
  const positional: string[] = []
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") break
    if (arg.startsWith("-")) break
    positional.push(arg)
  }
  return positional.length > 0 ? positional.join(" ") : undefined
}

function extractLaneFlag(args: string[]): { lane?: ProviderLane; rest: string[] } {
  const idx = args.indexOf("--lane")
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const value = args[idx + 1]
  if (!isProviderLane(value)) {
    throw new Error("--lane must be 'outward' or 'inner'")
  }
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { lane: value, rest }
}

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === "azure" || value === "anthropic" || value === "minimax" || value === "openai-codex" || value === "github-copilot"
}

export function usage(): string {
  return [
    "Usage:",
    "  ouro [up] [--no-repair]",
    "  ouro dev [--repo-path <path>] [--clone [--clone-path <path>]]",
    "  ouro stop|down|status|logs|hatch",
    "  ouro status --agent <name>",
    "  ouro use [--agent <name>] --lane outward|inner --provider <provider> --model <model> [--force]",
    "  ouro check [--agent <name>] --lane outward|inner",
    "  ouro repair [--agent <name>]",
    "  ouro provider refresh [--agent <name>]",
    "  ouro mailbox [--json]",
    "  ouro -v|--version",
    "  ouro config model [--agent <name>] <model-name>",
    "  ouro config models [--agent <name>]",
    "  ouro auth [--agent <name>] [--provider <provider>]",
    "  ouro account ensure [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]",
    "  ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail] [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]",
    "  ouro mail import-mbox --file <path> [--owner-email <email>] [--source <label>] [--agent <name>] [--foreground]",
    "  ouro mail backfill-indexes [--agent <name>] [--foreground]",
    "  ouro auth verify [--agent <name>] [--provider <provider>]",
    "  ouro auth switch [--agent <name>] --provider <provider>",
    "  ouro vault create [--agent <name>] --email <email> [--server <url>] [--store <store>]",
    "  ouro vault replace [--agent <name>] [--email <email>] [--server <url>] [--store <store>]",
    "  ouro vault recover [--agent <name>] --from <json> [--from <json>] [--email <email>] [--server <url>] [--store <store>]",
    "  ouro vault unlock [--agent <name>] [--store auto|macos-keychain|windows-dpapi|linux-secret-service|plaintext-file]",
    "  ouro vault status [--agent <name>] [--store auto|macos-keychain|windows-dpapi|linux-secret-service|plaintext-file]",
    "  ouro vault config set [--agent <name>] --key <path> [--value <value>] [--scope agent|machine]",
    "  ouro vault config status [--agent <name>] [--scope agent|machine|all]",
    "  ouro vault item set [--agent <name>] --item <path> --secret-field <name> [--public-field <key=value>] [--note <text>]",
    "  ouro vault item status [--agent <name>] --item <path>",
    "  ouro vault item list [--agent <name>] [--prefix <path-prefix>]",
    "  ouro vault ops porkbun set [--agent <name>] --account <account>",
    "  ouro vault ops porkbun status [--agent <name>] [--account <account>]",
    "  ouro dns backup|plan|apply|verify|rollback|certificate [--agent <name>] --binding <path> [--output <path>] [--backup <path>] [--yes]",
    "  ouro chat <agent>",
    "  ouro msg --to <agent> [--session <id>] [--task <ref>] <message>",
    "  ouro poke <agent> --task <task-id>",
    "  ouro poke <agent> --habit <name>",
    "  ouro habit list [--agent <name>]",
    "  ouro habit create [--agent <name>] <name> [--cadence <interval>]",
    "  ouro link <agent> --friend <id> --provider <provider> --external-id <external-id>",
    "  ouro bluebubbles replay [--agent <name>] --message-guid <guid> [--event-type new-message|updated-message] [--json]",
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
    "  ouro clone <remote> [--agent <name>]",
    "  ouro doctor",
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
    if (subcommand === "switch") {
      if (!provider) throw new Error(`auth switch requires --provider.\n${usage()}`)
      return {
        kind: "auth.switch",
        ...(agent ? { agent } : {}),
        provider,
        ...(facing ? { facing } : {}),
      }
    }
    return {
      kind: "auth.verify",
      ...(agent ? { agent } : {}),
      ...(provider ? { provider } : {}),
    }
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
  return {
    kind: "auth.run",
    ...(agent ? { agent } : {}),
    ...(provider ? { provider } : {}),
  }
}

function isVaultUnlockStoreKind(value: unknown): value is VaultUnlockStoreKind {
  return value === "auto" || value === "macos-keychain" || value === "windows-dpapi" || value === "linux-secret-service" || value === "plaintext-file"
}

function parseVaultCommand(args: string[]): OuroCliCommand {
  const sub = args[0]
  if (sub === "config") return parseVaultConfigCommand(args.slice(1))
  if (sub === "item") return parseVaultItemCommand(args.slice(1))
  if (sub === "ops") return parseVaultOpsCommand(args.slice(1))
  const { agent, rest } = extractAgentFlag(args.slice(1))
  let email: string | undefined
  let serverUrl: string | undefined
  let store: VaultUnlockStoreKind | undefined
  let generateUnlockSecret = false
  const sources: string[] = []

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--email") {
      email = rest[i + 1]
      i += 1
      continue
    }
    if (token === "--server") {
      serverUrl = rest[i + 1]
      i += 1
      continue
    }
    if (token === "--store") {
      const value = rest[i + 1]
      if (!isVaultUnlockStoreKind(value)) {
        throw new Error("vault --store must be auto|macos-keychain|windows-dpapi|linux-secret-service|plaintext-file")
      }
      store = value
      i += 1
      continue
    }
    if (token === "--from") {
      if (sub !== "recover") {
        throw new Error("--from is only valid with `ouro vault recover`; use `ouro vault replace` when there is no JSON export to import.")
      }
      const value = rest[i + 1]
      if (!value) throw new Error("Usage: ouro vault recover [--agent <name>] --from <json> [--from <json> ...]")
      sources.push(value)
      i += 1
      continue
    }
    if (token === "--generate-unlock-secret") {
      generateUnlockSecret = true
      continue
    }
    throw new Error("Usage: ouro vault create|replace|recover|unlock|status [--agent <name>]")
  }

  if (sub !== "create" && sub !== "replace" && sub !== "recover" && sub !== "unlock" && sub !== "status") {
    throw new Error("Usage: ouro vault create|replace|recover|unlock|status [--agent <name>]")
  }
  if (sub === "create") {
    return {
      kind: "vault.create",
      ...(agent ? { agent } : {}),
      ...(email ? { email } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      ...(store ? { store } : {}),
      ...(generateUnlockSecret ? { generateUnlockSecret: true } : {}),
    }
  }
  if (sub === "replace") {
    return {
      kind: "vault.replace",
      ...(agent ? { agent } : {}),
      ...(email ? { email } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      ...(store ? { store } : {}),
      ...(generateUnlockSecret ? { generateUnlockSecret: true } : {}),
    }
  }
  if (sub === "recover") {
    if (sources.length === 0) {
      throw new Error("Usage: ouro vault recover [--agent <name>] --from <json> [--from <json> ...]")
    }
    return {
      kind: "vault.recover",
      ...(agent ? { agent } : {}),
      sources,
      ...(email ? { email } : {}),
      ...(serverUrl ? { serverUrl } : {}),
      ...(store ? { store } : {}),
      ...(generateUnlockSecret ? { generateUnlockSecret: true } : {}),
    }
  }
  if (sub === "unlock") {
    return { kind: "vault.unlock", ...(agent ? { agent } : {}), ...(store ? { store } : {}) }
  }
  return { kind: "vault.status", ...(agent ? { agent } : {}), ...(store ? { store } : {}) }
}

function parseVaultItemCommand(args: string[]): OuroCliCommand {
  const action = args[0]
  if (action !== "set" && action !== "status" && action !== "list") {
    throw new Error("Usage: ouro vault item set|status|list [--agent <name>] --item <path>")
  }

  const { agent, rest } = extractAgentFlag(args.slice(1))
  let item: string | undefined
  let prefix: string | undefined
  let template: VaultItemTemplate | undefined
  let note: string | undefined
  const secretFields: string[] = []
  const publicFields: string[] = []

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--item") {
      item = normalizeVaultItemName(rest[i + 1])
      i += 1
      continue
    }
    if (token === "--prefix") {
      const value = rest[i + 1]?.trim() ?? ""
      if (!value || /[\r\n\t]/.test(value) || value.startsWith("/")) {
        throw new Error("Vault item prefix must be non-empty, relative, and free of control characters.")
      }
      prefix = value
      i += 1
      continue
    }
    if (token === "--template") {
      const value = rest[i + 1]
      if (!isVaultItemTemplate(value)) {
        throw new Error("vault item --template must be porkbun-api")
      }
      template = value
      i += 1
      continue
    }
    if (token === "--secret-field") {
      secretFields.push(normalizeVaultItemFieldName(rest[i + 1]))
      i += 1
      continue
    }
    if (token === "--public-field") {
      const value = rest[i + 1]?.trim() ?? ""
      const separator = value.indexOf("=")
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error("vault item --public-field must be key=value")
      }
      normalizeVaultItemFieldName(value.slice(0, separator))
      publicFields.push(value)
      i += 1
      continue
    }
    if (token === "--note") {
      note = rest[i + 1] ?? ""
      i += 1
      continue
    }
    throw new Error(`Usage: ouro vault item ${action} [--agent <name>] --item <path>`)
  }

  if (action === "list") {
    return { kind: "vault.item.list", ...(agent ? { agent } : {}), ...(prefix ? { prefix } : {}) }
  }
  if (!item) throw new Error(`Usage: ouro vault item ${action} [--agent <name>] --item <path>`)
  if (action === "status") {
    return { kind: "vault.item.status", ...(agent ? { agent } : {}), item }
  }
  if (!template && secretFields.length === 0) {
    throw new Error("ouro vault item set requires --secret-field or --template")
  }
  return {
    kind: "vault.item.set",
    ...(agent ? { agent } : {}),
    item,
    ...(template ? { template } : {}),
    ...(secretFields.length > 0 ? { secretFields } : {}),
    ...(publicFields.length > 0 ? { publicFields } : {}),
    ...(note !== undefined ? { note } : {}),
  }
}

function parseVaultOpsCommand(args: string[]): OuroCliCommand {
  const provider = args[0]
  const action = args[1]
  if (provider !== "porkbun") {
    throw new Error("Usage: ouro vault ops porkbun set|status [--agent <name>] [--account <account>]")
  }
  if (action !== "set" && action !== "status") {
    throw new Error("Usage: ouro vault ops porkbun set|status [--agent <name>] [--account <account>]")
  }

  const { agent, rest } = extractAgentFlag(args.slice(2))
  let account: string | undefined
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--account") {
      account = normalizePorkbunOpsAccount(rest[i + 1])
      i += 1
      continue
    }
    throw new Error(`Usage: ouro vault ops porkbun ${action} [--agent <name>] [--account <account>]`)
  }

  if (action === "set") {
    if (!account) throw new Error("Usage: ouro vault ops porkbun set [--agent <name>] --account <account>")
    return {
      kind: "vault.item.set",
      ...(agent ? { agent } : {}),
      item: porkbunOpsCredentialItemName(account),
      template: "porkbun-api",
      compatibilityAlias: PORKBUN_OPS_COMPATIBILITY_ALIAS,
    }
  }
  if (account) {
    return {
      kind: "vault.item.status",
      ...(agent ? { agent } : {}),
      item: porkbunOpsCredentialItemName(account),
      compatibilityAlias: PORKBUN_OPS_COMPATIBILITY_ALIAS,
    }
  }
  return {
    kind: "vault.item.list",
    ...(agent ? { agent } : {}),
    prefix: PORKBUN_OPS_CREDENTIAL_PREFIX,
    compatibilityAlias: PORKBUN_OPS_COMPATIBILITY_ALIAS,
  }
}

function isDnsWorkflowAction(value: unknown): value is DnsWorkflowAction {
  return value === "backup" || value === "plan" || value === "apply" || value === "verify" || value === "rollback" || value === "certificate"
}

function normalizeWorkflowPath(value: string | undefined, label: string): string {
  const trimmed = value?.trim() ?? ""
  if (!trimmed || /[\r\n\t]/.test(trimmed)) {
    throw new Error(`${label} must be a non-empty path without control characters.`)
  }
  return trimmed
}

function parseDnsCommand(args: string[]): OuroCliCommand {
  const action = args[0]
  if (!isDnsWorkflowAction(action)) {
    throw new Error("Usage: ouro dns backup|plan|apply|verify|rollback|certificate [--agent <name>] --binding <path>")
  }
  const { agent, rest } = extractAgentFlag(args.slice(1))
  let bindingPath: string | undefined
  let outputPath: string | undefined
  let backupPath: string | undefined
  let yes = false
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--binding") {
      bindingPath = normalizeWorkflowPath(rest[i + 1], "dns --binding")
      i += 1
      continue
    }
    if (token === "--output") {
      outputPath = normalizeWorkflowPath(rest[i + 1], "dns --output")
      i += 1
      continue
    }
    if (token === "--backup") {
      backupPath = normalizeWorkflowPath(rest[i + 1], "dns --backup")
      i += 1
      continue
    }
    if (token === "--yes") {
      yes = true
      continue
    }
    if (token === "--credential-item") {
      throw new Error("credential item belongs in the DNS workflow binding")
    }
    throw new Error(`Usage: ouro dns ${action} [--agent <name>] --binding <path>`)
  }
  if (!bindingPath) {
    throw new Error(`Usage: ouro dns ${action} [--agent <name>] --binding <path>`)
  }
  if (action === "apply" && !yes) {
    throw new Error("dns apply requires --yes after a reviewed dry-run")
  }
  if (action === "rollback") {
    if (!backupPath) throw new Error("dns rollback requires --backup <path>")
    if (!yes) throw new Error("dns rollback requires --yes after choosing a backup")
  }
  return {
    kind: "dns.workflow",
    action,
    ...(agent ? { agent } : {}),
    bindingPath,
    ...(outputPath ? { outputPath } : {}),
    ...(backupPath ? { backupPath } : {}),
    ...(yes ? { yes: true } : {}),
  }
}

function parseVaultConfigCommand(args: string[]): OuroCliCommand {
  const sub = args[0]
  const { agent, rest } = extractAgentFlag(args.slice(1))
  let key: string | undefined
  let value: string | undefined
  let scope: "agent" | "machine" | "all" | undefined

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--key") {
      key = rest[i + 1]
      i += 1
      continue
    }
    if (token === "--value") {
      value = rest[i + 1]
      i += 1
      continue
    }
    if (token === "--scope") {
      const raw = rest[i + 1]
      if (raw !== "agent" && raw !== "machine" && raw !== "all") {
        throw new Error("vault config --scope must be agent, machine, or all")
      }
      scope = raw
      i += 1
      continue
    }
    throw new Error("Usage: ouro vault config set [--agent <name>] --key <path> [--value <value>] OR ouro vault config status [--agent <name>]")
  }

  if (sub !== "set" && sub !== "status") {
    throw new Error("Usage: ouro vault config set [--agent <name>] --key <path> [--value <value>] OR ouro vault config status [--agent <name>]")
  }
  if (sub === "status") {
    if (key || value) {
      throw new Error("Usage: ouro vault config status [--agent <name>]")
    }
    return { kind: "vault.config.status", ...(agent ? { agent } : {}), ...(scope ? { scope } : {}) }
  }
  if (scope === "all") throw new Error("vault config --scope all is only valid for status")
  if (!key) {
    throw new Error("Usage: ouro vault config set [--agent <name>] --key <path> [--value <value>]")
  }
  return { kind: "vault.config.set", ...(agent ? { agent } : {}), key, ...(value !== undefined ? { value } : {}), ...(scope ? { scope } : {}) }
}

function normalizeConnectTarget(value: string | undefined): "providers" | "perplexity" | "embeddings" | "teams" | "bluebubbles" | "mail" | undefined {
  if (!value) return undefined
  if (value === "providers" || value === "provider" || value === "auth") return "providers"
  if (value === "perplexity" || value === "perplexity-search") return "perplexity"
  if (value === "embeddings" || value === "embedding" || value === "memory" || value === "note-search" || value === "notes") return "embeddings"
  if (value === "teams" || value === "msteams" || value === "microsoft-teams") return "teams"
  if (value === "bluebubbles" || value === "imessage" || value === "messages") return "bluebubbles"
  if (value === "mail" || value === "email" || value === "mailroom") return "mail"
  throw new Error("Usage: ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail] [--agent <name>]")
}

interface MailSourceFlagParse {
  rest: string[]
  ownerEmail?: string
  source?: string
  noDelegatedSource?: boolean
  rotateMissingMailKeys?: boolean
  hasMailSourceFlags: boolean
}

function extractMailSourceFlags(args: string[], usageText: string): MailSourceFlagParse {
  const rest: string[] = []
  let ownerEmail: string | undefined
  let source: string | undefined
  let noDelegatedSource = false
  let rotateMissingMailKeys = false
  let hasMailSourceFlags = false

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]
    if (token === "--owner-email") {
      if (args[i + 1] === undefined) throw new Error(usageText)
      ownerEmail = args[++i]
      hasMailSourceFlags = true
      continue
    }
    if (token === "--source") {
      if (args[i + 1] === undefined) throw new Error(usageText)
      source = args[++i]
      hasMailSourceFlags = true
      continue
    }
    if (token === "--no-delegated-source") {
      noDelegatedSource = true
      hasMailSourceFlags = true
      continue
    }
    if (token === "--rotate-missing-mail-keys") {
      rotateMissingMailKeys = true
      hasMailSourceFlags = true
      continue
    }
    rest.push(token)
  }

  if (noDelegatedSource && (ownerEmail !== undefined || source !== undefined)) {
    throw new Error("--no-delegated-source cannot be combined with --owner-email or --source")
  }
  if (source !== undefined && ownerEmail === undefined) {
    throw new Error("--source requires --owner-email")
  }
  return {
    rest,
    ...(ownerEmail !== undefined ? { ownerEmail } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(noDelegatedSource ? { noDelegatedSource: true } : {}),
    ...(rotateMissingMailKeys ? { rotateMissingMailKeys: true } : {}),
    hasMailSourceFlags,
  }
}

function parseConnectCommand(args: string[]): OuroCliCommand {
  const usageText = "Usage: ouro connect [providers|perplexity|embeddings|teams|bluebubbles|mail] [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]"
  const { agent, rest: afterAgent } = extractAgentFlag(args)
  const mailFlags = extractMailSourceFlags(afterAgent, usageText)
  if (mailFlags.rest.length > 1) throw new Error(usageText)
  const target = normalizeConnectTarget(mailFlags.rest[0])
  if (mailFlags.hasMailSourceFlags && target !== "mail") {
    throw new Error("Mail source flags require `ouro connect mail`.")
  }
  return {
    kind: "connect",
    ...(agent ? { agent } : {}),
    ...(target ? { target } : {}),
    ...(mailFlags.ownerEmail !== undefined ? { ownerEmail: mailFlags.ownerEmail } : {}),
    ...(mailFlags.source !== undefined ? { source: mailFlags.source } : {}),
    ...(mailFlags.noDelegatedSource ? { noDelegatedSource: true } : {}),
    ...(mailFlags.rotateMissingMailKeys ? { rotateMissingMailKeys: true } : {}),
  }
}

function parseMailCommand(args: string[]): OuroCliCommand {
  const [sub, ...subArgs] = args
  const usageText = "Usage: ouro mail import-mbox (--file <path>|--discover) [--owner-email <email>] [--source <label>] [--agent <name>] [--foreground]\n       ouro mail backfill-indexes [--agent <name>] [--foreground]"
  if (sub === "backfill-indexes") {
    const { agent, rest } = extractAgentFlag(subArgs)
    let foreground = false
    let operationId: string | undefined
    for (let i = 0; i < rest.length; i += 1) {
      const token = rest[i]
      if (token === "--foreground") {
        foreground = true
        continue
      }
      if (token === "--operation-id" && rest[i + 1]) {
        operationId = rest[++i]
        continue
      }
      throw new Error(usageText)
    }
    return {
      kind: "mail.backfill-indexes",
      ...(agent ? { agent } : {}),
      ...(foreground ? { foreground: true } : {}),
      ...(operationId ? { operationId } : {}),
    }
  }
  if (sub !== "import-mbox") {
    throw new Error(usageText)
  }
  const { agent, rest } = extractAgentFlag(subArgs)
  let filePath: string | undefined
  let discover = false
  let ownerEmail: string | undefined
  let source: string | undefined
  let foreground = false
  let operationId: string | undefined
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--file" && rest[i + 1]) {
      filePath = rest[++i]
      continue
    }
    if (token === "--discover") {
      discover = true
      continue
    }
    if (token === "--owner-email" && rest[i + 1]) {
      ownerEmail = rest[++i]
      continue
    }
    if (token === "--source" && rest[i + 1]) {
      source = rest[++i]
      continue
    }
    if (token === "--foreground") {
      foreground = true
      continue
    }
    if (token === "--operation-id" && rest[i + 1]) {
      operationId = rest[++i]
      continue
    }
    throw new Error(usageText)
  }
  if ((filePath ? 1 : 0) + (discover ? 1 : 0) !== 1) {
    throw new Error(usageText)
  }
  return {
    kind: "mail.import-mbox",
    ...(agent ? { agent } : {}),
    ...(filePath ? { filePath } : {}),
    ...(discover ? { discover: true } : {}),
    ...(ownerEmail ? { ownerEmail } : {}),
    ...(source ? { source } : {}),
    ...(foreground ? { foreground: true } : {}),
    ...(operationId ? { operationId } : {}),
  }
}

function parseAccountCommand(args: string[]): OuroCliCommand {
  const [sub, ...subArgs] = args
  const usageText = "Usage: ouro account ensure [--agent <name>] [--owner-email <email> --source <label>|--no-delegated-source] [--rotate-missing-mail-keys]"
  if (sub !== "ensure") {
    throw new Error(usageText)
  }
  const { agent, rest: afterAgent } = extractAgentFlag(subArgs)
  const mailFlags = extractMailSourceFlags(afterAgent, usageText)
  if (mailFlags.rest.length > 0) throw new Error(usageText)
  return {
    kind: "account.ensure",
    ...(agent ? { agent } : {}),
    ...(mailFlags.ownerEmail !== undefined ? { ownerEmail: mailFlags.ownerEmail } : {}),
    ...(mailFlags.source !== undefined ? { source: mailFlags.source } : {}),
    ...(mailFlags.noDelegatedSource ? { noDelegatedSource: true } : {}),
    ...(mailFlags.rotateMissingMailKeys ? { rotateMissingMailKeys: true } : {}),
  }
}

function parseProviderUseCommand(args: string[]): OuroCliCommand {
  const { agent, rest: afterAgent } = extractAgentFlag(args)
  const { facing, rest: afterFacing } = extractFacingFlag(afterAgent)
  const { lane, rest } = extractLaneFlag(afterFacing)
  let provider: AgentProvider | undefined
  let model: string | undefined
  let force = false

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]
    if (token === "--provider") {
      const value = rest[i + 1]
      if (!isAgentProvider(value)) throw new Error("Usage: ouro use [--agent <name>] --lane outward|inner --provider <provider> --model <model>")
      provider = value
      i += 1
      continue
    }
    if (token === "--model") {
      model = rest[i + 1]
      i += 1
      continue
    }
    if (token === "--force") {
      force = true
      continue
    }
    throw new Error("Usage: ouro use [--agent <name>] --lane outward|inner --provider <provider> --model <model> [--force]")
  }

  const resolvedLane = lane ?? (facing ? facingToProviderLane(facing) : undefined)
  if (!resolvedLane || !provider || !model) {
    throw new Error("Usage: ouro use [--agent <name>] --lane outward|inner --provider <provider> --model <model> [--force]")
  }
  return {
    kind: "provider.use",
    ...(agent ? { agent } : {}),
    lane: resolvedLane,
    provider,
    model,
    ...(force ? { force: true } : {}),
    ...(facing ? { legacyFacing: facing } : {}),
  }
}

function parseProviderCheckCommand(args: string[]): OuroCliCommand {
  const { agent, rest: afterAgent } = extractAgentFlag(args)
  const { facing, rest: afterFacing } = extractFacingFlag(afterAgent)
  const { lane, rest } = extractLaneFlag(afterFacing)
  const resolvedLane = lane ?? (facing ? facingToProviderLane(facing) : undefined)
  if (!resolvedLane || rest.length > 0) {
    throw new Error("Usage: ouro check [--agent <name>] --lane outward|inner")
  }
  return {
    kind: "provider.check",
    ...(agent ? { agent } : {}),
    lane: resolvedLane,
    ...(facing ? { legacyFacing: facing } : {}),
  }
}

function parseProviderCommand(args: string[]): OuroCliCommand {
  const sub = args[0]
  const { agent, rest } = extractAgentFlag(args.slice(1))
  if (sub === "refresh" && rest.length === 0) {
    return { kind: "provider.refresh", ...(agent ? { agent } : {}) }
  }
  throw new Error("Usage: ouro provider refresh [--agent <name>]")
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
    const modelName = rest[0]
    if (!modelName) throw new Error("Usage: ouro config model [--agent <name>] <model-name>")
    return {
      kind: "config.model",
      ...(agent ? { agent } : {}),
      modelName,
      ...(facing ? { facing } : {}),
    }
  }

  if (sub === "models") {
    return { kind: "config.models", ...(agent ? { agent } : {}) }
  }

  throw new Error(`Usage\n${usage()}`)
}

function parseMcpCommand(args: string[]): OuroCliCommand {
  const { agent, rest: cleaned } = extractAgentFlag(args)
  const [sub, ...rest] = cleaned
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

  if (sub === "canary") {
    let socketOverride: string | undefined
    let json = false
    const requiredSenses: string[] = []
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--socket" && rest[i + 1]) {
        socketOverride = rest[++i]
        continue
      }
      if (rest[i] === "--require-sense" && rest[i + 1]) {
        requiredSenses.push(rest[++i])
        continue
      }
      if (rest[i] === "--json") {
        json = true
        continue
      }
    }
    if (!agent) throw new Error("mcp canary requires --agent <name>")
    return {
      kind: "mcp.canary",
      agent,
      ...(socketOverride ? { socketOverride } : {}),
      ...(requiredSenses.length > 0 ? { requiredSenses } : {}),
      ...(json ? { json: true } : {}),
    }
  }

  throw new Error(`Usage\n${usage()}`)
}

export function inferAgentNameFromRemote(remote: string): string {
  // Remove trailing slash
  let name = remote.replace(/\/+$/, "")
  // Handle SSH URLs (git@host:user/repo) — extract after last / or :
  const lastSlash = name.lastIndexOf("/")
  const lastColon = name.lastIndexOf(":")
  const lastSep = Math.max(lastSlash, lastColon)
  if (lastSep !== -1) {
    name = name.slice(lastSep + 1)
  }
  // Strip .git suffix
  name = name.replace(/\.git$/, "")
  // Strip .ouro suffix
  name = name.replace(/\.ouro$/, "")
  return name
}

function parseCloneCommand(args: string[]): OuroCliCommand {
  let remote: string | undefined
  let agent: string | undefined

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i]
      continue
    }
    if (!remote) {
      remote = args[i]
    }
  }

  if (!remote) {
    throw new Error("clone requires a remote URL.\nUsage: ouro clone <remote> [--agent <name>]")
  }

  return agent
    ? { kind: "clone", remote, agent }
    : { kind: "clone", remote }
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
  if (args.includes("--agent") && !agent) throw new Error("setup requires --agent <name>")
  if (!tool) throw new Error("setup requires --tool (claude-code | codex)")
  if (tool !== "claude-code" && tool !== "codex") throw new Error(`Unknown tool: ${tool}. Supported: claude-code, codex`)
  return { kind: "setup", tool, ...(agent ? { agent } : {}) }
}

function parseBlueBubblesCommand(args: string[]): OuroCliCommand {
  const subcommand = args[0]
  if (subcommand !== "replay") {
    throw new Error(`Usage\n${usage()}`)
  }

  let agent: string | undefined
  let messageGuid: string | undefined
  let eventType: "new-message" | "updated-message" = "new-message"
  let json = false

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--agent" && args[i + 1]) {
      agent = args[++i]
      continue
    }
    if (args[i] === "--message-guid" && args[i + 1]) {
      messageGuid = args[++i]
      continue
    }
    if (args[i] === "--event-type" && args[i + 1]) {
      const candidate = args[++i]
      if (candidate !== "new-message" && candidate !== "updated-message") {
        throw new Error("bluebubbles replay --event-type must be new-message or updated-message")
      }
      eventType = candidate
      continue
    }
    if (args[i] === "--json") {
      json = true
      continue
    }
  }

  if (!messageGuid) throw new Error("bluebubbles replay requires --message-guid <guid>")
  return {
    kind: "bluebubbles.replay",
    ...(agent ? { agent } : {}),
    messageGuid,
    eventType,
    ...(json ? { json: true } : {}),
  }
}

// ── Main dispatch ──

export function parseOuroCommand(args: string[]): OuroCliCommand {
  const [head, second] = args
  if (!head) return { kind: "daemon.up" }

  // ── help command ──
  if (head === "help") {
    const command = helpCommandName(args.slice(1))
    return command ? { kind: "help", command } : { kind: "help" }
  }

  // ── per-command --help ──
  if (args.includes("--help") || args.includes("-h")) {
    const command = helpCommandName(args)
    return command ? { kind: "help", command } : { kind: "help" }
  }

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
  if (head === "up") {
    const noRepair = args.includes("--no-repair")
    return noRepair ? { kind: "daemon.up", noRepair: true } : { kind: "daemon.up" }
  }
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
  if (head === "status") {
    const { agent, rest } = extractAgentFlag(args.slice(1))
    const json = rest.includes("--json")
    const unknown = rest.filter((token) => token !== "--json")
    if (agent) {
      if (unknown.length > 0 || json) throw new Error("Usage: ouro status [--json] OR ouro status --agent <name>")
      return { kind: "provider.status", agent }
    }
    if (unknown.length > 0) throw new Error("Usage: ouro status [--json] OR ouro status --agent <name>")
    return { kind: "daemon.status", ...(json ? { json: true } : {}) }
  }
  if (head === "use") return parseProviderUseCommand(args.slice(1))
  if (head === "check") return parseProviderCheckCommand(args.slice(1))
  if (head === "repair") {
    const { agent, rest } = extractAgentFlag(args.slice(1))
    if (rest.length > 0) throw new Error("Usage: ouro repair [--agent <name>]")
    return agent ? { kind: "repair", agent } : { kind: "repair" }
  }
  if (head === "provider") return parseProviderCommand(args.slice(1))
  if (head === "mail") return parseMailCommand(args.slice(1))
  if (head === "dns") return parseDnsCommand(args.slice(1))
  if (head === "logs") {
    if (second === "prune") return { kind: "daemon.logs.prune" }
    return { kind: "daemon.logs" }
  }
  if (head === "mailbox" || head === "outlook") return { kind: "mailbox", ...(args.includes("--json") ? { json: true } : {}) }
  if (head === "hatch") return parseHatchCommand(args.slice(1))
  if (head === "auth") return parseAuthCommand(args.slice(1))
  if (head === "account") return parseAccountCommand(args.slice(1))
  if (head === "connect") return parseConnectCommand(args.slice(1))
  if (head === "vault") return parseVaultCommand(args.slice(1))
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
    if (!second) return { kind: "chat.connect", agent: "" }
    return { kind: "chat.connect", agent: second }
  }
  if (head === "msg") return parseMessageCommand(args.slice(1))
  if (head === "poke") return parsePokeCommand(args.slice(1))
  if (head === "link") return parseLinkCommand(args.slice(1))
  if (head === "mcp-serve") return parseMcpServeCommand(args.slice(1))
  if (head === "setup") return parseSetupCommand(args.slice(1))
  if (head === "clone") return parseCloneCommand(args.slice(1))
  if (head === "doctor") {
    const tail = args.slice(1)
    const json = tail.includes("--json")
    const hasCategoryFlag = tail.includes("--category")
    const hasStrictFlag = tail.includes("--strict")
    let category: string | undefined
    let strict = false
    for (let i = 0; i < tail.length; i++) {
      if (tail[i] === "--category" && typeof tail[i + 1] === "string") {
        category = tail[i + 1]
      } else if (tail[i] === "--strict") {
        strict = true
      }
    }
    const command: Extract<OuroCliCommand, { kind: "doctor" }> = { kind: "doctor" }
    if (category !== undefined) command.category = category
    if (strict) command.strict = true
    // --json default is only emitted for "plain" doctor invocations.
    // CI variants (--strict, --category) omit it; consumers go through doctorResult directly.
    if (!hasCategoryFlag && !hasStrictFlag) command.json = json
    return command
  }
  if (head === "bluebubbles") return parseBlueBubblesCommand(args.slice(1))

  const suggestion = suggestCommand(head)
  const hint = suggestion ? ` Did you mean '${suggestion}'?` : ""
  throw new Error(`Unknown command '${args.join(" ")}'.${hint}\n${usage()}`)
}
