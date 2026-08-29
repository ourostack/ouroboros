import * as path from "node:path";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { commitExternalEventDisposition, getExternalEventRoot, readExternalEventRecord } from "../heart/external-events/router";
import { emitNervesEvent } from "../nerves/runtime";
import { readRecentEpisodes, emitEpisode } from "../arc/episodes";
import { bindCareIncident, createCare, readActiveCares, readCares, resolveCare, resolveCareIncident, updateCare, upsertCareForIncident } from "../arc/cares";
import { readPresence, readPeerPresence } from "../arc/presence";
import { captureIntention, resolveIntention, dismissIntention } from "../arc/intentions";
import type { ToolDefinition } from "./tools-base";

export const continuityToolDefinitions: ToolDefinition[] = [
  // ── Continuity tools ──────────────────────────────────────────────
  {
    tool: {
      type: "function",
      function: {
        name: "external_event_disposition",
        description: "Classify the exact external-event generation I just investigated. This records why I acted or stayed silent and what exact change should wake me next; it never sends a message by itself.",
        parameters: {
          type: "object",
          properties: {
            recordPath: { type: "string", description: "Exact receipt path from the external-event message" },
            expectedGeneration: { type: "number", description: "Exact generation shown in the external-event turn" },
            classifiedRevision: { type: "string", description: "Exact observation revision investigated in this turn" },
            classification: { type: "string", enum: ["expected", "needs_attention", "adopted", "snoozed", "dismissed_until_change", "resolved"] },
            stewardPolicyKey: { type: "string", description: "Exact desired-state policy key used for this decision" },
            stewardPolicyVersion: { type: "number", description: "Exact desired-state policy version used for this decision" },
            decision: { type: "string", enum: ["silent", "act", "ask", "report"] },
            reason: { type: "string", description: "Short plain-language reason for the decision" },
            nextWake: { type: "string", enum: ["on_change", "on_escalation", "on_recovery", "at"] },
            wakeAt: { type: "string", description: "ISO time required when nextWake=at" },
            awaitId: { type: "string", description: "Existing await receipt required when nextWake=at" },
            careId: { type: "string", description: "Existing Care adopted for this incident, if any" },
            actionRefs: { type: "array", items: { type: "string" } },
            verificationRefs: { type: "array", items: { type: "string" } },
          },
          required: ["recordPath", "expectedGeneration", "classifiedRevision", "classification", "stewardPolicyKey", "stewardPolicyVersion", "decision", "reason", "nextWake"],
        },
      },
    },
    handler: (a, ctx) => {
      const agentName = getAgentName();
      const agentEventRoot = path.resolve(getExternalEventRoot(), agentName);
      const recordPath = path.resolve(String(a.recordPath ?? ""));
      const relative = path.relative(agentEventRoot, recordPath);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !recordPath.endsWith(".json")) {
        throw new Error("External event receipt does not belong to the current agent");
      }
      const record = readExternalEventRecord(recordPath);
      if (record.agent !== agentName) throw new Error("External event receipt does not belong to the current agent");
      const turnEvent = ctx?.currentExternalEvent;
      const expectedGeneration = Number(a.expectedGeneration);
      const classifiedRevision = String(a.classifiedRevision ?? "");
      if (!turnEvent || turnEvent.recordPath !== recordPath || turnEvent.agent !== agentName
        || turnEvent.generation !== expectedGeneration || turnEvent.observationRevision !== classifiedRevision
        || record.generation !== expectedGeneration || record.observationRevision !== classifiedRevision
        || record.executionState !== "running" || record.claimOwner !== turnEvent.claimOwner) {
        throw new Error("External event disposition is not authorized for this exact turn lease");
      }
      const classification = String(a.classification);
      const decision = String(a.decision);
      const nextWake = String(a.nextWake);
      const policyVersion = Number(a.stewardPolicyVersion);
      const reason = String(a.reason ?? "").trim();
      if (!reason || !Number.isSafeInteger(policyVersion) || policyVersion < 1
        || !["expected", "needs_attention", "adopted", "snoozed", "dismissed_until_change", "resolved"].includes(classification)
        || !["silent", "act", "ask", "report"].includes(decision)
        || !["on_change", "on_escalation", "on_recovery", "at"].includes(nextWake)) {
        throw new Error("External event disposition is invalid");
      }
      const wake = nextWake === "at" ? { kind: "at" as const, at: String(a.wakeAt ?? "") } : { kind: nextWake as "on_change" | "on_escalation" | "on_recovery" };
      const actionRefs = Array.isArray(a.actionRefs) ? a.actionRefs.map(String) : [];
      const verificationRefs = Array.isArray(a.verificationRefs) ? a.verificationRefs.map(String) : [];
      const authority = ctx?.externalEventAuthority?.authorizeDisposition({
        event: turnEvent,
        classification,
        decision,
        stewardPolicyKey: String(a.stewardPolicyKey),
        stewardPolicyVersion: policyVersion,
        nextWake,
        wakeAt: nextWake === "at" ? String(a.wakeAt ?? "") : null,
        awaitId: typeof a.awaitId === "string" && a.awaitId ? a.awaitId : null,
        careId: typeof a.careId === "string" && a.careId ? a.careId : null,
        actionRefs,
        verificationRefs,
      });
      if (!authority?.allowed) throw new Error(`External event disposition authority denied: ${authority?.reason ?? "authority unavailable"}`);
      const handled = commitExternalEventDisposition(recordPath, {
        owner: turnEvent.claimOwner,
        expectedVersion: record.version,
        expectedGeneration: record.generation,
        disposition: {
          classifiedRevision,
          classification: classification as import("../heart/external-events/router").ExternalEventClassification,
          stewardPolicy: { key: String(a.stewardPolicyKey), version: policyVersion },
          decision: decision as import("../heart/external-events/router").ExternalEventDecision,
          reason,
          nextWake: wake,
          careId: typeof a.careId === "string" && a.careId ? a.careId : null,
          awaitId: typeof a.awaitId === "string" && a.awaitId ? a.awaitId : null,
          actionRefs,
          verificationRefs,
        },
      });
      emitNervesEvent({ component: "repertoire", event: "repertoire.external_event_disposition", message: "external event disposition recorded", meta: { agentName, eventId: record.eventId, generation: record.generation, classification, decision } });
      return JSON.stringify(handled, null, 2);
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records the agent's classification on an existing external-event receipt" },
  },
  {
    tool: {
      type: "function",
      function: {
        name: "query_episodes",
        description: "Query recent episodes from my continuity log. Returns timestamped records of significant events (obligation shifts, coding milestones, bridge events, care events, turning points).",
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes continuity episode state" },
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
        description: "Create, update, or resolve a care, or bind and resolve one machine incident within it. Cares are things I watch over — people, projects, missions, system health.",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["create", "update", "resolve", "bind_incident", "resolve_incident", "upsert_incident"], description: "What to do" },
            id: { type: "string", description: "Care ID (required for update/resolve)" },
            label: { type: "string", description: "Short label for the care" },
            why: { type: "string", description: "Why this matters" },
            salience: { type: "string", description: "low, medium, high, or critical" },
            kind: { type: "string", description: "person, agent, project, mission, or system" },
            stewardship: { type: "string", description: "mine, shared, or delegated" },
            source: { type: "string", description: "Machine evidence source for an incident binding" },
            incidentKey: { type: "string", description: "Stable incident key within the source" },
            classifiedRevision: { type: "string", description: "Observation revision classified by the agent" },
            correlationKey: { type: "string", description: "Optional key relating several incidents to one concern" },
            expectedUpdatedAt: { type: "string", description: "Optional Care updatedAt value for CAS fencing" },
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
      } else if (a.action === "bind_incident") {
        if (!a.expectedUpdatedAt) throw new Error("Care incident binding requires expectedUpdatedAt");
        result = bindCareIncident(agentRoot, a.id, {
          source: a.source,
          incidentKey: a.incidentKey,
          classifiedRevision: a.classifiedRevision,
          ...(a.correlationKey ? { correlationKey: a.correlationKey } : {}),
        }, { expectedUpdatedAt: a.expectedUpdatedAt });
      } else if (a.action === "resolve_incident") {
        if (!a.expectedUpdatedAt) throw new Error("Care incident resolution requires expectedUpdatedAt");
        result = resolveCareIncident(agentRoot, a.id, {
          source: a.source,
          incidentKey: a.incidentKey,
          expectedUpdatedAt: a.expectedUpdatedAt,
        });
      } else if (a.action === "upsert_incident") {
        result = upsertCareForIncident(agentRoot, {
          label: a.label ?? "untitled",
          why: a.why ?? "",
          kind: (a.kind as any) ?? "system",
          status: "active",
          salience: (a.salience as any) ?? "medium",
          steward: (a.stewardship as any) ?? "mine",
          relatedFriendIds: [],
          relatedAgentIds: [],
          relatedObligationIds: [],
          relatedEpisodeIds: [],
          currentRisk: null,
          nextCheckAt: null,
          incident: {
            source: a.source,
            incidentKey: a.incidentKey,
            classifiedRevision: a.classifiedRevision,
            ...(a.correlationKey ? { correlationKey: a.correlationKey } : {}),
          },
        });
      }
      emitNervesEvent({ component: "repertoire", event: "repertoire.care_manage", message: `care ${a.action}`, meta: { action: a.action, id: a.id } });
      return JSON.stringify(result, null, 2);
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "creates or updates care state" },
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
            content: { type: "string", description: "What I want to keep track of" },
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "writes intention state" },
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
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "updates intention state" },
  },
]
