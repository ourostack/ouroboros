// The census's identity: its version, and the hash of the files that decide what it counts. A report carries both,
// and the release manifest (manifest.mts) pins the hash, so the adoption ledger trusts only a released checker. Node
// built-ins only, so the manifest can be checked without the walkers' dependencies.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CENSUS_VERSION = "0.1.0";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The files whose hash is the checker's identity; the ledger compares it with a released manifest. */
export const CHECKER_FILES = [
  "base.mts",
  "baseline.mts",
  "cards.mts",
  "census.mts",
  "checker.mts",
  "child.mts",
  "guard.mjs",
  "report.mts",
  "types.mts",
  "walkers/argv-entries.mts",
  "walkers/cli-cards.mts",
  "walkers/declared-tools.mts",
  "walkers/literals.mts",
  "walkers/mcp-schemas.mts",
  "walkers/registry.mts",
  "walkers/tool-schemas.mts",
  "walkers/ts-argv.mts",
  "walkers/ts-parser.mts",
];

export async function checkerHash(dir = HERE): Promise<string> {
  const hash = createHash("sha256");
  for (const file of CHECKER_FILES) {
    const content = await readFile(join(dir, file));
    hash.update(`${file}\n${createHash("sha256").update(content).digest("hex")}\n`);
  }
  return hash.digest("hex");
}
