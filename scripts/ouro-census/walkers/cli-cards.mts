// The cards of a CLI's doors (design section 2): an `ax` property on each entry of the product's command
// declarations, which a CLI walker source names as `cards: "<built module>#<export>"`. Each declaration has the
// command's words as `name`, and may have its `summary`, who sees its `effect` (`private` or `others`), a `readOnly`
// flag, an `example` (one argv after the tool's name that parses) and the `ax` card.
//
// What a declaration gives its door:
// - the card, and the summary as the door's description, so a `when` line that only repeats the summary is weak;
// - evidence: `readOnly` from the flag, and `mutates: "others"` from `effect: "others"`, so a command other people see
//   can't be declared a read;
// - `raises`: the card's error codes that are literals outside any card in the door's own file or the source's
//   `handlers` files (the dispatcher and the gate, which raise for every command).
//   For a CLI whose every door sits in one parser file, that check is CLI-wide: it catches a code nothing raises, not
//   a code raised only by some other command.
//
// A declaration that names no walked door is stale, a census error. The declaration of an alias (`down` for `stop`)
// needs no card: the door's card lists the alias instead (cards.mts checks that).
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import type { Door, DoorCard } from "../types.mts";
import { literalsOutsideCards } from "./literals.mts";
import type { Sources } from "./ts-argv.mts";

export interface CliDeclaration {
  name: string;
  summary?: string;
  effect?: string;
  readOnly?: boolean;
  example?: string;
  ax?: DoorCard;
}

export interface LoadedCards {
  declarations: CliDeclaration[];
  /** What the cards module exports as `serverErrors`, if anything. */
  serverErrors: unknown;
  module: string;
  errors: string[];
}

/** Read `<module>#<export>` from the built product; `null` when the source names no cards. */
export function loadCards(root: string, spec: string | undefined): LoadedCards | null {
  if (spec === undefined) return null;
  const hash = spec.lastIndexOf("#");
  if (hash <= 0 || hash === spec.length - 1) return { declarations: [], serverErrors: undefined, module: spec, errors: [`cards ${spec}: give it as <module>#<export>.`] };
  const module = spec.slice(0, hash);
  const require = createRequire(join(root, "package.json"));
  const loaded = require(resolve(root, module)) as Record<string, unknown>;
  const list = loaded[spec.slice(hash + 1)];
  if (!Array.isArray(list) || !list.every((d: { name?: unknown }) => typeof d?.name === "string")) {
    return { declarations: [], serverErrors: undefined, module, errors: [`${spec}: not a list of declarations with names.`] };
  }
  return { declarations: list as CliDeclaration[], serverErrors: loaded.serverErrors, module, errors: [] };
}

/** The literals outside cards in each file, read once. */
export class Raises {
  private readonly cache = new Map<string, Set<string>>();
  private readonly sources: Sources;
  private readonly root: string;
  private readonly handlers: readonly string[];
  constructor(sources: Sources, root: string, handlers: readonly string[]) {
    this.sources = sources;
    this.root = root;
    this.handlers = handlers;
  }

  private literals(path: string): Set<string> {
    let found = this.cache.get(path);
    if (!found) {
      found = literalsOutsideCards(this.sources.file(path));
      this.cache.set(path, found);
    }
    return found;
  }

  /** Whether `code` is raised in `file` (relative to the root) or a handler file. */
  has(file: string, code: string): boolean {
    return [file, ...this.handlers].some((f) => this.literals(resolve(this.root, f)).has(code));
  }
}

/**
 * Give each door its declaration's card and evidence. Returns the census errors: a name declared twice, a stale
 * declaration, and an alias with a card of its own.
 */
export function applyCards(doors: Door[], cards: LoadedCards, raises: Raises, spec: string): string[] {
  const errors: string[] = [];
  const byName = new Map<string, CliDeclaration>();
  for (const d of cards.declarations) {
    if (byName.has(d.name)) errors.push(`cli:${d.name}: declared twice in ${spec}.`);
    else byName.set(d.name, d);
  }
  const aliasOf = new Map<string, Door>();
  for (const door of doors) {
    const parent = door.name.split(" ").slice(0, -1);
    for (const alias of door.aliases ?? []) aliasOf.set([...parent, alias].join(" "), door);
  }
  const doorNames = new Set(doors.map((d) => d.name));
  for (const door of doors) {
    const d = byName.get(door.name);
    if (!d) continue;
    door.description = typeof d.summary === "string" ? d.summary : "";
    door.card = d.ax ?? null;
    if (d.readOnly === true) door.evidence.readOnly = true;
    if (d.effect === "others") door.evidence.mutates = "others";
    if (Array.isArray(d.ax?.errors)) door.evidence.raises = d.ax.errors.map((e) => e?.code).filter((code) => typeof code === "string" && raises.has(door.file, code));
  }
  for (const [name, d] of byName) {
    if (doorNames.has(name)) continue;
    const of = aliasOf.get(name);
    if (!of) errors.push(`cli:${name}: declared in ${spec}, but no walked path reaches it. Fix: remove the declaration, or make the parser accept its words.`);
    else if (d.ax) errors.push(`cli:${name}: an alias of ${of.id} has a card of its own. Fix: list ${name.split(" ").at(-1)} in ${of.id}'s card aliases and drop this card.`);
  }
  return errors;
}

/** The server-level check: a CLI that declares any card exports an `unknown-door` card and raises it. */
export function serverErrorsCheck(doors: readonly Door[], cards: LoadedCards, raises: Raises, root: string): string[] {
  if (!doors.some((d) => d.card)) return [];
  const list = Array.isArray(cards.serverErrors) ? (cards.serverErrors as { code?: unknown }[]) : [];
  const module = relative(root, resolve(root, cards.module));
  if (!list.some((c) => c?.code === "unknown-door")) return [`${module}: the CLI declares cards but exports no serverErrors with an unknown-door card, the answer to an unknown command.`];
  if (!doors.some((d) => raises.has(d.file, "unknown-door"))) return [`${module}: the CLI declares cards but unknown-door is never raised in its handler files.`];
  return [];
}
