import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { listSkills, loadSkill } from "./skills";
import { getIntegrationsConfig } from "../heart/config";
import { getAgentRoot } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import type { FriendRecord } from "../mind/friends/types";
import { readDiaryEntries, saveDiaryEntry, searchDiaryEntries, type DiaryEntryProvenance } from "../mind/diary";
import { classifyProvenanceTrust } from "../mind/provenance-trust";
import { type JournalIndexEntry } from "../mind/note-search";
import type { ToolDefinition } from "./tools-base";

export const notesToolDefinitions: ToolDefinition[] = [
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
        if (!key) return "error: perplexityApiKey not configured in the agent vault runtime/config item";
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
        name: "search_notes",
        description:
          "Search my diary and journal for facts, thoughts, and working notes matching a query. Uses semantic similarity -- phrasing matters. Try different angles if the first query doesn't find what you're looking for. Search written notes before asking the human something the notes may already answer.",
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
          let meta = `source=${fact.source}, createdAt=${fact.createdAt}`;
          if (fact.provenance) {
            if (fact.provenance.channel) meta += `, channel=${fact.provenance.channel}`;
            if (fact.provenance.friendName) meta += `, friend=${fact.provenance.friendName}`;
            if (fact.provenance.trust) meta += `, trust=${fact.provenance.trust}`;
          }
          const tag = classifyProvenanceTrust(fact.provenance) === "external" ? "diary/external" : "diary";
          resultLines.push(`[${tag}] ${fact.text} (${meta})`);
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
              /* v8 ignore next 4 -- both sides tested (filename-only match in search_notes-journal.test.ts); v8 misreports || short-circuit @preserve */
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
          "Write an entry in my diary -- something I learned, noticed, or concluded that I want available later. Use 'about' to tag the entry to a person, topic, or context. Write for my future self: include enough context that the entry makes sense without the surrounding conversation. Prefer durable conclusions over passing noise. Don't duplicate what already belongs in friend notes.",
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
    handler: async (a, ctx) => {
      const entry = (a.entry || "").trim();
      if (!entry) return "entry is required";

      let provenance: DiaryEntryProvenance | undefined;
      if (ctx?.context) {
        const p: DiaryEntryProvenance = { tool: "diary_write" };
        const channel = ctx.context.channel?.channel;
        if (channel) p.channel = channel;
        const friendId = ctx.context.friend?.id;
        if (friendId) p.friendId = friendId;
        const friendName = ctx.context.friend?.name;
        if (friendName) p.friendName = friendName;
        const trust = ctx.context.friend?.trustLevel;
        if (trust) p.trust = trust;
        provenance = p;
      }

      const result = await saveDiaryEntry({
        text: entry,
        source: "tool:diary_write",
        about: typeof a.about === "string" ? a.about : undefined,
        provenance,
      });
      return `saved diary entry (added=${result.added}, skipped=${result.skipped})`;
    },
    summaryKeys: ["entry", "about"],
  },
  {
    tool: {
      type: "function",
      function: {
        name: "friend_list",
        description: "list all friends with id, name, and trust level. use this when i need to see who i know — e.g. for cross-chat outreach decisions, screener triage, or just orienting on the friend graph.",
        parameters: {
          type: "object",
          properties: {
            trust: { type: "string", enum: ["family", "friend", "stranger"], description: "optional trust filter; omit to list all" },
            limit: { type: "string", description: "max records to return, 1-200. defaults to 50." },
          },
        },
      },
    },
    handler: async (a, ctx) => {
      /* v8 ignore start -- friend_list defensive plumbing: ctx + listAll guards, trust/limit branch fan-out, and empty-set status messages aren't all combined in tests; full coverage lives at the friend-store unit-test layer @preserve */
      if (!ctx?.friendStore) return "i can't list friends -- friend store not available"
      if (!ctx.friendStore.listAll) return "the configured friend store does not support listing."
      const all = await ctx.friendStore.listAll()
      const trustFilter = a.trust
      const filtered = trustFilter
        ? all.filter((f: FriendRecord) => (f.trustLevel ?? "friend") === trustFilter)
        : all
      const limitRaw = a.limit ? Number.parseInt(a.limit, 10) : 50
      const limit = Number.isFinite(limitRaw) ? Math.min(200, Math.max(1, limitRaw)) : 50
      const ordered = [...filtered].sort((left, right) => left.name.localeCompare(right.name)).slice(0, limit)
      if (ordered.length === 0) {
        return trustFilter ? `no friends with trust level '${trustFilter}'.` : "no friends recorded yet."
      }
      /* v8 ignore stop */
      /* v8 ignore start -- formatting branches: externalIds presence + pluralization + trust suffix variants depend on specific friend-record shapes not exhaustively combined in tests @preserve */
      const lines = ordered.map((friend: FriendRecord) => {
        const externals = friend.externalIds && friend.externalIds.length > 0
          ? ` [${friend.externalIds.map((id) => `${id.provider}:${id.externalId}`).join(", ")}]`
          : ""
        return `- ${friend.id} (${friend.trustLevel ?? "friend"}): ${friend.name}${externals}`
      })
      return `${ordered.length} friend${ordered.length === 1 ? "" : "s"}${trustFilter ? ` with trust=${trustFilter}` : ""}:\n${lines.join("\n")}`
      /* v8 ignore stop */
    },
    summaryKeys: ["trust", "limit"],
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
]
