// The baseline ratchet (design section 5): `ax/census.baseline.json` lists today's gaps, and the list only shrinks.
// A gap not on the list fails, an entry that is no longer a gap fails, and a pull request that adds an entry compared
// with its base fails. There is no override: agents merge their own pull requests, so a flag would be self-approved.
import type { BookletAllow, ProductWalker } from "./types.mts";

export interface BaselineInput {
  /** The ids the census counts against zero in this run (weak, undeclared, unwalked and stale). */
  gaps: readonly string[];
  /** The ids on this branch's baseline. */
  baseline: readonly string[];
  /**
   * The base branch's baseline, whether it already runs the census, and the door kinds its config walks (absent: all
   * of this run's kinds); null outside a pull request.
   */
  base: { baseline: readonly string[] | null; hasConfig: boolean; kinds?: readonly string[] } | null;
  /** The door kinds this census walks. */
  kinds: readonly string[];
  /** Ids this pull request may add to the baseline: doors a check the product adopts in it makes weak. */
  seed?: ReadonlySet<string>;
}

const kindOf = (id: string): string => (id.includes(":") ? id.slice(0, id.indexOf(":")) : id);

/** The problems with the baseline; `[]` passes. */
export function checkBaseline(input: BaselineInput): string[] {
  const problems: string[] = [];
  const gaps = new Set(input.gaps);
  const kinds = new Set(input.kinds);
  const entries = new Set<string>();
  const unknownKind = new Set<string>();

  const reported = new Set<string>();
  for (const id of input.baseline) {
    if (entries.has(id) && !reported.has(id)) {
      problems.push(`${id}: listed twice on the baseline.`);
      reported.add(id);
    }
    entries.add(id);
  }
  for (const id of entries) {
    const kind = kindOf(id);
    if (!kinds.has(kind)) {
      problems.push(`${id}: the census doesn't walk ${kind} doors yet, so it can't be on the baseline.`);
      unknownKind.add(id);
    }
  }
  for (const id of gaps) {
    if (!entries.has(id)) problems.push(`${id}: a door with no valid card, not on the baseline. Fix: give it an ax card in this pull request.`);
  }
  for (const id of entries) {
    if (!gaps.has(id) && !unknownKind.has(id)) problems.push(`${id}: on the baseline but no longer a gap. Fix: take it off ax/census.baseline.json.`);
  }
  if (input.base) {
    if (input.base.baseline) {
      const before = new Set(input.base.baseline);
      // A kind the base doesn't walk couldn't be on its baseline: the pull request that starts walking it seeds it.
      const walkedBefore = new Set(input.base.kinds ?? input.kinds);
      for (const id of entries) {
        if (!before.has(id) && walkedBefore.has(kindOf(id)) && !input.seed?.has(id)) problems.push(`${id}: added to the baseline. Fix: declare the door instead; the baseline only shrinks.`);
      }
    } else if (input.base.hasConfig && entries.size > 0) {
      problems.push("ax/census.baseline.json: missing on the base branch, which already runs the census. Fix: restore it from the base.");
    }
  }
  return problems;
}

export interface WalkerSource {
  walker: string;
  module: string;
  source: string;
  parser?: string;
  kinds?: string;
  claims?: readonly { entry: string; parser: string }[];
  cards?: string;
  handlers?: readonly string[];
  passthrough?: readonly string[];
  approvals?: readonly string[];
  reshape?: readonly string[];
  server?: string;
}

/**
 * The walker sources the base branch's config has that this branch's config lacks. Removing or narrowing a source
 * would make its doors vanish from the count, so it fails like a growing baseline does; adding one is fine.
 */
export function checkSources(sources: readonly WalkerSource[], baseSources: readonly WalkerSource[] | null): string[] {
  if (!baseSources) return [];
  // A changed parser or kinds type, an added claim or passthrough, a dropped approvals resolver or a renamed server can
  // hide doors as surely as a removed source.
  const key = (s: WalkerSource) =>
    [
      s.walker, s.module, s.source, ...(s.parser ? [s.parser] : []), ...(s.kinds ? [s.kinds] : []), ...(s.claims ?? []).map((c) => `claims ${c.entry}=${c.parser}`),
      ...(s.cards ? [`cards ${s.cards}`] : []), ...(s.passthrough ?? []).map((p) => `passthrough ${p}`), ...(s.approvals ?? []).map((a) => `approvals ${a}`),
      ...(s.reshape ?? []).map((r) => `reshape ${r}`), ...(s.server ? [`server ${s.server}`] : []),
    ].join(" ");
  const here = new Map(sources.map((s) => [key(s), s]));
  return baseSources.flatMap((s) => {
    const mine = here.get(key(s));
    if (!mine) return [`${key(s)}: a walker source on the base branch is missing here. Fix: restore it in ax/census.config.json; removing a source makes its doors vanish from the count.`];
    // Dropping a handlers file only makes codes harder to count as raised; adding one can make them all count.
    return (mine.handlers ?? []).filter((h) => !(s.handlers ?? []).includes(h))
      .map((h) => `${key(s)}: handlers ${h} is new here. Fix: raise each code where the door handles it; a new handlers file can make any card's codes count as raised.`);
  });
}

/**
 * The product walkers the base branch's config has that this branch's config dropped, moved or narrowed. Each would
 * make doors vanish from the count, so it fails like a removed source; adding a walker or a kind is fine.
 */
export function checkWalkers(walkers: Readonly<Record<string, ProductWalker>>, baseWalkers: Readonly<Record<string, ProductWalker>> | null): string[] {
  if (!baseWalkers) return [];
  return Object.entries(baseWalkers).flatMap(([name, before]) => {
    const now = walkers[name];
    if (!now) return [`${name}: a product walker on the base branch is missing here. Fix: restore it in ax/census.config.json; removing a walker makes its doors vanish from the count.`];
    if (now.module !== before.module) return [`${name}: the product walker moved from ${before.module} to ${now.module}. Fix: keep its module path; a new module can drop doors the old one found.`];
    return before.kinds.filter((k) => !now.kinds.includes(k)).map((k) => `${name}: the product walker no longer declares ${k}. Fix: keep every kind it walked on the base branch.`);
  });
}

const allowKey = (entry: BookletAllow): string => `${entry.door} ${entry.field} ${entry.word}`;

/**
 * The booklet-words ratchet: a product that checks booklet words on the base branch keeps checking them, and its
 * allowlist only shrinks. `used` holds the entries some door's text still needs; any other entry is stale.
 */
export function checkBooklet(allow: readonly BookletAllow[] | null, baseAllow: readonly BookletAllow[] | null | undefined, used: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  if (!allow) {
    if (baseAllow) problems.push("bookletWords: the base branch checks booklet words. Fix: keep bookletWords in ax/census.config.json; the rule is never turned off.");
    return problems;
  }
  const before = new Set((baseAllow ?? []).map(allowKey));
  for (const entry of allow) {
    const key = allowKey(entry);
    if (baseAllow && !before.has(key)) problems.push(`${key}: added to the booklet allowlist. Fix: rewrite the text instead; the allowlist only shrinks.`);
    if (!used.has(key)) problems.push(`${key}: on the booklet allowlist but the text doesn't say it. Fix: take it off bookletWords.allow.`);
  }
  return problems;
}
