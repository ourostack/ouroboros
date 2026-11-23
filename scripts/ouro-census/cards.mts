// The quality checks a door card must pass, so a declaration can't be empty (design section 3). A card that fails any
// check is weak, and weak counts against zero. Slice 1 applies the checks that need only the cards and the code the
// walker read. An error code must appear in the door's handler file outside any card (`evidence.raises`, when the
// walker can tell); the server-level `unknown-door` card is the walker's check, because it belongs to no one door.
import type { BookletAllow, Consent, Door, DoorCard, ErrorCard, GroupCard } from "./types.mts";

const CONSENTS: readonly Consent[] = ["read", "write", "consequential", "person-only"];

/** Words that carry no meaning in a `when` line. A fixed list, kept short on purpose. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "for", "with", "from", "by", "at", "as", "into",
  "this", "that", "these", "those", "it", "its", "is", "are", "be", "was", "you", "your", "use", "using", "when",
  "need", "needs", "want", "can", "will", "do", "does", "if", "then", "so", "any", "some", "all", "not", "no",
  "one", "about", "what", "which", "who", "how", "there", "here", "than", "only", "just", "tool",
]);

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Booklet words: text that tells the reading agent a rule instead of saying what the door does (butler-productionization
 * R11.6). A product adopts the check with `bookletWords` in its config; a reviewed allowlist entry lets one word stand
 * on one door's field.
 */
export const BOOKLET_WORDS: readonly string[] = ["always", "never", "do not", "use this whenever", "you must"];
export const BOOKLET_FIELDS: readonly BookletAllow["field"][] = ["description", "when", "fix"];

// A booklet word counts whole, quoted or not ("'never'" counts, "nevermore" and "always-on" don't), and a phrase's words
// may be split by spaces, line breaks, hyphens or underscores.
const bookletPattern = (word: string) => new RegExp(`(?<![a-z0-9_-])${word.replace(/ /g, "[\\s_-]+")}(?![a-z0-9_-])`, "i");

/** Each booklet word a text says, in the list's order. */
export function bookletWordsIn(text: unknown): string[] {
  return typeof text === "string" ? BOOKLET_WORDS.filter((word) => bookletPattern(word).test(text)) : [];
}

/** The texts the booklet check reads on a door, each with the field an allowlist entry names and the label a reason uses. */
export function bookletTexts(door: Door): { field: BookletAllow["field"]; label: string; text: unknown }[] {
  const card = door.card!;
  return [
    { field: "description", label: "description", text: door.description },
    { field: "when", label: "when", text: card.when },
    ...(Array.isArray(card.errors) ? card.errors.map((error, i) => ({ field: "fix" as const, label: `errors[${i}].fix`, text: error?.fix })) : []),
  ];
}

function bookletReasons(door: Door, allow: readonly BookletAllow[]): string[] {
  const reasons: string[] = [];
  for (const { field, label, text } of bookletTexts(door)) {
    for (const word of bookletWordsIn(text)) {
      if (allow.some((entry) => entry.door === door.id && entry.field === field && entry.word === word)) continue;
      reasons.push(`${label}: says "${word}", a rule for the reader; say what the door does instead`);
    }
  }
  return reasons;
}

function words(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1);
}

function isOneLine(text: unknown, min = 1, max = 200): boolean {
  return typeof text === "string" && !/[\r\n]/.test(text) && text.trim().length >= min && text.length <= max;
}

/** The words left in a `when` line after removing stop words and the given words. */
function contentWords(when: string, own: readonly string[]): Set<string> {
  const drop = new Set(own.flatMap(words));
  return new Set(words(when).filter((w) => !STOP_WORDS.has(w) && !drop.has(w)));
}

function whenReasons(when: unknown, own: readonly string[], label: string): string[] {
  if (!isOneLine(when, 6, 200)) return [`${label}: not one line of 6 to 200 characters`];
  if (contentWords(when as string, own).size < 3) return [`${label}: fewer than 3 words beyond the door's own name and description`];
  return [];
}

/** The `when` line with the door's own name words replaced by `_`, so templated lines compare equal. */
function skeleton(door: Door): string {
  const own = new Set(words(door.name));
  return words(door.card!.when).map((w) => (own.has(w) ? "_" : w)).join(" ");
}

function errorSet(errors: readonly ErrorCard[]): string {
  const sorted = [...errors].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  return JSON.stringify(sorted.map(({ code, means, fix }) => ({ code, means, fix })));
}

function groupReasons(card: DoorCard, groups: readonly GroupCard[]): string[] {
  const group = groups.find((g) => g.id === card.group);
  if (!group) return [`group: no group card named ${card.group}`];
  const reasons = whenReasons(group.when, [group.id], "when");
  return reasons.length > 0 ? [`group: ${group.id} has a weak when line`] : [];
}

function errorReasons(door: Door, others: readonly Door[]): string[] {
  const errors = door.card!.errors;
  if (!Array.isArray(errors) || errors.length === 0) return ["errors: none declared"];
  const reasons: string[] = [];
  errors.forEach((error, i) => {
    if (typeof error.code !== "string" || !KEBAB.test(error.code)) reasons.push(`errors[${i}]: code is not kebab-case`);
    if (!isOneLine(error.means)) reasons.push(`errors[${i}]: means is not one line`);
    if (!isOneLine(error.fix)) reasons.push(`errors[${i}]: fix is not one line`);
    if (typeof error.means === "string" && typeof error.fix === "string" && error.means.trim().toLowerCase() === error.fix.trim().toLowerCase()) {
      reasons.push(`errors[${i}]: fix repeats means`);
    }
    if (door.evidence.raises && !door.evidence.raises.includes(error.code)) reasons.push(`errors[${i}]: code ${error.code} is never raised in ${door.file}`);
  });
  const mine = errorSet(errors);
  const sharing = others.filter((o) => o.id !== door.id && o.card && Array.isArray(o.card.errors) && o.card.errors.length > 0 && errorSet(o.card.errors) === mine).length;
  if (sharing >= 3) reasons.push(`errors: same set as ${sharing} other doors`);
  return reasons;
}

function effectReasons(door: Door): string[] {
  const { effect, confirm } = door.card!;
  const { readOnly, mutates, approval } = door.evidence;
  if (!CONSENTS.includes(effect)) return [`effect: not one of ${CONSENTS.join(", ")}`];
  const reasons: string[] = [];
  const mutating = mutates !== undefined && mutates !== "none";
  if (effect === "read") {
    if (mutating) reasons.push(`effect: read, but the code mutates (${mutates})`);
    if (approval) reasons.push("effect: read, but the code asks for approval");
    if (!mutating && !approval && readOnly !== true && mutates !== "none") reasons.push("effect: read without evidence");
  } else if (readOnly === true) {
    reasons.push(`effect: ${effect}, but the code says read-only`);
  }
  // An in-turn tool's approval prompt is found from its code, so the card and the code must agree both ways.
  if (door.kind === "tool" && effect !== "read") {
    if (effect === "consequential" && approval !== true) reasons.push("effect: consequential, but the code never asks for approval (no approvalPolicy)");
    if (effect !== "consequential" && approval === true) reasons.push(`effect: ${effect}, but the code asks for approval; say consequential`);
  }
  if (effect === "consequential" && !isOneLine(confirm)) reasons.push("confirm: required for consequential");
  return reasons;
}

/**
 * The reasons a door's card is weak; `[]` means the card is valid. `others` is every door in the product (it may
 * include `door` itself), used for the checks that compare cards. A door with `card: null` is undeclared, not weak,
 * and is not passed here.
 */
export function checkCard(door: Door, ctx: { groups: readonly GroupCard[]; others: readonly Door[]; booklet?: readonly BookletAllow[] | null }): string[] {
  const card = door.card!;
  const reasons: string[] = [];
  if (card.id !== door.id) reasons.push(`id: card says ${card.id}`);
  if (door.line === null) reasons.push("name: not a literal");
  const when = whenReasons(card.when, [door.name, door.description], "when");
  reasons.push(...when);
  if (isOneLine(card.when)) {
    const mine = skeleton(door);
    for (const other of ctx.others) {
      if (other.id !== door.id && other.card && isOneLine(other.card.when) && skeleton(other) === mine) {
        reasons.push(`when: same skeleton as ${other.id}`);
      }
    }
  }
  for (const alias of door.aliases ?? []) {
    if (!Array.isArray(card.aliases) || !card.aliases.includes(alias)) reasons.push(`aliases: the code also accepts ${alias}; list it on the card`);
  }
  reasons.push(...groupReasons(card, ctx.groups));
  reasons.push(...errorReasons(door, ctx.others));
  reasons.push(...effectReasons(door));
  if (ctx.booklet) reasons.push(...bookletReasons(door, ctx.booklet));
  return reasons;
}

/**
 * The reasons a door declared by another door's card is weak: an approval prompt is declared by its tool's card,
 * which must itself be valid, say `consequential` and carry the `confirm` question.
 */
export function checkDeclaredBy(door: Door, ownerWeak: boolean): string[] {
  const card = door.card!;
  const reasons: string[] = [];
  if (ownerWeak) reasons.push(`card: ${door.declaredBy} is weak`);
  if (card.effect !== "consequential") reasons.push(`effect: the code asks for approval here, but ${door.declaredBy} says ${card.effect}`);
  if (!isOneLine(card.confirm)) reasons.push("confirm: required for consequential");
  return reasons;
}
