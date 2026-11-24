/**
 * Slugger's bundle for a sandboxed run: a projection built from an allowlist, never a mount of his live bundle.
 *
 * - **Source.** `archiveBundle` runs `git archive <commit>` of his bundle into a new temporary folder, so the live
 *   working tree is never read or written. The projection refuses any source folder that isn't an archive this module
 *   made and hasn't yet removed, and `removeArchive` deletes one by its exact path and reads back that it is gone.
 * - **Kept:** `psyche/` except `TACIT.md` and the old fact store `psyche/memory/`, `skills/`, and `bundle-meta.json`.
 * - **`agent.json`:** rebuilt from an allowlist of keys (`version`, `enabled`, `humanFacing`, `agentFacing`,
 *   `context`, `phrases`), each sense's on and off flag only, and `mcpServers` pointed at the run's fakes with no `env`.
 *   A server with no fake is left out, and so is every other key (`vault`, `home`, `sync`, `hostUsername`, ...).
 * - **Dropped:** everything else, including `friends/`, `state/`, `desk/`, `arc/`, `tasks/`, `vault`, every
 *   dot-file and dot-folder (`.git`, `.backup/`, ...) and every symbolic link.
 * - **Created empty:** every path Slugger's profile may write, so `books/` too, where the sandbox writes the books
 *   CLI's synthetic settings.
 * - **Leak patterns.** The household's names, handles, emails and addresses are kept in his private bundle at
 *   `eval/leak-patterns.json` (`{ "literals": [...] }`) and never committed to the harness. They are read from the
 *   same commit as the rest, so an older commit is checked against the list it had then. A pattern matches in any case
 *   and as a whole word only: not inside a longer run of letters (digits don't count, so `name99` matches). One with a
 *   letter outside basic Latin matches anywhere (see `wordPattern`).
 * - **Redaction.** Every match in a copied file's contents is replaced with a placeholder fixed by the pattern's place
 *   in the list, the same in every file: "Member A", "Member B", ..., or "member-a@example.invalid" for a pattern
 *   holding `@`, or "@member-a" for a handle starting with it. Longer patterns are replaced first. A gap gives only how many strings and files were replaced.
 * - **Leak lint.** After redaction the patterns are matched again against every projected file's and folder's name,
 *   every file's contents and every gap, before any model call. A match, or no pattern file, stops the projection and
 *   removes it; the error gives counts only, never a match.
 * `git archive` follows the bundle repository's `export-ignore` and `export-subst` attributes; a top-level entry left
 * out that way fails the archive's completeness check.
 * What differs from the live bundle comes back as `gaps`, which every report lists.
 */
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Readable } from "node:stream"
import { emitNervesEvent } from "../../nerves/runtime"
import type { AgentProfile } from "./agent-profile"

/**
 * What Slugger's turn writes; everything else in his projected bundle is read-only. The books CLI's download folder,
 * removed folder and ledger are here, as in the Butler's profile, so a books case runs the same way for him.
 */
export const SLUGGER_WRITABLE = ["books/work", "books/removed", "books/ledger.ndjson", "state", "friends", "arc", "desk/_record"] as const
/** Folders created empty: the writable folders, and the desk's `_record` folders a fresh agent root has. */
const EMPTY = ["books/work", "books/removed", "state", "friends", "arc", "desk/_record/diary/daily", "desk/_record/notes"]
/** Top-level paths a case may include, and that are copied. */
const KEPT = ["psyche", "skills", "bundle-meta.json"]
/** Never copied, wherever they sit under a kept path. Every dot-folder or dot-file (`.git`, `.backup`, ...) is left out too. */
const LEFT_OUT = ["psyche/TACIT.md", "psyche/memory"]
/**
 * Top-level `agent.json` keys kept as they are. `enabled` is kept because the harness refuses an `agent.json` without
 * it; it says only whether the agent is switched on.
 */
const AGENT_KEYS = ["version", "enabled", "humanFacing", "agentFacing", "context", "phrases"]
/** Where the household's leak patterns sit in his bundle. */
export const LEAK_PATTERNS = "eval/leak-patterns.json"
const ARCHIVE_PREFIX = "eval-slugger-archive-"

/** A fake MCP server for the run: how the agent container starts it. */
export type FakeMcpServer = { command: string; args?: string[]; tools?: string }

/** Archive folders this module made and hasn't removed. */
const archives = new Set<string>()

function run(command: string, args: string[], stdin?: Readable): { stdout: Readable; done: Promise<string> } {
  // A reader's own output is never read, so it goes nowhere instead of filling a pipe.
  const child = spawn(command, args, { stdio: [stdin ? "pipe" : "ignore", stdin ? "ignore" : "pipe", "pipe"] })
  if (stdin) {
    // A reader that stops early closes the writer's output too, so the writer ends on a broken pipe instead of waiting.
    const stop = (): void => { stdin.destroy() }
    child.stdin!.on("error", stop)
    child.on("close", stop)
    stdin.pipe(child.stdin!)
  }
  let stderr = ""
  child.stderr!.setEncoding("utf8")
  child.stderr!.on("data", (chunk: string) => { stderr += chunk })
  const done = new Promise<string>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => (code === 0 ? resolve(stderr) : reject(new Error(`${[command, ...args].join(" ")} exited ${code}: ${stderr.trim()}`))))
  })
  return { stdout: child.stdout!, done }
}

async function output(command: string, args: string[]): Promise<string> {
  const { stdout, done } = run(command, args)
  let text = ""
  stdout.setEncoding("utf8")
  stdout.on("data", (chunk: string) => { text += chunk })
  await done
  return text.trim()
}

/** `git archive` of `commit` in the bundle repository `repo`, unpacked into a new folder under `workRoot`. */
export async function archiveBundle(input: { repo: string; commit: string; workRoot?: string; tar?: string }): Promise<{ dir: string; commit: string }> {
  const commit = await output("git", ["-C", input.repo, "rev-parse", "--verify", "--end-of-options", `${input.commit}^{commit}`])
  const dir = fs.mkdtempSync(path.join(input.workRoot ?? os.tmpdir(), ARCHIVE_PREFIX))
  archives.add(dir)
  try {
    const archive = run("git", ["-C", input.repo, "archive", "--format=tar", commit])
    const unpack = run(input.tar ?? "tar", ["-x", "-f", "-", "-C", dir], archive.stdout)
    // Both must have ended before the folder can be removed, whichever failed first.
    const ended = await Promise.allSettled([archive.done, unpack.done])
    for (const each of ended) if (each.status === "rejected") throw each.reason
    // Every top-level entry of the commit must have arrived, so a reader that stops early can't pass for a smaller bundle.
    const names = (await output("git", ["-C", input.repo, "ls-tree", "-z", "--name-only", commit])).split("\0").filter(Boolean)
    const missing = names.filter((name) => !fs.lstatSync(path.join(dir, name), { throwIfNoEntry: false }))
    if (missing.length > 0) throw new Error(`the archive of ${commit} is missing ${missing.length} of its top-level entries`)
  } catch (error) {
    removeArchive(dir)
    throw error
  }
  emitNervesEvent({ component: "eval", event: "eval.slugger_archive", message: "archived a bundle commit for a projection", meta: { commit } })
  return { dir, commit }
}

/** Deletes an archive folder this module made, by its exact path, and reads back that it is gone. */
export function removeArchive(dir: string): void {
  if (!archives.has(dir)) throw new Error(`${dir} is no archive this run made`)
  fs.rmSync(dir, { recursive: true, force: true })
  if (fs.existsSync(dir)) throw new Error(`${dir} is still there after its removal`)
  archives.delete(dir)
}

function refuse(why: string): never {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.slugger_projection_refused", message: "refused a Slugger projection", meta: { why } })
  throw new Error(`Slugger projection: ${why}`)
}

const leftOut = (relative: string): boolean => {
  const lower = relative.toLowerCase()
  return lower.split("/").some((part) => part.startsWith(".")) || LEFT_OUT.some((p) => lower === p.toLowerCase() || lower.startsWith(`${p.toLowerCase()}/`))
}

function copyTree(from: string, to: string, relative: string, gaps: string[]): void {
  const source = path.join(from, relative)
  const stat = fs.lstatSync(source)
  if (stat.isSymbolicLink()) {
    gaps.push(`${relative}: a symbolic link, left out`)
  } else if (stat.isDirectory()) {
    fs.mkdirSync(path.join(to, relative), { recursive: true })
    for (const name of fs.readdirSync(source).sort()) {
      const child = path.posix.join(relative, name)
      if (!leftOut(child)) copyTree(from, to, child, gaps)
    }
  } else {
    // A git archive holds only files, folders and links.
    fs.copyFileSync(source, path.join(to, relative))
    fs.chmodSync(path.join(to, relative), stat.mode & 0o755)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** The allowlisted `agent.json`, and the names of the keys and servers it left out. */
export function projectAgentConfig(config: unknown, fakes: Record<string, FakeMcpServer>): { config: Record<string, unknown>; dropped: string[] } {
  if (!isRecord(config)) refuse("agent.json is not an object")
  const kept: Record<string, unknown> = {}
  const dropped: string[] = []
  for (const key of Object.keys(config).sort()) {
    if (AGENT_KEYS.includes(key)) kept[key] = config[key]
    else if (key !== "senses" && key !== "mcpServers") dropped.push(key)
  }
  if (isRecord(config.senses)) {
    const senses: Record<string, { enabled: boolean }> = {}
    for (const [name, sense] of Object.entries(config.senses).sort(([a], [b]) => (a < b ? -1 : 1))) {
      senses[name] = { enabled: isRecord(sense) && sense.enabled === true }
      if (isRecord(sense)) for (const field of Object.keys(sense).filter((f) => f !== "enabled").sort()) dropped.push(`senses.${name}.${field}`)
    }
    kept.senses = senses
  }
  if (isRecord(config.mcpServers)) {
    const servers: Record<string, FakeMcpServer> = {}
    for (const name of Object.keys(config.mcpServers).sort()) {
      const fake = fakes[name]
      if (fake) servers[name] = { command: fake.command, ...(fake.args ? { args: [...fake.args] } : {}), ...(fake.tools ? { tools: fake.tools } : {}) }
      else dropped.push(`mcpServers.${name}`)
    }
    kept.mcpServers = servers
  }
  return { config: kept, dropped }
}

/** Reads the household's leak patterns from the archive: literals of three or more characters, matched in any case. */
export function readLeakPatterns(archiveDir: string): string[] {
  const file = path.join(archiveDir, LEAK_PATTERNS)
  if (!fs.existsSync(file)) refuse(`the bundle has no ${LEAK_PATTERNS}, so its projection can't be checked for leaks`)
  let value: unknown
  try { value = JSON.parse(fs.readFileSync(file, "utf8")) } catch { refuse(`${LEAK_PATTERNS} is not JSON`) }
  const literals = isRecord(value) ? value.literals : undefined
  if (!Array.isArray(literals) || literals.length === 0 || !literals.every((l) => typeof l === "string" && l.trim().length >= 3)) {
    refuse(`${LEAK_PATTERNS} needs a non-empty "literals" list of strings of three or more characters`)
  }
  return (literals as string[]).map((literal) => literal.trim().toLowerCase())
}

/**
 * A pattern in any case, as a whole word: not next to another letter, so a name inside a longer word is no match, but
 * a handle next to digits (`name99`) is. Words in a pattern match across any run of spaces or line breaks. A pattern
 * with a letter outside basic Latin matches anywhere, since scripts such as Japanese don't separate words and Hebrew
 * joins prefixes to names.
 */
function wordPattern(pattern: string): RegExp {
  const body = pattern.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")
  if (/[^\p{ASCII}]/u.test(pattern)) return new RegExp(body, "giu")
  return new RegExp(`(?<![\\p{L}\\p{M}])${body}(?![\\p{L}\\p{M}])`, "giu")
}

const holdsAny = (text: string, patterns: string[]): boolean => patterns.some((pattern) => wordPattern(pattern).test(text))

/**
 * The placeholder for the pattern at `index`: "Member A" to "Member Z", then "Member AA"; an email's is an address
 * and a handle's (`@name`) a handle. A pattern such as `member` or `example` would match its own placeholder, which the
 * second lint then refuses.
 */
export function placeholder(index: number, pattern: string): string {
  let letters = ""
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters
  if (pattern.startsWith("@")) return `@member-${letters.toLowerCase()}`
  return pattern.includes("@") ? `member-${letters.toLowerCase()}@example.invalid` : `Member ${letters}`
}

const utf8 = new TextDecoder("utf-8", { fatal: true })

function filesUnder(root: string): string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    const full = path.join(root, relative)
    if (fs.lstatSync(full).isDirectory()) for (const name of fs.readdirSync(full).sort()) walk(relative ? path.posix.join(relative, name) : name)
    else found.push(relative)
  }
  walk("")
  return found
}

/**
 * Replaces every match in the contents of each file under `root` with its pattern's placeholder. A file that isn't
 * UTF-8 text is left as it is, so the lint after this refuses it if it holds a pattern.
 */
export function redact(root: string, patterns: string[]): { strings: number; files: number } {
  const order = patterns.map((pattern, index) => ({ pattern, index })).sort((a, b) => b.pattern.length - a.pattern.length || a.index - b.index)
  let strings = 0
  let files = 0
  for (const relative of filesUnder(root)) {
    const full = path.join(root, relative)
    let text: string
    try { text = utf8.decode(fs.readFileSync(full)) } catch { continue }
    let here = 0
    for (const { pattern, index } of order) {
      text = text.replace(wordPattern(pattern), () => { here += 1; return placeholder(index, pattern) })
    }
    if (here > 0) {
      // A failed write's error names the file, whose path the lint hasn't checked yet.
      try { fs.writeFileSync(full, text) } catch { refuse("a projected file couldn't be rewritten with placeholders") }
      strings += here
      files += 1
    }
  }
  return { strings, files }
}

/** Every file or folder under `root` whose path, or a file's contents, holds a pattern, by its path relative to `root`. */
export function leakLint(root: string, patterns: string[]): string[] {
  const flagged: string[] = []
  const holds = (text: string): boolean => holdsAny(text, patterns)
  const walk = (relative: string): void => {
    const full = path.join(root, relative)
    if (fs.lstatSync(full).isDirectory()) {
      if (relative && holds(relative)) flagged.push(`${relative}/`)
      for (const name of fs.readdirSync(full).sort()) walk(relative ? path.posix.join(relative, name) : name)
    } else if (holds(`${relative}\n${fs.readFileSync(full, "utf8")}`)) {
      flagged.push(relative)
    }
  }
  walk("")
  return flagged
}

export type SluggerProjectionInput = { archive: string; include: string[]; out: string; fakes: Record<string, FakeMcpServer> }

export function projectSlugger(input: SluggerProjectionInput): { gaps: string[] } {
  if (!archives.has(input.archive)) refuse(`${input.archive} is no git archive this run made`)
  for (const include of input.include) {
    const top = include.split("/")[0]!
    if (include !== "agent.json" && (!KEPT.includes(top) || path.posix.normalize(include) !== include || include.split("/").includes("..") || leftOut(include))) {
      refuse(`a case may include agent.json, ${KEPT.join(", ")} or paths inside them, not ${JSON.stringify(include)}`)
    }
  }
  if (fs.existsSync(input.out)) refuse(`the projection folder ${input.out} already exists`)
  const patterns = readLeakPatterns(input.archive)
  fs.mkdirSync(input.out, { recursive: true, mode: 0o755 })
  const gaps: string[] = []
  let redactedStrings = 0
  try {
    for (const include of input.include.filter((each) => each !== "agent.json")) {
      const parts = include.split("/")
      const linked = parts.slice(0, -1).some((_part, i) => fs.lstatSync(path.join(input.archive, ...parts.slice(0, i + 1)), { throwIfNoEntry: false })?.isSymbolicLink())
      if (linked) gaps.push(`${include}: under a symbolic link, left out`)
      else if (!fs.existsSync(path.join(input.archive, include))) gaps.push(`${include}: not in the bundle`)
      else copyTree(input.archive, input.out, include, gaps)
    }
    if (input.include.includes("agent.json")) {
      let config: unknown
      try { config = JSON.parse(fs.readFileSync(path.join(input.archive, "agent.json"), "utf8")) } catch { refuse("agent.json is missing or not JSON") }
      const projected = projectAgentConfig(config, input.fakes)
      fs.writeFileSync(path.join(input.out, "agent.json"), `${JSON.stringify(projected.config, null, 2)}\n`)
      if (projected.dropped.length > 0) gaps.push(`agent.json: left out ${projected.dropped.join(", ")}`)
      for (const name of Object.keys((projected.config.mcpServers as Record<string, FakeMcpServer> | undefined) ?? {})) gaps.push(`${name}: a fake MCP server with synthetic data stands in for the real one`)
    }
    for (const dir of EMPTY) fs.mkdirSync(path.join(input.out, dir), { recursive: true })
    fs.writeFileSync(path.join(input.out, "books/ledger.ndjson"), "")
    gaps.push(
      "psyche/TACIT.md and psyche/memory: left out",
      "friends, state, arc, desk and books: start empty",
      "browser: left out",
    )
    const redacted = redact(input.out, patterns)
    redactedStrings = redacted.strings
    if (redacted.strings > 0) gaps.push(`${redacted.strings} private strings replaced with placeholders in ${redacted.files} ${redacted.files === 1 ? "file" : "files"}`)
    // Gaps go into every report, so they are checked like the files are.
    const flagged = leakLint(input.out, patterns).length + gaps.filter((gap) => holdsAny(gap, patterns)).length
    if (flagged > 0) refuse(`${flagged} projected path(s) or gap(s) hold a leak pattern; nothing was run`)
  } catch (error) {
    fs.rmSync(input.out, { recursive: true, force: true })
    throw error
  }
  emitNervesEvent({ component: "eval", event: "eval.slugger_projection", message: "projected Slugger's bundle", meta: { gaps: gaps.length, redacted: redactedStrings } })
  return { gaps }
}

/** Slugger's profile for a run on an archive `archiveBundle` made; the caller removes the archive afterwards. */
export function sluggerProfile(input: { archive: string; fakes: Record<string, FakeMcpServer> }): AgentProfile {
  return {
    agent: "slugger",
    bundleSource: ({ include, out }) => projectSlugger({ archive: input.archive, include, out, fakes: input.fakes }),
    writable: SLUGGER_WRITABLE,
  }
}
