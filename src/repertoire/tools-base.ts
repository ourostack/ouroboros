import type OpenAI from "openai";
import * as fs from "fs";
import * as fg from "fast-glob";
import { execSync, spawnSync } from "child_process";
import * as path from "path";
import { listSkills, loadSkill } from "./skills";
import { spawnBackgroundShell, getShellSession, listShellSessions, tailShellSession, detectDestructivePatterns } from "./shell-sessions";
import { getIntegrationsConfig, resolveSessionPath } from "../heart/config";
import type { Integration, ResolvedContext, FriendRecord } from "../mind/friends/types";
import type { FriendStore } from "../mind/friends/store";
import { emitNervesEvent } from "../nerves/runtime";
import { fileStateCache } from "../mind/file-state";
import { trackModifiedFile, getModifiedFileCount, getPostImplementationScrutiny } from "../mind/scrutiny";
import { getAgentRoot, getAgentName, loadAgentConfig } from "../heart/identity";
import { getRepoRoot } from "../heart/identity";
import { getRegistryEntries, getRegistryEntriesByTopic, getRegistryEntry } from "../heart/config-registry";
import { requestInnerWake } from "../heart/daemon/socket-client";
import {
  deriveInnerDialogStatus,
  deriveInnerJob,
  extractThoughtResponseFromMessages,
  formatSurfacedValue,
  getInnerDialogSessionPath,
  readInnerDialogRawData,
  readInnerDialogStatus,
} from "../heart/daemon/thoughts";
import { createBridgeManager, formatBridgeStatus } from "../heart/bridges/manager";
import {
  recallSession,
  searchSessionTranscript,
  type SessionRecallOptions,
  type SessionRecallResult,
  type SessionSearchOptions,
  type SessionSearchResult,
} from "../heart/session-recall";
import { listSessionActivity } from "../heart/session-activity";
import { buildActiveWorkFrame, formatActiveWorkFrame, type ActiveWorkFrame } from "../heart/active-work";
import { codingToolDefinitions } from "./coding/tools";
import { getCodingSessionManager, type CodingSessionStatus } from "./coding";
import { readDiaryEntries, saveDiaryEntry, searchDiaryEntries } from "../mind/diary";
import { type JournalIndexEntry } from "../mind/associative-recall";
import { getTaskModule } from "./tasks";
import { getPendingDir, getInnerDialogPendingDir } from "../mind/pending";
import type { PendingMessage } from "../mind/pending";
import { createObligation as createInnerObligation, generateObligationId } from "../mind/obligations";
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import { buildProgressStory, renderProgressStory } from "../heart/progress-story";
import { deliverCrossChatMessage, type CrossChatDeliveryResult } from "../heart/cross-chat-delivery";
import { createObligation, readPendingObligations } from "../heart/obligations";
import { readRecentEpisodes, emitEpisode } from "../mind/episodes";
import { readActiveCares, readCares, createCare, updateCare, resolveCare } from "../heart/cares";
import { readPresence, readPeerPresence } from "../heart/presence";
import { captureIntention, resolveIntention, dismissIntention } from "../heart/intentions";

export interface CodingFeedbackTarget {
  send: (message: string) => Promise<void>;
}

export type BlueBubblesReplyTargetSelection =
  | { target: "current_lane" }
  | { target: "top_level" }
  | { target: "thread"; threadOriginatorGuid: string }

export interface BlueBubblesReplyTargetController {
  setSelection: (selection: BlueBubblesReplyTargetSelection) => string;
}

export interface ToolContext {
  graphToken?: string;
  adoToken?: string;
  githubToken?: string;
  signin: (connectionName: string) => Promise<string | undefined>;
  context?: ResolvedContext;
  friendStore?: FriendStore;
  summarize?: (transcript: string, instruction: string) => Promise<string>;
  codingFeedback?: CodingFeedbackTarget;
  tenantId?: string;
  // Bot Framework API client for proactive messaging (Teams channel only).
  // Provides conversations.create() and conversations.activities().create().
  // Uses `unknown` wrapper to avoid coupling to @microsoft/teams.api types.
  botApi?: {
    id: string;
    conversations: unknown;
  };
  bluebubblesReplyTarget?: BlueBubblesReplyTargetController;
  currentSession?: BridgeSessionRef;
  activeBridges?: BridgeRecord[];
  activeWorkFrame?: ActiveWorkFrame;
  supportedReasoningEfforts?: readonly string[];
  setReasoningEffort?: (level: string) => void;
  delegatedOrigins?: import("../senses/attention-queue").AttentionItem[];
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  handler: ToolHandler;
  integration?: Integration;
  confirmationRequired?: boolean;
  requiredCapability?: import("../heart/core").ProviderCapability;
  summaryKeys?: string[];
}

// Tracks which file paths have been read via read_file in this session.
// edit_file requires a file to be read first (must-read-first guard).
export const editFileReadTracker = new Set<string>();

function buildContextDiff(lines: string[], changeStart: number, changeEnd: number, contextSize = 3): string {
  const start = Math.max(0, changeStart - contextSize)
  const end = Math.min(lines.length, changeEnd + contextSize)
  const result: string[] = []
  for (let i = start; i < end; i++) {
    const lineNum = i + 1
    const prefix = (i >= changeStart && i < changeEnd) ? ">" : " "
    result.push(`${prefix} ${lineNum} | ${lines[i]}`)
  }
  return result.join("\n")
}

function resolveLocalToolPath(targetPath: string): string {
  if (!path.isAbsolute(targetPath)) {
    return path.resolve(getRepoRoot(), targetPath)
  }
  return targetPath
}

const NO_SESSION_FOUND_MESSAGE = "no session found for that friend/channel/key combination."
const EMPTY_SESSION_MESSAGE = "session exists but has no non-system messages."

function findDelegatingBridgeId(ctx?: ToolContext): string | undefined {
  const currentSession = ctx?.currentSession
  if (!currentSession) return undefined
  return ctx?.activeBridges?.find((bridge) =>
    bridge.lifecycle === "active"
    && bridge.attachedSessions.some((session) =>
      session.friendId === currentSession.friendId
      && session.channel === currentSession.channel
      && session.key === currentSession.key,
    ),
  )?.id
}

async function recallSessionSafely(options: SessionRecallOptions): Promise<SessionRecallResult | { kind: "missing" }> {
  try {
    return await recallSession(options)
  } catch (error) {
    if (options.summarize) {
      emitNervesEvent({
        component: "daemon",
        event: "daemon.session_recall_summary_fallback",
        message: "session recall summarization failed; using raw transcript",
        meta: {
          friendId: options.friendId,
          channel: options.channel,
          key: options.key,
          error: error instanceof Error ? error.message : String(error),
        },
      })
      try {
        return await recallSession({
          ...options,
          summarize: undefined,
        })
      } catch {
        return { kind: "missing" }
      }
    }
    return { kind: "missing" }
  }
}

async function searchSessionSafely(options: SessionSearchOptions): Promise<SessionSearchResult | { kind: "missing" }> {
  try {
    return await searchSessionTranscript(options)
  } catch {
    return { kind: "missing" }
  }
}

function normalizeProgressOutcome(text: string): string | null {
  const trimmed = text.trim()
  /* v8 ignore next -- defensive: normalizeProgressOutcome null branch @preserve */
  if (!trimmed || trimmed === "nothing yet" || trimmed === "nothing recent") {
    return null
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"") && trimmed.length >= 2) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function writePendingEnvelope(queueDir: string, message: PendingMessage): void {
  fs.mkdirSync(queueDir, { recursive: true })
  const fileName = `${message.timestamp}-${Math.random().toString(36).slice(2, 10)}.json`
  const filePath = path.join(queueDir, fileName)
  fs.writeFileSync(filePath, JSON.stringify(message, null, 2))
}

function renderCrossChatDeliveryStatus(
  target: string,
  result: CrossChatDeliveryResult,
): string {
  const phase = result.status === "delivered_now"
    ? "completed"
    : result.status === "queued_for_later"
      ? "queued"
      : result.status === "blocked"
        ? "blocked"
        : "errored"
  const lead = result.status === "delivered_now"
    ? "delivered now"
    : result.status === "queued_for_later"
      ? "queued for later"
      : result.status === "blocked"
        ? "blocked"
        : "failed"

  return renderProgressStory(buildProgressStory({
    scope: "shared-work",
    phase,
    objective: `message to ${target}`,
    outcomeText: `${lead}\n${result.detail}`,
  }))
}

function emptyTaskBoard() {
  return {
    compact: "",
    full: "",
    byStatus: {
      drafting: [],
      processing: [],
      validating: [],
      collaborating: [],
      paused: [],
      blocked: [],
      done: [],
      cancelled: [],
    },
    issues: [],
    actionRequired: [],
    unresolvedDependencies: [],
    activeSessions: [],
    activeBridges: [],
  }
}

function isLiveCodingSessionStatus(status: CodingSessionStatus): boolean {
  return status === "spawning"
    || status === "running"
    || status === "waiting_input"
    || status === "stalled"
}

function readActiveWorkInnerState(): ActiveWorkFrame["inner"] {
  const defaultJob = {
    status: "idle" as const,
    content: null,
    origin: null,
    mode: "reflect" as const,
    obligationStatus: null,
    surfacedResult: null,
    queuedAt: null,
    startedAt: null,
    surfacedAt: null,
  }
  try {
    const agentRoot = getAgentRoot()
    const pendingDir = getInnerDialogPendingDir(getAgentName())
    const sessionPath = getInnerDialogSessionPath(agentRoot)
    const { pendingMessages, turns, runtimeState } = readInnerDialogRawData(sessionPath, pendingDir)
    const dialogStatus = deriveInnerDialogStatus(pendingMessages, turns, runtimeState)
    const job = deriveInnerJob(pendingMessages, turns, runtimeState)
    const storeObligationPending = readPendingObligations(agentRoot).length > 0
    return {
      status: dialogStatus.processing === "started" ? "running" : "idle",
      hasPending: dialogStatus.queue !== "clear",
      origin: dialogStatus.origin,
      contentSnippet: dialogStatus.contentSnippet,
      obligationPending: dialogStatus.obligationPending || storeObligationPending,
      job,
    }
  } catch {
    return {
      status: "idle",
      hasPending: false,
      job: defaultJob,
    }
  }
}

async function buildToolActiveWorkFrame(ctx?: ToolContext): Promise<ActiveWorkFrame> {
  const currentSession = ctx?.currentSession
    ? {
        friendId: ctx.currentSession.friendId,
        channel: ctx.currentSession.channel as import("../mind/friends/types").Channel,
        key: ctx.currentSession.key,
        sessionPath: resolveSessionPath(ctx.currentSession.friendId, ctx.currentSession.channel, ctx.currentSession.key),
      }
    : null
  const agentRoot = getAgentRoot()
  const bridges = currentSession
    ? createBridgeManager().findBridgesForSession({
        friendId: currentSession.friendId,
        channel: currentSession.channel,
        key: currentSession.key,
      })
    : []

  let friendActivity = [] as ReturnType<typeof listSessionActivity>
  try {
    friendActivity = listSessionActivity({
      sessionsDir: `${agentRoot}/state/sessions`,
      friendsDir: `${agentRoot}/friends`,
      agentName: getAgentName(),
      currentSession,
    })
  } catch {
    friendActivity = []
  }

  const pendingObligations = (() => {
    try {
      return readPendingObligations(agentRoot)
    } catch {
      return []
    }
  })()

  let codingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  let otherCodingSessions = [] as ReturnType<ReturnType<typeof getCodingSessionManager>["listSessions"]>
  try {
    const liveCodingSessions = getCodingSessionManager()
      .listSessions()
      .filter((session) => isLiveCodingSessionStatus(session.status) && Boolean(session.originSession))
    if (currentSession) {
      codingSessions = liveCodingSessions.filter((session) =>
        session.originSession?.friendId === currentSession.friendId
        && session.originSession.channel === currentSession.channel
        && session.originSession.key === currentSession.key,
      )
      otherCodingSessions = liveCodingSessions.filter((session) =>
        !(
          session.originSession?.friendId === currentSession.friendId
          && session.originSession.channel === currentSession.channel
          && session.originSession.key === currentSession.key
        ),
      )
    } else {
      codingSessions = []
      otherCodingSessions = liveCodingSessions
    }
  } catch {
    codingSessions = []
    otherCodingSessions = []
  }

  const currentObligation = currentSession
    ? pendingObligations.find((obligation) =>
      obligation.status !== "fulfilled"
      && obligation.origin.friendId === currentSession.friendId
      && obligation.origin.channel === currentSession.channel
      && obligation.origin.key === currentSession.key,
    )?.content ?? null
    : null

  return buildActiveWorkFrame({
    currentSession,
    currentObligation,
    mustResolveBeforeHandoff: false,
    inner: readActiveWorkInnerState(),
    bridges,
    codingSessions,
    otherCodingSessions,
    pendingObligations,
    taskBoard: (() => {
      try {
        return getTaskModule().getBoard()
      } catch {
        return emptyTaskBoard()
      }
    })(),
    friendActivity,
    targetCandidates: [],
  })
}

export function renderInnerProgressStatus(
  status: { queue: string; wake: string; processing: string; surfaced: string },
): string {
  if (status.processing === "pending") {
    return "i've queued this thought for private attention. it'll come up when my inner dialog is free."
  }

  if (status.processing === "started") {
    return "i'm working through this privately right now."
  }

  // processed / completed
  if (status.surfaced && status.surfaced !== "nothing recent" && status.surfaced !== "no outward result") {
    return `i thought about this privately and came to something: ${status.surfaced}`
  }

  return "i thought about this privately. i'll bring it back when the time is right."
}

export const baseToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read file contents. Results include line numbers. Use offset/limit for large files -- don't read the whole thing if you only need a section. Use this tool before editing any file. When reading code, read enough context to understand the surrounding logic, not just the target line.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "number", description: "1-based line number to start reading from" },
            limit: { type: "number", description: "maximum number of lines to return" },
          },
          required: ["path"],
        },
      },
    },
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
      const content = fs.readFileSync(resolvedPath, "utf-8")
      editFileReadTracker.add(resolvedPath)
      const offset = a.offset ? parseInt(a.offset, 10) : undefined
      const limit = a.limit ? parseInt(a.limit, 10) : undefined

      // Record in file state cache for staleness detection
      try {
        const mtime = fs.statSync(resolvedPath).mtimeMs
        const readContent = (offset === undefined && limit === undefined)
          ? content
          : content.split("\n").slice(offset ? offset - 1 : 0, limit !== undefined ? (offset ? offset - 1 : 0) + limit : undefined).join("\n")
        fileStateCache.record(resolvedPath, readContent, mtime, offset, limit)
      } catch {
        // stat failed -- skip cache recording
      }

      if (offset === undefined && limit === undefined) return content
      const lines = content.split("\n")
      const start = offset ? offset - 1 : 0
      const end = limit !== undefined ? start + limit : lines.length
      return lines.slice(start, end).join("\n")
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "write_file",
        description: "Prefer this tool for creating new files or fully replacing existing ones. You MUST read an existing file with read_file before overwriting it. Prefer edit_file for modifying existing files -- it only sends the diff. Do not create documentation files (*.md, README) by default; only do so when explicitly asked or when documentation is clearly part of the requested change.",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
      fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
      fs.writeFileSync(resolvedPath, a.content, "utf-8")
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return scrutiny ? `ok\n\n${scrutiny}` : "ok"
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "Surgically edit a file by replacing an exact string. The file MUST have been read via read_file first -- this tool will reject the call otherwise. old_string must match EXACTLY ONE location in the file -- if it matches zero or multiple, the edit fails. To fix: provide more surrounding context to make the match unique. Preserve exact indentation (tabs/spaces) from the file. Prefer this over write_file for modifications -- it only sends the diff.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string" },
            old_string: { type: "string" },
            new_string: { type: "string" },
          },
          required: ["path", "old_string", "new_string"],
        },
      },
    },
    handler: (a) => {
      const resolvedPath = resolveLocalToolPath(a.path)
      if (!editFileReadTracker.has(resolvedPath)) {
        return `error: you must read the file with read_file before editing it. call read_file on ${a.path} first.`
      }

      // Check staleness before editing
      const stalenessCheck = fileStateCache.isStale(resolvedPath)

      let content: string
      try {
        content = fs.readFileSync(resolvedPath, "utf-8")
      } catch (e) {
        return `error: could not read file: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`
      }

      // Count occurrences
      const occurrences: number[] = []
      let searchFrom = 0
      while (true) {
        const idx = content.indexOf(a.old_string, searchFrom)
        if (idx === -1) break
        occurrences.push(idx)
        searchFrom = idx + 1
      }

      if (occurrences.length === 0) {
        return `error: old_string not found in ${a.path}`
      }

      if (occurrences.length > 1) {
        return `error: old_string is ambiguous -- found ${occurrences.length} matches in ${a.path}. provide more context to make the match unique.`
      }

      // Single unique match -- replace
      const idx = occurrences[0]
      const updated = content.slice(0, idx) + a.new_string + content.slice(idx + a.old_string.length)
      fs.writeFileSync(resolvedPath, updated, "utf-8")

      // Update file state cache with new content
      try {
        const newMtime = fs.statSync(resolvedPath).mtimeMs
        fileStateCache.record(resolvedPath, updated, newMtime)
      } catch {
        // stat failed -- skip cache update
      }

      // Build contextual diff
      const lines = updated.split("\n")
      const prefixLines = content.slice(0, idx).split("\n")
      const changeStartLine = prefixLines.length - 1
      const newStringLines = a.new_string.split("\n")
      const changeEndLine = changeStartLine + newStringLines.length

      const diffResult = buildContextDiff(lines, changeStartLine, changeEndLine)

      // Track modified file and compute scrutiny appendix
      trackModifiedFile(resolvedPath)
      const scrutiny = getPostImplementationScrutiny(getModifiedFileCount())

      // Append staleness warning if detected (do not block -- TTFA)
      /* v8 ignore start -- staleness+diff+scrutiny combo not exercised in integration tests @preserve */
      if (stalenessCheck.stale) {
        const base = `${diffResult}\n\n⚠️ warning: file changed externally since last read -- re-read recommended`
        return scrutiny ? `${base}\n\n${scrutiny}` : base
      }
      /* v8 ignore stop */
      /* v8 ignore next -- scrutiny appendix branch depends on session-level file count @preserve */
      return scrutiny ? `${diffResult}\n\n${scrutiny}` : diffResult
    },
    summaryKeys: ["path"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "glob",
        description: "Find files matching a glob pattern, sorted alphabetically. Use this instead of shell commands like `find` or `ls`. For broad exploratory searches that would require multiple rounds of globbing and grepping, consider using claude or coding_spawn.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "glob pattern (e.g. **/*.ts)" },
            cwd: { type: "string", description: "directory to search from (defaults to process.cwd())" },
          },
          required: ["pattern"],
        },
      },
    },
    handler: (a) => {
      const cwd = a.cwd ? resolveLocalToolPath(a.cwd) : process.cwd()
      const matches = fg.globSync(a.pattern, { cwd, dot: true })
      return matches.sort().join("\n")
    },
    summaryKeys: ["pattern", "cwd"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "grep",
        description:
          "Search file contents for lines matching a regex pattern. Searches recursively in directories. Use this instead of shell commands like `grep` or `rg`. Returns matching lines with file path and line numbers. Use context_lines for surrounding context. Use include to filter file types (e.g., '*.ts').",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "regex pattern to search for" },
            path: { type: "string", description: "file or directory to search" },
            context_lines: { type: "number", description: "number of surrounding context lines (default 0)" },
            include: { type: "string", description: "glob filter to limit searched files (e.g. *.ts)" },
          },
          required: ["pattern", "path"],
        },
      },
    },
    handler: (a) => {
      const targetPath = resolveLocalToolPath(a.path)
      const regex = new RegExp(a.pattern)
      const contextLines = parseInt(a.context_lines || "0", 10)
      const includeGlob = a.include || undefined

      function searchFile(filePath: string): string[] {
        let content: string
        try {
          content = fs.readFileSync(filePath, "utf-8")
        } catch {
          return []
        }
        const lines = content.split("\n")
        const matchIndices = new Set<number>()
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matchIndices.add(i)
          }
        }
        if (matchIndices.size === 0) return []

        const outputIndices = new Set<number>()
        for (const idx of matchIndices) {
          const start = Math.max(0, idx - contextLines)
          const end = Math.min(lines.length - 1, idx + contextLines)
          for (let i = start; i <= end; i++) {
            outputIndices.add(i)
          }
        }

        const sortedIndices = [...outputIndices].sort((a, b) => a - b)
        const results: string[] = []
        for (const idx of sortedIndices) {
          const lineNum = idx + 1
          if (matchIndices.has(idx)) {
            results.push(`${filePath}:${lineNum}: ${lines[idx]}`)
          } else {
            results.push(`-${filePath}:${lineNum}: ${lines[idx]}`)
          }
        }
        return results
      }

      function collectFiles(dirPath: string): string[] {
        const files: string[] = []
        function walk(dir: string) {
          let entries: fs.Dirent[]
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true })
          } catch {
            return
          }
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name)
            if (entry.isDirectory()) {
              walk(fullPath)
            } else if (entry.isFile()) {
              files.push(fullPath)
            }
          }
        }
        walk(dirPath)
        return files.sort()
      }

      function matchesGlob(filePath: string, glob: string): boolean {
        const escaped = glob
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")
          .replace(/\?/g, ".")
        return new RegExp(`(^|/)${escaped}$`).test(filePath)
      }

      const stat = fs.statSync(targetPath, { throwIfNoEntry: false })
      if (!stat) return ""

      if (stat.isFile()) {
        return searchFile(targetPath).join("\n")
      }

      let files = collectFiles(targetPath)
      if (includeGlob) {
        files = files.filter((f) => matchesGlob(f, includeGlob))
      }

      const allResults: string[] = []
      for (const file of files) {
        allResults.push(...searchFile(file))
      }
      return allResults.join("\n")
    },
    summaryKeys: ["pattern", "path", "include"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell",
        description: "Run a shell command and return stdout/stderr. Working directory persists between calls. Use dedicated tools instead of shell when available: read_file instead of cat, edit_file instead of sed, glob instead of find, grep instead of grep/rg. Reserve shell for operations that genuinely need the shell: installing packages, running builds/tests, git operations, process management. Be careful with destructive commands -- consider reversibility before running. If a command fails, read the error output before retrying with a different approach.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string" },
            timeout_ms: {
              type: "number",
              description: "Timeout in milliseconds. Default: 30000. Max: 600000.",
            },
            background: {
              type: "boolean",
              description: "Run in background. Returns immediately with a process ID. Use shell_status/shell_tail to monitor.",
            },
          },
          required: ["command"],
        },
      },
    },
    handler: (a) => {
      // Destructive pattern detection (friction, not a block)
      const destructivePatterns = detectDestructivePatterns(a.command)
      if (destructivePatterns.length > 0) {
        emitNervesEvent({
          level: "warn",
          event: "tool.shell.destructive_detected",
          component: "tools",
          message: `destructive pattern detected: ${destructivePatterns.join(", ")}`,
          meta: { command: a.command, patterns: destructivePatterns },
        })
      }

      // Background mode: spawn and return immediately
      if (a.background === "true") {
        const session = spawnBackgroundShell(a.command)
        return JSON.stringify({ id: session.id, command: session.command, status: session.status })
      }

      const MAX_TIMEOUT = 600000
      const requestedTimeout = Number(a.timeout_ms) || 0
      let configDefault = 30000
      try { configDefault = loadAgentConfig().shell?.defaultTimeout ?? 30000 } catch { /* test env: no --agent flag */ }
      const baseTimeout = requestedTimeout > 0 ? requestedTimeout : configDefault
      const timeout = Math.min(baseTimeout, MAX_TIMEOUT)
      const output = execSync(a.command, {
        encoding: "utf-8",
        timeout,
      })

      if (destructivePatterns.length > 0) {
        return `${output}\n\n--- destructive pattern detected: ${destructivePatterns.join(", ")} ---`
      }
      return output
    },
    summaryKeys: ["command"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell_status",
        description: "Check status of background shell processes. Omit id to list all.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
        },
      },
    },
    handler: (a) => {
      if (!a.id) {
        return JSON.stringify(listShellSessions())
      }
      const session = getShellSession(a.id)
      if (!session) return `process not found: ${a.id}`
      return JSON.stringify(session)
    },
    summaryKeys: ["id"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell_tail",
        description: "Show recent output from a background shell process.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Background shell process ID" },
          },
          required: ["id"],
        },
      },
    },
    handler: (a) => {
      /* v8 ignore next -- schema requires id, defensive guard @preserve */
      if (!a.id) return "id is required"
      const output = tailShellSession(a.id)
      if (output === undefined) return `process not found: ${a.id}`
      return output || "(no output yet)"
    },
    summaryKeys: ["id"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "list_skills",
        description: "list all available skills",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => JSON.stringify(listSkills()),
  },
  {
    tool: {
      type: "function",
      function: {
        name: "load_skill",
        description: "load a skill by name, returns its content",
        parameters: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    },
    handler: (a) => {
      try {
        return loadSkill(a.name);
      } catch (e) {
        return `error: ${e}`;
      }
    },
    summaryKeys: ["name"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "claude",
        description:
          "use claude code to query this codebase or get an outside perspective. Use for code review, second opinions, or questions that benefit from a fresh perspective outside this conversation's context.",
        parameters: {
          type: "object",
          properties: { prompt: { type: "string" } },
          required: ["prompt"],
        },
      },
    },
    handler: (a) => {
      try {
        const result = spawnSync(
          "claude",
          ["-p", "--no-session-persistence", "--dangerously-skip-permissions", "--add-dir", "."],
          {
            input: a.prompt,
            encoding: "utf-8",
            timeout: 60000,
          },
        );
        if (result.error) return `error: ${result.error}`;
        if (result.status !== 0)
          return `claude exited with code ${result.status}: ${result.stderr}`;
        return result.stdout || "(no output)";
      } catch (e) {
        return `error: ${e}`;
      }
    },
    summaryKeys: ["prompt"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "search the web using perplexity. returns ranked results with titles, urls, and snippets",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    handler: async (a) => {
      try {
        const key = getIntegrationsConfig().perplexityApiKey;
        if (!key) return "error: perplexityApiKey not configured in secrets.json";
        const res = await fetch("https://api.perplexity.ai/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: a.query, max_results: 5 }),
        });
        if (!res.ok) return `error: ${res.status} ${res.statusText}`;
        const data = (await res.json()) as {
          results?: { title: string; url: string; snippet: string }[];
        };
        if (!data.results?.length) return "no results found";
        return data.results
          .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
          .join("\n\n");
      } catch (e) {
        return `error: ${e}`;
      }
    },
    summaryKeys: ["query"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "recall",
        description:
          "Search my diary and journal for facts, thoughts, and working notes matching a query. Uses semantic similarity -- phrasing matters. Try different angles if the first query doesn't find what you're looking for. Check recall before asking the human something you might already know.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    },
    handler: async (a) => {
      try {
        const query = (a.query || "").trim();
        if (!query) return "query is required";

        const resultLines: string[] = [];

        // Search diary entries
        const hits = await searchDiaryEntries(query, readDiaryEntries());
        for (const fact of hits) {
          resultLines.push(`[diary] ${fact.text} (source=${fact.source}, createdAt=${fact.createdAt})`);
        }

        // Search journal index
        const agentRoot = getAgentRoot();
        const journalIndexPath = path.join(agentRoot, "journal", ".index.json");
        try {
          const raw = fs.readFileSync(journalIndexPath, "utf8");
          const journalEntries = JSON.parse(raw) as JournalIndexEntry[];
          if (Array.isArray(journalEntries) && journalEntries.length > 0) {
            // Substring match on preview and filename
            const lowerQuery = query.toLowerCase();
            for (const entry of journalEntries) {
              /* v8 ignore next 4 -- both sides tested (filename-only match in recall-journal.test.ts); v8 misreports || short-circuit @preserve */
              if (
                entry.preview.toLowerCase().includes(lowerQuery) ||
                entry.filename.toLowerCase().includes(lowerQuery)
              ) {
                resultLines.push(`[journal] ${entry.filename}: ${entry.preview}`);
              }
            }
          }
        } catch {
          // No journal index or malformed — skip journal search
        }

        return resultLines.join("\n");
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    summaryKeys: ["query"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "diary_write",
        description:
          "Write an entry in my diary -- something I learned, noticed, or concluded that I want to recall later. Use 'about' to tag the entry to a person, topic, or context. Write for my future self: include enough context that the entry makes sense without the surrounding conversation. Prefer durable conclusions over passing noise. Don't duplicate what already belongs in friend notes.",
        parameters: {
          type: "object",
          properties: {
            entry: { type: "string" },
            about: { type: "string" },
          },
          required: ["entry"],
        },
      },
    },
    handler: async (a) => {
      const entry = (a.entry || "").trim();
      if (!entry) return "entry is required";
      const result = await saveDiaryEntry({
        text: entry,
        source: "tool:diary_write",
        about: typeof a.about === "string" ? a.about : undefined,
      });
      return `saved diary entry (added=${result.added}, skipped=${result.skipped})`;
    },
    summaryKeys: ["entry", "about"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "get_friend_note",
        description:
          "read a specific friend record by friend id. use this when i need notes/context about someone not currently active",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string" },
          },
          required: ["friendId"],
        },
      },
    },
    handler: async (a, ctx) => {
      const friendId = (a.friendId || "").trim();
      if (!friendId) return "friendId is required";
      if (!ctx?.friendStore) return "i can't read friend notes -- friend store not available";

      const friend = await ctx.friendStore.get(friendId);
      if (!friend) return `friend not found: ${friendId}`;
      return JSON.stringify(friend, null, 2);
    },
    summaryKeys: ["friendId"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "save_friend_note",
        description:
          "save something i learned about my friend. use type 'name' to update their display name, 'tool_preference' for how they like a specific tool to behave (key = tool category like 'ado', 'graph'), or 'note' for general knowledge (key = topic). when updating an existing value, set override to true if i'm replacing/correcting it. omit override (or set false) if i'm unsure and want to check what's already saved.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["name", "tool_preference", "note"], description: "what kind of information to save" },
            key: { type: "string", description: "category key (required for tool_preference and note, e.g. 'ado', 'role')" },
            content: { type: "string", description: "the value to save" },
            override: { type: "string", enum: ["true", "false"], description: "set to 'true' to overwrite an existing value" },
          },
          required: ["type", "content"],
        },
      },
    },
    handler: async (a, ctx) => {
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.save_friend_note",
        message: "save friend note invoked",
        meta: { type: a.type },
      });
      if (!ctx?.context) {
        return "i can't save notes -- no friend context available";
      }
      if (!ctx.friendStore) {
        return "i can't save notes -- friend store not available";
      }
      const friendId = ctx.context.friend?.id;
      if (!friendId) return "i can't save notes -- no friend identity available";

      // Validate parameters
      if (!a.content) return "i need a content value to save";
      const validTypes = ["name", "tool_preference", "note"];
      if (!validTypes.includes(a.type)) return `i don't recognize type '${a.type}' -- use name, tool_preference, or note`;
      if ((a.type === "tool_preference" || a.type === "note") && !a.key) return "i need a key for tool_preference or note type";

      try {
        // Read fresh record from disk
        const record = await ctx.friendStore.get(friendId);
        if (!record) return "i can't find the friend record on disk";
        const isOverride = a.override === "true";

        if (a.type === "name") {
          const updated: FriendRecord = { ...record, name: a.content, updatedAt: new Date().toISOString() };
          await ctx.friendStore.put(friendId, updated);
          return `saved: name = ${a.content}`;
        }

        if (a.type === "tool_preference") {
          const existing = record.toolPreferences[a.key];
          if (existing && !isOverride) {
            return `i already have a preference for '${a.key}': "${existing}". if you want to replace it, call again with override: true. or merge both values into content and override.`;
          }
          const updated: FriendRecord = { ...record, toolPreferences: { ...record.toolPreferences, [a.key]: a.content }, updatedAt: new Date().toISOString() };
          await ctx.friendStore.put(friendId, updated);
          return `saved: toolPreference ${a.key} = ${a.content}`;
        }

        // type === "note"
        // Redirect "name" key to name field
        if (a.key === "name") {
          const updated: FriendRecord = { ...record, name: a.content, updatedAt: new Date().toISOString() };
          await ctx.friendStore.put(friendId, updated);
          return `updated friend's name to '${a.content}' (stored as name, not a note)`;
        }

        const existing = record.notes[a.key];
        if (existing && !isOverride) {
          return `i already have a note for '${a.key}': "${existing.value}". if you want to replace it, call again with override: true. or merge both values into content and override.`;
        }
        const updated: FriendRecord = { ...record, notes: { ...record.notes, [a.key]: { value: a.content, savedAt: new Date().toISOString() } }, updatedAt: new Date().toISOString() };
        await ctx.friendStore.put(friendId, updated);
        return `saved: note ${a.key} = ${a.content}`;
      } catch (err) {
        /* v8 ignore next -- defensive: non-Error branch for String(err) @preserve */
        return `error saving note: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    summaryKeys: ["type", "key", "content"],
  },
  // -- cross-session awareness --
  {
    tool: {
      type: "function",
      function: {
        name: "bridge_manage",
        description: "create and manage shared live-work bridges across already-active sessions.",
        parameters: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["begin", "attach", "status", "promote_task", "complete", "cancel"],
            },
            bridgeId: { type: "string", description: "bridge id for all actions except begin" },
            objective: { type: "string", description: "objective for begin" },
            summary: { type: "string", description: "optional concise shared-work summary" },
            friendId: { type: "string", description: "target friend id for attach" },
            channel: { type: "string", description: "target channel for attach" },
            key: { type: "string", description: "target session key for attach (defaults to 'session')" },
            title: { type: "string", description: "task title override for promote_task" },
            category: { type: "string", description: "task category override for promote_task" },
            body: { type: "string", description: "task body override for promote_task" },
          },
          required: ["action"],
        },
      },
    },
    handler: async (args, ctx) => {
      const manager = createBridgeManager()
      const action = (args.action || "").trim()

      if (action === "begin") {
        if (!ctx?.currentSession) {
          return "bridge_manage begin requires an active session context."
        }
        const objective = (args.objective || "").trim()
        if (!objective) return "objective is required for bridge begin."

        return formatBridgeStatus(
          manager.beginBridge({
            objective,
            summary: (args.summary || objective).trim(),
            session: ctx.currentSession,
          }),
        )
      }

      const bridgeId = (args.bridgeId || "").trim()
      if (!bridgeId) {
        return "bridgeId is required for this bridge action."
      }

      if (action === "attach") {
        const friendId = (args.friendId || "").trim()
        const channel = (args.channel || "").trim()
        const key = (args.key || "session").trim()
        if (!friendId || !channel) {
          return "friendId and channel are required for bridge attach."
        }

        const sessionPath = resolveSessionPath(friendId, channel, key)
        const recall = await recallSessionSafely({
          sessionPath,
          friendId,
          channel,
          key,
          messageCount: 20,
          trustLevel: ctx?.context?.friend?.trustLevel,
          summarize: ctx?.summarize,
        })
        if (recall.kind === "missing") {
          return NO_SESSION_FOUND_MESSAGE
        }

        return formatBridgeStatus(
          manager.attachSession(bridgeId, {
            friendId,
            channel,
            key,
            sessionPath,
            snapshot: recall.kind === "ok" ? recall.snapshot : EMPTY_SESSION_MESSAGE,
          }),
        )
      }

      if (action === "status") {
        const bridge = manager.getBridge(bridgeId)
        if (!bridge) return `bridge not found: ${bridgeId}`
        return formatBridgeStatus(bridge)
      }

      if (action === "promote_task") {
        return formatBridgeStatus(
          manager.promoteBridgeToTask(bridgeId, {
            title: args.title,
            category: args.category,
            body: args.body,
          }),
        )
      }

      if (action === "complete") {
        return formatBridgeStatus(manager.completeBridge(bridgeId))
      }

      if (action === "cancel") {
        return formatBridgeStatus(manager.cancelBridge(bridgeId))
      }

      return `unknown bridge action: ${action}`
    },
    summaryKeys: ["action", "bridgeId", "objective", "friendId", "channel", "key"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_active_work",
        description: "read the current live world-state across visible sessions, coding lanes, inner work, and return obligations. use this instead of piecing status together from separate session and coding tools.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: async (_args, ctx) => {
      const frame = await buildToolActiveWorkFrame(ctx)
      return `this is my current top-level live world-state.\nanswer whole-self status questions from this before drilling into individual sessions.\n\n${formatActiveWorkFrame(frame)}`
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_session",
        description: "inspect another session. use transcript for recent context, status for self/inner progress, or search to find older history by query.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, bluebubbles, inner, or mcp" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            messageCount: { type: "string", description: "how many recent messages to return (default 20)" },
            mode: {
              type: "string",
              enum: ["transcript", "status", "search"],
              description: "transcript (default), lightweight status for self/inner checks, or search for older history",
            },
            query: { type: "string", description: "required when mode=search; search term for older session history" },
          },
          required: ["friendId", "channel"],
        },
      },
    },
    handler: async (args, ctx) => {
      let friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const count = parseInt(args.messageCount || "20", 10)
      const mode = args.mode || "transcript"

      // Resolve friend name → UUID if not already a UUID or "self"
      if (friendId && friendId !== "self" && !/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(friendId) && ctx?.friendStore?.listAll) {
        const allFriends = await ctx.friendStore.listAll()
        const match = allFriends.find(f => f.name.toLowerCase() === friendId.toLowerCase())
        if (match) {
          friendId = match.id
        }
      }

      if (mode === "status") {
        if (friendId !== "self" || channel !== "inner") {
          return "status mode is only available for self/inner dialog."
        }

        const sessionPath = getInnerDialogSessionPath(getAgentRoot())
        const pendingDir = getInnerDialogPendingDir(getAgentName())
        return renderInnerProgressStatus(readInnerDialogStatus(sessionPath, pendingDir))
      }

      if (mode === "search") {
        const query = (args.query || "").trim()
        if (!query) {
          return "search mode requires a non-empty query."
        }

        const search = await searchSessionSafely({
          sessionPath: resolveSessionPath(friendId, channel, key),
          friendId,
          channel,
          key,
          query,
        })

        if (search.kind === "missing") {
          return NO_SESSION_FOUND_MESSAGE
        }
        if (search.kind === "empty") {
          return EMPTY_SESSION_MESSAGE
        }
        if (search.kind === "no_match") {
          return `no matches for "${search.query}" in that session.\n\n${search.snapshot}`
        }

        return [
          `history search: "${search.query}"`,
          search.snapshot,
          ...search.matches.map((match, index) => `match ${index + 1}\n${match}`),
        ].join("\n\n")
      }

      const sessFile = resolveSessionPath(friendId, channel, key)
      const recall = await recallSessionSafely({
        sessionPath: sessFile,
        friendId,
        channel,
        key,
        messageCount: count,
        trustLevel: ctx?.context?.friend?.trustLevel,
        summarize: ctx?.summarize,
      })

      if (recall.kind === "missing") {
        return NO_SESSION_FOUND_MESSAGE
      }
      if (recall.kind === "empty") {
        return EMPTY_SESSION_MESSAGE
      }

      return recall.summary
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_message",
        description: "send a message to a friend's session. when the request is explicitly authorized from a trusted live chat, the harness will try to deliver immediately; otherwise it reports truthful queued/block/failure state.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, bluebubbles, inner, or mcp" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            content: { type: "string", description: "the message content to send" },
          },
          required: ["friendId", "channel", "content"],
        },
      },
    },
    handler: async (args, ctx) => {
      const friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const content = args.content
      const now = Date.now()
      const agentName = getAgentName()

      // Self-routing: messages to "self" always go to inner dialog pending dir,
      // regardless of the channel or key the agent specified.
      const isSelf = friendId === "self"
      const pendingDir = isSelf
        ? getInnerDialogPendingDir(agentName)
        : getPendingDir(agentName, friendId, channel, key)
      const delegatingBridgeId = findDelegatingBridgeId(ctx)
      const delegatedFrom = isSelf
        && ctx?.currentSession
        && !(ctx.currentSession.friendId === "self" && ctx.currentSession.channel === "inner")
        ? {
            friendId: ctx.currentSession.friendId,
            channel: ctx.currentSession.channel,
            key: ctx.currentSession.key,
            ...(delegatingBridgeId ? { bridgeId: delegatingBridgeId } : {}),
          }
        : undefined
      const obligationId = delegatedFrom ? generateObligationId(now) : undefined
      const envelope: PendingMessage = {
        from: agentName,
        friendId,
        channel,
        key,
        content,
        timestamp: now,
        ...(delegatedFrom ? { delegatedFrom, obligationStatus: "pending" as const } : {}),
        ...(obligationId ? { obligationId } : {}),
      }

      if (isSelf) {
        writePendingEnvelope(pendingDir, envelope)
        if (delegatedFrom) {
          try {
            createObligation(getAgentRoot(), {
              origin: {
                friendId: delegatedFrom.friendId,
                channel: delegatedFrom.channel,
                key: delegatedFrom.key,
              },
              ...(delegatedFrom.bridgeId ? { bridgeId: delegatedFrom.bridgeId } : {}),
              content,
            })
          } catch {
            /* v8 ignore next -- defensive: obligation store write failure should not break send_message @preserve */
          }
          /* v8 ignore next -- obligationId always set when delegatedFrom is set (see generateObligationId above) @preserve */
          if (obligationId) {
            createInnerObligation(agentName, {
              id: obligationId,
              origin: delegatedFrom,
              status: "queued",
              delegatedContent: content.length > 120 ? `${content.slice(0, 117)}...` : content,
              createdAt: now,
            })
          }
          emitNervesEvent({
            event: "repertoire.obligation_created",
            component: "repertoire",
            message: "obligation created for inner dialog delegation",
            meta: {
              friendId: delegatedFrom.friendId,
              channel: delegatedFrom.channel,
              key: delegatedFrom.key,
            },
          })
        }
        let wakeResponse: { ok: boolean } | null = null
        try {
          wakeResponse = await requestInnerWake(agentName)
        } catch {
          wakeResponse = null
        }

        if (!wakeResponse?.ok) {
          const { runInnerDialogTurn } = await import("../senses/inner-dialog")
          if (ctx?.context?.channel.channel === "inner") {
            queueMicrotask(() => {
              void runInnerDialogTurn({ reason: "instinct" })
            })
            return renderInnerProgressStatus({
              queue: "queued to inner/dialog",
              wake: "inline scheduled",
              processing: "pending",
              surfaced: "nothing yet",
            })
          } else {
            const turnResult = await runInnerDialogTurn({ reason: "instinct" })
            const surfacedPreview = normalizeProgressOutcome(
              formatSurfacedValue(extractThoughtResponseFromMessages(turnResult?.messages ?? [])),
            )
            return renderProgressStory(buildProgressStory({
              scope: "inner-delegation",
              phase: "completed",
              objective: "queued to inner/dialog",
              outcomeText: `wake: inline fallback\n${surfacedPreview}`,
            }))
          }
        }

        return renderInnerProgressStatus({
          queue: "queued to inner/dialog",
          wake: "daemon requested",
          processing: "pending",
          surfaced: "nothing yet",
        })
      }

      const deliveryResult = await deliverCrossChatMessage({
        friendId,
        channel,
        key,
        content,
        intent: ctx?.currentSession && ctx.currentSession.friendId !== "self"
          ? "explicit_cross_chat"
          : "generic_outreach",
        ...(ctx?.currentSession && ctx.currentSession.friendId !== "self"
          ? {
              authorizingSession: {
                friendId: ctx.currentSession.friendId,
                channel: ctx.currentSession.channel,
                key: ctx.currentSession.key,
                trustLevel: ctx?.context?.friend?.trustLevel,
              },
            }
          : {}),
      }, {
        agentName,
        queuePending: (message) => writePendingEnvelope(pendingDir, message),
        deliverers: {
          bluebubbles: async (request) => {
            const { sendProactiveBlueBubblesMessageToSession } = await import("../senses/bluebubbles")
            const result = await sendProactiveBlueBubblesMessageToSession({
              friendId: request.friendId,
              sessionKey: request.key,
              text: request.content,
              intent: request.intent,
              authorizingSession: request.authorizingSession,
            } as any)
            if (result.delivered) {
              return {
                status: "delivered_now",
                detail: "sent to the active bluebubbles chat now",
              } as const
            }
            if (result.reason === "missing_target") {
              return {
                status: "blocked",
                detail: "bluebubbles could not resolve a routable target for that session",
              } as const
            }
            if (result.reason === "send_error") {
              return {
                status: "failed",
                detail: "bluebubbles send failed",
              } as const
            }
            return {
              status: "unavailable",
              detail: "live delivery unavailable right now; queued for the next active turn",
            } as const
          },
          teams: async (request) => {
            if (!ctx?.botApi) {
              return {
                status: "unavailable",
                detail: "live delivery unavailable right now; queued for the next active turn",
              } as const
            }
            const { sendProactiveTeamsMessageToSession } = await import("../senses/teams")
            const result = await sendProactiveTeamsMessageToSession({
              friendId: request.friendId,
              sessionKey: request.key,
              text: request.content,
              intent: request.intent,
              authorizingSession: request.authorizingSession,
            } as any, {
              botApi: ctx.botApi,
            })
            if (result.delivered) {
              return {
                status: "delivered_now",
                detail: "sent to the active teams chat now",
              } as const
            }
            if (result.reason === "missing_target") {
              return {
                status: "blocked",
                detail: "teams could not resolve a routable target for that session",
              } as const
            }
            if (result.reason === "send_error") {
              return {
                status: "failed",
                detail: "teams send failed",
              } as const
            }
            return {
              status: "unavailable",
              detail: "live delivery unavailable right now; queued for the next active turn",
            } as const
          },
        },
      })

      return renderCrossChatDeliveryStatus(`${friendId} on ${channel}/${key}`, deliveryResult)
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "set_reasoning_effort",
        description:
          "adjust your own reasoning depth for subsequent turns. use higher effort for complex analysis, lower for simple tasks.",
        parameters: {
          type: "object",
          properties: {
            level: { type: "string", description: "the reasoning effort level to set" },
          },
          required: ["level"],
        },
      },
    },
    handler: (args, ctx) => {
      if (!ctx?.supportedReasoningEfforts || !ctx.setReasoningEffort) {
        return "reasoning effort adjustment is not available in this context.";
      }
      const level = (args.level || "").trim();
      if (!ctx.supportedReasoningEfforts.includes(level)) {
        return `invalid reasoning effort level "${level}". accepted levels: ${ctx.supportedReasoningEfforts.join(", ")}`;
      }
      ctx.setReasoningEffort(level);
      emitNervesEvent({
        component: "repertoire",
        event: "repertoire.reasoning_effort_changed",
        message: `reasoning effort set to ${level}`,
        meta: { level },
      });
      return `reasoning effort set to "${level}".`;
    },
    requiredCapability: "reasoning-effort" as const,
    summaryKeys: ["level"],
  },
  // ── Continuity tools ──────────────────────────────────────────────
  {
    tool: {
      type: "function",
      function: {
        name: "query_episodes",
        description: "Query recent episodes from my continuity memory. Returns timestamped records of significant events (obligation shifts, coding milestones, bridge events, care events, turning points).",
        parameters: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Maximum episodes to return (default 20)" },
            kind: { type: "string", description: "Filter by episode kind: obligation_shift, coding_milestone, bridge_event, care_event, tempo_shift, turning_point" },
            since: { type: "string", description: "ISO timestamp — only return episodes after this time" },
          },
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      const options: { limit?: number; kinds?: import("../mind/episodes").EpisodeKind[]; since?: string } = {};
      if (a.limit) options.limit = parseInt(a.limit, 10);
      if (a.kind) options.kinds = [a.kind as import("../mind/episodes").EpisodeKind];
      if (a.since) options.since = a.since;
      const episodes = readRecentEpisodes(agentRoot, options);
      emitNervesEvent({ component: "repertoire", event: "repertoire.query_episodes", message: `queried ${episodes.length} episodes`, meta: { count: episodes.length } });
      return JSON.stringify(episodes, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "capture_episode",
        description: "Record a turning point or significant moment. This is my tool for saying 'that was important — keep it.' Nearly frictionless: only summary and whyItMattered required.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "What happened" },
            whyItMattered: { type: "string", description: "Why this was significant" },
            kind: { type: "string", description: "Episode kind (default: turning_point)" },
            salience: { type: "string", description: "low, medium, high, or critical (default: medium)" },
          },
          required: ["summary", "whyItMattered"],
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      const episode = emitEpisode(agentRoot, {
        kind: (a.kind as any) ?? "turning_point",
        summary: a.summary,
        whyItMattered: a.whyItMattered,
        relatedEntities: [],
        salience: (a.salience as any) ?? "medium",
      });
      emitNervesEvent({ component: "repertoire", event: "repertoire.capture_episode", message: `captured episode ${episode.id}`, meta: { id: episode.id } });
      return JSON.stringify(episode, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_presence",
        description: "Check who's around — my own availability/lane and known peer agents.",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => {
      const agentRoot = getAgentRoot();
      const agentName = getAgentName();
      const self = readPresence(agentRoot, agentName);
      const peers = readPeerPresence(agentRoot);
      emitNervesEvent({ component: "repertoire", event: "repertoire.query_presence", message: `presence: self + ${peers.length} peers`, meta: { peerCount: peers.length } });
      return JSON.stringify({ self, peers }, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_cares",
        description: "Query things I care about — ongoing concerns, watched situations, projects, people.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", description: "Filter by status: 'active', 'watching', 'resolved', 'dormant', or 'all' (default: active cares only)" },
          },
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      const cares = a.status === "all" ? readCares(agentRoot) : readActiveCares(agentRoot);
      emitNervesEvent({ component: "repertoire", event: "repertoire.query_cares", message: `queried ${cares.length} cares`, meta: { count: cares.length } });
      return JSON.stringify(cares, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "care_manage",
        description: "Create, update, or resolve a care. Cares are things I watch over — people, projects, missions, system health.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "update", "resolve"], description: "What to do" },
            id: { type: "string", description: "Care ID (required for update/resolve)" },
            label: { type: "string", description: "Short label for the care" },
            why: { type: "string", description: "Why this matters" },
            salience: { type: "string", description: "low, medium, high, or critical" },
            kind: { type: "string", description: "person, agent, project, mission, or system" },
            stewardship: { type: "string", description: "mine, shared, or delegated" },
          },
          required: ["action"],
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      let result: unknown;
      if (a.action === "create") {
        result = createCare(agentRoot, {
          label: a.label ?? "untitled",
          why: a.why ?? "",
          kind: (a.kind as any) ?? "project",
          status: "active",
          salience: (a.salience as any) ?? "medium",
          steward: (a.stewardship as any) ?? "mine",
          relatedFriendIds: [],
          relatedAgentIds: [],
          relatedObligationIds: [],
          relatedEpisodeIds: [],
          currentRisk: null,
          nextCheckAt: null,
        });
      } else if (a.action === "update") {
        const updates: Record<string, unknown> = {};
        if (a.label) updates.label = a.label;
        if (a.why) updates.why = a.why;
        if (a.salience) updates.salience = a.salience;
        result = updateCare(agentRoot, a.id, updates);
      } else if (a.action === "resolve") {
        result = resolveCare(agentRoot, a.id);
      }
      emitNervesEvent({ component: "repertoire", event: "repertoire.care_manage", message: `care ${a.action}`, meta: { action: a.action, id: a.id } });
      return JSON.stringify(result, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_relationships",
        description: "Query known agent relationships — familiarity, trust, shared missions, interaction history.",
        parameters: {
          type: "object",
          properties: {
            agentName: { type: "string", description: "Specific agent name to query (omit for all)" },
          },
        },
      },
    },
    handler: async (a, ctx) => {
      const allFriends = ctx?.friendStore?.listAll ? await ctx.friendStore.listAll() : [];
      let agents = allFriends.filter((f: { kind?: string }) => f.kind === "agent");
      if (a.agentName) {
        const needle = a.agentName.toLowerCase();
        agents = agents.filter((f: { name?: string }) => f.name?.toLowerCase() === needle);
      }
      emitNervesEvent({ component: "repertoire", event: "repertoire.query_relationships", message: `queried relationships`, meta: { agentName: a.agentName ?? "all" } });
      return JSON.stringify(agents, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "intention_capture",
        description: "File a lightweight mental note — something I want to do or check later, below the ceremony threshold of tasks or cares. Cheap to create, easy to close.",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "What I want to remember to do" },
            salience: { type: "string", description: "low, medium, or high (default: low)" },
            nudgeAfter: { type: "string", description: "ISO timestamp — nudge me after this time" },
          },
          required: ["content"],
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      const intention = captureIntention(agentRoot, {
        content: a.content,
        salience: (a.salience as any) ?? "low",
        source: "tool" as const,
        ...(a.nudgeAfter ? { nudgeAfter: a.nudgeAfter } : {}),
      });
      emitNervesEvent({ component: "repertoire", event: "repertoire.intention_capture", message: `captured intention ${intention.id}`, meta: { id: intention.id } });
      return JSON.stringify(intention, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "intention_manage",
        description: "Resolve or dismiss an intention. Resolve = done. Dismiss = no longer relevant. Both remove it from active list.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["resolve", "dismiss"], description: "What to do" },
            id: { type: "string", description: "Intention ID" },
          },
          required: ["action", "id"],
        },
      },
    },
    handler: (a) => {
      const agentRoot = getAgentRoot();
      const result = a.action === "resolve"
        ? resolveIntention(agentRoot, a.id)
        : dismissIntention(agentRoot, a.id);
      emitNervesEvent({ component: "repertoire", event: "repertoire.intention_manage", message: `intention ${a.action}: ${a.id}`, meta: { action: a.action, id: a.id } });
      return JSON.stringify(result, null, 2);
    },
  },
  // --- Config discovery tools ---
  {
    tool: {
      type: "function",
      function: {
        name: "read_config",
        description: "Read current agent configuration with tier annotations, descriptions, defaults, and effects. Optionally filter by topic to see only related settings.",
        parameters: {
          type: "object",
          properties: {
            related_to: {
              type: "string",
              description: "Optional topic to filter results (e.g., 'model', 'logging', 'senses'). Case-insensitive partial match.",
            },
          },
        },
      },
    },
    handler: (a) => {
      const entries = a.related_to
        ? getRegistryEntriesByTopic(a.related_to)
        : getRegistryEntries();

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown> = {};
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in read_config @preserve */
        emitNervesEvent({ component: "repertoire", event: "repertoire.read_config_error", message: "failed to read agent.json", meta: { path: configPath } });
      }

      const result = entries.map((entry) => {
        const parts = entry.path.split(".");
        let current: unknown = rawConfig;
        for (const part of parts) {
          if (current && typeof current === "object" && !Array.isArray(current)) {
            current = (current as Record<string, unknown>)[part];
          } else {
            current = undefined;
            break;
          }
        }
        return {
          path: entry.path,
          currentValue: current !== undefined ? current : (entry.default !== undefined ? entry.default : null),
          tier: entry.tier,
          description: entry.description,
          default: entry.default !== undefined ? entry.default : null,
          effects: entry.effects,
          topics: entry.topics,
        };
      });

      emitNervesEvent({ component: "repertoire", event: "repertoire.read_config", message: `read_config returned ${result.length} entries`, meta: { count: result.length, topic: a.related_to ?? null } });
      return JSON.stringify({ entries: result }, null, 2);
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "update_config",
        description: "Update an agent configuration value. Tier 1 (self-service) keys are applied immediately. Tier 2 (proposal) keys require operator confirmation. Tier 3 (operator-only) keys are refused.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Config key in dot-notation (e.g., 'context.contextMargin', 'logging.level')" },
            value: { type: "string", description: "New value as JSON (e.g., '25', '\"debug\"', '[\"terminal\", \"ndjson\"]')" },
            confirmed: { type: "string", description: "Set to 'true' to confirm a Tier 2 change after reviewing the proposal." },
          },
          required: ["path", "value"],
        },
      },
    },
    handler: (a) => {
      const entry = getRegistryEntry(a.path);
      if (!entry) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `unknown config path: ${a.path}`, meta: { path: a.path } });
        return `Error: unknown config path "${a.path}". Use read_config to see available paths.`;
      }

      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(a.value);
      } catch {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_error", message: `invalid JSON value for ${a.path}`, meta: { path: a.path, value: a.value } });
        return `Error: invalid JSON value. Provide value as valid JSON (e.g., 25, "debug", ["terminal"]).`;
      }

      // Tier 3: refuse
      if (entry.tier === 3) {
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_refused", message: `refused T3 change to ${a.path}`, meta: { path: a.path, tier: 3 } });
        return `Refused: "${a.path}" is an operator-only (Tier 3) key. ${entry.description} Only the operator can change this value directly in agent.json.`;
      }

      const agentRoot = getAgentRoot();
      const configPath = path.join(agentRoot, "agent.json");
      let rawConfig: Record<string, unknown>;
      try {
        rawConfig = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Record<string, unknown>;
      } catch {
        /* v8 ignore next -- defensive: agent.json read failure in update_config @preserve */
        return `Error: failed to read agent.json at ${configPath}`;
      }

      // Tier 2 without confirmation: return proposal
      if (entry.tier === 2 && a.confirmed !== "true") {
        const parts = entry.path.split(".");
        let current: unknown = rawConfig;
        for (const part of parts) {
          if (current && typeof current === "object" && !Array.isArray(current)) {
            current = (current as Record<string, unknown>)[part];
          } else {
            current = undefined;
            break;
          }
        }
        emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_proposal", message: `T2 proposal for ${a.path}`, meta: { path: a.path, currentValue: current, proposedValue: parsedValue } });
        return `Proposal: change "${a.path}" (Tier 2 — requires operator approval)\n\nCurrent: ${JSON.stringify(current)}\nProposed: ${JSON.stringify(parsedValue)}\n\nEffect: ${entry.effects}\n\nTo apply, call update_config with confirmed: "true".`;
      }

      // Apply the change (T1 or confirmed T2)
      const parts = entry.path.split(".");
      let target: Record<string, unknown> = rawConfig;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!(parts[i] in target) || typeof target[parts[i]] !== "object" || target[parts[i]] === null) {
          target[parts[i]] = {};
        }
        target = target[parts[i]] as Record<string, unknown>;
      }
      target[parts[parts.length - 1]] = parsedValue;

      fs.writeFileSync(configPath, JSON.stringify(rawConfig, null, 2) + "\n", "utf-8");
      emitNervesEvent({ component: "repertoire", event: "repertoire.update_config_applied", message: `applied config change to ${a.path}`, meta: { path: a.path, tier: entry.tier, value: parsedValue } });
      return `Success: "${a.path}" updated to ${JSON.stringify(parsedValue)}. Change applied immediately.`;
    },
  },
  ...codingToolDefinitions,
];

export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);

export const ponderTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "ponder",
    description: "i need to sit with this. from a conversation, takes the thread inward with a thought and a parting word. from inner dialog, keeps the wheel turning for another pass. must be the only tool call in the turn. Use when a question deserves more thought than this turn allows. Don't ponder trivial questions.",
    parameters: {
      type: "object",
      properties: {
        thought: {
          type: "string",
          description: "the question or thread that needs more thought — brief framing, not analysis. required from a conversation, ignored from inner dialog.",
        },
        say: {
          type: "string",
          description: "what you say before going quiet — speak to what caught your attention, not just that something did. required from a conversation, ignored from inner dialog.",
        },
      },
    },
  },
};

export const observeTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "observe",
    description: "absorb what happened without responding — the moment doesn't call for words. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "brief reason for staying silent (for logging)" },
      },
    },
  },
};

export const settleTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "settle",
    description:
      "respond to the user with your message. call this tool when you are ready to deliver your response. Only call when you have a substantive response. If you're settling with 'I'll look into that,' you probably should be using a tool instead.",
    parameters: {
      type: "object",
      properties: {
        answer: { type: "string" },
        intent: { type: "string", enum: ["complete", "blocked", "direct_reply"] },
      },
      required: ["answer"],
    },
  },
};

export const restTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "rest",
    description: "put this down for now — the wheel stops until the next heartbeat. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};
