import { describe, expect, it } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  buildVoiceRealtimeEvalDefaultExpectation,
  type VoiceRealtimeEvalExpectation,
} from "../../../senses/voice/realtime-eval"
import {
  formatVoiceRealtimeEvalTraceReport,
  gradeVoiceRealtimeEvalTrace,
  loadVoiceRealtimeEvalTraceArtifact,
  parseVoiceRealtimeEvalTraceArtifact,
  resolveVoiceRealtimeEvalTraceExpectation,
  traceArtifactToVoiceRealtimeEvalTimeline,
  type VoiceRealtimeEvalTraceArtifact,
} from "../../../senses/voice/realtime-trace"

const fixtureDir = path.resolve(__dirname, "../../fixtures/voice-realtime-traces")

const fixtureNames = [
  "clean-call.json",
  "interruption-barge-in.json",
  "tool-holding.json",
  "hangup-mid-turn.json",
  "delayed-audio-transcript-mismatch.json",
  "duplicate-late-provider-event.json",
]

const minimalExpectation: VoiceRealtimeEvalExpectation = {
  maxFirstAssistantAudioMs: 500,
  maxUserTurnResponseMs: 300,
  maxToolPresenceMs: 300,
  maxBargeInClearMs: 100,
  maxBargeInTruncateMs: 120,
}

function fixturePath(name: string): string {
  return path.join(fixtureDir, name)
}

function baseTrace(overrides: Partial<VoiceRealtimeEvalTraceArtifact> = {}): VoiceRealtimeEvalTraceArtifact {
  return parseVoiceRealtimeEvalTraceArtifact({
    schemaVersion: 1,
    traceId: "inline-trace",
    scenarioId: "inline-scenario",
    expectedOutcome: "pass",
    expectation: minimalExpectation,
    events: [
      { atMs: 0, event: "call.connected", source: { transport: "voice-eval", id: "inline" } },
      { atMs: 80, event: "assistant.audio.started", source: { transport: "voice-eval", id: "inline" } },
    ],
    ...overrides,
  }, "inline-trace.json")
}

describe("voice realtime trace replay", () => {
  it("grades committed golden trace fixtures against their declared outcomes", () => {
    const results = fixtureNames.map((name) => {
      const artifact = loadVoiceRealtimeEvalTraceArtifact(fixturePath(name))
      return { name, artifact, result: gradeVoiceRealtimeEvalTrace(artifact) }
    })

    expect(results.map(({ artifact }) => artifact.traceId)).toEqual([
      "clean-call",
      "interruption-barge-in",
      "tool-holding",
      "hangup-mid-turn",
      "delayed-audio-transcript-mismatch",
      "duplicate-late-provider-event",
    ])
    for (const { name, result } of results) {
      expect(result.outcomeMatched, `${name}\n${formatVoiceRealtimeEvalTraceReport(result)}`).toBe(true)
    }

    const clean = results.find(({ name }) => name === "clean-call.json")?.result
    expect(clean?.report).toMatchObject({
      passed: true,
      transportSources: ["openai-realtime-control", "openai-sip", "twilio-media-stream", "voice-eval"],
    })

    const delayed = results.find(({ name }) => name === "delayed-audio-transcript-mismatch.json")?.result
    expect(delayed).toMatchObject({
      expectedOutcome: "expected-fail",
      outcomeMatched: true,
      report: {
        passed: false,
      },
    })
    expect(delayed?.report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining([
      "first_audio_late",
      "user_response_late",
    ]))

    const duplicate = results.find(({ name }) => name === "duplicate-late-provider-event.json")
    const duplicateTimeline = traceArtifactToVoiceRealtimeEvalTimeline(duplicate?.artifact as VoiceRealtimeEvalTraceArtifact)
    expect(duplicateTimeline.filter((event) => event.type === "assistant.audio.started" && event.correlationId === "greeting")).toHaveLength(1)
    expect(duplicate?.result.ignoredEvents.map((event) => event.event)).toEqual([
      "openai.realtime.output_audio.delta",
      "openai.realtime.rate_limits.updated",
      "openai.realtime.response.done",
    ])
  })

  it("supports inline expectations and the named default phone profile", () => {
    const inline = baseTrace()
    const profiled = parseVoiceRealtimeEvalTraceArtifact({
      ...inline,
      traceId: "profiled",
      scenarioId: "profiled",
      expectationProfile: "voice-phone-default",
      expectation: undefined,
      events: [
        { atMs: 0, event: "call.connected", source: { transport: "openai-sip", id: "sip-1" } },
        {
          atMs: 20,
          event: "voice.context.injected",
          friendId: "friend-ari",
          sessionKey: "twilio-phone-friend-ari-via-ouro",
          text: "Resolved voice friend: Ari (friendId=friend-ari, trust=family).",
          source: { transport: "voice-eval" },
        },
        {
          atMs: 30,
          event: "session.updated",
          session: { turnDetection: { createResponse: false, interruptResponse: false } },
          source: { transport: "openai-realtime-control", id: "ws-1" },
        },
        { atMs: 100, event: "assistant.audio.started", source: { transport: "openai-sip", id: "sip-1" } },
        { atMs: 120, event: "assistant.transcript.done", text: "I am checking the weather.", source: { transport: "openai-realtime-control", id: "ws-1" } },
        { atMs: 150, event: "user.transcript.done", text: "Weather please.", correlationId: "user-1", source: { transport: "openai-realtime-control", id: "ws-1" } },
        { atMs: 220, event: "response.requested", correlationId: "user-1", source: { transport: "openai-realtime-control", id: "ws-1" } },
        { atMs: 300, event: "call.hangup.requested", source: { transport: "openai-realtime-control", id: "ws-1" } },
      ],
    }, "profiled.json")

    expect(gradeVoiceRealtimeEvalTrace(inline).report.metrics.ttfaMs).toBe(80)
    expect(buildVoiceRealtimeEvalDefaultExpectation()).toMatchObject({
      maxFirstAssistantAudioMs: 1200,
      requireHangup: true,
    })
    expect(gradeVoiceRealtimeEvalTrace(profiled).report.passed).toBe(true)
  })

  it("rejects malformed artifacts and unknown unmarked source events with actionable labels", () => {
    expect(() => parseVoiceRealtimeEvalTraceArtifact([], "")).toThrow("schemaVersion must be 1")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({}, "empty.json")).toThrow("empty.json: schemaVersion must be 1")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "maybe",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-outcome.json")).toThrow("bad-outcome.json: expectedOutcome must be pass, fail, or expected-fail")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectationProfile: "sleepy-phone",
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-profile.json")).toThrow("bad-profile.json: expectationProfile is unsupported")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      expectationProfile: "voice-phone-default",
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-contract-both.json")).toThrow("bad-contract-both.json: provide exactly one of expectation or expectationProfile")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-contract-none.json")).toThrow("bad-contract-none.json: provide exactly one of expectation or expectationProfile")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [],
    }, "bad-empty-events.json")).toThrow("bad-empty-events.json: events must contain at least one event")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      redacted: "yes",
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-redacted.json")).toThrow("bad-redacted.json: redacted must be boolean")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: { ...minimalExpectation, maxFirstAssistantAudioMs: 0 },
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-budget.json")).toThrow("bad-budget.json: expectation latency budgets must be positive finite numbers")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: null,
      events: [{ atMs: 0, event: "call.connected" }],
    }, "bad-expectation.json")).toThrow("bad-expectation.json: expectation must be an object")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [null],
    }, "bad-event-shape.json")).toThrow("bad-event-shape.json event[0]: must be an object")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "" }],
    }, "bad-event-name.json")).toThrow("bad-event-name.json event[0]: event must be a non-empty string")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: "now", event: "call.connected" }],
    }, "bad-atms.json")).toThrow("bad-atms.json event[0]: atMs must be a finite number")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "provider.future.surprise", source: { transport: "voice-eval" } }],
    }, "bad-event.json")).toThrow("bad-event.json event[0]: unknown trace event provider.future.surprise")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected", source: null }],
    }, "bad-source-shape.json")).toThrow("bad-source-shape.json event[0]: source must be an object")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected", source: { transport: "fax-machine" } }],
    }, "bad-transport.json")).toThrow("bad-transport.json event[0]: source.transport is unsupported")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected", source: { transport: "voice-eval", id: 42 } }],
    }, "bad-source-id.json")).toThrow("bad-source-id.json event[0]: source.id must be a string")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "user.transcript.done", role: "narrator" }],
    }, "bad-role.json")).toThrow("bad-role.json event[0]: role must be assistant or user")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "user.transcript.done", text: 42 }],
    }, "bad-text.json")).toThrow("bad-text.json event[0]: text must be a string")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "provider.future.noise", ignored: true }],
    }, "bad-ignore-reason.json")).toThrow("bad-ignore-reason.json event[0]: ignored events require ignoreReason")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected", ignored: "yes" }],
    }, "bad-ignore-flag.json")).toThrow("bad-ignore-flag.json event[0]: ignored must be boolean")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "session.updated", session: null }],
    }, "bad-session.json")).toThrow("bad-session.json event[0]: session must be an object")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "session.updated", session: { turnDetection: { createResponse: "false" } } }],
    }, "bad-create-response.json")).toThrow("bad-create-response.json event[0]: session.turnDetection.createResponse must be boolean")
    expect(() => parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "bad",
      scenarioId: "bad",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "session.updated", session: { turnDetection: { interruptResponse: "false" } } }],
    }, "bad-interrupt-response.json")).toThrow("bad-interrupt-response.json event[0]: session.turnDetection.interruptResponse must be boolean")
    const sessionWithoutTurnDetection = parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "session-without-turn-detection",
      scenarioId: "session-without-turn-detection",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "session.updated", session: {} }],
    }, "session-without-turn-detection.json")
    expect(sessionWithoutTurnDetection.events[0]?.session).toEqual({})
  })

  it("labels file loading, JSON, and defensive contract failures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-trace-test-"))
    const missingPath = path.join(dir, "missing.json")
    const badJsonPath = path.join(dir, "bad-json.json")
    const badArtifactPath = path.join(dir, "bad-artifact.json")
    fs.writeFileSync(badJsonPath, "{")
    fs.writeFileSync(badArtifactPath, "{}")

    expect(() => loadVoiceRealtimeEvalTraceArtifact(missingPath)).toThrow("failed to read trace artifact")
    expect(() => loadVoiceRealtimeEvalTraceArtifact(badJsonPath)).toThrow("invalid JSON")
    expect(() => loadVoiceRealtimeEvalTraceArtifact(badArtifactPath)).toThrow("schemaVersion must be 1")
    expect(() => resolveVoiceRealtimeEvalTraceExpectation({
      ...baseTrace(),
      expectation: undefined,
      expectationProfile: undefined,
    })).toThrow("trace artifact has no expectation contract")
    expect(() => traceArtifactToVoiceRealtimeEvalTimeline({
      ...baseTrace(),
      events: [{ atMs: 0, event: "provider.future.surprise" }],
    })).toThrow("unknown trace event provider.future.surprise")
  })

  it("rejects causal timeline violations before grading latency budgets", () => {
    const cases: Array<{ name: string; trace: VoiceRealtimeEvalTraceArtifact; message: string }> = [
      {
        name: "negative timestamp",
        trace: baseTrace({ events: [{ atMs: -1, event: "call.connected", source: { transport: "voice-eval" } }] }),
        message: "event[0] atMs must be a nonnegative finite number",
      },
      {
        name: "audio before connect",
        trace: baseTrace({ events: [
          { atMs: 20, event: "assistant.audio.started", source: { transport: "voice-eval" } },
          { atMs: 80, event: "call.connected", source: { transport: "voice-eval" } },
        ] }),
        message: "assistant audio started before call.connected",
      },
      {
        name: "response before user transcript",
        trace: baseTrace({ events: [
          { atMs: 0, event: "call.connected", source: { transport: "voice-eval" } },
          { atMs: 20, event: "assistant.audio.started", source: { transport: "voice-eval" } },
          { atMs: 70, event: "response.requested", correlationId: "user-1", source: { transport: "voice-eval" } },
          { atMs: 90, event: "user.transcript.done", correlationId: "user-1", text: "hello", source: { transport: "voice-eval" } },
        ] }),
        message: "response.requested for user-1 occurred before user.transcript.done",
      },
      {
        name: "tool completed before start",
        trace: baseTrace({ events: [
          { atMs: 0, event: "call.connected", source: { transport: "voice-eval" } },
          { atMs: 20, event: "assistant.audio.started", source: { transport: "voice-eval" } },
          { atMs: 70, event: "tool.call.completed", correlationId: "tool-1", toolName: "lookup", source: { transport: "voice-eval" } },
          { atMs: 90, event: "tool.call.started", correlationId: "tool-1", toolName: "lookup", source: { transport: "voice-eval" } },
        ] }),
        message: "tool.call.completed for tool-1 occurred before tool.call.started",
      },
      {
        name: "ended before hangup",
        trace: baseTrace({
          expectation: { ...minimalExpectation, requireHangup: true },
          events: [
            { atMs: 0, event: "call.connected", source: { transport: "voice-eval" } },
            { atMs: 20, event: "assistant.audio.started", source: { transport: "voice-eval" } },
            { atMs: 70, event: "call.ended", source: { transport: "voice-eval" } },
            { atMs: 90, event: "call.hangup.requested", source: { transport: "voice-eval" } },
          ],
        }),
        message: "call.ended occurred before call.hangup.requested",
      },
    ]

    for (const item of cases) {
      expect(() => gradeVoiceRealtimeEvalTrace(item.trace), item.name).toThrow(item.message)
    }
  })

  it("keeps explicitly ignored provider noise visible without letting it enter the grading timeline", () => {
    const trace = baseTrace({
      events: [
        { atMs: 0, event: "call.connected", source: { transport: "voice-eval" } },
        { atMs: 10, event: "openai.realtime.rate_limits.updated", ignored: true, ignoreReason: "provider bookkeeping", source: { transport: "openai-realtime-control", id: "ws-1" } },
        { atMs: 80, event: "assistant.audio.started", source: { transport: "voice-eval" } },
      ],
    })

    const timeline = traceArtifactToVoiceRealtimeEvalTimeline(trace)
    const report = gradeVoiceRealtimeEvalTrace(trace)

    expect(timeline.map((event) => event.type)).toEqual(["call.connected", "assistant.audio.started"])
    expect(report.ignoredEvents).toMatchObject([{ event: "openai.realtime.rate_limits.updated", ignoreReason: "provider bookkeeping" }])
    expect(formatVoiceRealtimeEvalTraceReport(report)).toContain("ignored provider events: 1")
  })

  it("formats source-free traces, stable timestamp ties, and expected fail outcomes", () => {
    const sourceFree = parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "source-free",
      scenarioId: "source-free",
      expectedOutcome: "pass",
      expectation: minimalExpectation,
      events: [
        { atMs: 0, event: "call.connected" },
        { atMs: 100, event: "assistant.audio.started", correlationId: "same-time" },
        { atMs: 100, event: "assistant.transcript.done", correlationId: "same-time", role: "assistant", text: "hello" },
      ],
    }, "source-free.json")
    const expectedFail = parseVoiceRealtimeEvalTraceArtifact({
      schemaVersion: 1,
      traceId: "expected-fail",
      scenarioId: "expected-fail",
      expectedOutcome: "fail",
      expectation: minimalExpectation,
      events: [{ atMs: 0, event: "call.connected" }],
    }, "expected-fail.json")

    const sourceFreeResult = gradeVoiceRealtimeEvalTrace(sourceFree)
    const sourceFreeFormatted = formatVoiceRealtimeEvalTraceReport(sourceFreeResult)
    const expectedFailResult = gradeVoiceRealtimeEvalTrace(expectedFail)

    expect(sourceFreeResult.report.transportSources).toEqual([])
    expect(sourceFreeResult.timeline.map((event) => event.type)).toEqual([
      "call.connected",
      "assistant.audio.started",
      "assistant.transcript.done",
    ])
    expect(sourceFreeFormatted).toContain("transports: none")
    expect(sourceFreeFormatted).toContain("\"hello\"")
    expect(expectedFailResult.outcomeMatched).toBe(true)
  })

  it("redacts transcript-bearing content in reports and cannot satisfy required transcript text from redacted traces", () => {
    const trace = baseTrace({
      redacted: true,
      expectation: {
        ...minimalExpectation,
        requiredTranscripts: [{ role: "user", contains: "secret project" }],
      },
      events: [
        { atMs: 0, event: "call.connected", source: { transport: "voice-eval" } },
        { atMs: 50, event: "assistant.audio.started", source: { transport: "voice-eval" } },
        { atMs: 90, event: "user.transcript.done", correlationId: "user-1", role: "user", text: "the secret project is ready", source: { transport: "voice-eval" } },
        { atMs: 130, event: "response.requested", correlationId: "user-1", source: { transport: "voice-eval" } },
      ],
    })

    const report = gradeVoiceRealtimeEvalTrace(trace)
    const formatted = formatVoiceRealtimeEvalTraceReport(report)

    expect(report.report.passed).toBe(false)
    expect(report.report.findings.map((finding) => finding.code)).toContain("transcript_missing")
    expect(formatted).toContain("[redacted]")
    expect(formatted).not.toContain("secret project")
  })
})
