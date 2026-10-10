import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * The code floor under every answer the cmux sense might give a coding agent's permission prompt.
 * It is an allowlist over cmux Feed's structured fields (`tool_name`, `tool_input`, `cwd`), never
 * screen prose, and its default is to escalate to the human.
 *
 * - `allow`: on the allowlist (an in-repo edit, or a read-only or test command after parsing).
 * - `soft`: not on the allowlist but not hazardous either. Only an exact precedent the human set can
 *   answer it; otherwise it escalates.
 * - `hard`: hazardous or unparseable. Nothing answers it: not precedent, not a model.
 */
export type FloorVerdict =
  | { verdict: "allow" | "soft"; reason: string; shape: CaseShape }
  | { verdict: "hard"; reason: string }

/** What a precedent must match exactly: the repository, the tool, and every command token or the repo-relative path. */
export interface CaseShape {
  repoRoot: string
  tool: string
  tokens: string[]
}

export interface FloorInput {
  kind: string
  source: string
  toolName: string | null
  toolInput: string | null
  toolInputTruncated: boolean
  cwd: string | null
}

export interface FloorFs {
  exists: (target: string) => boolean
  realpath: (target: string) => string
}

const realFs: FloorFs = { exists: (target) => fs.existsSync(target), realpath: (target) => fs.realpathSync(target) }

const MAX_COMMAND_CHARS = 2_000
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"])
/** Characters that make a command more than one simple command, or let it expand, redirect or substitute. */
const SHELL_CONTROL = /[\n\r;&|`$<>(){}\\!#]/
const PROTECTED_SEGMENTS = new Set([".git", ".claude", ".github", ".husky", ".vscode", ".idea"])
const PROTECTED_NAMES = new Set([
  "package.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".mcp.json", ".gitmodules", ".gitattributes", ".gitconfig",
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".envrc",
  "claude.md", "agents.md", "copilot-instructions.md",
])

/** Protected paths that can hold credentials (a token in a remote URL, an auth line): even reading them escalates. */
const CREDENTIAL_TOUCHES = new Set(["touches an environment file", "touches .git", "touches .npmrc", "touches .yarnrc", "touches .yarnrc.yml", "touches .gitconfig", "touches .envrc", "touches .claude"])

const HARD_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "dd", "mkfs", "diskutil", "chmod", "chown", "chgrp", "chflags", "xattr",
  "sudo", "su", "doas", "kill", "killall", "pkill", "launchctl", "shutdown", "reboot", "halt", "crontab", "defaults", "security",
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "open", "gh", "az", "aws", "gcloud", "kubectl", "terraform", "docker", "fly", "vercel", "heroku",
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "eval", "exec", "source", ".", "env", "xargs", "nohup", "time", "timeout", "nice", "caffeinate", "watch", "command", "builtin", "script", "expect", "osascript", "at", "batch",
  "npx", "pnpx", "bunx", "ouro", "cmux", "claude", "codex", "copilot", "tee", "truncate", "mv", "cp", "ln", "install", "base64", "openssl", "gpg",
])
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "deno", "bun", "lua", "tclsh", "rscript", "swift", "awk", "gawk", "sed", "jq"])
const INTERPRETER_CODE_FLAGS = new Set(["-c", "-e", "--eval", "-p", "--print", "-i", "--in-place", "-f", "-r", "-x"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "brew", "gem", "cargo", "go", "uv", "poetry", "composer", "swift"])
const PACKAGE_HARD_VERBS = new Set(["install", "i", "ci", "add", "uninstall", "remove", "rm", "un", "publish", "unpublish", "update", "upgrade", "up", "link", "unlink", "exec", "dlx", "x", "create", "init", "login", "logout", "adduser", "token", "owner", "dist-tag", "deprecate", "config", "set", "get", "cache", "prune", "dedupe", "rebuild", "tap", "untap", "services", "run-script", "explore", "edit", "fund", "audit", "version", "pack", "global", "tool", "self"])
const GIT_HARD_SUBCOMMANDS = new Set([
  "push", "reset", "clean", "checkout", "switch", "restore", "rebase", "merge", "rm", "mv", "filter-branch", "filter-repo", "gc", "prune", "reflog", "update-ref", "update-index", "symbolic-ref",
  "tag", "stash", "worktree", "remote", "config", "fetch", "pull", "clone", "submodule", "am", "apply", "cherry-pick", "revert", "commit", "notes", "replace", "bisect", "hook", "credential", "send-email", "daemon", "archive", "bundle", "lfs", "init",
])
const HARD_OPTION_PREFIXES = ["--output", "--pre", "--ext-diff", "--exec", "--upload-pack", "--receive-pack", "--config", "--git-dir", "--work-tree", "--namespace", "--global", "--system", "--force", "--delete", "--hard", "--mirror", "--fix"]
const FIND_HARD = new Set(["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"])

const READ_ONLY_COMMANDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "file", "stat", "diff", "which", "echo", "tree", "du", "less", "true", "date"])
const GIT_READ_ONLY = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "grep", "branch", "cat-file", "ls-tree", "merge-base", "rev-list", "name-rev"])
const GIT_BRANCH_LIST_FLAGS = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--list", "--show-current", "--merged", "--no-merged", "--contains", "--no-color", "--color"])
const TEST_COMMANDS: string[][] = [
  ["npm", "test"], ["npm", "run", "test"], ["npm", "run", "lint"], ["npm", "run", "typecheck"],
  ["swift", "test"], ["swift", "build"], ["cargo", "test"], ["cargo", "check"], ["go", "test"], ["go", "vet"],
]

function hard(reason: string): FloorVerdict {
  return { verdict: "hard", reason }
}

function parseObject(text: string | null): Record<string, unknown> | null {
  if (text === null) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** The nearest ancestor of `cwd` (after resolving symlinks) that holds a `.git` entry. */
export function findRepoRoot(cwd: string, fsx: FloorFs = realFs): string | null {
  if (!path.isAbsolute(cwd) || !fsx.exists(cwd)) return null
  let dir = fsx.realpath(cwd)
  for (;;) {
    if (fsx.exists(path.join(dir, ".git"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * The repo-relative path of `target` after resolving `..` and every symlink on the part of the path
 * that exists, or null when it lands outside the repository. A `~` path is never resolved.
 */
export function resolveInsideRepo(repoRoot: string, cwd: string, target: string, fsx: FloorFs = realFs): string | null {
  if (target.startsWith("~")) return null
  const absolute = path.resolve(cwd, target)
  let existing = absolute
  const rest: string[] = []
  while (!fsx.exists(existing)) {
    rest.unshift(path.basename(existing))
    existing = path.dirname(existing)
  }
  const resolved = path.join(fsx.realpath(existing), ...rest)
  if (resolved === repoRoot) return "."
  if (!resolved.startsWith(`${repoRoot}${path.sep}`)) return null
  return path.relative(repoRoot, resolved)
}

function protectedPath(relative: string): string | null {
  const segments = relative.split(path.sep).map((segment) => segment.toLowerCase())
  const protectedSegment = segments.find((segment) => PROTECTED_SEGMENTS.has(segment))
  if (protectedSegment) return `touches ${protectedSegment}`
  const name = segments[segments.length - 1]!
  if (PROTECTED_NAMES.has(name)) return `touches ${name}`
  if (name.startsWith(".env")) return "touches an environment file"
  return null
}

/** Shell words for a single simple command, or null when quoting is unbalanced. Escapes and expansions are refused earlier. */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: string | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === "'" || char === "\"") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) tokens.push(current)
      current = ""
      started = false
      continue
    }
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return tokens
}

function bashVerdict(command: unknown, repoRoot: string, cwd: string, fsx: FloorFs): FloorVerdict {
  if (typeof command !== "string" || !command.trim()) return hard("no command to judge")
  if (command.length > MAX_COMMAND_CHARS) return hard("command is too long to judge")
  if (SHELL_CONTROL.test(command)) return hard("command chains, pipes, redirects, substitutes or expands")
  const tokens = tokenizeCommand(command)
  if (!tokens || tokens.length === 0) return hard("command quoting does not parse")
  const [program, ...args] = tokens as [string, ...string[]]
  const name = program.toLowerCase()
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return hard("command sets environment variables")
  if (HARD_COMMANDS.has(name)) return hard(`${name} is never answered for the human`)
  if (INTERPRETERS.has(name) || /^python\d/.test(name)) {
    if (args.some((arg) => INTERPRETER_CODE_FLAGS.has(arg) || /^-[A-Za-z]*[ce]$/.test(arg))) return hard(`${name} runs inline code`)
  }
  if (PACKAGE_MANAGERS.has(name) && args.some((arg) => PACKAGE_HARD_VERBS.has(arg.toLowerCase()))) return hard(`${name} would change installed packages or publish`)
  let touches: string | null = null
  for (const arg of args) {
    const lower = arg.toLowerCase()
    if (HARD_OPTION_PREFIXES.some((prefix) => lower.startsWith(prefix))) return hard(`${arg.split("=")[0]} is never answered for the human`)
    if (name === "git" && /^-[a-zA-Z]*f[a-zA-Z]*$/.test(arg)) return hard("git force option")
    const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg
    const relative = resolveInsideRepo(repoRoot, cwd, value, fsx)
    // Every word is treated as a possible path: a plain word can name a symlink that leaves the repository.
    if (relative === null) return hard("command reaches outside the repository")
    if (!arg.startsWith("-")) touches ??= protectedPath(relative)
  }
  if (touches && CREDENTIAL_TOUCHES.has(touches)) return hard(`command ${touches}`)
  if (name === "find" && args.some((arg) => FIND_HARD.has(arg))) return hard("find would run, delete or write")
  if (name === "git") {
    const subcommand = args[0]
    if (!subcommand || subcommand.startsWith("-")) return hard("git global options are never answered for the human")
    if (GIT_HARD_SUBCOMMANDS.has(subcommand)) return hard(`git ${subcommand} changes or shares repository state`)
    if (subcommand === "branch" && !args.slice(1).every((arg) => GIT_BRANCH_LIST_FLAGS.has(arg))) return hard("git branch would create, move or delete a branch")
  }
  const shape: CaseShape = { repoRoot, tool: "Bash", tokens }
  const soft = (reason: string): FloorVerdict => touches ? hard(`command ${touches}`) : { verdict: "soft", reason, shape }
  if (program.includes("/")) return soft("runs a program by path")
  if (READ_ONLY_COMMANDS.has(name)) return { verdict: "allow", reason: `${name} only reads`, shape }
  if (name === "git" && GIT_READ_ONLY.has(args[0]!)) return { verdict: "allow", reason: `git ${args[0]} only reads`, shape }
  if (TEST_COMMANDS.some((entry) => entry.length === tokens.length && entry.every((token, index) => token === tokens[index]))) return { verdict: "allow", reason: "runs the repository's own checks", shape }
  return soft(`${name} is not on the allowlist`)
}

function pathVerdict(tool: string, input: Record<string, unknown>, repoRoot: string, cwd: string, fsx: FloorFs): FloorVerdict {
  const raw = input.file_path ?? input.notebook_path ?? input.path ?? (READ_TOOLS.has(tool) ? cwd : undefined)
  if (typeof raw !== "string" || !raw.trim()) return hard(`${tool} names no path`)
  const relative = resolveInsideRepo(repoRoot, cwd, raw, fsx)
  if (relative === null) return hard(`${tool} reaches outside the repository`)
  const blocked = protectedPath(relative)
  if (blocked && (EDIT_TOOLS.has(tool) || CREDENTIAL_TOUCHES.has(blocked))) return hard(`${tool} ${blocked}`)
  return { verdict: "allow", reason: EDIT_TOOLS.has(tool) ? `${tool} inside the repository` : `${tool} only reads inside the repository`, shape: { repoRoot, tool, tokens: [relative] } }
}

export function evaluateFloor(item: FloorInput, fsx: FloorFs = realFs): FloorVerdict {
  const verdict = judge(item, fsx)
  emitNervesEvent({ component: "senses", event: "senses.cmux_floor_judged", message: "judged a cmux Feed item against the floor", meta: { tool: item.toolName, verdict: verdict.verdict, reason: verdict.reason } })
  return verdict
}

function judge(item: FloorInput, fsx: FloorFs): FloorVerdict {
  if (item.kind !== "permissionRequest") return hard("questions and plan approvals always go to the human")
  if (item.source !== "claude") return hard(`${item.source} sessions are observe-only`)
  if (item.toolInputTruncated) return hard("the request was truncated")
  const tool = item.toolName
  if (!tool) return hard("the request names no tool")
  if (tool.startsWith("mcp__")) return hard("MCP tools always go to the human")
  if (!item.cwd) return hard("the request has no working directory")
  const repoRoot = findRepoRoot(item.cwd, fsx)
  if (!repoRoot) return hard("the working directory is not inside a repository")
  const cwd = fsx.realpath(item.cwd)
  const input = parseObject(item.toolInput)
  if (!input) return hard("the request input is not readable")
  if (tool === "Bash") return bashVerdict(input.command, repoRoot, cwd, fsx)
  if (EDIT_TOOLS.has(tool) || READ_TOOLS.has(tool)) return pathVerdict(tool, input, repoRoot, cwd, fsx)
  return hard(`${tool} always goes to the human`)
}
