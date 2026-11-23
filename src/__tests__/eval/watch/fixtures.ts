import { TurnTally } from "../../../heart/turn-summary"

/** A line exactly as the nerves file sink writes engine.turn_summary. */
export function summaryLine(overrides: Record<string, unknown> = {}, line: Record<string, unknown> = {}): string {
  const tally = new TurnTally()
  tally.offer([{ type: "function", function: { name: "shell", description: "d", parameters: {} } }], [], new Map())
  tally.step({ input_tokens: 100, output_tokens: 10, reasoning_tokens: 0, total_tokens: 110 }, "github-copilot", "claude-opus-5.5")
  tally.toolEnd("shell", true)
  const meta = { ...tally.summarize({ channel: "bluebubbles", outcome: "settled", errorClass: "none" }), runtimeVersion: "0.1.0-alpha.1500", ...overrides }
  return JSON.stringify({
    ts: "2026-11-23T10:00:00.000Z", level: "info", event: "engine.turn_summary", trace_id: "trace-1",
    component: "engine", message: "turn summary (counts only)", meta, ...line,
  })
}
