import * as fs from "fs"
import { emitNervesEvent } from "../../nerves/runtime"
import {
  buildVoiceRealtimeEvalDefaultExpectation,
  gradeVoiceRealtimeEvalTimeline,
  type VoiceRealtimeEvalEventType,
  type VoiceRealtimeEvalExpectation,
  type VoiceRealtimeEvalReport,
  type VoiceRealtimeEvalSessionConfig,
  type VoiceRealtimeEvalSource,
  type VoiceRealtimeEvalTimelineEvent,
  type VoiceRealtimeEvalTransport,
} from "./realtime-eval"

export type VoiceRealtimeEvalTraceExpectedOutcome = "expected-fail" | "fail" | "pass"
export type VoiceRealtimeEvalTraceExpectationProfile = "voice-phone-default"

export interface VoiceRealtimeEvalTraceEvent {
  atMs: number
  event: string
  source?: VoiceRealtimeEvalSource
  correlationId?: string
  text?: string
  role?: "assistant" | "user"
  toolName?: string
  friendId?: string
  sessionKey?: string
  session?: VoiceRealtimeEvalSessionConfig
  ignored?: boolean
  ignoreReason?: string
}

export interface VoiceRealtimeEvalTraceArtifact {
  schemaVersion: 1
  traceId: string
  scenarioId: string
  expectedOutcome: VoiceRealtimeEvalTraceExpectedOutcome
  expectation?: VoiceRealtimeEvalExpectation
  expectationProfile?: VoiceRealtimeEvalTraceExpectationProfile
  redacted?: boolean
  events: VoiceRealtimeEvalTraceEvent[]
}

export interface VoiceRealtimeEvalTraceReplayResult {
  artifact: VoiceRealtimeEvalTraceArtifact
  traceId: string
  scenarioId: string
  expectedOutcome: VoiceRealtimeEvalTraceExpectedOutcome
  outcomeMatched: boolean
  report: VoiceRealtimeEvalReport
  timeline: VoiceRealtimeEvalTimelineEvent[]
  ignoredEvents: VoiceRealtimeEvalTraceEvent[]
}

const transports: ReadonlySet<string> = new Set([
  "browser-meeting",
  "openai-realtime-control",
  "openai-sip",
  "twilio-media-stream",
  "voice-eval",
])

const normalizedEvents: ReadonlySet<string> = new Set([
  "assistant.audio.done",
  "assistant.audio.started",
  "assistant.transcript.done",
  "barge_in.detected",
  "call.connected",
  "call.ended",
  "call.hangup.requested",
  "response.requested",
  "response.truncated",
  "session.updated",
  "tool.call.completed",
  "tool.call.started",
  "tool.holding.started",
  "transport.playback_cleared",
  "user.transcript.done",
  "voice.context.injected",
])

const rawEventMap: ReadonlyMap<string, VoiceRealtimeEvalEventType> = new Map([
  ["openai.realtime.call.hangup.sent", "call.hangup.requested"],
  ["openai.realtime.conversation.item.truncate.sent", "response.truncated"],
  ["openai.realtime.input_audio_buffer.speech_started", "barge_in.detected"],
  ["openai.realtime.input_audio_transcription.completed", "user.transcript.done"],
  ["openai.realtime.output_audio.delta", "assistant.audio.started"],
  ["openai.realtime.output_audio.done", "assistant.audio.done"],
  ["openai.realtime.output_audio_transcript.done", "assistant.transcript.done"],
  ["openai.realtime.response.create.sent", "response.requested"],
  ["openai.realtime.response.function_call_arguments.done", "tool.call.started"],
  ["openai.realtime.session.updated", "session.updated"],
  ["openai.realtime.tool.completed", "tool.call.completed"],
  ["openai.sip.call.connected", "call.connected"],
  ["openai.sip.call.ended", "call.ended"],
  ["twilio.call.ended", "call.ended"],
  ["twilio.media.clear.sent", "transport.playback_cleared"],
  ["twilio.media.start", "call.connected"],
  ["voice.hangup.requested", "call.hangup.requested"],
  ["voice.tool_holding.started", "tool.holding.started"],
])

const expectedOutcomes: ReadonlySet<string> = new Set(["expected-fail", "fail", "pass"])
const expectationProfiles: ReadonlySet<string> = new Set(["voice-phone-default"])

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function label(prefix: string | undefined, detail: string): string {
  return prefix ? `${prefix}: ${detail}` : detail
}

function requiredString(value: unknown, name: string, sourceLabel: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(label(sourceLabel, `${name} must be a non-empty string`))
  return value.trim()
}

function optionalString(value: unknown, name: string, sourceLabel: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(label(sourceLabel, `${name} must be a string`))
  return value
}

function parseSource(value: unknown, sourceLabel: string): VoiceRealtimeEvalSource | undefined {
  if (value === undefined) return undefined
  const raw = objectRecord(value)
  if (!raw) throw new Error(label(sourceLabel, "source must be an object"))
  const transport = raw.transport
  if (typeof transport !== "string" || !transports.has(transport)) {
    throw new Error(label(sourceLabel, "source.transport is unsupported"))
  }
  const id = optionalString(raw.id, "source.id", sourceLabel)
  return id === undefined ? { transport: transport as VoiceRealtimeEvalTransport } : { transport: transport as VoiceRealtimeEvalTransport, id }
}

function parseTurnDetection(value: unknown, sourceLabel: string): VoiceRealtimeEvalSessionConfig | undefined {
  if (value === undefined) return undefined
  const session = objectRecord(value)
  if (!session) throw new Error(label(sourceLabel, "session must be an object"))
  const turnDetection = objectRecord(session.turnDetection)
  if (!turnDetection) return {}
  const createResponse = turnDetection.createResponse
  const interruptResponse = turnDetection.interruptResponse
  if (createResponse !== undefined && typeof createResponse !== "boolean") {
    throw new Error(label(sourceLabel, "session.turnDetection.createResponse must be boolean"))
  }
  if (interruptResponse !== undefined && typeof interruptResponse !== "boolean") {
    throw new Error(label(sourceLabel, "session.turnDetection.interruptResponse must be boolean"))
  }
  return { turnDetection: { createResponse, interruptResponse } }
}

function validateExpectation(expectation: VoiceRealtimeEvalExpectation, sourceLabel: string): VoiceRealtimeEvalExpectation {
  const budgets = [
    expectation.maxFirstAssistantAudioMs,
    expectation.maxUserTurnResponseMs,
    expectation.maxToolPresenceMs,
    expectation.maxBargeInClearMs,
    expectation.maxBargeInTruncateMs,
  ]
  if (budgets.some((budget) => typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0)) {
    throw new Error(label(sourceLabel, "expectation latency budgets must be positive finite numbers"))
  }
  return expectation
}

function parseExpectation(value: unknown, sourceLabel: string): VoiceRealtimeEvalExpectation {
  const raw = objectRecord(value)
  if (!raw) throw new Error(label(sourceLabel, "expectation must be an object"))
  return validateExpectation(raw as unknown as VoiceRealtimeEvalExpectation, sourceLabel)
}

function parseTraceEvent(value: unknown, index: number, sourceLabel: string): VoiceRealtimeEvalTraceEvent {
  const eventLabel = `${sourceLabel} event[${index}]`
  const raw = objectRecord(value)
  if (!raw) throw new Error(label(eventLabel, "must be an object"))
  const event = requiredString(raw.event, "event", eventLabel)
  const ignored = raw.ignored === undefined ? undefined : raw.ignored
  if (ignored !== undefined && typeof ignored !== "boolean") throw new Error(label(eventLabel, "ignored must be boolean"))
  if (!ignored && !normalizedEvents.has(event) && !rawEventMap.has(event)) {
    throw new Error(label(eventLabel, `unknown trace event ${event}`))
  }
  const atMs = raw.atMs
  if (typeof atMs !== "number" || !Number.isFinite(atMs)) {
    throw new Error(label(eventLabel, "atMs must be a finite number"))
  }
  let role: "assistant" | "user" | undefined
  if (raw.role !== undefined) {
    if (raw.role !== "assistant" && raw.role !== "user") throw new Error(label(eventLabel, "role must be assistant or user"))
    role = raw.role
  }
  const parsed: VoiceRealtimeEvalTraceEvent = {
    atMs,
    event,
    source: parseSource(raw.source, eventLabel),
    correlationId: optionalString(raw.correlationId, "correlationId", eventLabel),
    text: optionalString(raw.text, "text", eventLabel),
    role,
    toolName: optionalString(raw.toolName, "toolName", eventLabel),
    friendId: optionalString(raw.friendId, "friendId", eventLabel),
    sessionKey: optionalString(raw.sessionKey, "sessionKey", eventLabel),
    session: parseTurnDetection(raw.session, eventLabel),
    ignored: ignored || undefined,
    ignoreReason: optionalString(raw.ignoreReason, "ignoreReason", eventLabel),
  }
  if (parsed.ignored && !parsed.ignoreReason) throw new Error(label(eventLabel, "ignored events require ignoreReason"))
  return parsed
}

export function parseVoiceRealtimeEvalTraceArtifact(value: unknown, sourceLabel = "voice trace artifact"): VoiceRealtimeEvalTraceArtifact {
  const raw = objectRecord(value)
  if (!raw || raw.schemaVersion !== 1) throw new Error(label(sourceLabel, "schemaVersion must be 1"))
  const expectedOutcome = raw.expectedOutcome
  if (typeof expectedOutcome !== "string" || !expectedOutcomes.has(expectedOutcome)) {
    throw new Error(label(sourceLabel, "expectedOutcome must be pass, fail, or expected-fail"))
  }
  const expectationProfile = raw.expectationProfile
  if (expectationProfile !== undefined && (typeof expectationProfile !== "string" || !expectationProfiles.has(expectationProfile))) {
    throw new Error(label(sourceLabel, "expectationProfile is unsupported"))
  }
  const hasInlineExpectation = raw.expectation !== undefined
  if (hasInlineExpectation === (expectationProfile !== undefined)) {
    throw new Error(label(sourceLabel, "provide exactly one of expectation or expectationProfile"))
  }
  if (!Array.isArray(raw.events) || raw.events.length === 0) {
    throw new Error(label(sourceLabel, "events must contain at least one event"))
  }
  const redacted = raw.redacted
  if (redacted !== undefined && typeof redacted !== "boolean") throw new Error(label(sourceLabel, "redacted must be boolean"))
  return {
    schemaVersion: 1,
    traceId: requiredString(raw.traceId, "traceId", sourceLabel),
    scenarioId: requiredString(raw.scenarioId, "scenarioId", sourceLabel),
    expectedOutcome: expectedOutcome as VoiceRealtimeEvalTraceExpectedOutcome,
    expectation: hasInlineExpectation ? parseExpectation(raw.expectation, sourceLabel) : undefined,
    expectationProfile: expectationProfile as VoiceRealtimeEvalTraceExpectationProfile | undefined,
    redacted: redacted || undefined,
    events: raw.events.map((event, index) => parseTraceEvent(event, index, sourceLabel)),
  }
}

export function loadVoiceRealtimeEvalTraceArtifact(filePath: string): VoiceRealtimeEvalTraceArtifact {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf8")
  } catch {
    throw new Error(`${filePath}: failed to read trace artifact`)
  }
  try {
    return parseVoiceRealtimeEvalTraceArtifact(JSON.parse(raw), filePath)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${filePath}: invalid JSON: ${error.message}`)
    throw error
  }
}

export function resolveVoiceRealtimeEvalTraceExpectation(artifact: VoiceRealtimeEvalTraceArtifact): VoiceRealtimeEvalExpectation {
  if (artifact.expectationProfile === "voice-phone-default") return buildVoiceRealtimeEvalDefaultExpectation()
  if (artifact.expectation) return artifact.expectation
  throw new Error(`${artifact.traceId}: trace artifact has no expectation contract`)
}

function eventTypeFor(event: VoiceRealtimeEvalTraceEvent): VoiceRealtimeEvalEventType {
  if (normalizedEvents.has(event.event)) return event.event as VoiceRealtimeEvalEventType
  const type = rawEventMap.get(event.event)
  if (!type) throw new Error(`unknown trace event ${event.event}`)
  return type
}

function toTimelineEvent(event: VoiceRealtimeEvalTraceEvent, redacted: boolean): VoiceRealtimeEvalTimelineEvent {
  const type = eventTypeFor(event)
  return {
    type,
    atMs: event.atMs,
    source: event.source,
    correlationId: event.correlationId,
    text: redacted ? undefined : event.text,
    role: event.role,
    toolName: event.toolName,
    friendId: event.friendId,
    sessionKey: event.sessionKey,
    session: event.session,
  }
}

function sortedTimeline(events: VoiceRealtimeEvalTimelineEvent[]): VoiceRealtimeEvalTimelineEvent[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.atMs - right.event.atMs || left.index - right.index)
    .map(({ event }) => event)
}

function findFirst(events: VoiceRealtimeEvalTimelineEvent[], type: VoiceRealtimeEvalEventType): VoiceRealtimeEvalTimelineEvent | undefined {
  return events.find((event) => event.type === type)
}

function validateCausalTimeline(artifact: VoiceRealtimeEvalTraceArtifact, timeline: VoiceRealtimeEvalTimelineEvent[]): void {
  for (let index = 0; index < artifact.events.length; index += 1) {
    const event = artifact.events[index]
    if (event.ignored) continue
    if (event.atMs < 0) {
      throw new Error(`${artifact.traceId} event[${index}] atMs must be a nonnegative finite number`)
    }
  }

  const connected = findFirst(timeline, "call.connected")
  const audio = findFirst(timeline, "assistant.audio.started")
  if (connected && audio && audio.atMs < connected.atMs) {
    throw new Error(`${artifact.traceId}: assistant audio started before call.connected`)
  }

  for (const response of timeline.filter((event) => event.type === "response.requested" && event.correlationId)) {
    const transcript = timeline.find((event) => event.type === "user.transcript.done" && event.correlationId === response.correlationId)
    if (transcript && response.atMs < transcript.atMs) {
      throw new Error(`${artifact.traceId}: response.requested for ${response.correlationId} occurred before user.transcript.done`)
    }
  }

  for (const completed of timeline.filter((event) => event.type === "tool.call.completed" && event.correlationId)) {
    const started = timeline.find((event) => event.type === "tool.call.started" && event.correlationId === completed.correlationId)
    if (started && completed.atMs < started.atMs) {
      throw new Error(`${artifact.traceId}: tool.call.completed for ${completed.correlationId} occurred before tool.call.started`)
    }
  }

  const expectation = resolveVoiceRealtimeEvalTraceExpectation(artifact)
  if (expectation.requireHangup) {
    const ended = findFirst(timeline, "call.ended")
    const hangup = findFirst(timeline, "call.hangup.requested")
    if (ended && hangup && ended.atMs < hangup.atMs) {
      throw new Error(`${artifact.traceId}: call.ended occurred before call.hangup.requested`)
    }
  }
}

export function traceArtifactToVoiceRealtimeEvalTimeline(artifact: VoiceRealtimeEvalTraceArtifact): VoiceRealtimeEvalTimelineEvent[] {
  const timeline = sortedTimeline(artifact.events
    .filter((event) => !event.ignored)
    .map((event) => toTimelineEvent(event, Boolean(artifact.redacted))))
  validateCausalTimeline(artifact, timeline)
  return timeline
}

function expectedOutcomeMatched(expectedOutcome: VoiceRealtimeEvalTraceExpectedOutcome, passed: boolean): boolean {
  if (expectedOutcome === "pass") return passed
  return !passed
}

export function gradeVoiceRealtimeEvalTrace(artifact: VoiceRealtimeEvalTraceArtifact): VoiceRealtimeEvalTraceReplayResult {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_realtime_trace_replay_start",
    message: "starting Voice realtime trace replay",
    meta: { scenarioId: artifact.scenarioId, events: artifact.events.length },
  })
  const timeline = traceArtifactToVoiceRealtimeEvalTimeline(artifact)
  const report = gradeVoiceRealtimeEvalTimeline(
    artifact.scenarioId,
    timeline,
    resolveVoiceRealtimeEvalTraceExpectation(artifact),
  )
  const result: VoiceRealtimeEvalTraceReplayResult = {
    artifact,
    traceId: artifact.traceId,
    scenarioId: artifact.scenarioId,
    expectedOutcome: artifact.expectedOutcome,
    outcomeMatched: expectedOutcomeMatched(artifact.expectedOutcome, report.passed),
    report,
    timeline,
    ignoredEvents: artifact.events.filter((event) => event.ignored),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_realtime_trace_replay_end",
    message: "finished Voice realtime trace replay",
    meta: { scenarioId: artifact.scenarioId, passed: report.passed, findings: report.findings.length },
  })
  return result
}

function textForSummary(result: VoiceRealtimeEvalTraceReplayResult, event: VoiceRealtimeEvalTimelineEvent): string {
  if (result.artifact.redacted && (
    event.type === "assistant.transcript.done" ||
    event.type === "user.transcript.done" ||
    event.type === "voice.context.injected"
  )) {
    return " [redacted]"
  }
  if (event.text === undefined) return ""
  return ` "${event.text}"`
}

function sourceForSummary(source: VoiceRealtimeEvalSource | undefined): string {
  if (!source) return ""
  return source.id ? ` ${source.transport}/${source.id}` : ` ${source.transport}`
}

export function formatVoiceRealtimeEvalTraceReport(result: VoiceRealtimeEvalTraceReplayResult): string {
  const lines = [
    `trace ${result.traceId} scenario ${result.scenarioId}`,
    `expected: ${result.expectedOutcome}; report passed: ${result.report.passed}; outcome matched: ${result.outcomeMatched}`,
    `transports: ${result.report.transportSources.join(", ") || "none"}`,
    `metrics: ${JSON.stringify(result.report.metrics)}`,
  ]
  if (result.report.findings.length > 0) {
    lines.push("findings:")
    for (const finding of result.report.findings) {
      const message = result.artifact.redacted ? "[redacted]" : finding.message
      lines.push(`- ${finding.code}${finding.atMs === undefined ? "" : ` at ${finding.atMs}ms`}: ${message}`)
    }
  }
  lines.push("events:")
  for (const event of result.timeline) {
    lines.push(`- ${event.atMs}ms ${event.type}${sourceForSummary(event.source)}${textForSummary(result, event)}`)
  }
  lines.push(`ignored provider events: ${result.ignoredEvents.length}`)
  for (const event of result.ignoredEvents) {
    lines.push(`- ${event.atMs}ms ${event.event}${sourceForSummary(event.source)}: ${event.ignoreReason}`)
  }
  return lines.join("\n")
}
