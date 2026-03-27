// Pluggable session ID resolver for MCP conversations.
// Tries tool-specific methods first, falls back to UUID.
//
// Claude Code: walks parent PID chain -> reads ~/.claude/sessions/{pid}.json
// Codex: reads thread_id from env (future)
// Fallback: generates UUID

import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { randomUUID } from "crypto"
import { emitNervesEvent } from "../../nerves/runtime"

export interface SessionIdResolverOptions {
  /** Override the Claude sessions directory (for testing). */
  claudeSessionsDir?: string
}

const DEFAULT_CLAUDE_SESSIONS_DIR = path.join(os.homedir(), ".claude", "sessions")
const MAX_PID_WALK_DEPTH = 10

/**
 * Try to read a Claude Code session ID from a PID-keyed session file.
 * Returns the sessionId if found, null otherwise.
 */
function tryReadClaudeSession(sessionsDir: string, pid: number): string | null {
  const sessionFile = path.join(sessionsDir, `${pid}.json`)
  if (!fs.existsSync(sessionFile)) return null
  try {
    const raw = fs.readFileSync(sessionFile, "utf-8")
    const data = JSON.parse(raw)
    if (typeof data.sessionId === "string" && data.sessionId.length > 0) {
      return data.sessionId
    }
    return null
  } catch {
    return null
  }
}

/**
 * Walk the parent PID chain looking for a Claude Code session file.
 * Starts at the current process PID, walks up to parent, grandparent, etc.
 * Returns the session ID from the first matching file, or null.
 */
function walkPidChain(sessionsDir: string): string | null {
  let currentPid = process.pid
  for (let depth = 0; depth < MAX_PID_WALK_DEPTH; depth++) {
    const sessionId = tryReadClaudeSession(sessionsDir, currentPid)
    if (sessionId) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.session_id_pid_walk_hit",
        message: "found Claude session via PID walk",
        meta: { pid: currentPid, depth, sessionId },
      })
      return sessionId
    }

    // Walk to parent PID
    // On macOS/Linux, process.ppid gives the parent. For deeper ancestry,
    // we'd need /proc/{pid}/stat or ps -o ppid=. For now, we check current + parent.
    if (depth === 0) {
      currentPid = process.ppid
    } else {
      // Cannot walk further without OS-specific process tree APIs
      break
    }
  }
  return null
}

/**
 * Resolve a session ID for the current MCP connection.
 * Returns a stable identifier that ties MCP tool calls to a conversation session.
 *
 * Resolution order:
 * 1. Claude Code PID walk: check ~/.claude/sessions/{pid}.json for current + parent PID
 * 2. UUID fallback: generate a random UUID
 */
export function resolveSessionId(options?: SessionIdResolverOptions): string {
  const sessionsDir = options?.claudeSessionsDir ?? DEFAULT_CLAUDE_SESSIONS_DIR

  // Try Claude Code PID walk
  const claudeSessionId = walkPidChain(sessionsDir)
  if (claudeSessionId) {
    emitNervesEvent({
      component: "daemon",
      event: "daemon.session_id_resolved",
      message: "session ID resolved via Claude Code PID walk",
      meta: { sessionId: claudeSessionId, method: "claude-pid-walk" },
    })
    return claudeSessionId
  }

  // Fallback: UUID
  const sessionId = randomUUID()
  emitNervesEvent({
    component: "daemon",
    event: "daemon.session_id_resolved",
    message: "session ID resolved via UUID fallback",
    meta: { sessionId, method: "uuid-fallback" },
  })
  return sessionId
}
