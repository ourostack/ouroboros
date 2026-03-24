import type OpenAI from "openai";
import * as fs from "fs";
import * as fg from "fast-glob";
import { execSync, spawnSync } from "child_process";
import * as path from "path";
import { listSkills, loadSkill } from "./skills";
import { getIntegrationsConfig, resolveSessionPath } from "../heart/config";
import type { Integration, ResolvedContext, FriendRecord } from "../mind/friends/types";
import type { FriendStore } from "../mind/friends/store";
import { emitNervesEvent } from "../nerves/runtime";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { ensureSafeRepoWorkspace, resolveSafeRepoPath, resolveSafeShellExecution } from "../heart/safe-workspace";
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
import { readMemoryFacts, saveMemoryFact, searchMemoryFacts } from "../mind/memory";
import { getTaskModule } from "./tasks";
import { getPendingDir, getInnerDialogPendingDir } from "../mind/pending";
import type { PendingMessage } from "../mind/pending";
import { createObligation as createInnerObligation, generateObligationId } from "../mind/obligations";
import type { BridgeRecord, BridgeSessionRef } from "../heart/bridges/store";
import { buildProgressStory, renderProgressStory } from "../heart/progress-story";
import { deliverCrossChatMessage, type CrossChatDeliveryResult } from "../heart/cross-chat-delivery";
import { createObligation, readPendingObligations } from "../heart/obligations";

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
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  handler: ToolHandler;
  integration?: Integration;
  confirmationRequired?: boolean;
  requiredCapability?: import("../heart/core").ProviderCapability;
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
  return resolveSafeRepoPath({ requestedPath: targetPath }).resolvedPath
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
    },
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
        description: "read file contents",
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
      if (offset === undefined && limit === undefined) return content
      const lines = content.split("\n")
      const start = offset ? offset - 1 : 0
      const end = limit !== undefined ? start + limit : lines.length
      return lines.slice(start, end).join("\n")
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "write_file",
        description: "write content to file",
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
      return "ok"
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "edit_file",
        description:
          "surgically edit a file by replacing an exact string. the file must have been read via read_file first. old_string must match exactly one location in the file.",
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

      // Build contextual diff
      const lines = updated.split("\n")
      const prefixLines = content.slice(0, idx).split("\n")
      const changeStartLine = prefixLines.length - 1
      const newStringLines = a.new_string.split("\n")
      const changeEndLine = changeStartLine + newStringLines.length

      return buildContextDiff(lines, changeStartLine, changeEndLine)
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "glob",
        description: "find files matching a glob pattern. returns matching paths sorted alphabetically, one per line.",
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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "grep",
        description:
          "search file contents for lines matching a regex pattern. searches recursively when given a directory. returns matching lines with file path and line numbers.",
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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "safe_workspace",
        description: "acquire or inspect the safe harness repo workspace for local edits. returns the real workspace path, branch, and why it was chosen.",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    handler: () => {
      const selection = ensureSafeRepoWorkspace()
      return [
        `workspace: ${selection.workspaceRoot}`,
        `branch: ${selection.workspaceBranch}`,
        `runtime: ${selection.runtimeKind}`,
        `cleanup_after_merge: ${selection.cleanupAfterMerge ? "yes" : "no"}`,
        `note: ${selection.note}`,
      ].join("\n")
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "shell",
        description: "run shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    handler: (a) => {
      const prepared = resolveSafeShellExecution(a.command)
      return execSync(prepared.command, {
        encoding: "utf-8",
        timeout: 30000,
        ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
      })
    },
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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "claude",
        description:
          "use claude code to query this codebase or get an outside perspective. useful for code review, second opinions, and asking questions about your own source.",
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
  },
  {
    tool: {
      type: "function",
      function: {
        name: "memory_search",
        description:
          "search remembered facts stored in psyche memory and return relevant matches for a query",
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
        const memoryRoot = path.join(getAgentRoot(), "psyche", "memory");
        const hits = await searchMemoryFacts(query, readMemoryFacts(memoryRoot));
        return hits
          .map((fact) => `- ${fact.text} (source=${fact.source}, createdAt=${fact.createdAt})`)
          .join("\n");
      } catch (e) {
        return `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "memory_save",
        description:
          "save a general memory fact i want to recall later. optional 'about' can tag the fact to a person/topic/context",
        parameters: {
          type: "object",
          properties: {
            text: { type: "string" },
            about: { type: "string" },
          },
          required: ["text"],
        },
      },
    },
    handler: async (a) => {
      const text = (a.text || "").trim();
      if (!text) return "text is required";
      const result = await saveMemoryFact({
        text,
        source: "tool:memory_save",
        about: typeof a.about === "string" ? a.about : undefined,
      });
      return `saved memory fact (added=${result.added}, skipped=${result.skipped})`;
    },
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
            channel: { type: "string", description: "the channel: cli, teams, or inner" },
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
      const friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const count = parseInt(args.messageCount || "20", 10)
      const mode = args.mode || "transcript"

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
            channel: { type: "string", description: "the channel: cli, teams, or inner" },
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
  },
  ...codingToolDefinitions,
];

export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);

export const goInwardTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "go_inward",
    description: "i need to think about this privately. this takes the current thread inward -- i'll sit with it, work through it, or carry it to where it needs to go. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "what i need to think about -- the question, the thread, the thing that needs private attention",
        },
        answer: {
          type: "string",
          description: "if i want to say something outward before going inward -- an acknowledgment, a 'let me think about that', whatever feels right",
        },
        mode: {
          type: "string",
          enum: ["reflect", "plan", "relay"],
          description: "reflect: something to sit with. plan: something to work through. relay: something to carry across.",
        },
      },
      required: ["content"],
    },
  },
};

export const noResponseTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "no_response",
    description: "stay silent in this group chat — the moment doesn't call for a response. must be the only tool call in the turn.",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string", description: "brief reason for staying silent (for logging)" },
      },
    },
  },
};

export const finalAnswerTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "final_answer",
    description:
      "respond to the user with your message. call this tool when you are ready to deliver your response.",
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
