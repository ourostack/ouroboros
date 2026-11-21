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
