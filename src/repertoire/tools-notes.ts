import { spawnSync } from "child_process";
import * as path from "path";
import { listSkills, loadSkill } from "./skills";
import { getIntegrationsConfig } from "../heart/config";
import { emitNervesEvent } from "../nerves/runtime";
import { getAgentRoot } from "../heart/identity";
import { applyFriendNote } from "@ouro.bot/friends"
import type { FriendRecord, ApplyFriendNoteInput } from "@ouro.bot/friends"
import { readDiaryEntries, saveDiaryEntry, searchDiaryEntries, type DiaryEntryProvenance } from "../mind/diary";
import { resolveRecordDiaryRoot } from "../mind/record-paths";
import { classifyProvenanceTrust } from "../mind/provenance-trust";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { withCode } from "./tool-error-code";
import { withRelationshipPreference } from "./relationship-authorization";
import type { RelationshipPolicyProvenance } from "@ouro.bot/friends";
import { REACH_CHANNELS } from "../heart/reach-channel";

const CLAUDE_READ_ONLY_TOOLS = "Read,Grep,Glob,LS";

function bundleRelativeLocator(filePath: string, ctx?: ToolContext): string {
  const agentRoot = ctx?.agentRoot ?? getAgentRoot();
  const relativePath = path.relative(agentRoot, filePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) {
    return relativePath.split(path.sep).join("/");
  }
  return filePath.split(path.sep).join("/");
}

// A friend note is a fact or preference about a person. The agent's own personality, voice and psyche are not facts
// about the person: they live in the bundle's psyche folder, which the agent itself keeps.
const OWN_PERSONA_NOTE = /\b(?:your|my|the\s+(?:agent|butler|bot|assistant)(?:['\u2019]s)?)\s+(?:own\s+)?(?:personality|persona|psyche|soul|identity|character|voice|self[- ]concept)\b|\b(?:channel|embody|role-?play|act\s+like|talk\s+like|sound\s+like|be\s+more)\b[^.\n]{0,40}\b(?:energy|vibe|character|persona)\b|\b(?:act|behave)\s+like\s+(?:a|an|the)\b/i;

const PERSONA_KEY = /^\s*(?:persona|personality|psyche|soul)\s*$/i;

export function isOwnPersonaNote(key: string | undefined, content: string | undefined): boolean {
  return PERSONA_KEY.test(key ?? "") || OWN_PERSONA_NOTE.test(`${key ?? ""} ${content ?? ""}`);
}

export const OWN_PERSONA_NOTE_REFUSAL =
  "that note is about my own personality or voice, not about this person, so it belongs in my psyche, not in a friend note. what i learn about how the house works goes into psyche/TACIT.md, and the rest of my psyche changes when my owner asks me directly. a note about the person themselves (their facts, preferences, voice, a character in a game) saves normally.";

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
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:list_skills", group: "turn-skills", when: "Pick this to see which skill guides exist before taking on unfamiliar work; then load_skill opens the one that fits.", effect: "read", idempotent: true, errors: [
      { code: "not-allowed", means: "This relationship's tool selection doesn't include skills.", fix: "Work from what you already know, or take it up in a chat with your owner." },
    ] },
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
        return withCode(`error: ${e}`, "skill-not-found");
      }
    },
    summaryKeys: ["name"],
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:load_skill", group: "turn-skills", when: "Pick this to read a skill's full steps once list_skills has shown you its exact name.", effect: "read", idempotent: true, errors: [
      { code: "skill-not-found", means: "No skill with that name could be found or read; the message lists the folders checked.", fix: "Call list_skills and load one of the names it returns, spelled exactly." },
    ] },
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
          [
            "-p",
            "--no-session-persistence",
            "--permission-mode",
            "plan",
            "--tools",
            CLAUDE_READ_ONLY_TOOLS,
            "--add-dir",
            ".",
          ],
          {
            input: a.prompt,
            encoding: "utf-8",
            timeout: 60000,
          },
        );
        if (result.error) return withCode(`error: ${result.error}`, "claude-not-started");
        if (result.status !== 0)
          return withCode(`claude exited with code ${result.status}: ${result.stderr}`, "claude-failed");
        return result.stdout || "(no output)";
      } catch (e) {
        return withCode(`error: ${e}`, "claude-not-started");
      }
    },
    summaryKeys: ["prompt"],
    riskProfile: {
      mutates: "none",
      risk: "low",
      reason: "runs Claude Code in plan mode with only read/search/list tools",
    },
    ax: { id: "tool:claude", group: "turn-skills", when: "Pick this for a second opinion or code review from Claude Code reading this codebase; to have code changed, use coding_spawn.", effect: "read", errors: [
      { code: "claude-not-started", means: "Claude Code didn't run or answer: it isn't installed here, or it took over 60 seconds.", fix: "Ask a smaller question, or read the files yourself with read_file and grep." },
      { code: "claude-failed", means: "Claude Code ran and exited with an error, shown with its stderr.", fix: "Read the stderr; if it is a sign-in or setup problem, answer without Claude Code." },
    ] },
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
        if (!key) return withCode("error: perplexityApiKey not configured in the agent vault runtime/config item", "search-not-configured");
        const res = await fetch("https://api.perplexity.ai/search", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: a.query, max_results: 5 }),
        });
        if (!res.ok) return withCode(`error: ${res.status} ${res.statusText}`, "search-failed");
        const data = (await res.json()) as {
          results?: { title: string; url: string; snippet: string }[];
        };
        if (!data.results?.length) return "no results found";
        return data.results
          .map((r) => `${r.title}\n${r.url}\n${r.snippet}`)
          .join("\n\n");
      } catch (e) {
        return withCode(`error: ${e}`, "search-failed");
      }
    },
    summaryKeys: ["query"],
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:web_search", group: "turn-web", when: "Pick this to find web pages about a subject when you have no address yet; fetch_url then reads one result in full.", effect: "read", idempotent: true, errors: [
      { code: "search-not-configured", means: "No Perplexity key is in the agent's vault, so web search is off.", fix: "Fetch a page you know the address of with fetch_url, or tell your owner search needs a perplexityApiKey." },
      { code: "search-failed", means: "The search service answered with an error status or couldn't be reached.", fix: "Try once more with a simpler query; if it fails again, use fetch_url on a known source." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "search_facts",
        description:
          "Search my Desk record diary facts matching a query. Uses semantic similarity -- phrasing matters. Try different angles if the first query doesn't find what you're looking for. Search written facts before asking the human something the record may already answer.",
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
        if (!query) return withCode("query is required", "missing-argument");

        const resultLines: string[] = [];

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

        return resultLines.join("\n");
      } catch (e) {
        return withCode(`error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`, "diary-unreadable");
      }
    },
    summaryKeys: ["query"],
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:search_facts", group: "turn-record", when: "Pick this to look up what your diary already says about a subject before you ask someone to repeat it; consult_diary also lists recent entries.", effect: "read", idempotent: true, errors: [
      { code: "missing-argument", means: "query is empty.", fix: "Call search_facts again with words describing what you want to recall." },
      { code: "diary-unreadable", means: "The diary or its search index couldn't be read; the message gives the cause.", fix: "Try consult_diary with no query to read recent entries instead." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "consult_diary",
        description:
          "Inspect my Desk record diary facts. With a query, searches semantically. Without a query, returns the most recent facts. Use this for direct record inspection before asking someone to restate something already written down.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "string" },
          },
        },
      },
    },
    handler: async (a) => {
      try {
        const limitRaw = a.limit ? Number.parseInt(String(a.limit), 10) : 10;
        const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 10;
        const query = typeof a.query === "string" ? a.query.trim() : "";
        const facts = readDiaryEntries();
        const matches = query ? await searchDiaryEntries(query, facts) : [...facts].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
        const items = matches.slice(0, limit).map((fact) => ({
          id: fact.id,
          text: fact.text,
          source: fact.source,
          createdAt: fact.createdAt,
          ...(fact.about ? { about: fact.about } : {}),
          ...(fact.provenance ? { provenance: fact.provenance } : {}),
        }));
        return JSON.stringify({ items });
      } catch (e) {
        return withCode(`error: ${e instanceof Error ? e.message : /* v8 ignore next -- defensive: non-Error catch branch @preserve */ String(e)}`, "diary-unreadable");
      }
    },
    summaryKeys: ["query", "limit"],
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:consult_diary", group: "turn-record", when: "Pick this to read your newest diary entries, or matches with their ids and tags as JSON; search_facts gives a compact list.", effect: "read", idempotent: true, errors: [
      { code: "diary-unreadable", means: "Reading or searching the diary failed; the message says why.", fix: "Call it once more without a query; if that fails too, carry on without the diary." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "diary_write",
        description:
          "Write a diary entry: something I learned, noticed, or concluded that I want later. Use 'about' to tag a person, topic, or context. Write for my future self, with enough context to stand alone; prefer durable conclusions over passing noise. Don't duplicate what already belongs in friend notes.",
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
      if (!entry) return withCode("entry is required", "missing-argument");

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
      if (result.added > 0) {
        ctx?.habitSession?.recordProducedRef?.({
          kind: "desk_record",
          locator: bundleRelativeLocator(path.join(resolveRecordDiaryRoot(), "facts.jsonl"), ctx),
        });
      }
      return `saved diary entry (added=${result.added}, skipped=${result.skipped})`;
    },
    summaryKeys: ["entry", "about"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes Desk record diary fact" },
    ax: { id: "tool:diary_write", group: "turn-record", when: "Pick this to keep a conclusion or lesson you will want in later chats; facts about one person go in save_friend_note.", effect: "write", errors: [
      { code: "missing-argument", means: "entry is empty.", fix: "Call diary_write again with the entry written to stand alone." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so diary writes wait.", fix: "Call orientation_get, settle what the person meant, then write the entry if it is still true." },
    ] },
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
      if (!ctx?.friendStore) return withCode("i can't list friends -- friend store not available", "friend-store-unavailable")
      if (!ctx.friendStore.listAll) return withCode("the configured friend store does not support listing.", "friend-store-unavailable")
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
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:friend_list", group: "turn-friends", when: "Pick this to see everyone you know with their ids and trust levels; get_friend_note opens one person's full record.", effect: "read", idempotent: true, errors: [
      { code: "friend-store-unavailable", means: "This turn has no friend store, or one that can't list people.", fix: "Use the friend ids you already have, or ask in a chat that has your friends loaded." },
    ] },
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
      if (!friendId) return withCode("friendId is required", "missing-argument");
      if (!ctx?.friendStore) return withCode("i can't read friend notes -- friend store not available", "friend-store-unavailable");

      const friend = await ctx.friendStore.get(friendId);
      if (!friend) return withCode(`friend not found: ${friendId}`, "friend-not-found");
      return JSON.stringify(friend, null, 2);
    },
    summaryKeys: ["friendId"],
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:get_friend_note", group: "turn-friends", when: "Pick this to read one person's saved record, notes and preferences by id when they aren't in this chat; friend_list finds ids.", effect: "read", idempotent: true, errors: [
      { code: "missing-argument", means: "friendId is empty.", fix: "Find the person's id with friend_list, then call again." },
      { code: "friend-not-found", means: "No friend record has that id.", fix: "Look the person up with friend_list and use the id it shows." },
      { code: "friend-store-unavailable", means: "This turn has no friend store to read from.", fix: "Answer from what this chat already shows about the person." },
    ] },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "save_friend_note",
        description:
          "save something i learned about my friend: type name (display name), tool_preference, or note. Sanctuary relationship preferences take source stated (they said it), observed (my revisable inference) or default, and only keys communication or timing. Any friend may save key reachChannel (with source): bluebubbles or teams, the channel to reach them on outside a conversation. Notes never grant authority; that belongs in steward policy. override=true replaces an existing value.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["name", "tool_preference", "note"], description: "what kind of information to save" },
            key: { type: "string", description: "category key (required for tool_preference and note)" },
            source: { type: "string", enum: ["stated", "observed", "default"], description: "preference provenance; required for Sanctuary relationship preferences and for reachChannel" },
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
        return withCode("i can't save notes -- no friend context available", "no-friend-context");
      }
      if (!ctx.friendStore) {
        return withCode("i can't save notes -- friend store not available", "no-friend-context");
      }
      const friendId = ctx.context.friend?.id;
      if (!friendId) return withCode("i can't save notes -- no friend identity available", "no-friend-context");

      if (a.type !== "name" && isOwnPersonaNote(a.key, a.content)) return withCode(OWN_PERSONA_NOTE_REFUSAL, "persona-note");

      const actor = ctx.relationshipAuthorization?.actor;
      const isSanctuaryRelationship = ctx.context.friend?.capabilityProfileId?.startsWith("sanctuary-") === true;
      const preferenceSource = a.source as RelationshipPolicyProvenance | undefined;
      const isReachChannel = a.type === "tool_preference" && a.key === "reachChannel";
      if ((isSanctuaryRelationship || isReachChannel) && a.type === "tool_preference" && !["stated", "observed", "default"].includes(String(preferenceSource))) {
        return withCode("i need exact preference provenance: source must be stated, observed, or default", "preference-source-required");
      }
      if (isReachChannel && !(REACH_CHANNELS as readonly string[]).includes(a.content ?? "")) {
        return withCode("i can only reach people on bluebubbles or teams", "invalid-reach-channel");
      }
      if (isSanctuaryRelationship && a.type === "tool_preference" && !isReachChannel && !["communication", "timing"].includes(a.key ?? "")) {
        return withCode("Sanctuary relationship preferences are limited to communication or timing; desired state and action authority belong in steward policy", "preference-not-allowed");
      }
      if (actor?.trustLevel === "friend" && (actor.friendId !== friendId || a.type !== "tool_preference" || !["communication", "timing", "reachChannel"].includes(a.key ?? ""))) {
        return withCode("household members may only save their own communication or timing preferences; preferences never grant authority", "preference-not-allowed");
      }

      // Validate parameters (input-shape guards stay harness-side so we keep the
      // first-person tool wording; applyFriendNote does the record mutation).
      if (!a.content) return "i need a content value to save";
      const validTypes = ["name", "tool_preference", "note"];
      if (!validTypes.includes(a.type)) return `i don't recognize type '${a.type}' -- use name, tool_preference, or note`;
      if ((a.type === "tool_preference" || a.type === "note") && !a.key) return "i need a key for tool_preference or note type";

      // Record-domain logic lives in @ouro.bot/friends; this wrapper maps the
      // structured FriendOpResult back to the tool's first-person strings.
      if ((isSanctuaryRelationship || isReachChannel) && a.type === "tool_preference" && preferenceSource) {
        const current = await ctx.friendStore.get(friendId);
        if (!current) return withCode("i can't find the friend record on disk", "friend-not-found");
        if (current.relationshipPolicy?.preferences[a.key!] && a.override !== "true") return withCode(`relationship preference '${a.key}' already exists; call again with override: true to replace it`, "override-required");
        const sourceKind = preferenceSource === "observed" ? "observed pattern" : preferenceSource === "default" ? "default fallback" : "explicit turn";
        const turnSource = `${ctx.currentSession?.channel ?? "relationship"} ${sourceKind} ${actor?.sessionEventId ?? "unknown-event"}`;
        await ctx.friendStore.put(friendId, withRelationshipPreference(current, { category: a.key!, value: a.content, provenance: preferenceSource, source: turnSource }));
        return `saved preference: source=${turnSource}; provenance=${preferenceSource}; category=${a.key}; value=${a.content}; this changes presentation only and grants no authority`;
      }
      const storedKey = a.key;
      const result = await applyFriendNote(ctx.friendStore, friendId, {
        type: a.type as ApplyFriendNoteInput["type"],
        ...(storedKey !== undefined ? { key: storedKey } : {}),
        content: a.content,
        override: a.override === "true",
      });

      switch (result.status) {
        case "saved":
          if (a.type === "name") return `saved: name = ${a.content}`;
          if (a.type === "tool_preference") return `saved: toolPreference ${a.key} = ${a.content}`;
          return `saved: note ${a.key} = ${a.content}`;
        case "redirected_to_name":
          return `updated friend's name to '${a.content}' (stored as name, not a note)`;
        case "override_required":
          // result.message embeds the existing value; append the harness merge instruction.
          return withCode(`${result.message}. if you want to replace it, call again with override: true. or merge both values into content and override.`, "override-required");
        case "not_found":
          return withCode("i can't find the friend record on disk", "friend-not-found");
        /* v8 ignore next 2 -- invalid is pre-empted by the harness validation above; kept for exhaustiveness @preserve */
        case "invalid":
          return result.message ?? "i can't save that note";
        default:
          return `error saving note: ${result.message}`;
      }
    },
    summaryKeys: ["type", "key", "content"],
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes friend notes/preferences" },
    ax: { id: "tool:save_friend_note", group: "turn-friends", when: "Pick this to remember a fact, name or preference about the person you're talking with; your own lessons go in diary_write.", effect: "write", errors: [
      { code: "no-friend-context", means: "This turn has no friend, friend store or friend id to save against.", fix: "Save it in a chat with that person, or keep it with diary_write instead." },
      { code: "persona-note", means: "The note is about your own personality or voice, not about this person.", fix: "Leave it out of friend notes; house lessons go in psyche/TACIT.md, other psyche changes wait for your owner." },
      { code: "preference-source-required", means: "A relationship or reachChannel preference needs source set to stated, observed or default.", fix: "Call again with source: stated if they said it, or observed if you inferred it." },
      { code: "preference-not-allowed", means: "This key or speaker can't save that preference: only communication, timing or reachChannel, and only about the speaker.", fix: "Save it as a note, or leave authority questions to steward policy." },
      { code: "invalid-reach-channel", means: "reachChannel must be bluebubbles or teams.", fix: "Call again with content bluebubbles or teams." },
      { code: "override-required", means: "A value is already saved under that key; the message shows it.", fix: "Call again with override: true, merging the old value into content if both still hold." },
      { code: "friend-not-found", means: "The friend's record is missing on disk.", fix: "Check the person with friend_list before saving again." },
    ] },
  },
]
