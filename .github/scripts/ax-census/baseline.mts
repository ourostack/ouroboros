// The baseline ratchet (design section 5): `ax/census.baseline.json` lists today's gaps, and the list only shrinks.
// A gap not on the list fails, an entry that is no longer a gap fails, and a pull request that adds an entry compared
// with its base fails. There is no override: agents merge their own pull requests, so a flag would be self-approved.

export interface BaselineInput {
  /** The ids the census counts against zero in this run (weak, undeclared, unwalked and stale). */
  gaps: readonly string[];
  /** The ids on this branch's baseline. */
  baseline: readonly string[];
  /** The base branch's baseline and whether it already runs the census; null outside a pull request. */
  base: { baseline: readonly string[] | null; hasConfig: boolean } | null;
  /** The door kinds this census walks. */
  kinds: readonly string[];
}

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
    const kind = id.includes(":") ? id.slice(0, id.indexOf(":")) : id;
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
      for (const id of entries) {
        if (!before.has(id)) problems.push(`${id}: added to the baseline. Fix: declare the door instead; the baseline only shrinks.`);
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
}

/**
 * The walker sources the base branch's config has that this branch's config lacks. Removing or narrowing a source
 * would make its doors vanish from the count, so it fails like a growing baseline does; adding one is fine.
 */
export function checkSources(sources: readonly WalkerSource[], baseSources: readonly WalkerSource[] | null): string[] {
  if (!baseSources) return [];
  const key = (s: WalkerSource) => `${s.walker} ${s.module} ${s.source}`;
  const here = new Set(sources.map(key));
  return baseSources
    .filter((s) => !here.has(key(s)))
    .map((s) => `${key(s)}: a walker source on the base branch is missing here. Fix: restore it in ax/census.config.json; removing a source makes its doors vanish from the count.`);
}
