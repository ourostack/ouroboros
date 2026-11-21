// The census child: `node --import ./guard.mjs child.mts <config>` runs every walker the config names and prints
// exactly one JSON line, `{ "doors": Door[], "errors": string[] }`. The parent starts it with an empty HOME and
// TMPDIR and no credentials; the guard keeps it off the network. Anything a product's modules print while they load
// goes to stderr, so stdout carries only the result.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Door, Walker } from "./types.mts";
import { walkMcpSchemas } from "./walkers/mcp-schemas.mts";

/** The walkers a config may name. Closed on purpose: a config can't bring its own. */
export const WALKERS: Readonly<Record<string, Walker>> = { "mcp-schemas": walkMcpSchemas };

interface Source {
  walker: string;
  module: string;
  source: string;
}

export async function runChild(configPath: string, walkers: Readonly<Record<string, Walker>> = WALKERS): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as { product: string; sources: Source[] };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const doors: Door[] = [];
  const errors: string[] = [];
  try {
    for (const source of config.sources) {
      const walker = walkers[source.walker];
      if (!walker) {
        errors.push(`${source.walker}: no such walker`);
        continue;
      }
      const result = await walker({ product: config.product, module: source.module, source: source.source, root: process.cwd() });
      doors.push(...result.doors);
      errors.push(...result.errors);
    }
  } finally {
    process.stdout.write = write;
  }
  process.stdout.write(`${JSON.stringify({ doors, errors })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runChild(process.argv[2]!);
}
