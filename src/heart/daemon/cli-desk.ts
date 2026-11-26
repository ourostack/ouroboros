/**
 * `ouro desk` CLI: verbs over the agent's Desk MCP server.
 *
 * Desk is built into every agent: each agent's daemon runs the Desk MCP server
 * as server `desk`, and one more server `desk-<name>` for each other desk the
 * agent's agent.json `desks` map names. Every verb here turns argv into
 * `{ kind: "desk", tool, toolArgs }` and the executor sends it to the daemon
 * as `mcp.call` (see `daemon.ts::case "mcp.call"`). `--desk <name>` sends it
 * to `desk-<name>` instead of `desk`. No business logic lives here: Desk
 * checks every argument and its refusals say what to fix.
 *
 *   ouro desk task list [--track <t>] [--status <s>]    → desk_search {filters: {kind: "task", ...}}
 *   ouro desk task new <track>/<slug> [--title <t>]     → task_create
 *   ouro desk task done <track>/<slug> --pr|--commit    → task_update {status: "done", evidence}
 *   ouro desk task archive <track>/<slug> [--cancelled] → task_archive
 *   ouro desk task show <track>/<slug>                  → desk_search {query: slug, filters: {kind: "task", track}}
 *   ouro desk track show <slug>                         → desk_search {filters: {kind: "task", track}}
 *     (Desk 3 does not index track.md, so a track is seen through its tasks; task list shows each task's track.)
 *   ouro desk track new <slug> --title --scope          → track_create
 *   ouro desk friction add <text>                       → friction_add {body}
 *   ouro desk lesson add <text> --scope --topic         → lesson_add
 *   ouro desk search <query>                            → desk_search {query}
 *   ouro desk recall <topic>                            → desk_recall {topic}
 *   ouro desk status | doctor | reindex                 → desk_status | desk_doctor | desk_doctor {reindex: true}
 *   ouro task ...                                       (alias for ouro desk task ...)
 *
 * The Hosted Desk admin verbs (invite, access, delete-account) are parsed by
 * desk-admin.ts and reach the Hosted Desk gateway, not an MCP server.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import type { OuroCliCommand, OuroCliDeps, DeskCliCommand } from "./cli-types"
import type { DaemonResponse } from "./daemon"
import { parseDeskAdminCommand } from "./desk-admin"

// ── Public usage hint ──

export function deskUsage(): string {
  return [
    "Usage:",
    "  ouro desk task list [--track <t>] [--status <s>]",
    "  ouro desk task new <track>/<slug> [--title <title>]   (or <slug> --track <track>)",
    "  ouro desk task done <track>/<slug> --pr <url> | --commit <sha>",
    "  ouro desk task archive <track>/<slug> [--cancelled]",
    "  ouro desk task show <track>/<slug>",
    "  ouro desk track new <slug> --title <title> --scope <scope>",
    "  ouro desk track show <slug>",
    "  ouro desk friction add <text>",
    "  ouro desk lesson add <text> --scope <personal|desk|team> --topic <topic>",
    "  ouro desk search <query>",
    "  ouro desk recall <topic>",
    "  ouro desk status",
    "  ouro desk doctor",
    "  ouro desk reindex",
    "  (each of these takes --desk <name> to use another desk the agent's agent.json names)",
    "",
    "Hosted Desk admin (needs the ouro.admin role; signs in through the browser):",
    "  ouro desk invite --name <name> [--out <file>]       (--account <id> re-invites an unused account)",
    "  ouro desk access <account> on|off",
    "  ouro desk delete-account <account> --yes",
    "  (each takes --gateway <url> --trust-gateway to manage a Hosted Desk other than desk.ouro.bot)",
    "",
    "Alias:",
    "  ouro task list|new|done|archive|show [<ouro desk task arguments>]    (routes through ouro desk task)",
  ].join("\n")
}

function usageError(problem?: string): Error {
  return new Error(problem ? `${problem}\n${deskUsage()}` : deskUsage())
}

// ── Helpers ──

const DESK_NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/
const TASK_REF = /^([^/\s]+)\/([^/\s]+)$/

/** Who the call goes to: the agent (`--agent`) and which of its desks (`--desk`). */
interface DeskTarget {
  agent?: string
  desk?: string
}

function flagValue(args: string[], index: number): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw usageError(`${args[index]} needs a value.`)
  return value
}

/** Takes --agent and --desk out of the words, wherever they sit, since every desk-tool verb reads them. */
function extractTarget(args: string[]): { target: DeskTarget; rest: string[] } {
  const target: DeskTarget = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "--desk" || arg === "--agent") {
      const value = flagValue(args, i)
      i++
      if (arg === "--agent") {
        target.agent = value
        continue
      }
      if (!DESK_NAME.test(value)) {
        throw usageError(`--desk '${value.slice(0, 40)}' is not a desk name: use the lowercase name from the agent's agent.json desks.`)
      }
      target.desk = value
      continue
    }
    rest.push(arg)
  }
  return { target, rest }
}

/** Splits one verb's words from its flags; a flag the verb doesn't take is a usage error. */
function splitFlags(
  verb: string,
  args: string[],
  valued: readonly string[] = [],
  boolean: readonly string[] = [],
): { words: string[]; flags: Record<string, string | true> } {
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (!arg.startsWith("--")) {
      words.push(arg)
    } else if (boolean.includes(arg)) {
      flags[arg] = true
    } else if (valued.includes(arg)) {
      flags[arg] = flagValue(args, i)
      i++
    } else {
      throw usageError(`ouro desk ${verb} doesn't take ${arg}.`)
    }
  }
  return { words, flags }
}

function stringFlag(flags: Record<string, string | true>, flag: string): string | undefined {
  const value = flags[flag]
  return typeof value === "string" ? value : undefined
}

/** The verb's words must be empty: `ouro desk status` and friends take none. */
function noWords(verb: string, args: string[]): void {
  const { words } = splitFlags(verb, args)
  if (words.length > 0) throw usageError(`ouro desk ${verb} takes no words after it.`)
}

/** Exactly one word: the task's `<track>/<slug>`. */
function taskRef(verb: string, words: string[]): { track: string; slug: string } {
  const match = words.length === 1 ? TASK_REF.exec(words[0]!) : null
  if (!match) throw usageError(`ouro desk task ${verb} needs one task as <track>/<slug>; ouro desk task list shows them.`)
  return { track: match[1]!, slug: match[2]! }
}

/** The words after `add`, `search` or `recall`, joined as one text. */
function textOf(verb: string, words: string[], what: string): string {
  const text = words.join(" ").trim()
  if (!text) throw usageError(`ouro desk ${verb} needs ${what}.`)
  return text
}

function desk(target: DeskTarget, tool: string, toolArgs: Record<string, unknown>): DeskCliCommand {
  return { kind: "desk", tool, toolArgs, ...target }
}

// ── Sub-parsers ──

function parseTaskSubverb(args: string[], target: DeskTarget): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub === "list") {
    const { words, flags } = splitFlags("task list", rest, ["--track", "--status"])
    if (words.length > 0) throw usageError("ouro desk task list takes no words; filter with --track or --status.")
    const track = stringFlag(flags, "--track")
    const status = stringFlag(flags, "--status")
    return desk(target, "desk_search", { filters: { kind: "task", ...(track ? { track } : {}), ...(status ? { status } : {}) } })
  }

  if (sub === "new") {
    const { words, flags } = splitFlags("task new", rest, ["--track", "--title"])
    const flagTrack = stringFlag(flags, "--track")
    const ref = words.length === 1 ? words[0]! : ""
    const match = TASK_REF.exec(ref)
    let track: string | undefined
    let slug: string
    if (match) {
      if (flagTrack) throw usageError("ouro desk task new takes the track once: <track>/<slug>, or <slug> --track <track>.")
      track = match[1]!
      slug = match[2]!
    } else {
      track = flagTrack
      slug = ref
    }
    if (!track || !slug || slug.includes("/")) {
      throw usageError("ouro desk task new needs <track>/<slug>, or <slug> --track <track>; ouro desk task list shows each task's track.")
    }
    return desk(target, "task_create", { track, slug, title: stringFlag(flags, "--title") ?? slug })
  }

  if (sub === "done") {
    const { words, flags } = splitFlags("task done", rest, ["--pr", "--commit"])
    const ref = taskRef("done", words)
    const pr = stringFlag(flags, "--pr")
    const commit = stringFlag(flags, "--commit")
    if (Boolean(pr) === Boolean(commit)) {
      throw usageError("ouro desk task done needs its evidence: --pr <url> for the pull request, or --commit <sha> for the pushed commit (one of them).")
    }
    const evidence = pr ? { kind: "pr", ref: pr } : { kind: "commit", ref: commit }
    return desk(target, "task_update", { ...ref, status: "done", evidence })
  }

  if (sub === "archive") {
    const { words, flags } = splitFlags("task archive", rest, [], ["--cancelled"])
    const ref = taskRef("archive", words)
    return desk(target, "task_archive", { ...ref, ...(flags["--cancelled"] ? { outcome: "cancelled" } : {}) })
  }

  if (sub === "show") {
    const { words } = splitFlags("task show", rest)
    const { track, slug } = taskRef("show", words)
    return desk(target, "desk_search", { query: slug, filters: { kind: "task", track } })
  }

  throw usageError()
}

function parseTrackSubverb(args: string[], target: DeskTarget): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub === "new") {
    const { words, flags } = splitFlags("track new", rest, ["--title", "--scope"])
    const title = stringFlag(flags, "--title")
    const scope = stringFlag(flags, "--scope")
    if (words.length !== 1 || !title || !scope) {
      throw usageError('ouro desk track new needs a slug, --title <title> and --scope "<what belongs>; not <what doesn\'t>".')
    }
    return desk(target, "track_create", { slug: words[0]!, title, scope })
  }

  if (sub === "show") {
    const { words } = splitFlags("track show", rest)
    if (words.length !== 1) throw usageError("ouro desk track show needs one track slug; ouro desk task list shows each task's track.")
    return desk(target, "desk_search", { filters: { kind: "task", track: words[0]! } })
  }

  throw usageError()
}

function parseFrictionSubverb(args: string[], target: DeskTarget): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub !== "add") throw usageError()
  const { words } = splitFlags("friction add", rest)
  return desk(target, "friction_add", { body: textOf("friction add", words, "the note's text") })
}

function parseLessonSubverb(args: string[], target: DeskTarget): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub !== "add") throw usageError()
  const { words, flags } = splitFlags("lesson add", rest, ["--scope", "--topic"])
  const body = textOf("lesson add", words, "the lesson's text")
  const scope = stringFlag(flags, "--scope")
  const topic = stringFlag(flags, "--topic")
  if (!scope || !topic) throw usageError("ouro desk lesson add needs --scope <personal|desk|team> and --topic <short name>.")
  return desk(target, "lesson_add", { scope, topic, body })
}

// ── Public parsers ──

/**
 * Parse the `ouro desk <subverb> ...` umbrella into a canonical desk command.
 */
export function parseDeskCommand(args: string[]): OuroCliCommand {
  // The Hosted Desk admin verbs reach the gateway, not a desk, so they take their own flags and no --desk.
  const verb = args[0]
  if (verb === "invite" || verb === "access" || verb === "delete-account") return parseDeskAdminCommand(verb, args.slice(1))

  const { target, rest: words } = extractTarget(args)
  const [head, ...rest] = words

  if (head === "task") return parseTaskSubverb(rest, target)
  if (head === "track") return parseTrackSubverb(rest, target)
  if (head === "friction") return parseFrictionSubverb(rest, target)
  if (head === "lesson") return parseLessonSubverb(rest, target)

  if (head === "search") {
    const { words: query } = splitFlags("search", rest)
    return desk(target, "desk_search", { query: textOf("search", query, "words to search for") })
  }

  if (head === "recall") {
    const { words: topic } = splitFlags("recall", rest)
    return desk(target, "desk_recall", { topic: textOf("recall", topic, "a topic") })
  }

  if (head === "status") {
    noWords("status", rest)
    return desk(target, "desk_status", {})
  }

  if (head === "doctor") {
    noWords("doctor", rest)
    return desk(target, "desk_doctor", {})
  }

  if (head === "reindex") {
    noWords("reindex", rest)
    return desk(target, "desk_doctor", { reindex: true })
  }

  throw usageError()
}

/**
 * Parse `ouro task <subverb> ...` as an alias for `ouro desk task <subverb> ...`.
 */
export function parseTaskAliasCommand(args: string[]): OuroCliCommand {
  const { target, rest } = extractTarget(args)
  return parseTaskSubverb(rest, target)
}

// ── Executor ──

/**
 * Route a parsed desk command through the daemon socket as `mcp.call(server,
 * tool, args)` and render the response. The server is `desk`, or
 * `desk-<name>` for `--desk <name>`: the daemon runs one Desk MCP server per
 * desk the agent has.
 */
export async function executeDeskCommand(
  command: DeskCliCommand,
  deps: OuroCliDeps,
): Promise<string> {
  const server = command.desk ? `desk-${command.desk}` : "desk"
  emitNervesEvent({
    component: "daemon",
    event: "daemon.desk_cli_dispatch",
    message: `ouro desk → mcp__${server}__${command.tool}`,
    meta: { tool: command.tool, server, ...(command.agent ? { agent: command.agent } : {}) },
  })

  const daemonCommand = {
    kind: "mcp.call" as const,
    server,
    tool: command.tool,
    args: JSON.stringify(command.toolArgs),
    ...(command.agent ? { agent: command.agent } : {}),
  }

  let response: DaemonResponse
  try {
    response = await deps.sendCommand(deps.socketPath, daemonCommand)
  } catch {
    throw Object.assign(new Error("daemon unavailable — start with `ouro up` first"), { code: "daemon-down" })
  }

  if (!response.ok) {
    const message = response.error ?? "unknown error"
    deps.writeStdout(message)
    return message
  }

  const message = renderDeskMcpResult(response)
  deps.writeStdout(message)
  return message
}

/**
 * Render the MCP `content[]` payload to a single string for stdout.
 *
 * The desk MCP server returns `{ content: [{ type: "text", text: "..." }] }`
 * (the standard MCP tool-result envelope). We concatenate the text blocks
 * with newlines and fall back to `"no result"` when the envelope is
 * unexpectedly empty.
 */
function renderDeskMcpResult(response: DaemonResponse): string {
  const result = response.data as
    | { content?: Array<{ type: string; text: string }> }
    | undefined
  if (!result || !Array.isArray(result.content) || result.content.length === 0) {
    return response.message ?? "no result"
  }
  return result.content.map((c) => c.text ?? "").join("\n")
}
