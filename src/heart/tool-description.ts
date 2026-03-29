import { emitNervesEvent } from "../nerves/runtime"

/**
 * One-line human-readable description of what a tool is doing.
 * Returns `null` for tools that should be hidden (e.g. settle, rest — they ARE the response).
 */

type DescriptionBuilder = (args: Record<string, string>) => string | null

function basename(filePath: string): string {
  const idx = filePath.lastIndexOf("/")
  return idx >= 0 ? filePath.slice(idx + 1) : filePath
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + "\u2026"
}

const TOOL_DESCRIPTIONS: Record<string, DescriptionBuilder> = {
  shell: (args) => {
    const cmd = args.command
    if (!cmd) return "running a command..."
    return `running ${truncate(cmd, 50)}...`
  },
  read_file: (args) => {
    const fp = args.path || args.file_path
    if (!fp) return "reading a file..."
    return `reading ${basename(fp)}...`
  },
  write_file: (args) => {
    const fp = args.path || args.file_path
    if (!fp) return "writing a file..."
    return `writing ${basename(fp)}...`
  },
  edit_file: (args) => {
    const fp = args.path || args.file_path
    if (!fp) return "editing a file..."
    return `editing ${basename(fp)}...`
  },
  recall: (args) => {
    const q = args.query
    if (!q) return "searching memory..."
    return `searching memory for '${truncate(q, 40)}'...`
  },
  grep: (args) => {
    const p = args.pattern
    if (!p) return "searching code..."
    return `searching code for '${truncate(p, 40)}'...`
  },
  glob: (args) => {
    const p = args.pattern
    if (!p) return "searching for files..."
    return `searching for ${truncate(p, 40)}...`
  },
  query_session: () => "checking session history...",
  web_search: () => "searching the web...",
  coding_spawn: () => "starting coding session...",
  ponder: () => "thinking deeper...",
  observe: () => "listening...",
  diary_write: () => "noting something down...",
  save_friend_note: () => "making a note...",
  settle: () => null,
  rest: () => null,
}

export function humanReadableToolDescription(
  name: string,
  args: Record<string, string>,
): string | null {
  emitNervesEvent({
    component: "engine",
    event: "engine.tool_description",
    message: "generated human-readable tool description",
    meta: { tool: name },
  })

  const builder = TOOL_DESCRIPTIONS[name]
  if (builder) return builder(args)

  // MCP tools: mcp__server__toolname — extract last segment
  if (name.startsWith("mcp__")) {
    const parts = name.split("__")
    const toolName = parts[parts.length - 1]
    return `using ${toolName}...`
  }

  return `using ${name}...`
}
