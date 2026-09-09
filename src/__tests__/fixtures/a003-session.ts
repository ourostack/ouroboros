import type { SessionEnvelope, SessionEvent } from "../../heart/session-events"

// Literal raw JSON fixtures: never obtain the test oracle from the parser or
// repair implementation whose normalization/authority is under test.
export const A003_AT = "2026-09-05T12:00:00.000Z"
export const A003_REPAIR_AT = "2026-09-07T23:00:00.000Z"
// Independently pinned from the approved native-input contract, not imported
// from the repair implementation or inferred from an array offset.
export const A003_NATIVE_TARGETS = [
  { id: "evt-000347", sequence: 347 },
  { id: "evt-000355", sequence: 355 },
  { id: "evt-000363", sequence: 363 },
  { id: "evt-000366", sequence: 366 },
  { id: "evt-000369", sequence: 369 },
  { id: "evt-000400", sequence: 400 },
  { id: "evt-000447", sequence: 447 },
  { id: "evt-000448", sequence: 448 },
] as const
export const A003_LEGACY_MEDIA = "Use sanctuary_search_media_catalog before answering. If asked for taste or a favorite, form a light recommendation from returned catalog evidence instead of claiming you cannot have preferences. Keep it honest: say you cannot watch, but you can pick from the household shelf. Missing required tool calls: sanctuary_search_media_catalog."
export const A003_LEGACY_STORAGE = "Run both safe reads now, identify the largest measured evidence, report Unmanic and Jellyfin findings, and propose a sample encode without inventing future savings. If one read returns a degraded or partial result, continue with the other safe reads and bounded container/log tools before answering. Do not ask permission or send Ari to a shell, dashboard, logs, or QDirStat while these typed reads are available. Missing required tool calls: unraid_get_storage, sanctuary_get_media_optimization."

export function a003Event(sequence: number, role: SessionEvent["role"], content: SessionEvent["content"]): SessionEvent {
  return {
    id: `evt-${String(sequence).padStart(6, "0")}`,
    sequence,
    role,
    content,
    name: null,
    toolCallId: null,
    toolCalls: [],
    attachments: [],
    time: {
      authoredAt: role === "user" ? null : A003_AT,
      authoredAtSource: role === "user" ? "unknown" : "local",
      observedAt: A003_AT,
      observedAtSource: role === "user" ? "ingest" : "local",
      recordedAt: A003_AT,
      recordedAtSource: "save",
    },
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: [],
      toolCallId: null,
      supersedesEventId: null,
      redactsEventId: null,
    },
    provenance: { captureKind: "live", legacyVersion: null, sourceMessageIndex: null },
  }
}

export function a003Marker(target: SessionEvent, sequence: number): SessionEvent {
  return {
    ...a003Event(sequence, "system", null),
    time: {
      authoredAt: null,
      authoredAtSource: "migration",
      observedAt: null,
      observedAtSource: "migration",
      recordedAt: A003_REPAIR_AT,
      recordedAtSource: "migration",
    },
    relations: {
      replyToEventId: null,
      threadRootEventId: null,
      references: [],
      toolCallId: null,
      supersedesEventId: null,
      redactsEventId: target.id,
    },
    provenance: { captureKind: "migration", legacyVersion: 2, sourceMessageIndex: null },
  }
}

export function a003Envelope(events: SessionEvent[]): SessionEnvelope {
  return {
    version: 2,
    events,
    projection: {
      eventIds: events.map((event) => event.id),
      trimmed: false,
      maxTokens: null,
      contextMargin: null,
      inputTokens: null,
      projectedAt: A003_AT,
    },
    structuredOutputs: [],
    lastUsage: null,
    state: { mustResolveBeforeHandoff: false, lastFriendActivityAt: null },
  }
}

export function a003LegacyEnvelope(): SessionEnvelope {
  // Privacy-safe retained history: a nonzero native origin, deliberate gaps,
  // and a newer raw system event projected ahead of the earlier conversation.
  const sequences = Array.from({ length: 223 }, (_, index) => index + 290)
    .filter((sequence) => ![295, 354, 401, 430].includes(sequence))
  const envelope = a003Envelope(sequences.map((sequence) => {
    const targetIndex = A003_NATIVE_TARGETS.findIndex((target) => target.sequence === sequence)
    const event = a003Event(sequence, targetIndex >= 0 ? "user" : sequence === 509 ? "system" : sequence % 2 ? "user" : "assistant",
      targetIndex >= 0 ? targetIndex === 0 ? A003_LEGACY_STORAGE : A003_LEGACY_MEDIA
        : sequence === 509 ? "system prompt v1" : `ordinary conversation ${sequence}`)
    if (targetIndex >= 0) event.id = A003_NATIVE_TARGETS[targetIndex]!.id
    return event
  }))
  envelope.events.find((event) => event.sequence === 294)!.content = "Accepted choices:\n1. First\n2. Second"
  envelope.structuredOutputs = [{
    schemaVersion: 1, id: "structured-evt-000294-1", kind: "ordered_list", sourceEventId: "evt-000294",
    recordedAt: A003_AT, heading: "Accepted choices:", items: [{ label: "1", text: "First" }, { label: "2", text: "Second" }],
  }]
  envelope.lastUsage = { input_tokens: 100, output_tokens: 20, reasoning_tokens: 5, total_tokens: 125 }
  envelope.state = { mustResolveBeforeHandoff: true, lastFriendActivityAt: A003_AT }
  envelope.projection.maxTokens = 80000
  envelope.projection.contextMargin = 20
  envelope.projection.inputTokens = 100
  envelope.projection.eventIds = ["evt-000509", ...envelope.events.filter((event) => event.id !== "evt-000509").map((event) => event.id)]
  return envelope
}

export function a003Pair(): { target: SessionEvent; marker: SessionEvent; envelope: SessionEnvelope } {
  const target = a003Event(3, "user", "engine-only correction")
  target.time.observedAt = "2026-09-06T12:00:00.000Z"
  const marker = a003Marker(target, 4)
  return { target, marker, envelope: a003Envelope([a003Event(1, "user", "actual human"), a003Event(2, "assistant", "accepted answer"), target, marker]) }
}
