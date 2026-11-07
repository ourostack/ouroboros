import { emitNervesEvent } from "../nerves/runtime"

/** What one home tool shows at most. Kept under the engine's 32,000-character cap so a tool's own notice is what the model sees. */
export const TOOL_MAX_LINES = 2000
export const TOOL_MAX_CHARS = 30_000
export const SKIP_DIRS = [".git", "node_modules"]
const BINARY_SNIFF_BYTES = 8192

/** True when the first 8 KB holds a NUL byte, which text never does. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

/** Record that a tool cut its output short, and return the notice for the model. */
export function cutNotice(tool: string, notice: string, meta: Record<string, unknown> = {}): string {
  emitNervesEvent({ component: "repertoire", event: "repertoire.tool_output_cut", message: `${tool} cut its output short`, meta: { tool, ...meta } })
  return notice
}
