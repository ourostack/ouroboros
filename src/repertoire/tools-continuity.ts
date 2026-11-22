import * as path from "node:path";
import * as fs from "node:fs";
import { getAgentRoot, getAgentName } from "../heart/identity";
import { commitExternalEventDisposition, getExternalEventRoot, readExternalEventRecord } from "../heart/external-events/router";
import { emitNervesEvent } from "../nerves/runtime";
import { readRecentEpisodes, emitEpisode } from "../arc/episodes";
import { bindCareIncident, createCare, projectCareEvidence, readActiveCares, readCares, resolveCare, resolveCareIncident, updateCare, upsertCareForIncident } from "../arc/cares";
import { readPresence, readPeerPresence } from "../arc/presence";
import { captureIntention, resolveIntention, dismissIntention } from "../arc/intentions";
import type { ToolContext, ToolDefinition } from "./tools-base";
import { withCode } from "./tool-error-code";
import { readStewardPolicy } from "../heart/steward-policy";
import { parseAwaitFile } from "../heart/awaiting/await-parser";

const externalEventDispositionProperties = {
  recordPath: { type: "string", description: "Receipt path from the external-event message" },
  expectedGeneration: { type: "number", description: "Generation shown in the external-event turn" },
  classifiedRevision: { type: "string", description: "Observation revision investigated this turn" },
  classification: { type: "string", enum: ["expected", "needs_attention", "adopted", "snoozed", "dismissed_until_change", "resolved"] },
  stewardPolicyKind: { type: "string", enum: ["current", "none"], description: "current with the live policy key/version when one applies, else none" },
  stewardPolicyKey: { type: "string" },
  stewardPolicyVersion: { type: "number" },
  decision: { type: "string", enum: ["silent", "act", "ask", "report"] },
  reason: { type: "string", description: "Internal audit note; never shown to the owner" },
  owner_message: { type: "string", description: "Required for ask or report: the short plain message the owner reads. No ids, leases, generations or receipts." },
  nextWake: { type: "string", enum: ["on_change", "on_escalation", "on_recovery", "at"], description: "on_change unless you called await_condition for this event; then at, with its awaitId" },
  wakeAt: { type: "string", description: "ISO time, only for nextWake=at" },
  awaitId: { type: "string", description: "await_condition receipt, for nextWake=at" },
  careId: { type: "string" },
  actionRefs: { type: "array", items: { type: "string" } },
  verificationRefs: { type: "array", items: { type: "string" } },
};

const externalEventDispositionBatchSchema = {
  type: "array",
  minItems: 1,
  maxItems: 32,
  description: "One disposition per lease of a coalesced external-event turn, each with the single-form fields",
  items: { type: "object" },
};

// The owner reads owner_message verbatim, so internal bookkeeping words never reach them.
const OWNER_MESSAGE_FORBIDDEN = /\b(generation|lease|revision|receipt|disposition|claimOwner|recordPath)s?\b|[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/iu;

function prepareExternalEventDisposition(a: Record<string, unknown>, ctx?: ToolContext) {
  const agentName = getAgentName();
  const agentEventRoot = path.resolve(getExternalEventRoot(), agentName);
  const recordPath = path.resolve(String(a.recordPath ?? ""));
  const relative = path.relative(agentEventRoot, recordPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !recordPath.endsWith(".json")) {
    throw new Error(withCode("External event receipt does not belong to the current agent", "receipt-not-this-turn"));
  }
  const record = readExternalEventRecord(recordPath);
  if (record.agent !== agentName) throw new Error(withCode("External event receipt does not belong to the current agent", "receipt-not-this-turn"));
  const turnContext = ctx?.currentExternalEvent;
  const turnEvent = turnContext
    ? [turnContext, ...(turnContext.relatedEvents ?? [])].find((event) => path.resolve(event.recordPath) === recordPath)
    : undefined;
  const expectedGeneration = Number(a.expectedGeneration);
  const classifiedRevision = String(a.classifiedRevision ?? "");
  // The lease authorizes the turn to classify THIS generation of THIS receipt. It does not have to
  // still be held: the execution lease is short (30s) and a turn that reads evidence and reasons
  // about it routinely outlives it, after which the daemon moves the receipt to retry_wait and
  // clears the claim owner. That must not discard the agent's work, so authorization is checked
  // against the stable identity the lease was minted with — agent, event id, generation and the
  // observation revision handed to this turn — and each mismatch says which field was wrong.
  // The receipt's own observationRevision is deliberately NOT compared: a newer observation can
  // land on the receipt while this generation is still being worked, and the lease revision is
  // the one the agent actually investigated.
  if (!turnEvent) throw new Error(withCode("External event disposition is not authorized for this exact turn lease", "receipt-not-this-turn"));
  if (turnEvent.agent !== agentName || record.agent !== agentName) throw new Error(withCode("External event receipt does not belong to the current agent", "receipt-not-this-turn"));
  if (turnEvent.eventId !== record.eventId) throw new Error(withCode("External event disposition event id does not match the turn lease", "receipt-not-this-turn"));
  if (turnEvent.generation !== expectedGeneration || record.generation !== expectedGeneration) throw new Error(withCode("External event disposition generation does not match the turn lease", "receipt-not-this-turn"));
  if (turnEvent.observationRevision !== classifiedRevision) throw new Error(withCode("External event disposition revision does not match the exact turn lease", "receipt-not-this-turn"));
  if (record.disposition != null) throw new Error(withCode("External event generation is already dispositioned", "receipt-closed"));
  if (record.executionState === "dead_letter") throw new Error(withCode("External event receipt is dead-lettered and cannot be dispositioned", "receipt-closed"));
  const classification = String(a.classification);
  const decision = String(a.decision);
  const nextWake = String(a.nextWake);
  const policyVersion = Number(a.stewardPolicyVersion);
  const policyKind = String(a.stewardPolicyKind ?? "");
  const reason = String(a.reason ?? "").trim();
  const ownerText = String(a.owner_message ?? "").trim();
  if (!reason || (policyKind !== "none" && (!Number.isSafeInteger(policyVersion) || policyVersion < 1))
    || !["current", "none"].includes(policyKind)
    || !["expected", "needs_attention", "adopted", "snoozed", "dismissed_until_change", "resolved"].includes(classification)
    || !["silent", "act", "ask", "report"].includes(decision)
    || !["on_change", "on_escalation", "on_recovery", "at"].includes(nextWake)) {
    throw new Error(withCode("External event disposition is invalid", "disposition-invalid"));
  }
  const wake = nextWake === "at" ? { kind: "at" as const, at: String(a.wakeAt ?? "") } : { kind: nextWake as "on_change" | "on_escalation" | "on_recovery" };
  const actionRefs = Array.isArray(a.actionRefs) ? a.actionRefs.map(String) : [];
  const verificationRefs = Array.isArray(a.verificationRefs) ? a.verificationRefs.map(String) : [];
  const agentRoot = getAgentRoot();
  const policy = readStewardPolicy(agentRoot);
  let stewardPolicy: import("../heart/external-events/router").ExternalEventDisposition["stewardPolicy"];
  if (policyKind === "none") {
    stewardPolicy = { kind: "none" };
  } else {
    const key = String(a.stewardPolicyKey ?? "").trim();
    if (!key) throw new Error(withCode("External event disposition is invalid", "disposition-invalid"));
    if (policy.version !== policyVersion || (!policy.desiredStates[key] && !policy.routineActionGrants[key])) {
      throw new Error(withCode("External event steward policy is not the exact current key/version", "policy-not-current"));
    }
    stewardPolicy = { kind: "current", key, version: policyVersion };
  }
  if (typeof a.careId === "string" && a.careId) {
    const care = readCares(agentRoot).find((candidate) => candidate.id === a.careId);
    const binding = care?.incidentBindings?.find((candidate) => candidate.source === record.source && candidate.incidentKey === record.eventId && candidate.classifiedRevision === classifiedRevision);
    if (!care || !binding) throw new Error(withCode("External event Care does not belong to this agent and incident revision", "care-not-bound"));
  }
  if (classification === "adopted" && !(typeof a.careId === "string" && a.careId)) {
    throw new Error(withCode("External event adopted disposition requires a Care", "care-not-bound"));
  }
  if (nextWake === "at") {
    const awaitId = typeof a.awaitId === "string" ? a.awaitId : "";
    if (!/^[A-Za-z0-9_-]+$/u.test(awaitId)) throw new Error(withCode("External event timed disposition requires a current pending Await", "await-mismatch"));
    const awaitPath = path.join(agentRoot, "awaiting", `${awaitId}.md`);
    let pendingAwait;
    try {
      const stat = fs.lstatSync(awaitPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe Await");
      pendingAwait = parseAwaitFile(fs.readFileSync(awaitPath, "utf8"), awaitPath);
    } catch {
      throw new Error(withCode("External event timed disposition requires a current pending Await", "await-mismatch"));
    }
    const expectedOwnerId = ctx?.context?.friend.id;
    if (pendingAwait.filed_from !== "external-event" || pendingAwait.filed_from_key !== record.recordPath
      || (expectedOwnerId && pendingAwait.filed_for_friend_id !== expectedOwnerId)) {
      throw new Error(withCode("External event timed disposition Await is not owned by this exact external event", "await-mismatch"));
    }
    if (pendingAwait.status !== "pending" || pendingAwait.wake_at !== String(a.wakeAt)) {
      throw new Error(withCode("External event timed disposition Await does not match the exact wake time", "await-mismatch"));
    }
  }
  const authority = ctx?.externalEventAuthority?.authorizeDisposition({
    event: turnEvent,
    classification,
    decision,
    stewardPolicy,
    nextWake,
    wakeAt: nextWake === "at" ? String(a.wakeAt) : null,
    awaitId: typeof a.awaitId === "string" && a.awaitId ? a.awaitId : null,
    careId: typeof a.careId === "string" && a.careId ? a.careId : null,
    actionRefs,
    verificationRefs,
  });
  if (!authority?.allowed) throw new Error(withCode(`External event disposition authority denied: ${authority?.reason ?? "authority unavailable"}`, "authority-denied"));

  return {
    recordPath,
    finish: async () => {
      let ownerMessage: import("../heart/external-events/router").ExternalEventOwnerMessage | undefined;
      if (decision === "ask" || decision === "report") {
        if (!ownerText) throw new Error(withCode("ask and report need owner_message: the short plain text the owner will read", "owner-message-invalid"));
        if (Buffer.byteLength(ownerText, "utf8") > 1_200) throw new Error(withCode("External event owner message must be phone-sized", "owner-message-invalid"));
        if (OWNER_MESSAGE_FORBIDDEN.test(ownerText)) throw new Error(withCode("owner_message must be plain words for the owner, with no internal ids, leases, generations, revisions, receipts or hidden characters", "owner-message-invalid"));
        if (!ctx?.externalEventEffects) throw new Error(withCode("External event owner delivery is unavailable", "owner-delivery-unavailable"));
        // The whole dispatched batch shares one owner message; the delivery port settles later decisions as covered by it.
        const relatedEvents = [turnContext!, ...(turnContext!.relatedEvents ?? [])]
          .filter((event) => path.resolve(event.recordPath) !== recordPath)
          .map((event) => ({ source: event.source, eventId: event.eventId, generation: event.generation }));
        const delivered = await ctx.externalEventEffects.deliverOwnerDecision({ source: record.source, eventId: record.eventId, generation: record.generation, text: ownerText, relatedEvents });
        ownerMessage = { status: delivered.status, effectKey: delivered.effectKey };
      }
      const handled = commitExternalEventDisposition(recordPath, {
        owner: turnEvent.claimOwner,
        // No expectedVersion: the lease heartbeat advances the receipt version every few seconds,
        // so the snapshot taken when the turn started is legitimately stale by commit time. The
        // generation is the durable identity of what the agent investigated.
        expectedGeneration: record.generation,
        disposition: {
          classifiedRevision,
          classification: classification as import("../heart/external-events/router").ExternalEventClassification,
          stewardPolicy,
          decision: decision as import("../heart/external-events/router").ExternalEventDecision,
          reason,
          nextWake: wake,
          careId: typeof a.careId === "string" && a.careId ? a.careId : null,
          awaitId: typeof a.awaitId === "string" && a.awaitId ? a.awaitId : null,
          actionRefs,
          verificationRefs,
          ...(ownerMessage ? { ownerMessage } : {}),
        },
      });
      ctx?.externalEventAuthority?.recordCommittedDisposition?.(turnEvent);
      emitNervesEvent({ component: "repertoire", event: "repertoire.external_event_disposition", message: "external event disposition recorded", meta: { agentName, eventId: record.eventId, generation: record.generation, classification, decision, ...(ownerMessage ? { ownerMessage: ownerMessage.status } : {}) } });
      return handled;
    },
  };
}

export const continuityToolDefinitions: ToolDefinition[] = [
  // ── Continuity tools ──────────────────────────────────────────────
  {
    tool: {
      type: "function",
      function: {
        name: "external_event_disposition",
        description: "Classify the external event I just investigated. ask and report send owner_message (the only way to reach the owner); silent and act only record. In a batch only the first ask or report sends, covering the rest, so make its owner_message cover every incident.",
        parameters: {
          type: "object",
          properties: {
            ...externalEventDispositionProperties,
            batch: externalEventDispositionBatchSchema,
          },
          additionalProperties: false,
        },
      },
    },
    handler: (a, ctx) => {
      const input = a as unknown as Record<string, unknown>;
      if (input.batch !== undefined) {
        if (Object.keys(input).some((key) => key !== "batch")) throw new Error(withCode("External event disposition single and batch forms are mutually exclusive", "disposition-invalid"));
        if (!Array.isArray(input.batch) || input.batch.length < 1 || input.batch.length > 32) throw new Error(withCode("External event disposition batch must contain 1 to 32 items", "disposition-invalid"));
        if (input.batch.some((item) => !item || typeof item !== "object" || Array.isArray(item))) throw new Error(withCode("External event disposition batch item is invalid", "disposition-invalid"));
        const recordPaths = input.batch.map((item) => path.resolve(String((item as Record<string, unknown>).recordPath ?? "")));
        if (new Set(recordPaths).size !== recordPaths.length) throw new Error(withCode("External event disposition batch contains a duplicate receipt", "disposition-invalid"));
        const activeFrame = ctx?.currentExternalEvent
          ? [ctx.currentExternalEvent, ...(ctx.currentExternalEvent.relatedEvents ?? [])]
          : [];
        const activeRecordPaths = new Set(activeFrame.map((event) => path.resolve(event.recordPath)));
        if (activeRecordPaths.size !== recordPaths.length || recordPaths.some((recordPath) => !activeRecordPaths.has(recordPath))) {
          throw new Error(withCode("External event disposition batch must contain every lease in the active turn frame", "batch-incomplete"));
        }
        const prepared = input.batch.map((item) => prepareExternalEventDisposition(item as Record<string, unknown>, ctx));
        return (async () => {
          const results: Array<{ recordPath: string; ok: boolean; record?: unknown; error?: string }> = [];
          for (const item of prepared) {
            try {
              results.push({ recordPath: item.recordPath, ok: true, record: await item.finish() });
            } catch (error) {
              results.push({ recordPath: item.recordPath, ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
            }
          }
          return JSON.stringify({ results }, null, 2);
        })();
      }
      const prepared = prepareExternalEventDisposition(input, ctx);
      return prepared.finish().then((handled) => JSON.stringify(handled, null, 2));
    },
    riskProfile: { mutates: "durable_state_write", risk: "high", reason: "records the agent's classification on an existing external-event receipt" },
    ax: { id: "tool:external_event_disposition", group: "turn-external-events", when: "Pick this once you have investigated an external event this turn, to record what it means and whether the owner hears about it.", effect: "write", errors: [
      { code: "receipt-not-this-turn", means: "The receipt or its generation, event id or revision doesn't match a lease handed to this turn.", fix: "Copy recordPath, expectedGeneration and classifiedRevision exactly from this turn's external-event message." },
      { code: "receipt-closed", means: "This generation already has a disposition, or the daemon dead-lettered it.", fix: "Stop; nothing more is needed for this generation." },
      { code: "disposition-invalid", means: "A field is missing or not one of its allowed values, or the single and batch forms are mixed.", fix: "Send either one disposition or one batch, with reason and each enum field set to an allowed value." },
      { code: "batch-incomplete", means: "The batch leaves out a lease of this turn or names one that isn't in it.", fix: "Send one batch item for every lease the turn listed, and only those." },
      { code: "policy-not-current", means: "stewardPolicyKey and stewardPolicyVersion don't match the live steward policy.", fix: "Read the current policy's key and version again, or set stewardPolicyKind to none." },
      { code: "care-not-bound", means: "adopted needs a careId, and that Care must be bound to this incident revision.", fix: "Bind the incident with care_manage bind_incident first, then pass that Care's id." },
      { code: "await-mismatch", means: "nextWake at needs a pending Await filed for this event at the same wake time.", fix: "Call await_condition for this event, then pass its awaitId and the same wakeAt." },
      { code: "authority-denied", means: "The runtime refused this disposition for this event; the message gives the reason.", fix: "Choose a disposition the reason allows, usually ask or report to the owner." },
      { code: "owner-message-invalid", means: "ask and report need owner_message as short plain words, with no internal ids or bookkeeping terms.", fix: "Write one phone-sized message the owner can read cold, without ids, leases or receipts." },
      { code: "owner-delivery-unavailable", means: "This turn can't deliver a message to the owner.", fix: "Use decision silent or act for now and record why in reason." },
    ] },
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
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_episodes", group: "turn-continuity", when: "Pick this to recall recent significant events from your continuity log, filtered by kind or time, before retelling what happened lately.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "limit isn't a number, or kind or since isn't text.", fix: "Pass limit as a number such as 20, and since as an ISO time." },
    ] },
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
    ax: { id: "tool:capture_episode", group: "turn-continuity", when: "Pick this to mark a turning point worth remembering with why it mattered; later chats find it through query_episodes.", effect: "write", errors: [
      { code: "invalid-arguments", means: "summary or whyItMattered is missing.", fix: "Call capture_episode again with both a summary and why it mattered." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so new episodes wait.", fix: "Call orientation_get, settle what the person meant, then go ahead if it is still right." },
    ] },
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
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_presence", group: "turn-continuity", when: "Pick this to see your own current availability and lane, and which peer agents are around, before handing off or waiting on one.", effect: "read", idempotent: true, errors: [
      { code: "not-allowed", means: "This relationship's tool selection doesn't include presence.", fix: "Carry on without it; presence matters only for coordinating with other agents." },
    ] },
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
      const now = Date.now()
      const cares = (a.status === "all" ? readCares(agentRoot) : readActiveCares(agentRoot)).map((care) => projectCareEvidence(care, now));
      emitNervesEvent({ component: "repertoire", event: "repertoire.query_cares", message: `queried ${cares.length} cares`, meta: { count: cares.length } });
      return JSON.stringify(cares, null, 2);
    },
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_cares", group: "turn-continuity", when: "Pick this to list what you are watching over, active cares by default or every status, before creating one with care_manage.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "status isn't text.", fix: "Pass status as active, watching, resolved, dormant or all." },
    ] },
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
            status: { type: "string", enum: ["active", "watching", "resolved", "dormant"], description: "active, watching, resolved, or dormant" },
            stewardship: { type: "string", description: "mine, shared, or delegated" },
            source: { type: "string", description: "Machine evidence source for an incident binding" },
            incidentKey: { type: "string", description: "Stable incident key within the source" },
            classifiedRevision: { type: "string", description: "Observation revision classified by the agent" },
            correlationKey: { type: "string", description: "Optional key relating several incidents to one concern" },
            expectedUpdatedAt: { type: "string", description: "The Care's current updatedAt, copied from the last care_manage result. Required for bind_incident and resolve_incident; optional for update." },
            currentRisk: { type: "string", description: "Current material risk for this Care, or an empty string to clear it" },
            nextCheckAt: { type: "string", description: "Exact ISO time of the next owned check" },
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
          status: (a.status as any) ?? "active",
          salience: (a.salience as any) ?? "medium",
          steward: (a.stewardship as any) ?? "mine",
          relatedFriendIds: [],
          relatedAgentIds: [],
          relatedObligationIds: [],
          relatedEpisodeIds: [],
          currentRisk: a.currentRisk ? String(a.currentRisk) : null,
          nextCheckAt: a.nextCheckAt ? String(a.nextCheckAt) : null,
        });
      } else if (a.action === "update") {
        const updates: Record<string, unknown> = {};
        if (a.label) updates.label = a.label;
        if (a.why) updates.why = a.why;
        if (a.salience) updates.salience = a.salience;
        if (a.currentRisk !== undefined) updates.currentRisk = a.currentRisk || null;
        if (a.nextCheckAt !== undefined) updates.nextCheckAt = a.nextCheckAt || null;
        result = updateCare(agentRoot, a.id, updates);
      } else if (a.action === "resolve") {
        result = resolveCare(agentRoot, a.id);
      } else if (a.action === "bind_incident") {
        if (!a.expectedUpdatedAt) throw new Error(withCode("bind_incident requires expectedUpdatedAt: copy the Care's current updatedAt from the last care_manage result", "expected-updated-at-required"));
        result = bindCareIncident(agentRoot, a.id, {
          source: a.source,
          incidentKey: a.incidentKey,
          classifiedRevision: a.classifiedRevision,
          ...(a.correlationKey ? { correlationKey: a.correlationKey } : {}),
        }, { expectedUpdatedAt: a.expectedUpdatedAt });
      } else if (a.action === "resolve_incident") {
        if (!a.expectedUpdatedAt) throw new Error(withCode("resolve_incident requires expectedUpdatedAt: copy the Care's current updatedAt from the last care_manage result", "expected-updated-at-required"));
        result = resolveCareIncident(agentRoot, a.id, {
          source: a.source,
          incidentKey: a.incidentKey,
          expectedUpdatedAt: a.expectedUpdatedAt,
          ...((a.label !== undefined || a.why !== undefined || a.currentRisk !== undefined || a.nextCheckAt !== undefined) ? {
            display: {
              ...(a.label !== undefined ? { label: String(a.label) } : {}),
              ...(a.why !== undefined ? { why: String(a.why) } : {}),
              ...(a.currentRisk !== undefined ? { currentRisk: a.currentRisk ? String(a.currentRisk) : null } : {}),
              ...(a.nextCheckAt !== undefined ? { nextCheckAt: a.nextCheckAt ? String(a.nextCheckAt) : null } : {}),
            },
          } : {}),
        });
      } else if (a.action === "upsert_incident") {
        result = upsertCareForIncident(agentRoot, {
          ...(a.id ? { id: String(a.id) } : {}),
          ...(!a.id ? {
            label: a.label ?? "untitled", why: a.why ?? "", kind: (a.kind as any) ?? "system", status: (a.status as any) ?? "active",
            salience: (a.salience as any) ?? "medium", steward: (a.stewardship as any) ?? "mine",
          } : {
            ...(a.label !== undefined ? { label: String(a.label) } : {}), ...(a.why !== undefined ? { why: String(a.why) } : {}),
            ...(a.kind !== undefined ? { kind: a.kind as any } : {}), ...(a.status !== undefined ? { status: a.status as any } : {}),
            ...(a.salience !== undefined ? { salience: a.salience as any } : {}), ...(a.stewardship !== undefined ? { steward: a.stewardship as any } : {}),
          }),
          relatedFriendIds: [],
          relatedAgentIds: [],
          relatedObligationIds: [],
          relatedEpisodeIds: [],
          ...(!a.id || a.currentRisk !== undefined ? { currentRisk: a.currentRisk ? String(a.currentRisk) : null } : {}),
          ...(!a.id || a.nextCheckAt !== undefined ? { nextCheckAt: a.nextCheckAt ? String(a.nextCheckAt) : null } : {}),
          ...(a.expectedUpdatedAt ? { expectedUpdatedAt: String(a.expectedUpdatedAt) } : {}),
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
    ax: { id: "tool:care_manage", group: "turn-continuity", when: "Pick this to start, change or close a care, or tie a machine incident to one; query_cares finds existing ids first.", effect: "write", errors: [
      { code: "expected-updated-at-required", means: "bind_incident and resolve_incident need the Care's current updatedAt.", fix: "Copy updatedAt from the last care_manage or query_cares result into expectedUpdatedAt." },
      { code: "invalid-arguments", means: "action is missing or not one of create, update, resolve, bind_incident, resolve_incident or upsert_incident.", fix: "Call care_manage again with one of those actions and its fields." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so care changes wait.", fix: "Call orientation_get, settle what the person meant, then go ahead if it is still right." },
    ] },
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
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:query_relationships", group: "turn-continuity", when: "Pick this to see what you know about other agents you work with, one by name or all; people are in friend_list.", effect: "read", idempotent: true, errors: [
      { code: "invalid-arguments", means: "agentName isn't text.", fix: "Pass the agent's name as text, or leave it out to list all agents." },
    ] },
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
    ax: { id: "tool:intention_capture", group: "turn-continuity", when: "Pick this to jot something small you mean to do or check later, with an optional nudge time; bigger concerns become cares.", effect: "write", errors: [
      { code: "invalid-arguments", means: "content is missing.", fix: "Call intention_capture again with what you mean to do as content." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so new intentions wait.", fix: "Call orientation_get, settle what the person meant, then go ahead if it is still right." },
    ] },
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
    ax: { id: "tool:intention_manage", group: "turn-continuity", when: "Pick this to close an intention, as resolve when done or dismiss when it no longer matters, using its id.", effect: "write", errors: [
      { code: "invalid-arguments", means: "action isn't resolve or dismiss, or id is missing.", fix: "Call intention_manage again with action resolve or dismiss and the intention's id." },
      { code: "orientation-hold", means: "This turn is on a correction hold, so intention changes wait.", fix: "Call orientation_get, settle what the person meant, then go ahead if it is still right." },
    ] },
  },
]
