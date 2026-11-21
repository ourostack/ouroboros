// The argv entry-point finder (design section 1): every source module that reads `process.argv` and runs on load (a
// read at top level, or a read in a function when the module has top-level code that runs) is an entry point an
// agent's shell can reach as `node <built path>`. An entry point another walker covers is claimed in the config, with
// the parser source it must import (transitively, through relative imports); any other entry point is one door, and
// the words its argv is compared with at the first position, in the module and the functions it passes argv to, are
// its subcommands. Those are read from the syntax tree only: nothing here is run.
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, WalkerOptions, WalkResult } from "../types.mts";
import { nextWords, Sources } from "./ts-argv.mts";

const SKIP_DIRS = new Set(["node_modules", "__tests__", "fixtures"]);
const SOURCE = /\.[cm]?ts$/;
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?ts$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : sourceFiles(join(dir, e.name))) : SOURCE.test(e.name) && !NOT_SOURCE.test(e.name) ? [join(dir, e.name)] : []));
}

const isArgv = (n: ts.Node): boolean => ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "process" && n.name.text === "argv";

/** The node of the module's first `process.argv` read when the module is an entry point, else null. */
function entryRead(sf: ts.SourceFile): ts.Node | null {
  let first: ts.Node | null = null;
  let topLevel = false;
  const visit = (n: ts.Node, inFunction: boolean): void => {
    if (isArgv(n)) {
      first ??= n;
      if (!inFunction) topLevel = true;
    }
    ts.forEachChild(n, (c) => visit(c, inFunction || ts.isFunctionLike(n)));
  };
  visit(sf, false);
  const runs = sf.statements.some((s) => ts.isExpressionStatement(s) || ts.isIfStatement(s));
  return first && (topLevel || runs) ? first : null;
}

/** Whether `from` reaches `target` through relative imports and re-exports. */
function reaches(sources: Sources, from: string, target: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length > 0) {
    for (const next of sources.importsOf(queue.shift()!)) {
      if (next === target) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

export async function walkArgvEntries(opts: WalkerOptions): Promise<WalkResult> {
  const sources = new Sources();
  const dir = resolve(opts.root, opts.source);
  const entries = new Map<string, ts.Node>();
  for (const path of sourceFiles(dir)) {
    const sf = sources.file(path);
    const read = entryRead(sf);
    if (read) entries.set(path, read);
  }
  const errors: string[] = [];
  const claimed = new Set<string>();
  for (const claim of opts.claims ?? []) {
    const entry = resolve(opts.root, claim.entry);
    if (!entries.has(entry)) errors.push(`argv-entries: ${claim.entry} is claimed, but it isn't an argv entry point under ${opts.source}`);
    else if (!reaches(sources, entry, resolve(opts.root, claim.parser))) errors.push(`argv-entries: ${claim.entry} is claimed by ${claim.parser}, but never imports it`);
    else claimed.add(entry);
  }
  const doors: Door[] = [];
  const door = (name: string, file: string, line: number): Door => ({
    id: `cli:${name}`,
    kind: "cli",
    product: opts.product,
    name,
    description: "",
    file: relative(opts.root, file),
    line,
    card: null,
    evidence: { confirmed: false, kinds: [] },
  });
  for (const [path, read] of entries) {
    if (claimed.has(path)) continue;
    const sf = sources.file(path);
    const built = join(opts.module, relative(dir, path)).replace(/ts$/, "js");
    const name = `node ${built}`;
    doors.push(door(name, path, sf.getLineAndCharacterOfPosition(read.getStart(sf)).line + 1));
    // process.argv[2] is the first word.
    const context = sources.read(path, sf, [], -2);
    for (const [word, { first }] of nextWords([{ context, region: null }], 0)) doors.push(door(`${name} ${word}`, first.file, first.line));
  }
  return { doors, errors, unwalked: [] };
}
