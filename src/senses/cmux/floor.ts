import * as fs from "node:fs"
import * as path from "node:path"
import { emitNervesEvent } from "../../nerves/runtime"

/**
 * The code floor under every answer the cmux sense might give a coding agent's permission prompt.
 * It judges cmux Feed's structured fields (`tool_name`, `tool_input`, `cwd`), never screen prose,
 * and its default is to escalate to the human.
 *
 * - `allow`: an in-repo edit or read, an allowlisted command whose every option is on that
 *   command's own option list, or one of the repository's own check commands.
 * - `soft`: not allowlisted but not hazardous. Only an exact precedent the human set can answer it.
 * - `hard`: hazardous, unknown or unparseable. Nothing answers it: not precedent, not a model.
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
  /** A file's text, or null when it is missing, a directory or unreadable. */
  read: (target: string) => string | null
}

const realFs: FloorFs = {
  exists: (target) => fs.existsSync(target),
  realpath: (target) => fs.realpathSync(target),
  read: (target) => {
    try {
      return fs.readFileSync(target, "utf-8")
    } catch {
      return null
    }
  },
}

const MAX_COMMAND_CHARS = 2_000
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"])
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"])
/** Characters that chain, pipe, redirect, substitute, expand or escape anywhere in the command, quoted or not. */
const SHELL_CONTROL = /[\n\r;&|`$<>(){}\\!#]/
/** Characters the shell expands as a glob when they appear outside quotes. */
const GLOB = /[*?[\]]/
const PROTECTED_SEGMENTS = new Set([".git", ".claude", ".github", ".husky", ".vscode", ".idea"])
const PROTECTED_NAMES = new Set([
  "package.json", ".npmrc", ".yarnrc", ".yarnrc.yml", ".mcp.json", ".gitmodules", ".gitattributes", ".gitconfig",
  ".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".envrc",
  "claude.md", "agents.md", "copilot-instructions.md",
])
/** Protected paths that can hold credentials: even reading them escalates. */
const CREDENTIAL_TOUCHES = new Set(["touches an environment file", "touches .git", "touches .npmrc", "touches .yarnrc", "touches .yarnrc.yml", "touches .gitconfig", "touches .envrc", "touches .claude"])

/** Programs never answered for the human, even with a precedent: they delete, escalate, reach the network, wrap or run other programs. */
const HARD_COMMANDS = new Set([
  "rm", "rmdir", "unlink", "shred", "dd", "mkfs", "diskutil", "chmod", "chown", "chgrp", "chflags", "xattr", "mv", "cp", "ln", "install", "tee", "truncate",
  "sudo", "su", "doas", "kill", "killall", "pkill", "launchctl", "shutdown", "reboot", "halt", "crontab", "defaults", "security", "osascript", "open",
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "nc", "ncat", "netcat", "telnet", "ftp", "socat", "gh", "az", "aws", "gcloud", "kubectl", "terraform", "docker", "fly", "vercel", "heroku",
  "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "eval", "exec", "source", ".", "env", "xargs", "nohup", "time", "timeout", "nice", "caffeinate", "watch", "command", "builtin", "script", "expect", "at", "batch",
  "npx", "pnpx", "bunx", "ouro", "cmux", "claude", "codex", "copilot", "base64", "openssl", "gpg", "date", "less", "more", "vi", "vim", "nano", "emacs",
])
/** Programs that run code they are handed: a precedent may answer them only with no options at all. */
const INTERPRETERS = new Set(["python", "python3", "node", "ruby", "perl", "php", "deno", "lua", "swift", "awk", "gawk", "sed", "jq", "make"])
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun", "pip", "pip3", "pipx", "brew", "gem", "cargo", "go", "uv", "poetry", "composer"])
/** The repository's own checks, allowed only as these exact words. */
const TEST_COMMANDS: string[][] = [
  ["npm", "test"], ["npm", "run", "test"], ["npm", "run", "lint"], ["npm", "run", "typecheck"],
  ["swift", "test"], ["swift", "build"], ["cargo", "test"], ["cargo", "check"], ["go", "test"], ["go", "vet"],
]

/**
 * An allowlisted command and the only options it may carry. `flag` takes no value, `num` takes
 * digits, `text` takes a word with no `/` and no leading `~`. Every other word is a path that must
 * resolve inside the repository. An option not listed here escalates.
 */
type OptionKind = "flag" | "num" | "text"
interface CommandSpec {
  short?: Record<string, OptionKind>
  long?: Record<string, OptionKind>
  /** Accepts `-<digits>` (for example `head -20`). */
  digits?: boolean
  /** Takes no positional words at all. */
  noPositional?: boolean
}

const flags = (letters: string, values: Record<string, OptionKind> = {}): Record<string, OptionKind> =>
  ({ ...Object.fromEntries([...letters].map((letter) => [letter, "flag" as const])), ...values })
const longFlags = (names: string[], values: Record<string, OptionKind> = {}): Record<string, OptionKind> =>
  ({ ...Object.fromEntries(names.map((name) => [name, "flag" as const])), ...values })

const GREP: CommandSpec = {
  short: flags("rRnilvwcEFHhosx", { e: "text", m: "num", A: "num", B: "num", C: "num" }),
  long: longFlags(["--line-number", "--ignore-case", "--recursive", "--count", "--files-with-matches", "--fixed-strings", "--word-regexp"], { "--include": "text", "--exclude": "text", "--exclude-dir": "text" }),
}
const COMMANDS: Record<string, CommandSpec> = {
  ls: { short: flags("1aAlhRtrSdF"), long: longFlags(["--all", "--human-readable", "--recursive"]) },
  pwd: { noPositional: true },
  cat: { short: flags("n") },
  head: { short: { n: "num", c: "num" }, digits: true },
  tail: { short: { n: "num", c: "num" }, digits: true },
  wc: { short: flags("lwcm") },
  grep: GREP, egrep: GREP, fgrep: GREP,
  rg: {
    short: flags("inlwcFSuvHo", { g: "text", t: "text", e: "text", m: "num", A: "num", B: "num", C: "num" }),
    long: longFlags(["--hidden", "--files", "--fixed-strings", "--ignore-case", "--line-number", "--count", "--files-with-matches", "--no-ignore"], { "--glob": "text", "--type": "text" }),
  },
  find: { long: longFlags(["-print", "-empty"], { "-name": "text", "-iname": "text", "-type": "text", "-maxdepth": "num", "-mindepth": "num" }) },
  tree: { short: flags("adf", { L: "num" }) },
  file: { short: flags("b") },
  stat: {},
  diff: { short: flags("uqrN") },
  which: { short: flags("a") },
  echo: { short: flags("n") },
  du: { short: flags("sh", { d: "num" }) },
  true: { noPositional: true },
}
/** Read-only git subcommands and their options. Any other git subcommand escalates. */
const GIT: Record<string, CommandSpec> = {
  status: { short: flags("sb"), long: longFlags(["--short", "--branch", "--porcelain"]) },
  log: { short: { n: "num" }, digits: true, long: longFlags(["--oneline", "--decorate", "--graph"], { "--max-count": "num" }) },
  diff: { long: longFlags(["--name-only", "--name-status", "--cached", "--staged", "--no-ext-diff", "--no-textconv"]) },
  show: { long: longFlags(["--name-only", "--name-status", "--oneline", "--no-ext-diff", "--no-textconv"]) },
  "rev-parse": { long: longFlags(["--show-toplevel", "--abbrev-ref", "--short", "--is-inside-work-tree"]) },
  "ls-files": { long: longFlags(["--others", "--exclude-standard", "--cached", "--modified"]) },
  branch: { short: flags("arv"), long: longFlags(["--all", "--remotes", "--verbose", "--show-current"]), noPositional: true },
  "merge-base": {},
  "rev-list": { long: longFlags(["--count"]) },
  describe: { long: longFlags(["--tags", "--always"]) },
}
/** Repository git config keys and sections that make read-only git commands run a program. */
const GIT_CONFIG_HAZARD = /^\s*(?:fsmonitor|external|textconv|pager|sshcommand|hookspath|askpass|editor|clean|smudge|process|command|cmd|helper|program|tool)\s*=|^\s*\[\s*(?:include|includeif|filter|alias)\b/im

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
  let existing = path.resolve(cwd, target)
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

/**
 * Shell words for a single simple command, or null when quoting is unbalanced. `globbed` is true when
 * a glob character appears outside quotes. Escapes and expansions are refused before this runs.
 */
export function tokenizeCommand(command: string): { tokens: string[]; globbed: boolean } | null {
  const tokens: string[] = []
  let current = ""
  let started = false
  let quote: string | null = null
  let globbed = false
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
    if (GLOB.test(char)) globbed = true
    current += char
    started = true
  }
  if (quote) return null
  if (started) tokens.push(current)
  return { tokens, globbed }
}

/** Whether repository git config could make a read-only git command run a program. Unreadable config counts. */
export function gitConfigHazard(repoRoot: string, fsx: FloorFs = realFs): boolean {
  const pointer = fsx.read(path.join(repoRoot, ".git"))
  const gitDir = pointer === null ? path.join(repoRoot, ".git") : path.resolve(repoRoot, pointer.replace(/^gitdir:\s*/, "").trim())
  const common = fsx.read(path.join(gitDir, "commondir"))
  const configs = [path.join(gitDir, "config"), path.join(gitDir, "config.worktree"), ...(common ? [path.join(path.resolve(gitDir, common.trim()), "config")] : [])]
  const texts = configs.map((file) => fsx.read(file))
  if (texts[0] === null && (common === null || texts[2] === null)) return true
  return texts.some((text) => text !== null && GIT_CONFIG_HAZARD.test(text))
}

interface WordCheck { outside: boolean; touches: string | null }

function checkWord(repoRoot: string, cwd: string, word: string, fsx: FloorFs): WordCheck {
  const relative = resolveInsideRepo(repoRoot, cwd, word, fsx)
  return relative === null ? { outside: true, touches: null } : { outside: false, touches: protectedPath(relative) }
}

/** Null when every option is on the command's list and every value fits its kind; otherwise the reason. */
function checkOptions(spec: CommandSpec, args: string[], positional: (word: string) => string | null): string | null {
  const value = (kind: OptionKind, text: string | undefined, name: string): string | null => {
    if (text === undefined) return `${name} is missing its value`
    if (kind === "num" ? !/^\d+$/.test(text) : text.includes("/") || text.startsWith("~")) return `${name} has a value the floor does not accept`
    return null
  }
  let endOfOptions = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!
    if (endOfOptions || !arg.startsWith("-") || arg === "-") {
      const reason = spec.noPositional ? "takes no arguments here" : positional(arg)
      if (reason) return reason
      continue
    }
    if (arg === "--") {
      endOfOptions = true
      continue
    }
    const equals = arg.indexOf("=")
    const name = equals > 0 ? arg.slice(0, equals) : arg
    const longKind = spec.long?.[name]
    if (longKind) {
      if (longKind === "flag") {
        if (equals > 0) return `${name} takes no value`
        continue
      }
      const reason = value(longKind, equals > 0 ? arg.slice(equals + 1) : args[++index], name)
      if (reason) return reason
      continue
    }
    if (arg.startsWith("--")) return `${name} is not on the allowlist`
    if (spec.digits && /^-\d+$/.test(arg)) continue
    for (let at = 1; at < arg.length; at += 1) {
      const letter = arg[at]!
      const kind = spec.short?.[letter]
      if (!kind) return `-${letter} is not on the allowlist`
      if (kind === "flag") continue
      const attached = arg.slice(at + 1)
      const reason = value(kind, attached || args[++index], `-${letter}`)
      if (reason) return reason
      break
    }
  }
  return null
}

function bashVerdict(command: unknown, repoRoot: string, cwd: string, fsx: FloorFs): FloorVerdict {
  if (typeof command !== "string" || !command.trim()) return hard("no command to judge")
  if (command.length > MAX_COMMAND_CHARS) return hard("command is too long to judge")
  if (SHELL_CONTROL.test(command)) return hard("command chains, pipes, redirects, substitutes or expands")
  const parsed = tokenizeCommand(command)
  if (!parsed || parsed.tokens.length === 0) return hard("command quoting does not parse")
  if (parsed.globbed) return hard("command has an unquoted glob")
  const tokens = parsed.tokens
  const [program, ...args] = tokens as [string, ...string[]]
  const name = program.toLowerCase()
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return hard("command sets environment variables")
  if (HARD_COMMANDS.has(name)) return hard(`${name} is never answered for the human`)

  // Every word, and every value glued to an option, must stay inside the repository; credential paths escalate.
  let touches: string | null = null
  for (const arg of args) {
    const values = arg.startsWith("-") ? [arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg.slice(2)] : [arg]
    for (const word of values.filter((entry) => entry.includes("/") || entry.startsWith("~") || !arg.startsWith("-"))) {
      const check = checkWord(repoRoot, cwd, word, fsx)
      if (check.outside) return hard("command reaches outside the repository")
      if (!arg.startsWith("-")) touches ??= check.touches
    }
  }
  if (touches && CREDENTIAL_TOUCHES.has(touches)) return hard(`command ${touches}`)

  const shape: CaseShape = { repoRoot, tool: "Bash", tokens }
  if (TEST_COMMANDS.some((entry) => entry.length === tokens.length && entry.every((token, index) => token === tokens[index]))) return { verdict: "allow", reason: "runs the repository's own checks", shape }
  if (name === "git") {
    const subcommand = args[0] ?? ""
    const spec = GIT[subcommand]
    if (!spec) return hard(`git ${subcommand || "with global options"} is never answered for the human`)
    if (gitConfigHazard(repoRoot, fsx)) return hard("the repository's git config can run programs")
    const reason = checkOptions(spec, args.slice(1), () => null)
    return reason ? hard(`git ${subcommand}: ${reason}`) : { verdict: "allow", reason: `git ${subcommand} only reads`, shape }
  }
  const spec = COMMANDS[name]
  if (spec && !program.includes("/")) {
    const reason = checkOptions(spec, args, () => null)
    return reason ? hard(`${name}: ${reason}`) : { verdict: "allow", reason: `${name} only reads`, shape }
  }
  if (PACKAGE_MANAGERS.has(name)) {
    const script = (args[0] === "run" && args.length === 2) || (args[0] === "test" && args.length === 1)
    if (!script) return hard(`${name} ${args[0] ?? ""} is never answered for the human`.trim())
  }
  if ((INTERPRETERS.has(name) || /^python\d/.test(name)) && args.some((arg) => arg.startsWith("-"))) return hard(`${name} with options can run inline code`)
  if (touches) return hard(`command ${touches}`)
  return { verdict: "soft", reason: program.includes("/") ? "runs a program by path" : `${name} is not on the allowlist`, shape }
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
