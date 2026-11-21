// The census report (design section 4): one ProductReport per product, and the short text table CI prints.
import type { CensusReport, Counts, Door, Gap, ProductReport } from "./types.mts";

/**
 * `weak` maps a door id to its reasons; a door with a card and no entry is declared, and a door without a card and no
 * entry is undeclared.
 */
export function buildProductReport(
  product: string,
  doors: readonly Door[],
  weak: ReadonlyMap<string, string[]>,
  baselineSize: number,
  walked: { kinds: string[]; finders: string[] },
  unwalked: readonly Gap[] = [],
  excluded: readonly { hit: string; category: string }[] = [],
): ProductReport {
  const byKind: Record<string, Counts> = {};
  const undeclared: Gap[] = [];
  const weakGaps: Gap[] = [];
  let declared = 0;
  for (const door of doors) {
    const counts = (byKind[door.kind] ??= { found: 0, declared: 0, weak: 0, undeclared: 0, unwalked: 0 });
    counts.found += 1;
    const reasons = weak.get(door.id);
    if (reasons) {
      counts.weak += 1;
      weakGaps.push({ id: door.id, kind: door.kind, file: door.file, line: door.line, reasons });
    } else if (door.card) {
      counts.declared += 1;
      declared += 1;
    } else {
      counts.undeclared += 1;
      undeclared.push({ id: door.id, kind: door.kind, file: door.file, line: door.line, ...(door.walker ? { walker: door.walker } : {}) });
    }
  }
  for (const gap of unwalked) (byKind[gap.kind] ??= { found: 0, declared: 0, weak: 0, undeclared: 0, unwalked: 0 }).unwalked += 1;
  return {
    product,
    walked,
    summary: { found: doors.length, declared, weak: weakGaps.length, undeclared: undeclared.length, unwalked: unwalked.length, stale: 0, excluded: excluded.length, baseline: baselineSize },
    byKind,
    undeclared,
    weak: weakGaps,
    unwalked: [...unwalked],
    excluded: [...excluded],
  };
}

function byPlace(a: Gap, b: Gap): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  if (a.line !== b.line) return (a.line ?? Infinity) - (b.line ?? Infinity);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Per product: `<product>: N found, N declared, N weak, N undeclared[, N unwalked] (<kind> N, ...)`, then one
 * `file:line id` line per gap.
 */
export function renderText(report: CensusReport): string {
  const lines: string[] = [];
  for (const p of report.products) {
    const kinds = Object.entries(p.byKind).map(([kind, c]) => `${kind} ${c.found}`).join(", ");
    const s = p.summary;
    const unwalked = s.unwalked > 0 ? `, ${s.unwalked} unwalked` : "";
    lines.push(`${p.product}: ${s.found} found, ${s.declared} declared, ${s.weak} weak, ${s.undeclared} undeclared${unwalked} (${kinds})`);
    const isUnwalked = new Set(p.unwalked.map((g) => g.id));
    for (const gap of [...p.undeclared, ...p.weak, ...p.unwalked].sort(byPlace)) {
      const why = gap.reasons ? ` (${isUnwalked.has(gap.id) ? "unwalked" : "weak"}: ${gap.reasons.join("; ")})` : "";
      lines.push(`${gap.file}:${gap.line ?? "?"} ${gap.id}${why}`);
    }
  }
  return lines.join("\n");
}
