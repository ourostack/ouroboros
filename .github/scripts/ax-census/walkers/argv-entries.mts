// The argv entry-point finder (design section 1): every source module that reads `process.argv` and runs on load (a
// read at top level, or a read in a function when the module has top-level code that runs) is an entry point an
// agent's shell can reach as `node <built path>`. An entry point another walker covers is claimed in the config, with
// the parser source it must import (transitively, through relative imports), and only a first word it checks that the
// parser source never mentions is a door of its own. Any other entry point is one door, and
// the words its argv is compared with at the first position, in the module and the functions it passes argv to, are
// its subcommands. Those are read from the syntax tree only: nothing here is run.
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, WalkerOptions, WalkResult } from "../types.mts";
import { applyCards, loadCards, Raises } from "./cli-cards.mts";
import { nextWords, Sources } from "./ts-argv.mts";

const SKIP_DIRS = new Set(["node_modules", "__tests__", "fixtures"]);
const SOURCE = /\.[cm]?ts$/;
const NOT_SOURCE = /\.d\.[cm]?ts$|\.(test|spec)\.[cm]?ts$/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? (SKIP_DIRS.has(e.name) ? [] : sourceFiles(join(dir, e.name))) : SOURCE.test(e.name) && !NOT_SOURCE.test(e.name) ? [join(dir, e.name)] : []));
}

/** `process`, or `globalThis.process`. */
const isProcess = (n: ts.Node): boolean =>
  (ts.isIdentifier(n) && n.text === "process") || (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "globalThis" && n.name.text === "process");
/** A read of argv: `process.argv`, `process["argv"]`, or `const { argv } = process`. */
const isArgv = (n: ts.Node): boolean =>
  (ts.isPropertyAccessExpression(n) && isProcess(n.expression) && n.name.text === "argv") ||
  (ts.isElementAccessExpression(n) && isProcess(n.expression) && ts.isStringLiteral(n.argumentExpression) && n.argumentExpression.text === "argv") ||
  (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && !!n.initializer && isProcess(n.initializer) && n.name.elements.some((e) => (e.propertyName ?? e.name).getText() === "argv"));

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

/** Every string literal in a file. */
function literalsOf(sf: ts.SourceFile): Set<string> {
  const found = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n)) found.add(n.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
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
  /** Claimed entry → the strings its parser source holds. */
  const claimed = new Map<string, Set<string>>();
  for (const claim of opts.claims ?? []) {
    const entry = resolve(opts.root, claim.entry);
    if (!entries.has(entry)) errors.push(`argv-entries: ${claim.entry} is claimed, but it isn't an argv entry point under ${opts.source}`);
    else if (!reaches(sources, entry, resolve(opts.root, claim.parser))) errors.push(`argv-entries: ${claim.entry} is claimed by ${claim.parser}, but never imports it`);
    else claimed.set(entry, literalsOf(sources.file(resolve(opts.root, claim.parser))));
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
    const sf = sources.file(path);
    const built = join(opts.module, relative(dir, path)).replace(/ts$/, "js");
    const name = `node ${built}`;
    const parserWords = claimed.get(path);
    if (!parserWords) doors.push(door(name, path, sf.getLineAndCharacterOfPosition(read.getStart(sf)).line + 1));
    // process.argv[2] is the first word. A claimed entry's words are its parser's, unless the parser never mentions one.
    const context = sources.read(path, sf, [], -2);
    for (const [word, { first }] of nextWords([{ context, region: null }], 0)) {
      if (!parserWords?.has(word)) doors.push(door(`${name} ${word}`, first.file, first.line));
    }
  }
  const cards = loadCards(opts.root, opts.cards);
  if (cards) errors.push(...cards.errors, ...applyCards(doors, cards, new Raises(sources, opts.root, opts.handlers ?? []), opts.cards!));
  return { doors, errors, unwalked: [] };
}
