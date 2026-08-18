import * as fs from "node:fs"
import * as path from "node:path"
import { isTrustedLevel, type TrustLevel } from "@ouro.bot/friends"
import { parse as parseShell, type ControlOperator } from "shell-quote"
import { emitNervesEvent } from "../nerves/runtime"
import { validateCommerceAuthority } from "../commerce/store"

export interface GuardContext {
  readPaths: ReadonlySet<string>
  trustLevel?: TrustLevel
  agentRoot?: string
  friendId?: string
  senseType?: string
  isGroupChat?: boolean
  /** For first-class MCP tools: the server this tool belongs to. */
  mcpServerName?: string
}

export type GuardResult = { allowed: true } | { allowed: false; reason: string }

const deny = (reason: string): GuardResult => ({ allowed: false, reason })
const allow: GuardResult = { allowed: true }

// --- reason templates ---
// Structural reasons (always-on, apply to everyone)
const REASONS = {
  readBeforeEdit: "i need to read that file first before i can edit it.",
  readBeforeOverwrite: "i need to read that file first before i can overwrite it.",
  protectedPath: "that path is protected — i can read it but not modify it.",
  destructiveCommand: "that command is too dangerous to run — it could cause irreversible damage.",
  // Trust reasons (vary by relationship)
  needsTrust: "i'd need a closer friend to vouch for you before i can do that.",
  needsTrustForWrite: "i'd need a closer friend to vouch for you before i can write files outside my home.",
} as const

// --- read-only tools that never need guardrails ---

const READ_ONLY_TOOLS = new Set(["read_file", "glob", "grep"])

// --- protected path detection ---

const PROTECTED_PATH_SEGMENTS = [
  ".git/",
  ".ouro-cli/vault-unlock/",
  ".ouro-cli/vault-unlock-dpapi/",
]
const PROTECTED_FILENAMES = ["agent.json"]

function isProtectedPath(filePath: string): boolean {
  for (const segment of PROTECTED_PATH_SEGMENTS) {
    if (filePath.includes(`/${segment}`) || filePath.startsWith(segment)) return true
  }
  for (const name of PROTECTED_FILENAMES) {
    if (path.basename(filePath) === name) return true
  }
  return false
}

// --- destructive shell patterns ---

const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-\w*\s+)*-\w*r\w*\s+(-\w+\s+)*[/~]/,      // rm -rf / or rm -rf ~
  /\bchmod\s+(-\w*\s+)*-\w*R\w*\s+\d+\s+\//,           // chmod -R 777 /
  /\bmkfs\b/,                                             // mkfs.*
  /\bdd\s+if=/,                                           // dd if=
]

function isDestructiveShellCommand(command: string): boolean {
  return DESTRUCTIVE_PATTERNS.some((p) => p.test(command))
}

// --- compound command splitting ---
// Shell operators that chain commands: &&, ||, ;, |, $(), backticks
const COMPOUND_SEPARATORS = /\s*(?:&&|\|\||;|\|)\s*/
const SUBSHELL_PATTERN = /\$\(|`/

function splitShellCommands(command: string): string[] {
  if (SUBSHELL_PATTERN.test(command)) return [command]
  return command.split(COMPOUND_SEPARATORS).filter(Boolean)
}

// --- shell commands that write to protected paths ---

function shellWritesToProtectedPath(command: string): boolean {
  const redirectMatch = command.match(/>\s*(\S+)/)
  if (redirectMatch && isProtectedPath(redirectMatch[1])) return true

  const teeMatch = command.match(/tee\s+(?:-\w+\s+)*(\S+)/)
  if (teeMatch && isProtectedPath(teeMatch[1])) return true

  return false
}

// --- structural guardrail checks (always on, all trust levels) ---

function checkReadBeforeWrite(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  if (toolName === "edit_file") {
    const filePath = args.path || ""
    if (!context.readPaths.has(filePath)) return deny(REASONS.readBeforeEdit)
  }

  if (toolName === "write_file") {
    const filePath = args.path || ""
    if (context.readPaths.has(filePath)) return allow
    if (!fs.existsSync(filePath)) return allow
    return deny(REASONS.readBeforeOverwrite)
  }

  return allow
}

function checkDestructiveShellPatterns(toolName: string, args: Record<string, string>): GuardResult {
  if (toolName !== "shell") return allow
  const command = args.command || ""
  // Check each subcommand in compound commands for destructive patterns
  for (const sub of splitShellCommands(command)) {
    if (isDestructiveShellCommand(sub)) return deny(REASONS.destructiveCommand)
  }
  return allow
}

function checkProtectedPaths(toolName: string, args: Record<string, string>): GuardResult {
  if (toolName === "write_file" || toolName === "edit_file") {
    const filePath = args.path || ""
    if (isProtectedPath(filePath)) return deny(REASONS.protectedPath)
  }

  if (toolName === "shell") {
    const command = args.command || ""
    if (shellWritesToProtectedPath(command)) return deny(REASONS.protectedPath)
  }

  return allow
}

function checkStructuralGuardrails(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  const protectedResult = checkProtectedPaths(toolName, args)
  if (!protectedResult.allowed) return protectedResult

  const destructiveResult = checkDestructiveShellPatterns(toolName, args)
  if (!destructiveResult.allowed) return destructiveResult

  return checkReadBeforeWrite(toolName, args, context)
}

// --- ouro CLI trust manifest ---

/** Minimum trust level required for each ouro CLI subcommand. */
export const OURO_CLI_TRUST_MANIFEST: Record<string, TrustLevel> = {
  whoami: "acquaintance",
  changelog: "acquaintance",
  "session list": "acquaintance",
  "friend list": "friend",
  "friend show": "friend",
  "friend create": "friend",
  "friend update": "family",
  "config model": "friend",
  "config models": "friend",
  "mcp list": "acquaintance",
  "mcp call": "friend",
  auth: "family",
  "auth verify": "family",
  "auth switch": "family",
  rollback: "family",
  versions: "acquaintance",
}

// --- trust level comparison ---

const LEVEL_ORDER: Record<TrustLevel, number> = {
  stranger: 0,
  acquaintance: 1,
  friend: 2,
  family: 3,
}

function trustLevelSatisfied(required: TrustLevel, actual: TrustLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[required]
}

// --- general CLI allowlists for acquaintance ---

const ACQUAINTANCE_SHELL_ALLOWLIST = new Set([
  "cat", "ls", "head", "tail", "wc", "file", "stat", "which", "echo",
  "pwd", "env", "printenv", "whoami", "date", "uname",
])

const ACQUAINTANCE_GIT_ALLOWLIST = new Set([
  "status", "log", "show", "diff", "branch",
])

// --- trust-level shell guardrails ---

function resolveOuroSubcommand(command: string): string | null {
  const afterOuro = command.replace(/^ouro\s+/, "").trim()
  /* v8 ignore next -- bare "ouro" is caught upstream by checkShellTrustGuardrails @preserve */
  if (!afterOuro) return null

  const tokens = afterOuro.split(/\s+/)
  const twoWord = tokens.length >= 2 ? `${tokens[0]} ${tokens[1]}` : null

  // Two-word match first (e.g. "task board"), then one-word (e.g. "whoami")
  if (twoWord && OURO_CLI_TRUST_MANIFEST[twoWord]) return twoWord
  if (OURO_CLI_TRUST_MANIFEST[tokens[0]]) return tokens[0]
  return null
}

// --- MCP server-specific trust rules ---

const MCP_SERVER_TRUST: Record<string, {
  minTrust: TrustLevel
  blockGroupChat: boolean
}> = {
  browser: { minTrust: "friend", blockGroupChat: true },
}

function checkMcpServerTrust(command: string, context: GuardContext): GuardResult {
  const match = command.match(/^ouro\s+mcp\s+call\s+(\S+)/)
  if (!match) return allow
  const serverName = match[1]
  const rules = MCP_SERVER_TRUST[serverName]
  if (!rules) return allow // no special rules for this server

  if (!trustLevelSatisfied(rules.minTrust, context.trustLevel ?? "friend")) {
    return deny(REASONS.needsTrust)
  }
  if (rules.blockGroupChat && context.isGroupChat) {
    return deny("browser tools are only available in 1:1 conversations, not group chats.")
  }
  return allow
}

function checkSingleShellCommandTrust(command: string, trustLevel: TrustLevel): GuardResult {
  const trimmed = command.trim()
  const tokens = trimmed.split(/\s+/)
  const firstToken = tokens[0] || ""

  // ouro CLI — check per-subcommand trust manifest
  if (firstToken === "ouro") {
    const subcommand = resolveOuroSubcommand(trimmed)
    const requiredLevel = subcommand ? OURO_CLI_TRUST_MANIFEST[subcommand] : "friend"
    if (trustLevelSatisfied(requiredLevel as TrustLevel, trustLevel)) return allow
    return deny(REASONS.needsTrust)
  }

  // git — check subcommand allowlist
  if (firstToken === "git") {
    const gitSub = tokens[1] || ""
    if (ACQUAINTANCE_GIT_ALLOWLIST.has(gitSub)) return allow
    return deny(REASONS.needsTrust)
  }

  // General CLI — check allowlist
  if (ACQUAINTANCE_SHELL_ALLOWLIST.has(firstToken)) return allow

  return deny(REASONS.needsTrust)
}

function checkShellTrustGuardrails(command: string, trustLevel: TrustLevel): GuardResult {
  // Subshell patterns ($(), backticks) can't be reliably split — check as single command
  /* v8 ignore next -- subshell branch: tested via guardrails.test.ts @preserve */
  if (SUBSHELL_PATTERN.test(command)) {
    return checkSingleShellCommandTrust(command, trustLevel)
  }

  // Compound commands: check each subcommand individually
  const subcommands = splitShellCommands(command)
  if (subcommands.length === 0) return checkSingleShellCommandTrust(command, trustLevel)
  for (const sub of subcommands) {
    const result = checkSingleShellCommandTrust(sub, trustLevel)
    if (!result.allowed) return result
  }
  return allow
}

function checkWriteTrustGuardrails(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  if (toolName !== "write_file" && toolName !== "edit_file") return allow
  const filePath = args.path || ""
  if (context.agentRoot && filePath.startsWith(context.agentRoot)) return allow
  if (!context.agentRoot) return allow
  return deny(REASONS.needsTrustForWrite)
}

// --- credential tool trust gating ---

// Credential write tools: family only
const CREDENTIAL_FAMILY_TOOLS = new Set([
  "credential_generate_password", "credential_store", "credential_delete", "vault_setup",
  // User profile tools: family only
  "user_profile_store", "user_profile_get", "user_profile_delete",
  // Payment tools: family only
  "stripe_create_card", "stripe_deactivate_card", "stripe_list_cards",
  // Booking tools that involve payment: family only
  "flight_book", "flight_hold", "flight_cancel",
])
// Credential read tools: friend+
const CREDENTIAL_TRUSTED_TOOLS = new Set(["credential_get", "credential_list"])

// Travel tools: friend+ (weather_lookup accesses vault credentials indirectly;
// advisory and geocode are public APIs but gated for consistency)
// Flight search is also friend+ (read-only, no payment)
const TRAVEL_TRUSTED_TOOLS = new Set(["weather_lookup", "travel_advisory", "geocode_search", "flight_search"])
const A2A_TRUSTED_TOOLS = new Set(["a2a_list_peers", "a2a_send_message", "a2a_get_task"])
const COMMERCE_FAMILY_TOOLS = new Set(["commerce_checkout_preview", "commerce_checkout_commit", "commerce_receipt_get", "commerce_access_log"])
const COMMERCE_AUTHORITY_TOOLS = new Set(["stripe_create_card", "flight_hold", "flight_book"])
const MAIL_FAMILY_TOOLS = new Set(["mail_screener", "mail_decide", "mail_access_log", "mail_send", "mail_index_refresh"])
const MAIL_DELEGATED_READ_TOOLS = new Set(["mail_recent", "mail_search"])

type AnsiShellAtom = string | null

function opaqueAnsiShellAtoms(command: string): AnsiShellAtom[] {
  const atoms: AnsiShellAtom[] = []
  let inAnsiQuote = false
  for (let index = 0; index < command.length;) {
    if (!inAnsiQuote && command.startsWith("$'", index)) {
      inAnsiQuote = true
      index += 2
      continue
    }
    const character = command[index]!
    if (inAnsiQuote && character === "'") {
      inAnsiQuote = false
      index += 1
      continue
    }
    if (inAnsiQuote && character === "\\") {
      const escape = command.slice(index).match(/^\\(?:x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|U[0-9a-fA-F]{1,8}|[0-7]{1,3}|c.|.)?/s)![0]
      atoms.push(null)
      index += escape.length
      continue
    }
    if (!inAnsiQuote && (character === "'" || character === '"')) {
      index += 1
      continue
    }
    if (!inAnsiQuote && character === "\\" && index + 1 < command.length) {
      atoms.push(command[index + 1]!)
      index += 2
      continue
    }
    atoms.push(character)
    index += 1
  }
  return atoms
}

function shellContainsAmbiguousAnsiMailCacheSync(command: string): boolean {
  if (!command.includes("$'")) return false
  const expected = ["ouro", "mail", "sync-cache"]
  let states = new Set(["0:0"])

  const crossTokenBoundary = (current: ReadonlySet<string>): { matched: boolean; states: Set<string> } => {
    const next = new Set(["0:0"])
    for (const state of current) {
      const [tokenIndex, characterIndex] = state.split(":").map(Number)
      if (characterIndex !== expected[tokenIndex]!.length) continue
      if (tokenIndex === expected.length - 1) return { matched: true, states: next }
      next.add(`${tokenIndex + 1}:0`)
    }
    return { matched: false, states: next }
  }

  for (const atom of opaqueAnsiShellAtoms(command)) {
    if (atom === null) {
      const next = new Set(states)
      for (const state of states) {
        const [tokenIndex, characterIndex] = state.split(":").map(Number)
        if (characterIndex >= 0 && characterIndex < expected[tokenIndex]!.length) {
          next.add(`${tokenIndex}:${characterIndex + 1}`)
        }
      }
      const boundary = crossTokenBoundary(states)
      if (boundary.matched) return true
      states = new Set([...next, ...boundary.states])
      continue
    }
    if (/\s|[;&|()`]/.test(atom)) {
      const boundary = crossTokenBoundary(states)
      if (boundary.matched) return true
      states = boundary.states
      continue
    }
    const next = new Set<string>()
    for (const state of states) {
      const [tokenIndex, characterIndex] = state.split(":").map(Number)
      const wanted = expected[tokenIndex]?.[characterIndex]
      next.add(wanted?.toLowerCase() === atom.toLowerCase() ? `${tokenIndex}:${characterIndex + 1}` : `${tokenIndex}:-1`)
    }
    states = next
  }
  return crossTokenBoundary(states).matched
}

const SHELL_COMMAND_BOUNDARIES = new Set<ControlOperator["op"]>(["||", "&&", ";;", "|&", "&", ";", "(", ")", "|", "<("])
const SHELL_COMMAND_WRAPPERS = new Set(["command", "env", "exec", "nohup"])
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh"])
const SHELL_PARAMETER_MARKER = "__OURO_SHELL_PARAMETER_"

interface ParsedShellCommand {
  commands: string[][]
  parameterNames: ReadonlyMap<string, string>
}

function parseShellCommands(command: string): ParsedShellCommand {
  let parameterIndex = 0
  const parameterNames = new Map<string, string>()
  const entries = parseShell<string>(command.replace(/\r?\n|`/g, " ; "), (name) => {
    const marker = `${SHELL_PARAMETER_MARKER}${parameterIndex}__`
    parameterIndex += 1
    parameterNames.set(marker, name)
    return marker
  })
  const commands: string[][] = []
  let current: string[] = []
  let skipRedirectionTarget = false
  const flush = () => {
    if (current.length > 0) commands.push(current)
    current = []
    skipRedirectionTarget = false
  }
  for (const entry of entries) {
    if (typeof entry === "string") {
      if (skipRedirectionTarget) skipRedirectionTarget = false
      else current.push(entry)
      continue
    }
    if ("comment" in entry) break
    if (entry.op === "glob") {
      current.push(entry.pattern)
      continue
    }
    if (SHELL_COMMAND_BOUNDARIES.has(entry.op)) {
      flush()
      continue
    }
    // Every remaining control operator is a redirection. Its next string is
    // a path or descriptor, not an argv token.
    skipRedirectionTarget = true
  }
  flush()
  return { commands, parameterNames }
}

function resolveKnownShellParameters(
  token: string,
  knownVariables: ReadonlyMap<string, string>,
  parameterNames: ReadonlyMap<string, string>,
): string {
  let resolved = token
  for (const [marker, name] of parameterNames) {
    const known = knownVariables.get(name)
    if (known !== undefined) resolved = resolved.replaceAll(marker, known)
  }
  return resolved
}

function shellTokenCanEqual(token: string, expected: string): boolean {
  const escaped = token
    .split(new RegExp(`${SHELL_PARAMETER_MARKER}\\d+__`, "g"))
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${escaped}$`, "i").test(expected)
}

function shellCommandsContainMailCacheSync(
  command: string,
  inheritedVariables: ReadonlyMap<string, string> = new Map(),
  depth = 0,
): boolean {
  // Recursive wrappers always consume argv, but cap adversarial nesting before
  // it can exhaust the JS stack. An opaque command at the cap fails closed.
  if (depth >= 32) return true
  let parsed: ParsedShellCommand
  try {
    parsed = parseShellCommands(command)
  } catch {
    return false
  }
  const knownVariables = new Map(inheritedVariables)
  for (const rawTokens of parsed.commands) {
    const tokens = rawTokens.map((token) => resolveKnownShellParameters(token, knownVariables, parsed.parameterNames))
    const invocationVariables = new Map(knownVariables)
    let commandIndex = 0
    while (commandIndex < tokens.length) {
      const assignment = tokens[commandIndex]!.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s)
      if (!assignment) break
      if (assignment[2]!.includes(SHELL_PARAMETER_MARKER) || /\s/.test(assignment[2]!)) invocationVariables.delete(assignment[1]!)
      else invocationVariables.set(assignment[1]!, assignment[2]!)
      commandIndex += 1
    }
    if (commandIndex === tokens.length) {
      knownVariables.clear()
      for (const [name, value] of invocationVariables) knownVariables.set(name, value)
      continue
    }
    while (SHELL_COMMAND_WRAPPERS.has(tokens[commandIndex]?.toLowerCase() ?? "")) {
      commandIndex += 1
      while (tokens[commandIndex]?.startsWith("-")) commandIndex += 1
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[commandIndex] ?? "")) commandIndex += 1
    }
    const executable = tokens[commandIndex]?.toLowerCase()
    if (SHELL_INTERPRETERS.has(executable ?? "") && tokens[commandIndex + 1] === "-c") {
      if (shellCommandsContainMailCacheSync(tokens.slice(commandIndex + 2).join(" "), invocationVariables, depth + 1)) return true
      continue
    }
    if (executable === "eval") {
      if (shellCommandsContainMailCacheSync(tokens.slice(commandIndex + 1).join(" "), invocationVariables, depth + 1)) return true
      continue
    }
    const protectedArgv = ["ouro", "mail", "sync-cache"]
    if (protectedArgv.every((expected, offset) => shellTokenCanEqual(tokens[commandIndex + offset] ?? "", expected))) return true
  }
  return false
}

function shellContainsMailCacheSync(command: string): boolean {
  if (shellContainsAmbiguousAnsiMailCacheSync(command)) return true
  return shellCommandsContainMailCacheSync(command)
}

function mailCacheSyncShellGuardrail(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  if (toolName !== "shell" || !shellContainsMailCacheSync(args.command ?? "")) return allow
  if (context.trustLevel === undefined || context.trustLevel === "family") return allow
  return deny("hosted mail cache convergence requires family trust.")
}

function mailTrustGuardrail(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  if (MAIL_FAMILY_TOOLS.has(toolName)) {
    if (context.trustLevel === undefined || context.trustLevel === "family") return allow
    if (toolName === "mail_send") return deny("outbound mail sends require family trust.")
    return deny(toolName === "mail_decide"
      ? "mail screener decisions require family trust."
      : "delegated human mail requires family trust.")
  }
  if (MAIL_DELEGATED_READ_TOOLS.has(toolName)) {
    const scope = (args.scope ?? "").trim().toLowerCase()
    if (scope === "delegated" || scope === "all") {
      if (context.trustLevel === undefined || context.trustLevel === "family") return allow
      return deny("delegated human mail requires family trust.")
    }
  }
  return allow
}

function checkCredentialTrustGuardrails(toolName: string, context: GuardContext): GuardResult {
  if (CREDENTIAL_FAMILY_TOOLS.has(toolName) || COMMERCE_FAMILY_TOOLS.has(toolName)) {
    if (context.trustLevel === "family") return allow
    return deny(REASONS.needsTrust)
  }
  if (CREDENTIAL_TRUSTED_TOOLS.has(toolName) || TRAVEL_TRUSTED_TOOLS.has(toolName) || A2A_TRUSTED_TOOLS.has(toolName)) {
    if (isTrustedLevel(context.trustLevel)) return allow
    return deny(REASONS.needsTrust)
  }
  return allow
}

function checkCommerceAuthorityGuardrails(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  if (!COMMERCE_AUTHORITY_TOOLS.has(toolName)) return allow
  if (!context.agentRoot) return deny("commerce authority unavailable: agent root could not be resolved.")
  const result = validateCommerceAuthority({
    agentRoot: context.agentRoot,
    token: args.commerce_authority,
    toolName,
    args,
    friendId: context.friendId,
  })
  if (result.ok) return allow
  return deny(`commerce authority required: ${result.reason}`)
}

function checkFirstClassMcpTrust(context: GuardContext): GuardResult {
  if (!context.mcpServerName) return allow
  const rules = MCP_SERVER_TRUST[context.mcpServerName] ?? { minTrust: "friend" as TrustLevel, blockGroupChat: false }
  if (!trustLevelSatisfied(rules.minTrust, context.trustLevel ?? "friend")) {
    return deny(REASONS.needsTrust)
  }
  if (rules.blockGroupChat && context.isGroupChat) {
    return deny("browser tools are only available in 1:1 conversations, not group chats.")
  }
  return allow
}

function checkTrustLevelGuardrails(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  const cacheSyncResult = mailCacheSyncShellGuardrail(toolName, args, context)
  if (!cacheSyncResult.allowed) return cacheSyncResult

  const mailResult = mailTrustGuardrail(toolName, args, context)
  if (!mailResult.allowed) return mailResult

  // Credential tools have their own trust rules that apply at all levels
  const credentialResult = checkCredentialTrustGuardrails(toolName, context)
  if (!credentialResult.allowed) return credentialResult

  const commerceAuthorityResult = checkCommerceAuthorityGuardrails(toolName, args, context)
  if (!commerceAuthorityResult.allowed) return commerceAuthorityResult

  // First-class MCP tool trust (e.g. browser_navigate) — applies at all trust levels
  const firstClassMcpResult = checkFirstClassMcpTrust(context)
  if (!firstClassMcpResult.allowed) return firstClassMcpResult

  // MCP server-specific trust via shell (e.g. ouro mcp call browser) — applies at all trust levels
  if (toolName === "shell") {
    const mcpResult = checkMcpServerTrust(args.command || "", context)
    if (!mcpResult.allowed) return mcpResult
  }

  // Trusted levels (family/friend) — no further trust guardrails. Undefined defaults to friend.
  if (isTrustedLevel(context.trustLevel)) return allow

  if (toolName === "shell") {
    return checkShellTrustGuardrails(args.command || "", context.trustLevel!)
  }

  return checkWriteTrustGuardrails(toolName, args, context)
}

// --- main entry point ---

export function guardInvocation(
  toolName: string,
  args: Record<string, string>,
  context: GuardContext,
): GuardResult {
  emitNervesEvent({
    component: "tools",
    event: "tools.guard_check",
    message: "guardrail check",
    meta: { toolName },
  })

  // Read-only tools are always allowed (no structural or trust guardrails)
  if (READ_ONLY_TOOLS.has(toolName)) return allow

  // Layer 1: structural guardrails (always on)
  const structuralResult = checkStructuralGuardrails(toolName, args, context)
  if (!structuralResult.allowed) return structuralResult

  // Layer 2: trust-level guardrails (varies by friend's trust)
  return checkTrustLevelGuardrails(toolName, args, context)
}
