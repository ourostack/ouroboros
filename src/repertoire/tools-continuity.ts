import { getAgentRoot, getAgentName } from "../heart/identity";
import { emitNervesEvent } from "../nerves/runtime";
import { readRecentEpisodes, emitEpisode } from "../arc/episodes";
import { readActiveCares, readCares, createCare, updateCare, resolveCare } from "../arc/cares";
import { readPresence, readPeerPresence } from "../arc/presence";
import { captureIntention, resolveIntention, dismissIntention } from "../arc/intentions";
import type { ToolDefinition } from "./tools-base";

export const continuityToolDefinitions: ToolDefinition[] = [
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
      const options: { limit?: number; kinds?: import("../arc/episodes").EpisodeKind[]; since?: string } = {};
      if (a.limit) options.limit = parseInt(a.limit, 10);
      if (a.kind) options.kinds = [a.kind as import("../arc/episodes").EpisodeKind];
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
]
