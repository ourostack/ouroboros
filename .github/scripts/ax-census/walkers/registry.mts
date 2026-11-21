// The one list of walkers: the name a config uses, the door kinds each finds, and the function. Closed on purpose, so
// a config can't bring its own walker.
import type { Walker } from "../types.mts";
import { walkArgvEntries } from "./argv-entries.mts";
import { walkMcpSchemas } from "./mcp-schemas.mts";
import { walkToolSchemas } from "./tool-schemas.mts";
import { walkTsParser } from "./ts-parser.mts";

export const WALKERS: Readonly<Record<string, { kinds: readonly string[]; walk: Walker }>> = {
  "mcp-schemas": { kinds: ["mcp"], walk: walkMcpSchemas },
  "ts-parser": { kinds: ["cli"], walk: walkTsParser },
  "argv-entries": { kinds: ["cli"], walk: walkArgvEntries },
  "tool-schemas": { kinds: ["tool", "approval"], walk: walkToolSchemas },
};
