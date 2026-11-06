import { emitNervesEvent } from "../nerves/runtime"

/** The most characters one tool result may put in front of the model (about 8k tokens). */
export const TOOL_OUTPUT_MAX_CHARS = 32_000

const HEAD_SHARE = 0.75

/** Cut to the last line break at or before `limit`, or to `limit` when the text has none there. */
function headWithin(text: string, limit: number): string {
  const head = text.slice(0, limit)
  const lastBreak = head.lastIndexOf("\n")
  return lastBreak > 0 ? head.slice(0, lastBreak) : head
}

/** Keep the last `limit` characters, starting after a line break when there is one. */
function tailWithin(text: string, limit: number): string {
  const tail = text.slice(text.length - limit)
  const firstBreak = tail.indexOf("\n")
  return firstBreak >= 0 ? tail.slice(firstBreak + 1) : tail
}

/**
 * Fit one tool result into the model's view. Output within the budget is returned unchanged.
 * Larger output keeps its start and its end, on line boundaries, around one line that says how
 * big the whole result was and how to see the rest, so a huge listing or log never overflows
 * the context window and kills the turn.
 */
export function fitToolOutputForModel(tool: string, text: string): string {
  if (text.length <= TOOL_OUTPUT_MAX_CHARS) return text
  const head = headWithin(text, Math.floor(TOOL_OUTPUT_MAX_CHARS * HEAD_SHARE))
  const tail = tailWithin(text, TOOL_OUTPUT_MAX_CHARS - head.length)
  const omitted = text.length - head.length - tail.length
  emitNervesEvent({
    component: "engine",
    event: "engine.tool_output_fitted",
    message: "tool output fitted to the model's budget",
    meta: { tool, totalChars: text.length, omittedChars: omitted },
  })
  const notice = `[${tool} returned ${text.length.toLocaleString("en-US")} characters; the middle ${omitted.toLocaleString("en-US")} are not shown. To see them, narrow the request: a tighter pattern or folder, a line range, or a filter such as head, tail or grep.]`
  return `${head}\n${notice}\n${tail}`
}
