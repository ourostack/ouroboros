// The quality checks a door card must pass, so a declaration can't be empty (design section 3). A card that fails any
// check is weak, and weak counts against zero. Slice 1 applies the checks that need only the cards and the code the
// walker read. An error code must appear in the door's handler file outside any card (`evidence.raises`, when the
// walker can tell); the server-level `unknown-door` card is the walker's check, because it belongs to no one door.
import type { Consent, Door, DoorCard, ErrorCard, GroupCard } from "./types.mts";

const CONSENTS: readonly Consent[] = ["read", "write", "consequential", "person-only"];

/** Words that carry no meaning in a `when` line. A fixed list, kept short on purpose. */
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "to", "of", "in", "on", "for", "with", "from", "by", "at", "as", "into",
  "this", "that", "these", "those", "it", "its", "is", "are", "be", "was", "you", "your", "use", "using", "when",
  "need", "needs", "want", "can", "will", "do", "does", "if", "then", "so", "any", "some", "all", "not", "no",
  "one", "about", "what", "which", "who", "how", "there", "here", "than", "only", "just", "tool",
]);

const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

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
  if (effect === "consequential" && !isOneLine(confirm)) reasons.push("confirm: required for consequential");
  return reasons;
}

/**
 * The reasons a door's card is weak; `[]` means the card is valid. `others` is every door in the product (it may
 * include `door` itself), used for the checks that compare cards. A door with `card: null` is undeclared, not weak,
 * and is not passed here.
 */
export function checkCard(door: Door, ctx: { groups: readonly GroupCard[]; others: readonly Door[] }): string[] {
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
  reasons.push(...groupReasons(card, ctx.groups));
  reasons.push(...errorReasons(door, ctx.others));
  reasons.push(...effectReasons(door));
  return reasons;
}
