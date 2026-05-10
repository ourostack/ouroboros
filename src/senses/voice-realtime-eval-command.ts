import { emitNervesEvent } from "../nerves/runtime"
import {
  runBuiltInVoiceRealtimeEvalSuite,
  summarizeVoiceRealtimeEvalSuite,
  type VoiceRealtimeEvalReport,
  type VoiceRealtimeEvalSource,
  type VoiceRealtimeEvalSuiteSummary,
} from "./voice/realtime-eval"
import {
  gradeVoiceRealtimeEvalTrace,
  loadVoiceRealtimeEvalTraceArtifact,
  type VoiceRealtimeEvalTraceExpectedOutcome,
  type VoiceRealtimeEvalTraceReplayResult,
} from "./voice/realtime-trace"

export interface VoiceRealtimeEvalCommandTraceIgnoredEvent {
  atMs: number
  event: string
  source?: VoiceRealtimeEvalSource
  ignoreReason?: string
}

export interface VoiceRealtimeEvalCommandTraceResult {
  traceId: string
  scenarioId: string
  expectedOutcome: VoiceRealtimeEvalTraceExpectedOutcome
  outcomeMatched: boolean
  report: VoiceRealtimeEvalReport
  ignoredEvents: VoiceRealtimeEvalCommandTraceIgnoredEvent[]
}

export interface VoiceRealtimeEvalCommandTraceSummary {
  matched: number
  mismatched: number
  total: number
  mismatchedScenarioIds: string[]
}

export interface VoiceRealtimeEvalCommandPayload {
  summary?: VoiceRealtimeEvalSuiteSummary
  expectedKnownBadFailed?: boolean
  happyPathPassed?: boolean
  traceSummary?: VoiceRealtimeEvalCommandTraceSummary
  traces?: VoiceRealtimeEvalCommandTraceResult[]
  error?: string
}

export interface VoiceRealtimeEvalCommandResult {
  exitCode: number
  payload: VoiceRealtimeEvalCommandPayload
}

function parseTraceArgs(argv: string[]): string[] {
  const tracePaths: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== "--trace") throw new Error(`unknown argument: ${arg}`)
    const tracePath = argv[index + 1]
    if (!tracePath) throw new Error("--trace requires a file path")
    tracePaths.push(tracePath)
    index += 1
  }
  return tracePaths
}

function builtInPayload(): Pick<VoiceRealtimeEvalCommandPayload, "expectedKnownBadFailed" | "happyPathPassed" | "summary"> {
  const reports = runBuiltInVoiceRealtimeEvalSuite()
  const summary = summarizeVoiceRealtimeEvalSuite(reports)
  return {
    summary,
    expectedKnownBadFailed: summary.failed === 1 && summary.failedScenarioIds[0] === "voice-known-bad-latency",
    happyPathPassed: reports.some((report) => report.scenarioId === "voice-happy-path" && report.passed),
  }
}

function traceResultPayload(result: VoiceRealtimeEvalTraceReplayResult): VoiceRealtimeEvalCommandTraceResult {
  return {
    traceId: result.traceId,
    scenarioId: result.scenarioId,
    expectedOutcome: result.expectedOutcome,
    outcomeMatched: result.outcomeMatched,
    report: result.report,
    ignoredEvents: result.ignoredEvents.map((event) => ({
      atMs: event.atMs,
      event: event.event,
      source: event.source,
      ignoreReason: event.ignoreReason,
    })),
  }
}

function summarizeTraceResults(traces: VoiceRealtimeEvalCommandTraceResult[]): VoiceRealtimeEvalCommandTraceSummary {
  const mismatchedScenarioIds = traces.filter((trace) => !trace.outcomeMatched).map((trace) => trace.scenarioId)
  return {
    matched: traces.length - mismatchedScenarioIds.length,
    mismatched: mismatchedScenarioIds.length,
    total: traces.length,
    mismatchedScenarioIds,
  }
}

function errorResult(error: unknown): VoiceRealtimeEvalCommandResult {
  return {
    exitCode: 1,
    payload: { error: String(error).replace(/^Error: /, "") },
  }
}

export function runVoiceRealtimeEvalCommand(argv: string[]): VoiceRealtimeEvalCommandResult {
  emitNervesEvent({
    component: "senses",
    event: "senses.voice_realtime_eval_command_start",
    message: "starting Voice realtime eval command runner",
    meta: { scenarioId: "voice-eval-command", events: argv.length },
  })
  try {
    const tracePaths = parseTraceArgs(argv)
    const payload: VoiceRealtimeEvalCommandPayload = builtInPayload()
    if (tracePaths.length > 0) {
      const traces = tracePaths
        .map((tracePath) => gradeVoiceRealtimeEvalTrace(loadVoiceRealtimeEvalTraceArtifact(tracePath)))
        .map(traceResultPayload)
      payload.traces = traces
      payload.traceSummary = summarizeTraceResults(traces)
    }
    const builtInsPassed = Boolean(payload.expectedKnownBadFailed && payload.happyPathPassed)
    const tracesPassed = payload.traceSummary ? payload.traceSummary.mismatched === 0 : true
    const result: VoiceRealtimeEvalCommandResult = { exitCode: builtInsPassed && tracesPassed ? 0 : 1, payload }
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_realtime_eval_command_end",
      message: "finished Voice realtime eval command runner",
      meta: { scenarioId: "voice-eval-command", passed: result.exitCode === 0, findings: payload.traceSummary?.mismatched ?? 0 },
    })
    return result
  } catch (error) {
    const result = errorResult(error)
    emitNervesEvent({
      component: "senses",
      event: "senses.voice_realtime_eval_command_error",
      message: "Voice realtime eval command runner failed",
      meta: { scenarioId: "voice-eval-command", error: result.payload.error },
      level: "error",
    })
    return result
  }
}
