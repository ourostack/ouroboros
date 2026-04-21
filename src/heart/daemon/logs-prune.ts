import { existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { randomUUID } from "crypto"

import {
  DEFAULT_MAX_GENERATIONS,
  DEFAULT_MAX_LOG_SIZE_BYTES,
  rotateIfNeeded,
} from "../../nerves"
import { emitNervesEvent } from "../../nerves/runtime"
import { getAgentDaemonLogsDir } from "../identity"

/**
 * Apply the current rotation policy to every active `.ndjson` and `.log` file
 * in the daemon logs directory, compacting any file that's over the threshold.
 *
 * Concurrent-writer safety
 * ------------------------
 * This helper drives `rotateIfNeeded`, which uses a rename-then-gzip pattern:
 * the active file is renamed first (the inode stays alive for any open writer
 * fd), and the rename target is then gzipped. An active writer keeps writing
 * to its original fd until its next stat check, at which point it sees the
 * path is gone and creates a fresh file. No additional locking is needed.
 *
 * This makes `ouro logs prune` safe to run while the daemon is up: worst
 * case, the last few events before the stat-check cycle end up in an
 * orphaned inode that the writer will release on its next file cycle.
 */
export interface PruneDaemonLogsOptions {
  /** Defaults to the canonical agent daemon logs dir for the active agent. */
  logsDir?: string
  /** Override the rotation threshold. Default: 25 MB. */
  maxSizeBytes?: number
  /** Override the generation cap. Default: 5. */
  maxGenerations?: number
  /** Override the agent name used to resolve the default logs dir. */
  agentName?: string
}

export interface PruneDaemonLogsResult {
  filesCompacted: number
  bytesFreed: number
}

function isActiveLogStream(name: string): boolean {
  if (name.endsWith(".ndjson")) {
    return !/\.\d+\.ndjson$/.test(name)
  }
  if (name.endsWith(".log")) {
    return !/\.\d+\.log$/.test(name)
  }
  return false
}

export function pruneDaemonLogs(options: PruneDaemonLogsOptions = {}): PruneDaemonLogsResult {
  /* v8 ignore next -- defensive: tests always pass logsDir to avoid prod paths @preserve */
  const logsDir = options.logsDir ?? getAgentDaemonLogsDir(options.agentName)
  const maxSizeBytes = options.maxSizeBytes ?? DEFAULT_MAX_LOG_SIZE_BYTES
  const maxGenerations = options.maxGenerations ?? DEFAULT_MAX_GENERATIONS
  const traceId = randomUUID()

  emitNervesEvent({
    component: "nerves",
    event: "nerves.logs_prune_start",
    trace_id: traceId,
    message: "pruning daemon logs",
    meta: { logsDir, maxSizeBytes, maxGenerations },
  })

  let completed = false
  try {
    if (!existsSync(logsDir)) {
      completed = true
      emitNervesEvent({
        component: "nerves",
        event: "nerves.logs_prune_end",
        trace_id: traceId,
        message: "daemon logs dir does not exist",
        meta: { logsDir, filesCompacted: 0, bytesFreed: 0 },
      })
      return { filesCompacted: 0, bytesFreed: 0 }
    }

    let filesCompacted = 0
    let bytesFreed = 0

    // Enumerate and rotate each active structured stream plus legacy launchd
    // .log streams. We explicitly skip .gz and other files — only the active
    // stream can be a rotation candidate. Legacy generation files are handled
    // inside rotateIfNeeded's generation-shift step, so we skip them here to
    // avoid double-rotating.
    for (const name of readdirSync(logsDir)) {
      if (!isActiveLogStream(name)) continue

      const filePath = join(logsDir, name)
      let sizeBefore: number
      try {
        sizeBefore = statSync(filePath).size
      /* v8 ignore start -- defensive: file disappears between readdir and stat @preserve */
      } catch {
        continue
      }
      /* v8 ignore stop */

      if (sizeBefore < maxSizeBytes) continue

      // rotateIfNeeded returns true because we pre-checked sizeBefore >=
      // maxSizeBytes above. The false branch of `if (rotated)` is defensive
      // and unreachable under normal flow; we skip it from coverage so a
      // future refactor that weakens the pre-check still reports correct
      // counts without needing a contrived test.
      const rotated = rotateIfNeeded(filePath, {
        maxSizeBytes,
        maxGenerations,
        compress: true,
      })
      /* v8 ignore next 3 -- defensive: pre-check guarantees rotated=true @preserve */
      if (!rotated) {
        continue
      }
      filesCompacted += 1
      bytesFreed += sizeBefore
    }

    completed = true
    emitNervesEvent({
      component: "nerves",
      event: "nerves.logs_prune_end",
      trace_id: traceId,
      message: "daemon logs pruned",
      meta: { logsDir, filesCompacted, bytesFreed },
    })
    return { filesCompacted, bytesFreed }
  } catch (err) {
    /* v8 ignore next -- defensive: completed=true only reached after try returns @preserve */
    if (!completed) {
      /* v8 ignore next -- defensive: rotation always throws real Errors @preserve */
      const reason = err instanceof Error ? err.message : String(err)
      emitNervesEvent({
        component: "nerves",
        event: "nerves.logs_prune_error",
        trace_id: traceId,
        level: "error",
        message: "daemon logs prune failed",
        meta: { logsDir, error: reason },
      })
    }
    throw err
  }
}
