import * as fs from "node:fs"
import * as os from "node:os"
import { isTrustedLevel, type TrustLevel } from "../mind/friends/types"
import { emitNervesEvent } from "../nerves/runtime"

export interface GuardContext {
  readPaths: ReadonlySet<string>
  trustLevel?: TrustLevel
  agentRoot?: string
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

const PROTECTED_PATH_SEGMENTS = [".git/"]

function getProtectedAbsolutePrefixes(): string[] {
  return [`${os.homedir()}/.agentsecrets/`]
}

function isProtectedPath(filePath: string): boolean {
  for (const segment of PROTECTED_PATH_SEGMENTS) {
    if (filePath.includes(`/${segment}`) || filePath.startsWith(segment)) return true
  }
  for (const prefix of getProtectedAbsolutePrefixes()) {
    if (filePath.startsWith(prefix)) return true
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
  "task board": "friend",
  "task create": "friend",
  "task update": "friend",
  "task show": "friend",
  "task actionable": "friend",
  "task deps": "friend",
  "task sessions": "friend",
  "friend list": "friend",
  "friend show": "friend",
  "friend create": "friend",
  "friend update": "family",
  "reminder create": "friend",
  "config model": "friend",
  "config models": "friend",
  "mcp list": "acquaintance",
  "mcp call": "friend",
  auth: "family",
  "auth verify": "family",
  "auth switch": "family",
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

function checkTrustLevelGuardrails(toolName: string, args: Record<string, string>, context: GuardContext): GuardResult {
  // Trusted levels (family/friend) — no trust guardrails. Undefined defaults to friend.
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
