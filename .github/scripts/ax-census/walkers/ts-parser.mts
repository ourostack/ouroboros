// The legacy-parser walker (design section 1): the doors of a hand-written TypeScript argv parser such as the
// harness's parseOuroCommand. Candidate word paths come from the syntax tree (ts-argv.mts); each is then checked
// against the built parser, in this process, which only parses argv and never runs a command:
//
// - A path is a door when some test argv after it makes the parser return a kind that its parent path, with the same
//   test argv, doesn't. The test argv is built from the syntax tree too: the flags the path's parsers mention, bare
//   or with a value, positional values, then a short greedy search that keeps a token while it brings a new error.
// - A path that returns, but only kinds its parent returns too, is an argument (`connect providers`), not a door.
// - A path that never returns can't be confirmed, because it needs values no test argv has (a 64-hex id). It stays a
//   door, `confirmed: false`: counting a non-door costs a card, dropping a door hides it.
// - A path that prefixes a door is a door (`mail` before `mail import-mbox`).
// - Two words compared in one `||` (or listed in one `includes`) that parse the same for every test argv are one door
//   with an alias (`stop` and `down`).
//
// The cross-check: every kind of the command type must be returned by a confirmed path, or sit in the branch of an
// unconfirmed leaf path. A kind reached neither way is an `unwalked` gap at its line in the type.
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import ts from "typescript";
import type { Door, Gap, WalkerOptions, WalkResult } from "../types.mts";
import { applyCards, loadCards, Raises, serverErrorsCheck } from "./cli-cards.mts";
import { type Comparison, expand, inside, nextWords, type Scope, Sources } from "./ts-argv.mts";

const MAX_DEPTH = 6;
const VALUES = ["census", "/census", "1"];
const GREEDY_ROUNDS = 8;

type Parse = (argv: string[]) => unknown;
interface Outcome {
  kind: string | null;
  text: string;
}

type KindDecl = ts.TypeAliasDeclaration | ts.InterfaceDeclaration;
interface At {
  file: string;
  line: number;
}

/**
 * The kinds of a type alias's union, each at its literal, following `import("...").T`, imported names and interfaces.
 * A union member whose kind can't be read as string literals (a template kind, a type from a package) is `unread`:
 * the cross-check fails closed, because a command typed that way could hide behind a word the walker misses.
 */
export function readKinds(sources: Sources, file: string, name: string): { kinds: Map<string, At>; unread: (At & { text: string })[] } {
  const kinds = new Map<string, At>();
  const unread: (At & { text: string })[] = [];
  const declIn = (path: string, decl: string): KindDecl | null =>
    sources.file(path).statements.find((s): s is KindDecl => (ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name.text === decl) ?? null;
  const at = (path: string, node: ts.Node): At => {
    const sf = sources.file(path);
    return { file: path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 };
  };
  const literals = (path: string, t: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(t)) return t.types.map((u) => literals(path, u)).every(Boolean);
    if (!ts.isLiteralTypeNode(t) || !ts.isStringLiteral(t.literal)) return false;
    if (!kinds.has(t.literal.text)) kinds.set(t.literal.text, at(path, t.literal));
    return true;
  };
  /** Whether the members hold a `kind` of string literals; false when there's none, or it isn't literals. */
  const members = (path: string, list: ts.NodeArray<ts.TypeElement>): boolean => {
    const kind = list.find((m): m is ts.PropertySignature => ts.isPropertySignature(m) && ts.isIdentifier(m.name) && m.name.text === "kind");
    return !!kind?.type && literals(path, kind.type);
  };
  const seen = new Set<ts.Node>();
  const declared = (path: string, decl: KindDecl): boolean => {
    if (seen.has(decl)) return true;
    seen.add(decl);
    if (ts.isTypeAliasDeclaration(decl)) return visit(path, decl.type);
    const heritage = (decl.heritageClauses ?? []).flatMap((h) => h.types).map((h) => (ts.isIdentifier(h.expression) ? sources.imported(path, h.expression.text, declIn) : null));
    return members(path, decl.members) || heritage.some((found) => !!found && declared(found.file, found.found));
  };
  const visit = (path: string, node: ts.TypeNode): boolean => {
    if (ts.isUnionTypeNode(node)) {
      for (const t of node.types) if (!visit(path, t)) unread.push({ ...at(path, t), text: t.getText(sources.file(path)).replace(/\s+/g, " ") });
      return true;
    }
    if (ts.isIntersectionTypeNode(node)) return node.types.map((t) => visit(path, t)).some(Boolean);
    if (ts.isParenthesizedTypeNode(node)) return visit(path, node.type);
    if (ts.isTypeLiteralNode(node)) return members(path, node.members);
    if (ts.isImportTypeNode(node) && node.qualifier && ts.isIdentifier(node.qualifier) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      const target = sources.module(path, node.argument.literal.text);
      const decl = target && declIn(target, node.qualifier.text);
      return !!target && !!decl && declared(target, decl);
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName) && !node.typeArguments) {
      const found = sources.imported(path, node.typeName.text, declIn);
      return !!found && declared(found.file, found.found);
    }
    return false;
  };
  const alias = declIn(file, name);
  if (alias) declared(file, alias);
  return { kinds, unread };
}

interface Candidate {
  path: string[];
  first: Comparison;
  scopes: Scope[];
  fillers: string[][];
  /** Kinds this path returns that its parent doesn't, per the test argv tried. */
  kinds: Set<string>;
  returned: boolean;
  /** Whether some test argv made this path and its parent both return, and whether their kinds ever differed then. */
  bothReturned: boolean;
  bothDiffered: boolean;
  /** The kinds inside the path's own branches, for a path that never returns. */
  branchKinds: Set<string>;
}

export async function walkTsParser(opts: WalkerOptions): Promise<WalkResult> {
  const [kindsFile, kindsType] = (opts.kinds ?? "").split("#");
  if (!opts.parser || !kindsFile || !kindsType) return { doors: [], errors: ["ts-parser needs parser and kinds (<file>#<type>) in its source"], unwalked: [] };
  const require = createRequire(join(opts.root, "package.json"));
  const parse = (require(resolve(opts.root, opts.module)) as Record<string, unknown>)[opts.parser];
  if (typeof parse !== "function") return { doors: [], errors: [`${opts.module}: exports no ${opts.parser} function`], unwalked: [] };
  const sources = new Sources();
  const sourcePath = resolve(opts.root, opts.source);
  const fn = sources.functionIn(sourcePath, opts.parser);
  if (!fn) return { doors: [], errors: [`${opts.source}: declares no function ${opts.parser}`], unwalked: [] };
  const { kinds, unread } = readKinds(sources, resolve(opts.root, kindsFile), kindsType);
  if (kinds.size === 0) return { doors: [], errors: [`${opts.kinds}: no type alias with kind literals`], unwalked: [] };

  const outcome = (argv: string[]): Outcome => {
    try {
      const result = (parse as Parse)(argv) as { kind?: unknown } | null;
      return typeof result?.kind === "string" ? { kind: result.kind, text: JSON.stringify(result) } : { kind: null, text: "no kind" };
    } catch (error) {
      return { kind: null, text: `throws ${(error as Error)?.message}` };
    }
  };

  const top: Scope[] = [{ context: sources.read(sourcePath, fn, [{ arr: 0 }]), region: null }];
  const candidates = new Map<string, Candidate>();
  const queue: { path: string[]; scopes: Scope[] }[] = [{ path: [], scopes: top }];
  while (queue.length > 0) {
    const { path, scopes } = queue.shift()!;
    if (path.length >= MAX_DEPTH) continue;
    for (const [word, { scopes: narrowed, first }] of nextWords(scopes, path.length)) {
      const p = [...path, word];
      const id = p.join(" ");
      if (candidates.has(id)) continue;
      const own = expand(narrowed);
      // The flags of the path's own parsers, and of its parent's where the word was read by a helper.
      const pool = path.length > 0 ? [...own, ...expand(scopes)] : own;
      const flags = [...new Set(pool.flatMap((s) => [...s.context.flags]))].filter((f) => f !== "--help" && f !== "-h");
      const values = [...new Set(["census", ...own.flatMap((s) => s.context.comparisons.filter((c) => c.pos === null || c.pos > p.length).map((c) => c.text))])];
      const groups = [...values.map((v) => [v]), ...flags.flatMap((f) => [[f], ...VALUES.map((v) => [f, v])])];
      const candidate: Candidate = { path: p, first, scopes: narrowed, fillers: [], kinds: new Set(), returned: false, bothReturned: false, bothDiffered: false, branchKinds: new Set() };
      const attempt = (filler: string[]): Outcome => {
        candidate.fillers.push(filler);
        const mine = outcome([...p, ...filler]);
        if (mine.kind) {
          candidate.returned = true;
          // A first word has no parent path: `ouro` alone is not a word.
          const parent = path.length === 0 ? null : outcome([...path, ...filler]).kind;
          if (parent !== mine.kind) candidate.kinds.add(mine.kind);
          if (parent !== null) {
            candidate.bothReturned = true;
            if (parent !== mine.kind) candidate.bothDiffered = true;
          }
        }
        return mine;
      };
      for (const filler of [[], ...groups, ...flags.flatMap((f) => VALUES.map((v) => ["census", f, v]))]) attempt(filler);
      if (!candidate.returned) {
        let current: string[] = [];
        const seen = new Set([outcome(p).text]);
        for (let round = 0; round < GREEDY_ROUNDS && !candidate.returned; round += 1) {
          const step = groups.find((g) => {
            const o = attempt([...current, ...g]);
            return o.kind !== null || !seen.has(o.text);
          });
          if (!step) break;
          seen.add(outcome([...p, ...current, ...step]).text);
          current = [...current, ...step];
        }
      }
      if (!candidate.returned) {
        // A region several words share holds their kinds together, so it reaches none of them for this word.
        for (const s of own) if (!s.shared) for (const k of s.context.kinds) if (inside(s.region, k.at) && kinds.has(k.kind)) candidate.branchKinds.add(k.kind);
      }
      candidates.set(id, candidate);
      queue.push({ path: p, scopes: narrowed });
    }
  }

  // Doors: confirmed paths, paths that never return, and every prefix of a door.
  const isDoor = new Set<string>();
  for (const c of candidates.values()) {
    // An argument: whenever the path and its parent both return, they return the same kind.
    if (c.returned && (c.kinds.size === 0 || (c.bothReturned && !c.bothDiffered))) continue;
    for (let n = 1; n <= c.path.length; n += 1) isDoor.add(c.path.slice(0, n).join(" "));
  }
  const hasChild = (id: string) => [...isDoor].some((other) => other.startsWith(`${id} `));

  // Aliases: siblings from one comparison group whose outcomes match for every test argv either tried.
  const aliasOf = new Map<string, string>();
  const doorIds = [...candidates.keys()].filter((id) => isDoor.has(id));
  for (const [i, a] of doorIds.entries()) {
    if (aliasOf.has(a)) continue;
    const ca = candidates.get(a)!;
    for (const b of doorIds.slice(i + 1)) {
      const cb = candidates.get(b)!;
      if (aliasOf.has(b) || cb.first.group !== ca.first.group || ca.path.length !== cb.path.length || ca.path.slice(0, -1).join(" ") !== cb.path.slice(0, -1).join(" ")) continue;
      const same = [...ca.fillers, ...cb.fillers].every((f) => outcome([...ca.path, ...f]).text === outcome([...cb.path, ...f]).text);
      if (same && ca.returned) aliasOf.set(b, a);
    }
  }

  const doors: Door[] = [];
  const reached = new Set<string>();
  for (const id of doorIds) {
    if (aliasOf.has(id)) continue;
    const c = candidates.get(id)!;
    const leaf = !hasChild(id);
    const reach = c.kinds.size > 0 ? [...c.kinds] : leaf ? [...c.branchKinds] : [];
    reach.forEach((k) => reached.add(k));
    const aliases = [...aliasOf].filter(([, of]) => of === id).map(([alias]) => alias.split(" ").at(-1)!);
    doors.push({
      id: `cli:${id}`,
      kind: "cli",
      product: opts.product,
      name: id,
      description: "",
      file: relative(opts.root, c.first.file),
      line: c.first.line,
      card: null,
      evidence: { confirmed: c.returned, kinds: reach.sort() },
      ...(aliases.length > 0 ? { aliases } : {}),
    });
  }
  // Cards, and the kinds each declaration's example reaches: a kind behind values no test argv has (an id, a table).
  const errors: string[] = [];
  const cards = loadCards(opts.root, opts.cards);
  if (cards) {
    errors.push(...cards.errors);
    const raises = new Raises(sources, opts.root, opts.handlers ?? []);
    errors.push(...applyCards(doors, cards, raises, opts.cards!));
    for (const d of cards.declarations) {
      const door = doors.find((x) => x.name === d.name);
      if (typeof d.example !== "string" || !door) continue;
      const words = d.example.trim().split(/\s+/);
      if (d.name.split(" ").some((w, i) => words[i] !== w)) {
        errors.push(`cli:${d.name}: its example \`${d.example}\` doesn't start with its words.`);
        continue;
      }
      const o = outcome(words);
      if (!o.kind) {
        errors.push(`cli:${d.name}: its example \`${d.example}\` doesn't parse (${o.text}). Fix: give an example the parser accepts.`);
        continue;
      }
      door.evidence.confirmed = true;
      door.evidence.kinds = [...new Set([...(door.evidence.kinds ?? []), o.kind])].sort();
      reached.add(o.kind);
    }
    errors.push(...serverErrorsCheck(doors, cards, raises, opts.root));
  }
  const unwalked: Gap[] = [...kinds]
    .filter(([kind]) => !reached.has(kind))
    .map(([kind, at]): Gap => ({ id: `cli:kind ${kind}`, kind: "cli", file: relative(opts.root, at.file), line: at.line, walker: "ts-parser", reasons: ["no walked path returns this kind"] }));
  for (const u of unread) {
    unwalked.push({ id: `cli:type ${u.text}`, kind: "cli", file: relative(opts.root, u.file), line: u.line, walker: "ts-parser", reasons: ["the kind cross-check can't read this member's kind as string literals"] });
  }
  return { doors, errors, unwalked };
}
