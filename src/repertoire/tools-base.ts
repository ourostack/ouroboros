import type OpenAI from "openai";
import * as fs from "fs";
import { execSync, spawnSync } from "child_process";
import * as path from "path";
import { listSkills, loadSkill } from "./skills";
import { getIntegrationsConfig } from "../heart/config";
import type { Integration, ResolvedContext, FriendRecord } from "../mind/friends/types";
import type { FriendStore } from "../mind/friends/store";
import { emitNervesEvent } from "../nerves/runtime";
import { getAgentRoot, getAgentName } from "../heart/identity";
import * as os from "os";
import { getTaskModule } from "./tasks";
import { codingToolDefinitions } from "./coding/tools";
import { readMemoryFacts, saveMemoryFact, searchMemoryFacts } from "../mind/memory";

export interface CodingFeedbackTarget {
  send: (message: string) => Promise<void>;
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
}

export type ToolHandler = (args: Record<string, string>, ctx?: ToolContext) => string | Promise<string>;

export interface ToolDefinition {
  tool: OpenAI.ChatCompletionFunctionTool;
  handler: ToolHandler;
  integration?: Integration;
  confirmationRequired?: boolean;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function buildTaskCreateInput(args: Record<string, string>) {
  return {
    title: args.title,
    type: args.type,
    category: args.category,
    body: args.body,
    status: normalizeOptionalText(args.status) ?? undefined,
    validator: normalizeOptionalText(args.validator),
    requester: normalizeOptionalText(args.requester),
    cadence: normalizeOptionalText(args.cadence),
    scheduledAt: normalizeOptionalText(args.scheduledAt),
  }
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

export const baseToolDefinitions: ToolDefinition[] = [
  {
    tool: {
      type: "function",
      function: {
        name: "read_file",
        description: "read file contents",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
    handler: (a) => {
      const content = fs.readFileSync(a.path, "utf-8")
      editFileReadTracker.add(a.path)
      return content
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
      fs.mkdirSync(path.dirname(a.path), { recursive: true })
      fs.writeFileSync(a.path, a.content, "utf-8")
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
      if (!editFileReadTracker.has(a.path)) {
        return `error: you must read the file with read_file before editing it. call read_file on ${a.path} first.`
      }

      let content: string
      try {
        content = fs.readFileSync(a.path, "utf-8")
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
      fs.writeFileSync(a.path, updated, "utf-8")

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
      const cwd = a.cwd || process.cwd()
      const matches = fs.globSync(a.pattern, { cwd })
      return [...matches].sort().join("\n")
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
      const targetPath = a.path
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
        name: "shell",
        description: "run shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    },
    handler: (a) => execSync(a.command, { encoding: "utf-8", timeout: 30000 }),
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
        name: "task_board",
        description: "show the task board grouped by status",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => {
      const board = getTaskModule().getBoard();
      return board.full || board.compact || "no tasks found";
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_create",
        description:
          "create a new task in the bundle task system. optionally set `scheduledAt` for a one-time reminder or `cadence` for recurring daemon-scheduled work.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            type: { type: "string", enum: ["one-shot", "ongoing", "habit"] },
            category: { type: "string" },
            body: { type: "string" },
            status: { type: "string" },
            validator: { type: "string" },
            requester: { type: "string" },
            scheduledAt: { type: "string", description: "ISO timestamp for a one-time scheduled run/reminder" },
            cadence: { type: "string", description: "recurrence like 30m, 1h, 1d, or cron" },
          },
          required: ["title", "type", "category", "body"],
        },
      },
    },
    handler: (a) => {
      try {
        const created = getTaskModule().createTask(buildTaskCreateInput(a));
        return `created: ${created}`;
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "schedule_reminder",
        description:
          "create a scheduled reminder or recurring daemon job. use `scheduledAt` for one-time reminders and `cadence` for recurring reminders. this writes canonical task fields that the daemon reconciles into OS-level jobs.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
            body: { type: "string" },
            category: { type: "string" },
            scheduledAt: { type: "string", description: "ISO timestamp for a one-time reminder" },
            cadence: { type: "string", description: "recurrence like 30m, 1h, 1d, or cron" },
          },
          required: ["title", "body"],
        },
      },
    },
    handler: (a) => {
      const scheduledAt = normalizeOptionalText(a.scheduledAt)
      const cadence = normalizeOptionalText(a.cadence)
      if (!scheduledAt && !cadence) {
        return "error: provide scheduledAt or cadence"
      }

      try {
        const created = getTaskModule().createTask({
          title: a.title,
          type: cadence ? "habit" : "one-shot",
          category: normalizeOptionalText(a.category) ?? "reminder",
          body: a.body,
          scheduledAt,
          cadence,
        })
        return `created: ${created}`
      } catch (error) {
        return `error: ${error instanceof Error ? error.message : String(error)}`
      }
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_update_status",
        description: "update a task status using validated transitions",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string" },
            status: { type: "string" },
          },
          required: ["name", "status"],
        },
      },
    },
    handler: (a) => {
      const result = getTaskModule().updateStatus(a.name, a.status);
      if (!result.ok) {
        return `error: ${result.reason ?? "status update failed"}`;
      }
      const archivedSuffix = result.archived && result.archived.length > 0
        ? ` | archived: ${result.archived.join(", ")}`
        : "";
      return `updated: ${a.name} -> ${result.to}${archivedSuffix}`;
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_board_status",
        description: "show board detail for a specific status",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string" },
          },
          required: ["status"],
        },
      },
    },
    handler: (a) => {
      const lines = getTaskModule().boardStatus(a.status);
      return lines.length > 0 ? lines.join("\n") : "no tasks in that status";
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_board_action",
        description: "show tasks or validation issues that require action",
        parameters: {
          type: "object",
          properties: {
            scope: { type: "string" },
          },
        },
      },
    },
    handler: (a) => {
      const lines = getTaskModule().boardAction();
      if (!a.scope) {
        return lines.length > 0 ? lines.join("\n") : "no action required";
      }
      const filtered = lines.filter((line) => line.includes(a.scope));
      return filtered.length > 0 ? filtered.join("\n") : "no matching action items";
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_board_deps",
        description: "show unresolved task dependencies",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => {
      const lines = getTaskModule().boardDeps();
      return lines.length > 0 ? lines.join("\n") : "no unresolved dependencies";
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "task_board_sessions",
        description: "show tasks with active coding or sub-agent sessions",
        parameters: { type: "object", properties: {} },
      },
    },
    handler: () => {
      const lines = getTaskModule().boardSessions();
      return lines.length > 0 ? lines.join("\n") : "no active sessions";
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
        name: "query_session",
        description: "read the last messages from another session. use this to check on a conversation with a friend or review your own inner dialog.",
        parameters: {
          type: "object",
          properties: {
            friendId: { type: "string", description: "the friend UUID (or 'self')" },
            channel: { type: "string", description: "the channel: cli, teams, or inner" },
            key: { type: "string", description: "session key (defaults to 'session')" },
            messageCount: { type: "string", description: "how many recent messages to return (default 20)" },
          },
          required: ["friendId", "channel"],
        },
      },
    },
    handler: async (args, ctx) => {
      try {
        const friendId = args.friendId
        const channel = args.channel
        const key = args.key || "session"
        const count = parseInt(args.messageCount || "20", 10)

        const sessFile = path.join(
          os.homedir(), ".agentstate", getAgentName(), "sessions",
          friendId, channel, `${key}.json`,
        )
        const raw = fs.readFileSync(sessFile, "utf-8")
        const data = JSON.parse(raw)
        const messages: { role: string; content: string }[] = (data.messages || [])
          .filter((m: { role: string }) => m.role !== "system")
        const tail = messages.slice(-count)
        if (tail.length === 0) return "session exists but has no non-system messages."

        const transcript = tail.map((m: { role: string; content: string }) => `[${m.role}] ${m.content}`).join("\n")

        // LLM summarization when summarize function is available
        if (ctx?.summarize) {
          const trustLevel = ctx.context?.friend?.trustLevel ?? "family"
          const isSelfQuery = friendId === "self"
          const instruction = isSelfQuery
            ? "summarize this session transcript fully and transparently. this is my own inner dialog — include all details, decisions, and reasoning."
            : `summarize this session transcript. the person asking has trust level: ${trustLevel}. family=full transparency, friend=share work and general topics but protect other people's identities, acquaintance=very guarded minimal disclosure.`
          return await ctx.summarize(transcript, instruction)
        }

        return transcript
      } catch {
        return "no session found for that friend/channel/key combination."
      }
    },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "send_message",
        description: "send a message to a friend's session. the message is queued as a pending file and delivered when the target session drains its queue.",
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
    handler: async (args) => {
      const friendId = args.friendId
      const channel = args.channel
      const key = args.key || "session"
      const content = args.content
      const now = Date.now()

      const pendingDir = path.join(
        os.homedir(), ".agentstate", getAgentName(), "pending",
        friendId, channel, key,
      )
      fs.mkdirSync(pendingDir, { recursive: true })

      const fileName = `${now}-${Math.random().toString(36).slice(2, 10)}.json`
      const filePath = path.join(pendingDir, fileName)
      const envelope = {
        from: getAgentName(),
        friendId,
        channel,
        key,
        content,
        timestamp: now,
      }
      fs.writeFileSync(filePath, JSON.stringify(envelope, null, 2))
      const preview = content.length > 80 ? content.slice(0, 80) + "…" : content
      return `message queued for delivery to ${friendId} on ${channel}/${key}. preview: "${preview}". it will be delivered when their session is next active.`
    },
  },
  ...codingToolDefinitions,
];

// Backward-compat: extract just the OpenAI tool schemas
export const tools: OpenAI.ChatCompletionFunctionTool[] = baseToolDefinitions.map((d) => d.tool);

// Backward-compat: extract just the handlers by name
export const baseToolHandlers: Record<string, ToolHandler> = Object.fromEntries(
  baseToolDefinitions.map((d) => [d.tool.function.name, d.handler]),
);

export const finalAnswerTool: OpenAI.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "final_answer",
    description:
      "respond to the user with your message. call this tool when you are ready to deliver your response.",
    parameters: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  },
};
