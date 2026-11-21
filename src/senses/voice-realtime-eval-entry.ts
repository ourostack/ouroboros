import { emitNervesEvent } from "../nerves/runtime"
import { runVoiceRealtimeEvalCommand } from "./voice-realtime-eval-command"

emitNervesEvent({
  component: "senses",
  event: "senses.voice_realtime_eval_start",
  message: "starting Voice realtime eval command",
  meta: { scenarioId: "built-in-suite", events: 0 },
})
const result = runVoiceRealtimeEvalCommand(process.argv.slice(2))

emitNervesEvent({
  component: "senses",
  event: "senses.voice_realtime_eval_end",
  message: "finished Voice realtime eval command",
  meta: { scenarioId: "built-in-suite", passed: result.exitCode === 0, findings: result.payload.traceSummary?.mismatched ?? result.payload.summary?.failed ?? 0 },
})

// eslint-disable-next-line no-console -- terminal UX: eval command summary
console.log(JSON.stringify(result.payload, null, 2))

if (result.exitCode !== 0) {
  // stderr's last line names the failure: a bad --trace argument or file, or a scenario that didn't match.
  process.stderr.write(`code: ${result.payload.error === undefined ? "eval-failed" : "eval-error"}\n`)
  process.exit(result.exitCode)
}
