// The one list of walkers: the name a config uses, the door kind each finds, and the function. Closed on purpose, so
// a config can't bring its own walker.
import type { Walker } from "../types.mts";
import { walkArgvEntries } from "./argv-entries.mts";
import { walkMcpSchemas } from "./mcp-schemas.mts";
import { walkTsParser } from "./ts-parser.mts";

export const WALKERS: Readonly<Record<string, { kind: string; walk: Walker }>> = {
  "mcp-schemas": { kind: "mcp", walk: walkMcpSchemas },
  "ts-parser": { kind: "cli", walk: walkTsParser },
  "argv-entries": { kind: "cli", walk: walkArgvEntries },
};
