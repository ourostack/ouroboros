import { test } from "node:test";
import { deepEqual, ok } from "node:assert/strict";
import { checkBaseline, checkSources } from "./baseline.mts";

const kinds = ["mcp"];
const noBase = { baseline: ["mcp:ask"], hasConfig: true };

test("a gap on the baseline passes", () => {
  deepEqual(checkBaseline({ gaps: ["mcp:ask"], baseline: ["mcp:ask"], base: noBase, kinds }), []);
});

test("a new gap fails and says how to fix it", () => {
  deepEqual(checkBaseline({ gaps: ["mcp:ask", "mcp:new"], baseline: ["mcp:ask"], base: noBase, kinds }), [
    "mcp:new: a door with no valid card, not on the baseline. Fix: give it an ax card in this pull request.",
  ]);
});

test("a baseline entry now declared or gone fails", () => {
  deepEqual(checkBaseline({ gaps: [], baseline: ["mcp:ask"], base: noBase, kinds }), [
    "mcp:ask: on the baseline but no longer a gap. Fix: take it off ax/census.baseline.json.",
  ]);
});

test("growing the baseline against the base fails", () => {
  const problems = checkBaseline({ gaps: ["mcp:ask", "mcp:new"], baseline: ["mcp:ask", "mcp:new"], base: { baseline: ["mcp:ask"], hasConfig: true }, kinds });
  ok(problems.includes("mcp:new: added to the baseline. Fix: declare the door instead; the baseline only shrinks."), problems.join("\n"));
});

test("the first census may bring its baseline", () => {
  deepEqual(checkBaseline({ gaps: ["mcp:ask"], baseline: ["mcp:ask"], base: { baseline: null, hasConfig: false }, kinds }), []);
});

test("a baseline appearing where a census already ran fails", () => {
  const problems = checkBaseline({ gaps: ["mcp:ask"], baseline: ["mcp:ask"], base: { baseline: null, hasConfig: true }, kinds });
  ok(problems.includes("ax/census.baseline.json: missing on the base branch, which already runs the census. Fix: restore it from the base."), problems.join("\n"));
});

test("duplicate ids fail", () => {
  const problems = checkBaseline({ gaps: ["mcp:ask"], baseline: ["mcp:ask", "mcp:ask"], base: noBase, kinds });
  ok(problems.includes("mcp:ask: listed twice on the baseline."), problems.join("\n"));
});

test("an id of a kind the census doesn't walk fails", () => {
  const problems = checkBaseline({ gaps: [], baseline: ["cli:up"], base: { baseline: ["cli:up"], hasConfig: true }, kinds });
  ok(problems.includes("cli:up: the census doesn't walk cli doors yet, so it can't be on the baseline."), problems.join("\n"));
});

test("order doesn't matter", () => {
  const gaps = ["mcp:ask", "mcp:catchup", "mcp:status"];
  deepEqual(checkBaseline({ gaps, baseline: [...gaps].reverse(), base: { baseline: gaps, hasConfig: true }, kinds }), []);
});

test("outside a pull request the growth check is skipped", () => {
  deepEqual(checkBaseline({ gaps: ["mcp:ask", "mcp:new"], baseline: ["mcp:ask", "mcp:new"], base: null, kinds }), []);
});

test("walker sources may be added but not removed", () => {
  const mcp = { walker: "mcp-schemas", module: "dist/a.js", source: "src/a.ts" };
  const other = { walker: "mcp-schemas", module: "dist/b.js", source: "src/b.ts" };
  deepEqual(checkSources([mcp, other], [mcp]), []);
  deepEqual(checkSources([mcp], null), []);
  deepEqual(checkSources([other], [mcp]), [
    "mcp-schemas dist/a.js src/a.ts: a walker source on the base branch is missing here. Fix: restore it in ax/census.config.json; removing a source makes its doors vanish from the count.",
  ]);
});

test("a CLI source's parser, kinds and claims are part of what can't be removed", () => {
  const parser = { walker: "ts-parser", module: "dist/p.js", source: "src/p.ts", parser: "parse", kinds: "src/t.ts#T" };
  const entries = { walker: "argv-entries", module: "dist", source: "src", claims: [{ entry: "src/e.ts", parser: "src/p.ts" }] };
  deepEqual(checkSources([parser, entries], [parser, entries]), []);
  // A new claim hides an entry's doors, so it counts as narrowing the source.
  const more = { ...entries, claims: [...entries.claims, { entry: "src/f.ts", parser: "src/p.ts" }] };
  deepEqual(checkSources([parser, more], [parser, entries]).length, 1);
  deepEqual(checkSources([{ ...parser, kinds: "src/t.ts#U" }, entries], [parser, entries]).length, 1);
});

test("a kind the base branch doesn't walk yet may join the baseline; a kind it walks may not grow", () => {
  const gaps = ["mcp:ask", "cli:up", "cli:down"];
  const base = { baseline: ["mcp:ask"], hasConfig: true, kinds: ["mcp"] };
  deepEqual(checkBaseline({ gaps, baseline: gaps, base, kinds: ["mcp", "cli"] }), []);
  deepEqual(checkBaseline({ gaps: [...gaps, "mcp:new"], baseline: [...gaps, "mcp:new"], base, kinds: ["mcp", "cli"] }), [
    "mcp:new: added to the baseline. Fix: declare the door instead; the baseline only shrinks.",
  ]);
  // Once the base walks cli, cli entries are ratcheted too.
  deepEqual(checkBaseline({ gaps, baseline: gaps, base: { ...base, kinds: ["mcp", "cli"] }, kinds: ["mcp", "cli"] }), [
    "cli:up: added to the baseline. Fix: declare the door instead; the baseline only shrinks.",
    "cli:down: added to the baseline. Fix: declare the door instead; the baseline only shrinks.",
  ]);
});
