/**
 * `ouro desk` umbrella CLI — verb-and-router layer over the desk MCP server.
 *
 * W6 Unit 10 of the desk-as-universal-substrate plan. The desk MCP server
 * (declared by the desk plugin, auto-spawned per agent by Unit 9's daemon
 * plugin-MCP wiring) exposes 12 tools: 7 runtime CRUD (`task_create`,
 * `task_update`, `task_archive`, `track_create`, `track_update`,
 * `friction_add`, `lesson_add`), 4 search (`desk_search`, `desk_recall`,
 * `desk_similar`, `desk_timeline`), and 1 provenance walk (`desk_thread`).
 *
 * This module is pure verb-and-router: argv → `{ kind: "desk", tool,
 * toolArgs }` → daemon `mcp.call` with `server: "desk"`. No new business
 * logic. The daemon's existing MCP-client surface (see
 * `daemon.ts::case "mcp.call"`) dispatches into the spawned desk MCP
 * server.
 *
 * The CLI surface deliberately mirrors the agent-facing nouns:
 *   ouro desk task list|new|done|archive|show
 *   ouro desk track list|new|show
 *   ouro desk friction add "<text>"
 *   ouro desk lesson add "<text>"
 *   ouro desk search "<query>"
 *   ouro desk recall "<topic>"
 *   ouro desk reindex
 *   ouro desk thread <path>
 *   ouro task ...    (alias → ouro desk task ...)
 *
 * For verbs where no direct desk MCP tool exists (`task list`, `task show`,
 * `task done`, `track list`, `track show`), we route via the closest tool:
 *   task list / track list / task show / track show → desk_search with
 *     kind=task|track and (optionally) the slug as query
 *   task done <slug> → task_update path=<slug>/task.md, frontmatter.status=done
 *
 * `desk reindex` routes to `desk_reindex` — no such MCP tool exists yet, but
 * surfacing the tool name lets the daemon return a clean "unknown tool"
 * error from the MCP server itself, deferring the actual reindex tool to a
 * follow-up unit per the plan's Out-of-scope notes.
 */

import { emitNervesEvent } from "../../nerves/runtime"
import type { OuroCliCommand, OuroCliDeps, DeskCliCommand } from "./cli-types"
import type { DaemonResponse } from "./daemon"

// ── Public usage hint ──

export function deskUsage(): string {
  return [
    "Usage:",
    "  ouro desk task list [--track <t>] [--status <s>]",
    "  ouro desk task new <slug> --track <track>",
    "  ouro desk task done <slug>",
    "  ouro desk task archive <slug>",
    "  ouro desk task show <slug>",
    "  ouro desk track list",
    "  ouro desk track new <slug>",
    "  ouro desk track show <slug>",
    "  ouro desk friction add <text>",
    "  ouro desk lesson add <text>",
    "  ouro desk search <query>",
    "  ouro desk recall <topic>",
    "  ouro desk reindex",
    "  ouro desk thread <path>",
    "",
    "Alias:",
    "  ouro task ...    (routes through ouro desk task ...)",
  ].join("\n")
}

function usageError(): Error {
  return new Error(`Usage\n${deskUsage()}`)
}

// ── Helpers ──

function taskMdPath(slug: string): string {
  // Slugs may be "<track>/<task>" or just "<task>"; always append /task.md.
  return slug.endsWith("/task.md") ? slug : `${slug.replace(/\/$/, "")}/task.md`
}

function extractStringFlag(args: string[], flag: string): { value?: string; rest: string[] } {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return { rest: args }
  const value = args[idx + 1]
  const rest = [...args.slice(0, idx), ...args.slice(idx + 2)]
  return { value, rest }
}

// ── Sub-parsers ──

function parseTaskSubverb(args: string[]): DeskCliCommand {
  const [sub, ...rest] = args
  if (!sub) throw usageError()

  if (sub === "list") {
    const { value: track, rest: afterTrack } = extractStringFlag(rest, "--track")
    const { value: status } = extractStringFlag(afterTrack, "--status")
    const filters: Record<string, unknown> = { kind: "task" }
    if (track) filters.track = track
    if (status) filters.status = status
    return {
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters },
    }
  }

  if (sub === "new") {
    const { value: track, rest: afterTrack } = extractStringFlag(rest, "--track")
    const slug = afterTrack[0]
    if (!slug || !track) throw usageError()
    return {
      kind: "desk",
      tool: "task_create",
      toolArgs: { track, slug },
    }
  }

  if (sub === "done") {
    const slug = rest[0]
    if (!slug) throw usageError()
    return {
      kind: "desk",
      tool: "task_update",
      toolArgs: { path: taskMdPath(slug), frontmatter: { status: "done" } },
    }
  }

  if (sub === "archive") {
    const slug = rest[0]
    if (!slug) throw usageError()
    return {
      kind: "desk",
      tool: "task_archive",
      toolArgs: { path: taskMdPath(slug) },
    }
  }

  if (sub === "show") {
    const slug = rest[0]
    if (!slug) throw usageError()
    return {
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: slug, filters: { kind: "task" } },
    }
  }

  throw usageError()
}

function parseTrackSubverb(args: string[]): DeskCliCommand {
  const [sub, ...rest] = args
  if (!sub) throw usageError()

  if (sub === "list") {
    return {
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: "", filters: { kind: "track" } },
    }
  }

  if (sub === "new") {
    const slug = rest[0]
    if (!slug) throw usageError()
    return {
      kind: "desk",
      tool: "track_create",
      toolArgs: { slug },
    }
  }

  if (sub === "show") {
    const slug = rest[0]
    if (!slug) throw usageError()
    return {
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query: slug, filters: { kind: "track" } },
    }
  }

  throw usageError()
}

function parseFrictionSubverb(args: string[]): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub !== "add") throw usageError()
  const text = rest.join(" ").trim()
  if (!text) throw usageError()
  return {
    kind: "desk",
    tool: "friction_add",
    toolArgs: { text },
  }
}

function parseLessonSubverb(args: string[]): DeskCliCommand {
  const [sub, ...rest] = args
  if (sub !== "add") throw usageError()
  const text = rest.join(" ").trim()
  if (!text) throw usageError()
  return {
    kind: "desk",
    tool: "lesson_add",
    toolArgs: { text },
  }
}

// ── Public parsers ──

/**
 * Parse the `ouro desk <subverb> ...` umbrella into a canonical desk command.
 */
export function parseDeskCommand(args: string[]): OuroCliCommand {
  const [head, ...rest] = args
  if (!head) throw usageError()

  if (head === "task") return parseTaskSubverb(rest)
  if (head === "track") return parseTrackSubverb(rest)
  if (head === "friction") return parseFrictionSubverb(rest)
  if (head === "lesson") return parseLessonSubverb(rest)

  if (head === "search") {
    const query = rest.join(" ").trim()
    if (!query) throw usageError()
    return {
      kind: "desk",
      tool: "desk_search",
      toolArgs: { query },
    }
  }

  if (head === "recall") {
    const query = rest.join(" ").trim()
    if (!query) throw usageError()
    return {
      kind: "desk",
      tool: "desk_recall",
      toolArgs: { query },
    }
  }

  if (head === "reindex") {
    return {
      kind: "desk",
      tool: "desk_reindex",
      toolArgs: {},
    }
  }

  if (head === "thread") {
    const startPath = rest[0]
    if (!startPath) throw usageError()
    return {
      kind: "desk",
      tool: "desk_thread",
      toolArgs: { start_path: startPath },
    }
  }

  throw usageError()
}

/**
 * Parse `ouro task <subverb> ...` as an alias for `ouro desk task <subverb> ...`.
 */
export function parseTaskAliasCommand(args: string[]): OuroCliCommand {
  return parseTaskSubverb(args)
}

// ── Executor ──

/**
 * Route a parsed desk command through the daemon socket as `mcp.call(server:
 * "desk", tool, args)` and render the response.
 *
 * The daemon's `mcp.call` handler (see `daemon.ts`) reaches into the shared
 * MCP manager — which Unit 9's plugin-MCP wiring populates with the
 * auto-spawned desk server per running agent.
 */
export async function executeDeskCommand(
  command: DeskCliCommand,
  deps: OuroCliDeps,
): Promise<string> {
  emitNervesEvent({
    component: "daemon",
    event: "daemon.desk_cli_dispatch",
    message: `ouro desk → mcp__desk__${command.tool}`,
    meta: { tool: command.tool, ...(command.agent ? { agent: command.agent } : {}) },
  })

  const daemonCommand = {
    kind: "mcp.call" as const,
    server: "desk",
    tool: command.tool,
    args: JSON.stringify(command.toolArgs),
    ...(command.agent ? { agent: command.agent } : {}),
  }

  let response: DaemonResponse
  try {
    response = await deps.sendCommand(deps.socketPath, daemonCommand)
  } catch {
    const message = "daemon unavailable — start with `ouro up` first"
    deps.writeStdout(message)
    return message
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
