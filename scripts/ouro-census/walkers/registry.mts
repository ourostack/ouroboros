// The built-in walkers: the name a config uses, the door kinds each finds, and the function. The checker's hash vouches
// for these only; a product's own walkers (the config's `walkers`) are listed in the report with their own hashes.
import type { Walker } from "../types.mts";
import { walkArgvEntries } from "./argv-entries.mts";
import { walkDeclaredTools } from "./declared-tools.mts";
import { walkMcpSchemas } from "./mcp-schemas.mts";
import { walkToolSchemas } from "./tool-schemas.mts";
import { walkTsParser } from "./ts-parser.mts";

export const WALKERS: Readonly<Record<string, { kinds: readonly string[]; walk: Walker }>> = {
  "mcp-schemas": { kinds: ["mcp"], walk: walkMcpSchemas },
  "ts-parser": { kinds: ["cli"], walk: walkTsParser },
  "argv-entries": { kinds: ["cli"], walk: walkArgvEntries },
  "tool-schemas": { kinds: ["tool", "approval"], walk: walkToolSchemas },
  "declared-tools": { kinds: ["tool"], walk: walkDeclaredTools },
};
