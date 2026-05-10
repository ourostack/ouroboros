import {
  runBuiltInVoiceRealtimeEvalSuite,
  summarizeVoiceRealtimeEvalSuite,
} from "./voice/realtime-eval"
import { emitNervesEvent } from "../nerves/runtime"

emitNervesEvent({
  component: "senses",
  event: "senses.voice_realtime_eval_start",
  message: "starting Voice realtime eval command",
  meta: { scenarioId: "built-in-suite", events: 0 },
})
const reports = runBuiltInVoiceRealtimeEvalSuite()
const summary = summarizeVoiceRealtimeEvalSuite(reports)
const expectedKnownBadFailed = summary.failed === 1 && summary.failedScenarioIds[0] === "voice-known-bad-latency"
const happyPathPassed = reports.some((report) => report.scenarioId === "voice-happy-path" && report.passed)

emitNervesEvent({
  component: "senses",
  event: "senses.voice_realtime_eval_end",
  message: "finished Voice realtime eval command",
  meta: { scenarioId: "built-in-suite", passed: expectedKnownBadFailed && happyPathPassed, findings: summary.failed },
})

// eslint-disable-next-line no-console -- terminal UX: eval command summary
console.log(JSON.stringify({ summary, expectedKnownBadFailed, happyPathPassed }, null, 2))

if (!expectedKnownBadFailed || !happyPathPassed) {
  process.exit(1)
}
