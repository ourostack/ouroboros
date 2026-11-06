import { describe, expect, it } from "vitest"
import {
  buildVoiceRealtimeEvalHappyPath,
  gradeVoiceRealtimeEvalTimeline,
  runBuiltInVoiceRealtimeEvalSuite,
  summarizeVoiceRealtimeEvalSuite,
  type VoiceRealtimeEvalExpectation,
  type VoiceRealtimeEvalTimelineEvent,
} from "../../../senses/voice/realtime-eval"

const baselineExpectation: VoiceRealtimeEvalExpectation = {
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

const minimalExpectation: VoiceRealtimeEvalExpectation = {
  maxFirstAssistantAudioMs: 100,
  maxUserTurnResponseMs: 100,
  maxToolPresenceMs: 100,
  maxBargeInClearMs: 100,
  maxBargeInTruncateMs: 100,
}

function mutateHappyPath(mutator: (events: VoiceRealtimeEvalTimelineEvent[]) => void): VoiceRealtimeEvalTimelineEvent[] {
  const events = buildVoiceRealtimeEvalHappyPath()
  mutator(events)
  return events
}

describe("voice realtime eval kernel", () => {
  it("passes a healthy transport-aware voice timeline and reports core latency metrics", () => {
    const report = gradeVoiceRealtimeEvalTimeline("happy-path", buildVoiceRealtimeEvalHappyPath(), baselineExpectation)

    expect(report.passed).toBe(true)
    expect(report.findings).toEqual([])
    expect(report.metrics).toMatchObject({
      ttfaMs: 720,
      firstUserResponseMs: 280,
      firstToolPresenceMs: 260,
      firstBargeInClearMs: 40,
      firstBargeInTruncateMs: 70,
    })
    expect(report.transportSources).toEqual([
      "openai-realtime-control",
      "openai-sip",
      "twilio-media-stream",
      "voice-eval",
    ])
  })

  it("flags missing or late first audio, late user responses, and missing transcripts", () => {
    const late = mutateHappyPath((events) => {
      const firstAudio = events.find((event) => event.type === "assistant.audio.started")
      if (firstAudio) firstAudio.atMs = 1_900
      const firstResponse = events.find((event) => event.type === "response.requested" && event.correlationId === "user-1")
      if (firstResponse) firstResponse.atMs = 3_300
      const transcript = events.find((event) => event.type === "assistant.transcript.done")
      if (transcript) transcript.text = "done"
    })

    const report = gradeVoiceRealtimeEvalTimeline("late-path", late, baselineExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "first_audio_late",
      "user_response_late",
      "transcript_missing",
    ]))
    expect(report.findings.find((finding) => finding.code === "first_audio_late")).toMatchObject({
      severity: "fail",
      source: { transport: "openai-sip", id: "sip-call-1" },
    })
  })

  it("flags absent tool presence, duplicate response requests while playback is active, and weak floor control", () => {
    const flawed = mutateHappyPath((events) => {
      const session = events.find((event) => event.type === "session.updated")
      if (session?.session) {
        session.session.turnDetection = { createResponse: true, interruptResponse: true }
      }
      const holdingIndex = events.findIndex((event) => event.type === "tool.holding.started")
      if (holdingIndex >= 0) events.splice(holdingIndex, 1)
      events.push({
        type: "response.requested",
        atMs: 1_600,
        correlationId: "overlap",
        source: { transport: "openai-realtime-control", id: "ws-1" },
      })
    })

    const report = gradeVoiceRealtimeEvalTimeline("tool-floor-path", flawed, baselineExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "manual_floor_control_missing",
      "tool_presence_missing",
      "response_overlap",
    ]))
  })

  it("covers missing first audio, missing user response, late tool presence, and late barge controls", () => {
    const flawed = mutateHappyPath((events) => {
      const firstAudioIndex = events.findIndex((event) => event.type === "assistant.audio.started")
      if (firstAudioIndex >= 0) events.splice(firstAudioIndex, 1)
      const userResponseIndex = events.findIndex((event) => event.type === "response.requested" && event.correlationId === "user-1")
      if (userResponseIndex >= 0) events.splice(userResponseIndex, 1)
      const holding = events.find((event) => event.type === "tool.holding.started")
      if (holding) holding.atMs = 3_900
      const clear = events.find((event) => event.type === "transport.playback_cleared")
      if (clear) clear.atMs = 4_500
      const truncate = events.find((event) => event.type === "response.truncated")
      if (truncate) truncate.atMs = 4_500
    })

    const report = gradeVoiceRealtimeEvalTimeline("missing-late-path", flawed, baselineExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "first_audio_late",
      "user_response_missing",
      "tool_presence_late",
      "barge_in_clear_late",
      "barge_in_truncate_late",
    ]))
  })

  it("flags a connected call that never starts assistant audio", () => {
    const silent = mutateHappyPath((events) => {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === "assistant.audio.started") events.splice(index, 1)
      }
    })

    const report = gradeVoiceRealtimeEvalTimeline("silent-path", silent, baselineExpectation)

    expect(report.findings.find((finding) => finding.code === "first_audio_missing")).toMatchObject({
      severity: "fail",
      source: { transport: "openai-sip", id: "sip-call-1" },
      atMs: 0,
    })
  })

  it("flags malformed timelines with audio but no connect marker or neither connect nor audio", () => {
    const noConnect = gradeVoiceRealtimeEvalTimeline("no-connect", [
      { type: "assistant.audio.started", atMs: 50, source: { transport: "openai-sip", id: "sip-call-1" } },
    ], minimalExpectation)
    const noConnectOrAudio = gradeVoiceRealtimeEvalTimeline("no-connect-audio", [
      { type: "user.transcript.done", atMs: 50 },
    ], minimalExpectation)

    expect(noConnect.findings.find((finding) => finding.code === "first_audio_missing")).toMatchObject({
      source: { transport: "openai-sip", id: "sip-call-1" },
      atMs: 50,
    })
    expect(noConnectOrAudio.findings.find((finding) => finding.code === "first_audio_missing")).toMatchObject({
      severity: "fail",
    })
  })

  it("treats transcript events without text as missing required content", () => {
    const missingText = mutateHappyPath((events) => {
      const assistantTranscript = events.find((event) => event.type === "assistant.transcript.done")
      if (assistantTranscript) delete assistantTranscript.text
    })

    const report = gradeVoiceRealtimeEvalTimeline("missing-transcript-text", missingText, baselineExpectation)

    expect(report.findings.find((finding) => finding.code === "transcript_missing")).toMatchObject({
      message: "Missing assistant transcript containing \"checking the weather\".",
    })
  })

  it("flags missed barge-in controls, missing friend context, and missing hangup", () => {
    const flawed = mutateHappyPath((events) => {
      const clearIndex = events.findIndex((event) => event.type === "transport.playback_cleared")
      if (clearIndex >= 0) events.splice(clearIndex, 1)
      const truncateIndex = events.findIndex((event) => event.type === "response.truncated")
      if (truncateIndex >= 0) events.splice(truncateIndex, 1)
      const context = events.find((event) => event.type === "voice.context.injected")
      if (context) {
        context.friendId = "friend-stranger"
        context.sessionKey = "twilio-phone-stranger"
        context.text = "trust=unknown"
      }
      const hangupIndex = events.findIndex((event) => event.type === "call.hangup.requested")
      if (hangupIndex >= 0) events.splice(hangupIndex, 1)
    })

    const report = gradeVoiceRealtimeEvalTimeline("identity-barge-path", flawed, baselineExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "barge_in_clear_missing",
      "barge_in_truncate_missing",
      "friend_context_mismatch",
      "hangup_missing",
    ]))
  })

  it("flags impossible duplex floor decisions with readable diagnostics", () => {
    const report = gradeVoiceRealtimeEvalTimeline("floor-violations", [
      { type: "call.connected", atMs: 0, source: { transport: "voice-eval", id: "floor" } },
      { type: "assistant.audio.started", atMs: 40, correlationId: "greeting", source: { transport: "voice-eval", id: "floor" } },
      {
        type: "floor.state.changed",
        atMs: 80,
        floorPhase: "caller-speaking",
        floorOwner: "caller",
        activeAssistantSpeechId: "greeting",
        pendingSpeechId: "followup",
        pendingToolCallIds: ["weather-1"],
        interruptionTurnId: "turn-2",
        decisionReason: "caller_has_floor",
        source: { transport: "voice-eval", id: "floor" },
      },
      {
        type: "speech.policy.decision",
        atMs: 90,
        role: "assistant",
        correlationId: "followup",
        speechDecision: "allow",
        decisionReason: "assistant_speech_allowed",
        source: { transport: "voice-eval", id: "floor" },
      },
      {
        type: "tool.result.spoken",
        atMs: 100,
        correlationId: "weather-1",
        source: { transport: "voice-eval", id: "floor" },
      },
      { type: "call.hangup.requested", atMs: 120, source: { transport: "voice-eval", id: "floor" } },
      { type: "response.requested", atMs: 150, correlationId: "late-followup", source: { transport: "voice-eval", id: "floor" } },
    ], minimalExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "speech_allowed_while_caller_has_floor",
      "tool_result_spoken_while_caller_has_floor",
      "response_after_hangup",
    ]))
    expect(report.findings.find((finding) => finding.code === "speech_allowed_while_caller_has_floor")).toMatchObject({
      severity: "fail",
      atMs: 90,
      floor: {
        phase: "caller-speaking",
        floorOwner: "caller",
        activeAssistantSpeechId: "greeting",
        pendingSpeechId: "followup",
        pendingToolCallIds: ["weather-1"],
        interruptionTurnId: "turn-2",
        decisionReason: "assistant_speech_allowed",
      },
    })
  })

  it("rejects stale tool result speech while preserving the floor reason", () => {
    const report = gradeVoiceRealtimeEvalTimeline("stale-tool-floor", [
      { type: "call.connected", atMs: 0 },
      { type: "assistant.audio.started", atMs: 40, correlationId: "greeting" },
      {
        type: "floor.state.changed",
        atMs: 100,
        floorPhase: "suppressing",
        floorOwner: "none",
        staleToolCallIds: ["research-1"],
        pendingToolCallIds: [],
        decisionReason: "newer_user_turn_started",
      },
      { type: "tool.result.ready", atMs: 110, correlationId: "research-1", toolName: "search" },
      { type: "tool.result.spoken", atMs: 120, correlationId: "research-1", toolName: "search" },
    ], minimalExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.find((finding) => finding.code === "stale_tool_result_spoken")).toMatchObject({
      severity: "fail",
      atMs: 120,
      floor: {
        phase: "suppressing",
        floorOwner: "none",
        staleToolCallIds: ["research-1"],
        decisionReason: "newer_user_turn_started",
      },
    })
  })

  it("flags speech and tool-result output after terminal floor state", () => {
    const report = gradeVoiceRealtimeEvalTimeline("terminal-floor", [
      { type: "call.connected", atMs: 0 },
      { type: "assistant.audio.started", atMs: 40, correlationId: "greeting" },
      { type: "call.hangup.requested", atMs: 80 },
      {
        type: "floor.state.changed",
        atMs: 90,
        floorPhase: "listening",
        floorOwner: "none",
        pendingToolCallIds: ["weather-1"],
        decisionReason: "hangup_terminal",
      },
      {
        type: "speech.policy.decision",
        atMs: 100,
        speechDecision: "allow",
        decisionReason: "assistant_speech_allowed",
        correlationId: "late-speech",
      },
      { type: "tool.result.spoken", atMs: 110, correlationId: "weather-1", toolName: "weather_lookup" },
    ], minimalExpectation)

    expect(report.passed).toBe(false)
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "speech_allowed_after_hangup",
      "tool_result_spoken_after_hangup",
    ]))

    const terminalFloorOnly = gradeVoiceRealtimeEvalTimeline("terminal-floor-only", [
      { type: "call.connected", atMs: 0 },
      { type: "assistant.audio.started", atMs: 40, correlationId: "greeting" },
      {
        type: "floor.state.changed",
        atMs: 80,
        floorPhase: "hangup",
        floorOwner: "terminal",
        decisionReason: "hangup_terminal",
      },
      { type: "tool.result.spoken", atMs: 90, correlationId: "weather-1", toolName: "weather_lookup" },
    ], minimalExpectation)
    expect(terminalFloorOnly.findings.map((finding) => finding.code)).toContain("tool_result_spoken_after_hangup")

    const safeToolSpeech = gradeVoiceRealtimeEvalTimeline("safe-tool-floor", [
      { type: "call.connected", atMs: 0 },
      { type: "assistant.audio.started", atMs: 40, correlationId: "greeting" },
      {
        type: "floor.state.changed",
        atMs: 80,
        floorPhase: "tool-result-ready",
        floorOwner: "none",
        pendingToolCallIds: ["weather-1"],
        decisionReason: "tool_result_ready",
      },
      { type: "tool.result.spoken", atMs: 90, correlationId: "weather-1", toolName: "weather_lookup" },
    ], minimalExpectation)
    expect(safeToolSpeech.passed).toBe(true)
  })

  it("rejects empty inputs and invalid latency budgets", () => {
    expect(() => gradeVoiceRealtimeEvalTimeline("", buildVoiceRealtimeEvalHappyPath(), baselineExpectation)).toThrow(
      "voice eval scenario id is empty",
    )
    expect(() => gradeVoiceRealtimeEvalTimeline("empty", [], baselineExpectation)).toThrow(
      "voice eval timeline is empty",
    )
    expect(() => gradeVoiceRealtimeEvalTimeline("bad-threshold", buildVoiceRealtimeEvalHappyPath(), {
      ...baselineExpectation,
      maxFirstAssistantAudioMs: 0,
    })).toThrow("voice eval latency budgets must be positive")
    expect(() => gradeVoiceRealtimeEvalTimeline("nan-threshold", buildVoiceRealtimeEvalHappyPath(), {
      ...baselineExpectation,
      maxToolPresenceMs: Number.NaN,
    })).toThrow("voice eval latency budgets must be positive")
  })

  it("allows minimal timelines when optional voice assertions are disabled", () => {
    const report = gradeVoiceRealtimeEvalTimeline("minimal", [
      { type: "call.connected", atMs: 40 },
      { type: "assistant.audio.started", atMs: 100 },
    ], minimalExpectation)

    expect(report).toMatchObject({
      passed: true,
      metrics: { ttfaMs: 60 },
      transportSources: [],
    })
  })

  it("runs built-in no-human scenarios and summarizes pass/fail counts", () => {
    const reports = runBuiltInVoiceRealtimeEvalSuite()
    const summary = summarizeVoiceRealtimeEvalSuite(reports)

    expect(reports.map((report) => report.scenarioId)).toEqual([
      "voice-happy-path",
      "voice-known-bad-latency",
    ])
    expect(summary).toEqual({
      passed: 1,
      failed: 1,
      total: 2,
      failedScenarioIds: ["voice-known-bad-latency"],
    })
    expect(reports[1].findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "first_audio_late",
      "user_response_late",
    ]))
  })
})
