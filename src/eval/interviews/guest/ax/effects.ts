export { audienceLines, DEFAULT_HEADINGS, DRY_RUN_FLAG, effectAnnotations, namesLine, ONLY_YOU, privateResult, WHY_FLAG, WHY_PLACEHOLDER };
export type { Audience, Effect, EffectHeadings };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * Effect classes: a command either touches only the person's own space ("private") or reaches other people
 * ("others"). Help groups commands under those headings, an "others" command needs `--why` and previews its
 * audience before it acts, and its result says who can see it. `readOnly` marks reads, which change nothing.
 */
type Effect = "private" | "others";

interface EffectHeadings {
  private: string;
  others: string;
}

const DEFAULT_HEADINGS: EffectHeadings = Object.freeze({ private: "Only you see these", others: "Other people see these" });

/** Who can see an effect, in words a person reads: `{ only: true, who: "only you" }` or the people of a conversation. */
interface Audience {
  only: boolean;
  who: string;
}

const ONLY_YOU: Audience = Object.freeze({ only: true, who: "only you" });

/** The flag an "others" command takes: who asked, and what they said. */
const WHY_FLAG = "why";
const WHY_PLACEHOLDER = "<who asked you, and what they said>";

/** The flag that previews an "others" command's effect and audience without acting. */
const DRY_RUN_FLAG = "dry-run";

/** MCP tool annotations for an effect, as [the MCP specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) defines them. */
function effectAnnotations(effect: Effect, readOnly: boolean): { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean } {
  return { readOnlyHint: readOnly, destructiveHint: effect === "others", openWorldHint: effect === "others" };
}

/**
 * "Jo Park", "Jo Park and Ana Ruiz", "Jo Park, Ana Ruiz and 3 others".
 *
 * @claim "Ana Ruiz and 3 others" registry/ouro/ax/effects.test.mts verify:testExists(registry/ouro/ax/effects.test.mts::names read as a person would say them)
 */
function namesLine(names: readonly string[], max: number = 2): string {
  if (names.length === 0) return "nobody";
  if (names.length <= max) return names.length === 1 ? names[0]! : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;
  const more = names.length - max;
  return `${names.slice(0, max).join(", ")} and ${more} other${more === 1 ? "" : "s"}`;
}

/**
 * The audience preview an "others" action prints before it runs, and the line its result states.
 * @example audienceLines({ doing: "Sending", done: "Sent", where: '"Design sync"', as: "the person", who: ["Jo Park", "Ana Ruiz"] })
 */
function audienceLines(a: { doing: string; done: string; where: string; as: string; who: readonly string[] | "everyone" }): { preview: string; result: string } {
  const who = a.who === "everyone" ? `Everyone in ${a.where}` : namesLine(a.who);
  return {
    preview: `${a.doing} to ${a.where} as ${a.as}. ${who} will see it.`,
    result: `${a.done} to ${a.where} as ${a.as}. ${who} can see it.`,
  };
}

/** The result line of a private action: what changed, and that nobody else saw it. */
function privateResult(what: string): string {
  return `${what.replace(/[.\s]+$/, "")}. Only you see it; nothing was sent.`;
}
