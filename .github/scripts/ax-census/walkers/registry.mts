// The one list of walkers: the name a config uses, the door kind each finds, and the function. Closed on purpose, so
// a config can't bring its own walker.
import type { Walker } from "../types.mts";
import { walkMcpSchemas } from "./mcp-schemas.mts";

export const WALKERS: Readonly<Record<string, { kind: string; walk: Walker }>> = {
  "mcp-schemas": { kind: "mcp", walk: walkMcpSchemas },
};

/** The walker that finds a kind of door, as the report names it. */
export function walkerOfKind(kind: string): string {
  return Object.entries(WALKERS).find(([, w]) => w.kind === kind)?.[0] ?? kind;
}
