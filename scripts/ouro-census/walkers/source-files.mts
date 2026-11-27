// The source files a walker reads under a product's source folder. Dependency, test and fixture folders are left out,
// and so is each folder the config names under `skip`: another product's code vendored here, whose doors that
// product's own census counts. A skip proves itself: every source file in the folder must be pinned, with its sha256,
// in the repository's `upstream-sources.lock.json` (the lock Ouro Current keeps), so a product can't skip its own code.
// A skipped folder is reported as excluded, so the census still shows what it left out.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative, resolve } from "node:path";
import type { WalkerOptions } from "../types.mts";

const SKIP_DIRS = new Set(["node_modules", "__tests__", "fixtures"]);
const LOCK = "upstream-sources.lock.json";

export interface SourceFiles {
  files: string[];
  excluded: { hit: string; category: string }[];
  errors: string[];
}

/** Each vendored file's path from the root, mapped to its pinned sha256, from the root's lock file. */
function pinned(root: string): Map<string, string> {
  const pins = new Map<string, string>();
  let lock: { sources?: { files?: { generatedPath?: unknown; sha256?: unknown }[] }[] };
  try {
    lock = JSON.parse(readFileSync(join(root, LOCK), "utf8"));
  } catch {
    return pins;
  }
  for (const source of lock.sources ?? []) {
    for (const file of source.files ?? []) {
      if (typeof file.generatedPath === "string" && typeof file.sha256 === "string") pins.set(resolve(root, file.generatedPath), file.sha256);
    }
  }
  return pins;
}

export function sourceFiles(opts: Pick<WalkerOptions, "root" | "source" | "skip">, walker: string, source: RegExp, notSource: RegExp): SourceFiles {
  const dir = resolve(opts.root, opts.source);
  const skipped = new Set<string>();
  const excluded: SourceFiles["excluded"] = [];
  const errors: string[] = [];
  const list = (at: string, leave: ReadonlySet<string>): string[] =>
    readdirSync(at, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .flatMap((e) => {
        const path = join(at, e.name);
        if (e.isDirectory()) return SKIP_DIRS.has(e.name) || leave.has(path) ? [] : list(path, leave);
        return source.test(e.name) && !notSource.test(e.name) ? [path] : [];
      });
  const pins = opts.skip?.length ? pinned(opts.root) : new Map<string, string>();
  for (const folder of opts.skip ?? []) {
    const path = resolve(opts.root, folder);
    const name = relative(opts.root, path);
    const inside = relative(dir, path);
    if (inside === "" || inside.startsWith("..") || !existsSync(path) || !statSync(path).isDirectory()) {
      errors.push(`${walker}: skip ${folder} isn't a folder under ${opts.source}. Fix: remove it from the config, or name the folder the vendored code is in.`);
      continue;
    }
    if (skipped.has(path)) continue;
    const unpinned = list(path, new Set()).filter((file) => pins.get(file) !== createHash("sha256").update(readFileSync(file)).digest("hex"));
    if (unpinned.length > 0) {
      errors.push(`${walker}: skip ${name} holds ${relative(opts.root, unpinned[0]!)}, which ${LOCK} doesn't pin at its current sha256. Fix: vendor the folder through ${LOCK}, or drop the skip so its doors count.`);
      continue;
    }
    skipped.add(path);
    excluded.push({ hit: name, category: "vendored" });
  }
  return { files: list(dir, skipped), excluded, errors };
}
