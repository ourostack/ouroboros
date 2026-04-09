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
  // Cut at last space before maxLen to avoid mid-word truncation
  const slice = text.slice(0, max - 1)
  const lastSpace = slice.lastIndexOf(" ")
  if (lastSpace > 0) return text.slice(0, lastSpace) + "\u2026"
  // No space found (single long word) — hard truncate
  return slice + "\u2026"
}

const TOOL_DESCRIPTIONS: Record<string, DescriptionBuilder> = {
  // File operations
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
  glob: (args) => {
    const p = args.pattern
    if (!p) return "searching for files..."
    return `searching for ${truncate(p, 40)}...`
  },
  grep: (args) => {
    const p = args.pattern
    if (!p) return "searching code..."
    return `searching code for '${truncate(p, 40)}'...`
  },

  // Memory and knowledge
  recall: (args) => {
    const q = args.query
    if (!q) return "searching memory..."
    return `searching memory for '${truncate(q, 40)}'...`
  },
  diary_write: (args) => {
    const about = args.about
    return about ? `noting something about ${truncate(about, 30)}...` : "noting something down..."
  },
  save_friend_note: () => "making a note about you...",
  get_friend_note: () => "checking my notes...",
  load_skill: (args) => {
    const name = args.name || args.skill
    return name ? `loading ${name} skill...` : "loading a skill..."
  },

  // Session and context
  query_session: (args) => {
    const mode = args.mode
    if (mode === "search") return `searching session for '${truncate(args.query || "", 30)}'...`
    if (mode === "status") return "checking inner session status..."
    return "checking session history..."
  },
  web_search: (args) => {
    const q = args.query
    return q ? `searching the web for '${truncate(q, 35)}'...` : "searching the web..."
  },
  coding_spawn: (args) => {
    const runner = args.runner
    return runner ? `starting ${runner} coding session...` : "starting coding session..."
  },
  coding_status: () => "checking coding sessions...",
  coding_tail: () => "reading coding output...",
  coding_kill: () => "stopping coding session...",
  bridge_manage: () => "managing conversation bridge...",

  // Communication
  send_message: (args) => {
    const to = args.to
    return to ? `sending a message to ${to}...` : "sending a message..."
  },
  surface: () => "sharing a thought...",

  // Metacognitive (agent's inner life)
  ponder: (args) => {
    const objective = args.objective || args.thought
    return objective ? `bookmarking ${truncate(objective, 40)}...` : "bookmarking deeper work..."
  },
  observe: () => null,
  claude: () => "reasoning...",
  set_reasoning_effort: (args) => {
    const level = args.level
    return level ? `setting thinking depth to ${level}...` : "adjusting thinking depth..."
  },

  // Hidden — these ARE the response or end-of-turn
  settle: () => null,
  rest: () => null,
  descend: () => null,
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
