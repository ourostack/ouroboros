import { emitNervesEvent } from "../../nerves/runtime"

export type VoiceRealtimeEvalTransport =
  | "browser-meeting"
  | "openai-realtime-control"
  | "openai-sip"
  | "twilio-media-stream"
  | "voice-eval"

export type VoiceRealtimeEvalEventType =
  | "assistant.audio.done"
  | "assistant.audio.started"
  | "assistant.transcript.done"
  | "barge_in.detected"
  | "call.connected"
  | "call.ended"
  | "call.hangup.requested"
  | "response.requested"
  | "response.truncated"
  | "session.updated"
  | "tool.call.completed"
  | "tool.call.started"
  | "tool.holding.started"
  | "transport.playback_cleared"
  | "user.transcript.done"
  | "voice.context.injected"

export interface VoiceRealtimeEvalSource {
  transport: VoiceRealtimeEvalTransport
  id?: string
}

export interface VoiceRealtimeEvalSessionConfig {
  turnDetection?: {
    createResponse?: boolean
    interruptResponse?: boolean
  }
}

export interface VoiceRealtimeEvalTimelineEvent {
  type: VoiceRealtimeEvalEventType
  atMs: number
  source?: VoiceRealtimeEvalSource
  correlationId?: string
  text?: string
  role?: "assistant" | "user"
  toolName?: string
  friendId?: string
  sessionKey?: string
  session?: VoiceRealtimeEvalSessionConfig
}

export interface VoiceRealtimeEvalTranscriptRequirement {
  role: "assistant" | "user"
  contains: string
}

export interface VoiceRealtimeEvalFriendRequirement {
  friendId: string
  sessionKey: string
  marker: string
}

export interface VoiceRealtimeEvalExpectation {
  maxFirstAssistantAudioMs: number
  maxUserTurnResponseMs: number
  maxToolPresenceMs: number
  maxBargeInClearMs: number
  maxBargeInTruncateMs: number
  requireManualFloorControl?: boolean
  requireFriendContext?: VoiceRealtimeEvalFriendRequirement
  requireHangup?: boolean
  requiredTranscripts?: VoiceRealtimeEvalTranscriptRequirement[]
}

export type VoiceRealtimeEvalFindingSeverity = "fail" | "warn"

export interface VoiceRealtimeEvalFinding {
  code: string
  severity: VoiceRealtimeEvalFindingSeverity
  message: string
  atMs?: number
  source?: VoiceRealtimeEvalSource
}

export interface VoiceRealtimeEvalMetrics {
  ttfaMs?: number
  firstUserResponseMs?: number
  firstToolPresenceMs?: number
  firstBargeInClearMs?: number
  firstBargeInTruncateMs?: number
}

export interface VoiceRealtimeEvalReport {
  scenarioId: string
  passed: boolean
  findings: VoiceRealtimeEvalFinding[]
  metrics: VoiceRealtimeEvalMetrics
  transportSources: VoiceRealtimeEvalTransport[]
}

export interface VoiceRealtimeEvalSuiteSummary {
  passed: number
  failed: number
  total: number
  failedScenarioIds: string[]
}

function validateTimeline(scenarioId: string, events: VoiceRealtimeEvalTimelineEvent[], expectation: VoiceRealtimeEvalExpectation): string {
  const normalizedScenarioId = scenarioId.trim()
  if (!normalizedScenarioId) throw new Error("voice eval scenario id is empty")
  if (events.length === 0) throw new Error("voice eval timeline is empty")
  const budgets = [
    expectation.maxFirstAssistantAudioMs,
    expectation.maxUserTurnResponseMs,
    expectation.maxToolPresenceMs,
    expectation.maxBargeInClearMs,
    expectation.maxBargeInTruncateMs,
  ]
  if (budgets.some((budget) => !Number.isFinite(budget) || budget <= 0)) {
    throw new Error("voice eval latency budgets must be positive")
  }
  return normalizedScenarioId
}

function sortedEvents(events: VoiceRealtimeEvalTimelineEvent[]): VoiceRealtimeEvalTimelineEvent[] {
  return [...events].sort((left, right) => left.atMs - right.atMs)
}

function firstEvent(events: VoiceRealtimeEvalTimelineEvent[], type: VoiceRealtimeEvalEventType): VoiceRealtimeEvalTimelineEvent | undefined {
  return events.find((event) => event.type === type)
}

function allEvents(events: VoiceRealtimeEvalTimelineEvent[], type: VoiceRealtimeEvalEventType): VoiceRealtimeEvalTimelineEvent[] {
  return events.filter((event) => event.type === type)
}

function lowerText(value: string | undefined): string {
  return value?.toLowerCase() ?? ""
}

function pushFinding(findings: VoiceRealtimeEvalFinding[], finding: VoiceRealtimeEvalFinding): void {
  findings.push(finding)
}

function gradeFirstAudio(
  events: VoiceRealtimeEvalTimelineEvent[],
  expectation: VoiceRealtimeEvalExpectation,
  findings: VoiceRealtimeEvalFinding[],
): number | undefined {
  const connected = firstEvent(events, "call.connected")
  const firstAudio = firstEvent(events, "assistant.audio.started")
  if (!connected || !firstAudio) {
    pushFinding(findings, {
      code: "first_audio_missing",
      severity: "fail",
      message: "Voice call did not produce assistant audio after connect.",
      source: connected?.source ?? firstAudio?.source,
      atMs: connected?.atMs ?? firstAudio?.atMs,
    })
    return undefined
  }
  const ttfaMs = firstAudio.atMs - connected.atMs
  if (ttfaMs > expectation.maxFirstAssistantAudioMs) {
    pushFinding(findings, {
      code: "first_audio_late",
      severity: "fail",
      message: `First assistant audio started after ${ttfaMs}ms, over the ${expectation.maxFirstAssistantAudioMs}ms budget.`,
      source: firstAudio.source,
      atMs: firstAudio.atMs,
    })
  }
  return ttfaMs
}

function gradeFirstUserResponse(
  events: VoiceRealtimeEvalTimelineEvent[],
  expectation: VoiceRealtimeEvalExpectation,
  findings: VoiceRealtimeEvalFinding[],
): number | undefined {
  const userTranscript = firstEvent(events, "user.transcript.done")
  if (!userTranscript) return undefined
  const response = events.find((event) =>
    event.type === "response.requested"
    && event.atMs >= userTranscript.atMs
    && (!userTranscript.correlationId || event.correlationId === userTranscript.correlationId)
  )
  if (!response) {
    pushFinding(findings, {
      code: "user_response_missing",
      severity: "fail",
      message: "No voice response was requested after the caller transcript completed.",
      source: userTranscript.source,
      atMs: userTranscript.atMs,
    })
    return undefined
  }
  const latencyMs = response.atMs - userTranscript.atMs
  if (latencyMs > expectation.maxUserTurnResponseMs) {
    pushFinding(findings, {
      code: "user_response_late",
      severity: "fail",
      message: `Voice response was requested after ${latencyMs}ms, over the ${expectation.maxUserTurnResponseMs}ms budget.`,
      source: response.source,
      atMs: response.atMs,
    })
  }
  return latencyMs
}

function gradeToolPresence(
  events: VoiceRealtimeEvalTimelineEvent[],
  expectation: VoiceRealtimeEvalExpectation,
  findings: VoiceRealtimeEvalFinding[],
): number | undefined {
  const toolCall = firstEvent(events, "tool.call.started")
  if (!toolCall) return undefined
  const holding = events.find((event) =>
    event.type === "tool.holding.started"
    && event.atMs >= toolCall.atMs
    && (!toolCall.correlationId || event.correlationId === toolCall.correlationId)
  )
  if (!holding) {
    pushFinding(findings, {
      code: "tool_presence_missing",
      severity: "fail",
      message: "Tool call did not produce a short voice holding phrase.",
      source: toolCall.source,
      atMs: toolCall.atMs,
    })
    return undefined
  }
  const latencyMs = holding.atMs - toolCall.atMs
  if (latencyMs > expectation.maxToolPresenceMs) {
    pushFinding(findings, {
      code: "tool_presence_late",
      severity: "fail",
      message: `Tool holding phrase started after ${latencyMs}ms, over the ${expectation.maxToolPresenceMs}ms budget.`,
      source: holding.source,
      atMs: holding.atMs,
    })
  }
  return latencyMs
}

function gradeBargeIn(
  events: VoiceRealtimeEvalTimelineEvent[],
  expectation: VoiceRealtimeEvalExpectation,
  findings: VoiceRealtimeEvalFinding[],
): Pick<VoiceRealtimeEvalMetrics, "firstBargeInClearMs" | "firstBargeInTruncateMs"> {
  const bargeIn = firstEvent(events, "barge_in.detected")
  if (!bargeIn) return {}
  const clear = events.find((event) => event.type === "transport.playback_cleared" && event.atMs >= bargeIn.atMs)
  const truncate = events.find((event) => event.type === "response.truncated" && event.atMs >= bargeIn.atMs)
  const metrics: Pick<VoiceRealtimeEvalMetrics, "firstBargeInClearMs" | "firstBargeInTruncateMs"> = {}
  if (!clear) {
    pushFinding(findings, {
      code: "barge_in_clear_missing",
      severity: "fail",
      message: "Caller barge-in did not clear transport playback.",
      source: bargeIn.source,
      atMs: bargeIn.atMs,
    })
  } else {
    metrics.firstBargeInClearMs = clear.atMs - bargeIn.atMs
    if (metrics.firstBargeInClearMs > expectation.maxBargeInClearMs) {
      pushFinding(findings, {
        code: "barge_in_clear_late",
        severity: "fail",
        message: `Barge-in playback clear took ${metrics.firstBargeInClearMs}ms, over the ${expectation.maxBargeInClearMs}ms budget.`,
        source: clear.source,
        atMs: clear.atMs,
      })
    }
  }
  if (!truncate) {
    pushFinding(findings, {
      code: "barge_in_truncate_missing",
      severity: "fail",
      message: "Caller barge-in did not truncate the active Realtime response.",
      source: bargeIn.source,
      atMs: bargeIn.atMs,
    })
  } else {
    metrics.firstBargeInTruncateMs = truncate.atMs - bargeIn.atMs
    if (metrics.firstBargeInTruncateMs > expectation.maxBargeInTruncateMs) {
      pushFinding(findings, {
        code: "barge_in_truncate_late",
        severity: "fail",
        message: `Barge-in response truncation took ${metrics.firstBargeInTruncateMs}ms, over the ${expectation.maxBargeInTruncateMs}ms budget.`,
        source: truncate.source,
        atMs: truncate.atMs,
      })
    }
  }
  return metrics
}

function gradeManualFloorControl(
  events: VoiceRealtimeEvalTimelineEvent[],
  findings: VoiceRealtimeEvalFinding[],
): void {
  const session = allEvents(events, "session.updated").find((event) => event.session?.turnDetection)
  if (
    session?.session?.turnDetection?.createResponse === false
    && session.session.turnDetection.interruptResponse === false
  ) {
    return
  }
  pushFinding(findings, {
    code: "manual_floor_control_missing",
    severity: "fail",
    message: "Realtime session did not disable provider auto-response and provider interruption.",
    source: session?.source,
    atMs: session?.atMs,
  })
}

function gradeFriendContext(
  events: VoiceRealtimeEvalTimelineEvent[],
  requirement: VoiceRealtimeEvalFriendRequirement,
  findings: VoiceRealtimeEvalFinding[],
): void {
  const context = firstEvent(events, "voice.context.injected")
  if (
    context?.friendId === requirement.friendId
    && context.sessionKey === requirement.sessionKey
    && lowerText(context.text).includes(requirement.marker.toLowerCase())
  ) {
    return
  }
  pushFinding(findings, {
    code: "friend_context_mismatch",
    severity: "fail",
    message: "Voice context did not preserve the expected friend identity, trust marker, and stable session key.",
    source: context?.source,
    atMs: context?.atMs,
  })
}

function gradeTranscripts(
  events: VoiceRealtimeEvalTimelineEvent[],
  requirements: VoiceRealtimeEvalTranscriptRequirement[],
  findings: VoiceRealtimeEvalFinding[],
): void {
  for (const requirement of requirements) {
    const type: VoiceRealtimeEvalEventType = requirement.role === "assistant"
      ? "assistant.transcript.done"
      : "user.transcript.done"
    const found = allEvents(events, type).some((event) => lowerText(event.text).includes(requirement.contains.toLowerCase()))
    if (!found) {
      pushFinding(findings, {
        code: "transcript_missing",
        severity: "fail",
        message: `Missing ${requirement.role} transcript containing "${requirement.contains}".`,
      })
    }
  }
}

function gradeHangup(events: VoiceRealtimeEvalTimelineEvent[], findings: VoiceRealtimeEvalFinding[]): void {
  const hangup = firstEvent(events, "call.hangup.requested")
  if (hangup) return
  const ended = firstEvent(events, "call.ended")
  pushFinding(findings, {
    code: "hangup_missing",
    severity: "fail",
    message: "Voice eval expected an agent-controlled hangup request before call end.",
    source: ended?.source,
    atMs: ended?.atMs,
  })
}

function gradeOverlappingResponses(events: VoiceRealtimeEvalTimelineEvent[], findings: VoiceRealtimeEvalFinding[]): void {
  for (const response of allEvents(events, "response.requested")) {
    const activeAudio = allEvents(events, "assistant.audio.started").find((started) => {
      const done = events.find((event) => event.type === "assistant.audio.done" && event.atMs >= started.atMs)
      return response.atMs > started.atMs && (!done || response.atMs < done.atMs)
    })
    if (activeAudio) {
      pushFinding(findings, {
        code: "response_overlap",
        severity: "fail",
        message: "Voice response was requested while assistant audio was still active.",
        source: response.source,
        atMs: response.atMs,
      })
      return
    }
  }
}

function collectTransportSources(events: VoiceRealtimeEvalTimelineEvent[]): VoiceRealtimeEvalTransport[] {
  return [...new Set(events.flatMap((event) => event.source ? [event.source.transport] : []))].sort()
}

export function gradeVoiceRealtimeEvalTimeline(
  scenarioId: string,
  timeline: VoiceRealtimeEvalTimelineEvent[],
  expectation: VoiceRealtimeEvalExpectation,
): VoiceRealtimeEvalReport {
  const normalizedScenarioId = validateTimeline(scenarioId, timeline, expectation)
  const events = sortedEvents(timeline)
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_realtime_eval_start",
    message: "starting Voice realtime eval timeline grading",
    meta: { scenarioId: normalizedScenarioId, events: events.length },
  })

  const findings: VoiceRealtimeEvalFinding[] = []
  const metrics: VoiceRealtimeEvalMetrics = {
    ttfaMs: gradeFirstAudio(events, expectation, findings),
    firstUserResponseMs: gradeFirstUserResponse(events, expectation, findings),
    firstToolPresenceMs: gradeToolPresence(events, expectation, findings),
    ...gradeBargeIn(events, expectation, findings),
  }
  if (expectation.requireManualFloorControl) gradeManualFloorControl(events, findings)
  if (expectation.requireFriendContext) gradeFriendContext(events, expectation.requireFriendContext, findings)
  if (expectation.requiredTranscripts) gradeTranscripts(events, expectation.requiredTranscripts, findings)
  if (expectation.requireHangup) gradeHangup(events, findings)
  gradeOverlappingResponses(events, findings)

  const report: VoiceRealtimeEvalReport = {
    scenarioId: normalizedScenarioId,
    passed: findings.every((finding) => finding.severity !== "fail"),
    findings,
    metrics,
    transportSources: collectTransportSources(events),
  }
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_realtime_eval_end",
    message: "finished Voice realtime eval timeline grading",
    meta: { scenarioId: normalizedScenarioId, passed: report.passed, findings: findings.length },
  })
  return report
}

export function buildVoiceRealtimeEvalHappyPath(): VoiceRealtimeEvalTimelineEvent[] {
  return [
    { type: "call.connected", atMs: 0, source: { transport: "openai-sip", id: "sip-call-1" } },
    {
      type: "voice.context.injected",
      atMs: 80,
      friendId: "friend-ari",
      sessionKey: "twilio-phone-friend-ari-via-ouro",
      text: "Resolved voice friend: Ari (friendId=friend-ari, trust=family).",
      source: { transport: "voice-eval" },
    },
    {
      type: "session.updated",
      atMs: 100,
      session: { turnDetection: { createResponse: false, interruptResponse: false } },
      source: { transport: "openai-realtime-control", id: "ws-1" },
    },
    { type: "response.requested", atMs: 120, correlationId: "greeting", source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "assistant.audio.started", atMs: 720, correlationId: "greeting", source: { transport: "openai-sip", id: "sip-call-1" } },
    { type: "assistant.audio.done", atMs: 1_820, correlationId: "greeting", source: { transport: "openai-sip", id: "sip-call-1" } },
    {
      type: "assistant.transcript.done",
      atMs: 1_840,
      correlationId: "greeting",
      text: "Hey Ari, I am checking the weather now.",
      source: { transport: "openai-realtime-control", id: "ws-1" },
    },
    {
      type: "user.transcript.done",
      atMs: 2_200,
      correlationId: "user-1",
      text: "Can you check the weather and then hang up?",
      source: { transport: "twilio-media-stream", id: "stream-1" },
    },
    { type: "response.requested", atMs: 2_480, correlationId: "user-1", source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "assistant.audio.started", atMs: 2_540, correlationId: "user-1", source: { transport: "openai-sip", id: "sip-call-1" } },
    { type: "assistant.audio.done", atMs: 2_820, correlationId: "user-1", source: { transport: "openai-sip", id: "sip-call-1" } },
    { type: "tool.call.started", atMs: 3_000, correlationId: "tool-1", toolName: "weather_lookup", source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "tool.holding.started", atMs: 3_260, correlationId: "tool-1", text: "One sec, checking.", source: { transport: "openai-sip", id: "sip-call-1" } },
    { type: "tool.call.completed", atMs: 3_800, correlationId: "tool-1", toolName: "weather_lookup", source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "barge_in.detected", atMs: 4_100, source: { transport: "twilio-media-stream", id: "stream-1" } },
    { type: "transport.playback_cleared", atMs: 4_140, source: { transport: "twilio-media-stream", id: "stream-1" } },
    { type: "response.truncated", atMs: 4_170, source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "call.hangup.requested", atMs: 5_000, source: { transport: "openai-realtime-control", id: "ws-1" } },
    { type: "call.ended", atMs: 5_100, source: { transport: "openai-sip", id: "sip-call-1" } },
  ]
}

function builtInExpectation(): VoiceRealtimeEvalExpectation {
  return {
    maxFirstAssistantAudioMs: 1_200,
    maxUserTurnResponseMs: 900,
    maxToolPresenceMs: 600,
    maxBargeInClearMs: 120,
    maxBargeInTruncateMs: 180,
    requireManualFloorControl: true,
    requireFriendContext: {
      friendId: "friend-ari",
      sessionKey: "twilio-phone-friend-ari-via-ouro",
      marker: "trust=family",
    },
    requireHangup: true,
    requiredTranscripts: [
      { role: "user", contains: "weather" },
      { role: "assistant", contains: "checking the weather" },
    ],
  }
}

function buildKnownBadLatencyPath(): VoiceRealtimeEvalTimelineEvent[] {
  return buildVoiceRealtimeEvalHappyPath().map((event) => {
    if (event.type === "assistant.audio.started" && event.correlationId === "greeting") return { ...event, atMs: 1_900 }
    if (event.type === "response.requested" && event.correlationId === "user-1") return { ...event, atMs: 3_500 }
    return event
  })
}

export function runBuiltInVoiceRealtimeEvalSuite(): VoiceRealtimeEvalReport[] {
  const expectation = builtInExpectation()
  return [
    gradeVoiceRealtimeEvalTimeline("voice-happy-path", buildVoiceRealtimeEvalHappyPath(), expectation),
    gradeVoiceRealtimeEvalTimeline("voice-known-bad-latency", buildKnownBadLatencyPath(), expectation),
  ]
}

export function summarizeVoiceRealtimeEvalSuite(reports: VoiceRealtimeEvalReport[]): VoiceRealtimeEvalSuiteSummary {
  const failedScenarioIds = reports.filter((report) => !report.passed).map((report) => report.scenarioId)
  return {
    passed: reports.length - failedScenarioIds.length,
    failed: failedScenarioIds.length,
    total: reports.length,
    failedScenarioIds,
  }
}
