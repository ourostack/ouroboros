// The census child: `node --import ./guard.mjs child.mts <config>` runs every walker the config names and prints
// exactly one JSON line, `{ "doors": Door[], "errors": string[], "unwalked": Gap[], "excluded": [...] }`. The parent starts it with an empty HOME and
// TMPDIR and no credentials; the guard keeps it off the network. Anything a product's modules print while they load
// goes to stderr, so stdout carries only the result. A product's own walkers (the config's `walkers`) load here too,
// under the same guard, and may return doors of the kinds they declare only.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { Door, Gap, ProductWalker, Walker, WalkerOptions } from "./types.mts";
import { WALKERS } from "./walkers/registry.mts";

const BUILT_IN: Readonly<Record<string, Walker>> = Object.fromEntries(Object.entries(WALKERS).map(([name, w]) => [name, w.walk]));

type Source = Omit<WalkerOptions, "product" | "root"> & { walker: string };

/** Import each product walker; one that can't load or has no `walk` is a census error, and its sources find nothing. */
async function productWalkers(walkers: Readonly<Record<string, ProductWalker>>, errors: string[]): Promise<Record<string, Walker>> {
  const loaded: Record<string, Walker> = {};
  for (const [name, { module, kinds }] of Object.entries(walkers)) {
    let walk: unknown;
    try {
      walk = ((await import(pathToFileURL(resolve(process.cwd(), module)).href)) as { walk?: unknown }).walk;
    } catch (error) {
      errors.push(`${name}: can't load ${module}: ${(error as Error).message.split("\n")[0]}`);
      continue;
    }
    if (typeof walk !== "function") {
      errors.push(`${name}: ${module} exports no walk function`);
      continue;
    }
    loaded[name] = async (options) => {
      const result = await (walk as Walker)(options);
      const foreign = result.doors.filter((d) => !kinds.includes(d.kind));
      // Exclusions are a closed list with checked proof, so only the built-in walkers make them.
      const { excluded = [], ...rest } = result;
      return {
        ...rest,
        doors: result.doors.filter((d) => kinds.includes(d.kind)),
        errors: [
          ...result.errors,
          ...foreign.map((d) => `${name}: returned ${d.id}, a ${d.kind} door, but declares only ${kinds.join(", ")}`),
          ...excluded.map((e) => `${name}: excluded ${e.hit} as ${e.category}, but only the built-in walkers may exclude a hit`),
        ],
      };
    };
  }
  return loaded;
}

export async function runChild(configPath: string, builtIn: Readonly<Record<string, Walker>> = BUILT_IN): Promise<void> {
  const config = JSON.parse(await readFile(configPath, "utf8")) as { product: string; sources: Source[]; walkers?: Record<string, ProductWalker> };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  const doors: Door[] = [];
  const errors: string[] = [];
  const unwalked: Gap[] = [];
  const excluded: { hit: string; category: string }[] = [];
  try {
    const walkers = { ...(await productWalkers(config.walkers ?? {}, errors)), ...builtIn };
    for (const source of config.sources) {
      const walker = Object.hasOwn(walkers, source.walker) ? walkers[source.walker] : undefined;
      if (!walker) {
        if (!Object.hasOwn(config.walkers ?? {}, source.walker)) errors.push(`${source.walker}: no such walker`);
        continue;
      }
      const { walker: name, ...where } = source;
      process.stderr.write(`ax-census: start ${name}\n`);
      const startedAt = Date.now();
      const result = await walker({ ...where, product: config.product, root: process.cwd() });
      process.stderr.write(`ax-census: finish ${name} in ${Date.now() - startedAt}ms\n`);
      doors.push(...result.doors.map((d) => ({ ...d, walker: name })));
      errors.push(...result.errors);
      unwalked.push(...(result.unwalked ?? []));
      excluded.push(...(result.excluded ?? []));
    }
  } finally {
    process.stdout.write = write;
  }
  process.stdout.write(`${JSON.stringify({ doors, errors, unwalked, excluded })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await runChild(process.argv[2]!);
}
