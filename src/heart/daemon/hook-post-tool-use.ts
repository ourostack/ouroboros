/**
 * `ouro hook post-tool-use --agent <agent>`, without loading the CLI.
 *
 * Claude Code runs this after every Bash, Edit and Write call in every session (`ouro setup`'s PostToolUse hook), so
 * with 20 sessions open it runs many times a minute. Through the full CLI each call took about 340 ms of wall time and
 * 0.3 s of CPU (measured 2026-11-22 on alpha.1354, recorded in the PR), almost all of it loading modules to send one
 * message. The entry point sends it here instead, importing only node modules and the socket client, and sends at most
 * one note per session in each quiet window: the note says only that the session used a tool, which the agent already
 * knows from the first one, and the hook never wakes the agent.
 *
 * It skips without a send when the hook fires inside a subagent (Claude Code puts `agent_id` on the event), when the
 * session already sent within the quiet window, or when the daemon's socket is missing. It always answers
 * `{"continue":true}`, so a slow or absent daemon never holds up the tool call.
 */
import * as crypto from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { DEFAULT_DAEMON_SOCKET_PATH, sendDaemonCommand } from "./socket-client"
import { emitNervesEvent } from "../../nerves/runtime"
import type { DaemonCommand } from "./daemon"

/** How long a session's tool use stays news: one note per session in each window. */
export const POST_TOOL_USE_QUIET_MS = 5 * 60 * 1000
/** The hook's whole budget for the send; Claude Code's own timeout is 5 s. */
export const POST_TOOL_USE_SEND_TIMEOUT_MS = 2_000

/** True for exactly `hook post-tool-use --agent <agent>`, the argv the entry point hands this module. */
export function isPostToolUseHook(argv: readonly string[]): boolean {
  return argv.length === 4 && argv[0] === "hook" && argv[1] === "post-tool-use" && argv[2] === "--agent" && /^[A-Za-z0-9._-]+$/.test(argv[3])
}

export interface PostToolUseDeps {
  readStdin(): string
  writeStdout(text: string): void
  socketPath: string
  /** Where each session's last send is stamped. */
  stampDir: string
  now(): number
  send(socketPath: string, command: DaemonCommand, options: { timeoutMs: number }): Promise<unknown>
}

export type PostToolUseOutcome = "sent" | "subagent" | "quiet" | "no-daemon" | "send-failed"

function stampPath(dir: string, agent: string, sessionId: string): string {
  return path.join(dir, `${agent}-${crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`)
}

/** Within the quiet window since this session's last send. A missing or unreadable stamp is not. */
function quiet(file: string, now: number): boolean {
  try {
    return now - fs.statSync(file).mtimeMs < POST_TOOL_USE_QUIET_MS
  } catch {
    return false
  }
}

function stamp(dir: string, file: string, now: number): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(file, "")
    fs.utimesSync(file, now / 1000, now / 1000)
  } catch {
    // An unwritable stamp only means the next call sends again.
  }
}

export async function runPostToolUseHook(agent: string, deps: PostToolUseDeps): Promise<PostToolUseOutcome> {
  const outcome = await decide(agent, deps)
  // Nothing configures a log sink in this process, so this costs only the runtime's import (about 10 ms).
  emitNervesEvent({ event: "daemon.hook_post_tool_use", component: "daemon", message: `post-tool-use hook: ${outcome}`, meta: { agent, outcome } })
  return outcome
}

async function decide(agent: string, deps: PostToolUseDeps): Promise<PostToolUseOutcome> {
  try {
    let event: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(deps.readStdin())
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) event = parsed as Record<string, unknown>
    } catch {
      // Malformed or missing input still answers continue, as the CLI did.
    }
    if (typeof event.agent_id === "string" && event.agent_id !== "") return "subagent"
    const sessionId = typeof event.session_id === "string" && event.session_id !== "" ? event.session_id : "unknown"
    const toolName = typeof event.tool_name === "string" ? event.tool_name : ""
    const file = stampPath(deps.stampDir, agent, sessionId)
    const now = deps.now()
    if (quiet(file, now)) return "quiet"
    if (!fs.existsSync(deps.socketPath)) return "no-daemon"
    stamp(deps.stampDir, file, now)
    try {
      await deps.send(deps.socketPath, {
        kind: "message.send", from: `claude-code:${sessionId}`, to: agent,
        content: `[Claude Code used ${toolName} in session ${sessionId}]`,
      } as DaemonCommand, { timeoutMs: POST_TOOL_USE_SEND_TIMEOUT_MS })
      return "sent"
    } catch {
      return "send-failed"
    }
  } finally {
    deps.writeStdout(JSON.stringify({ continue: true }))
  }
}

/* v8 ignore start -- the real process's stdin, stdout and socket @preserve */
export function defaultPostToolUseDeps(): PostToolUseDeps {
  return {
    readStdin: () => { try { return fs.readFileSync(0, "utf-8") } catch { return "" } },
    writeStdout: (text) => { process.stdout.write(text) },
    socketPath: DEFAULT_DAEMON_SOCKET_PATH,
    stampDir: path.join(os.tmpdir(), "ouro-hook-post-tool-use"),
    now: () => Date.now(),
    send: (socketPath, command, options) => sendDaemonCommand(socketPath, command, options),
  }
}
/* v8 ignore stop */
