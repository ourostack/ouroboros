export { BARE_FAILURE, CAUSE_MARKER, checkFailureCopyAllow, FAILURE_KEYS, LEAD_FAILURE, NOT_A_CAUSE, NOT_BARE_LEADS, statesCause, VAGUE_FAILURE_PHRASES, vagueFailureIn, vagueFailuresIn };
export type { FailureCopyAllow, VagueFailureFinding, VagueFailuresOptions };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * A failure says what happened and precisely why (the system and its answer: "The mail service says this file was
 * deleted"), who or what caused it where that is known, and the next step as a working action. "Couldn't show this
 * picture" leaves the agent guessing at the cause and at what to tell the person. When the cause is unknown, the message
 * says what was tried and what came back.
 *
 * Vague: "couldn't", "could not", "something went wrong", "unable to", "failed to load", "an error occurred", and a
 * text that is only a bare "Error" or "Upload failed", unless the cause follows the phrase in the same sentence ("Couldn't send:
 * you're offline. Try again when you're back online.", "… because …"; not "Couldn't send: try again"). A negation or an action before the word ("No errors", "Retry failed") passes. The source rules kit (ouro-source-rules) keeps the identical
 * list for an app's UI copy; change both together. A text that is precise and still holds a phrase ("The card service
 * says your card could not be charged. Use another card.") goes on an allow-list, each entry with its reason.
 *
 * @claim "A negation or an action before the word" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 * @claim "unless the cause follows the phrase" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 * @claim "goes on an allow-list, each entry with its reason" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::an allow-list needs a match and a reason in every entry)
 * @claim "The source rules kit (ouro-source-rules) keeps the identical list" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::keeps the source rules kit's list of phrases)
 */
interface FailureCopyAllow {
  /** Part of the text, case-sensitive: a text that holds it passes. */
  match: string;
  /** Why this wording is precise. */
  reason: string;
}

interface VagueFailureFinding {
  /** The phrase, by its name ("could not", "bare error"). */
  phrase: string;
  /** Where in the value, such as `error.message`; "" for a string on its own. */
  where: string;
  /** The whole message the phrase is in. */
  text: string;
  /** The allow-list entry that lets it through, or null. */
  allowed: FailureCopyAllow | null;
}

interface VagueFailuresOptions {
  /** Read only what speaks to the agent or the person ({@link FAILURE_KEYS}), as in a read's `--json`, whose other fields are the person's data. */
  messagesOnly?: boolean;
  allow?: readonly FailureCopyAllow[];
}

/** A phrase's name, then its pattern. */
const VAGUE_FAILURE_PHRASES: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["couldn't", /\bcouldn[’']?t\b/i],
  ["could not", /\bcould not\b/i],
  ["something went wrong", /\bsomething went wrong\b/i],
  ["unable to", /\bunable to\b/i],
  ["failed to load", /\bfailed to load\b/i],
  ["an error occurred", /\ban? (?:unknown |unexpected )?error (?:has )?occurred\b|\ban (?:unknown|unexpected) error\b/i],
] as const);

/**
 * A bare failure: the whole text is "error" or "failed" (or "failure"), at most two words before it, or "Error:" with nothing after.
 *
 * @claim "at most two words before it" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 */
const BARE_FAILURE = /^[^\p{L}\p{N}]*(?:(?:\p{L}[\p{L}'’-]*\s+){0,2}(?:error|errors|failed|failure)|error\s*:)[^\p{L}\p{N}]*$/iu;

/** What marks a failure's cause after the phrase, in the same sentence: a colon, a dash or "because". */
const CAUSE_MARKER = /:|\s[—–-]\s|\bbecause\b/iu;

/**
 * First words that make the words after a marker a next step ("try again") or a vague word ("error") in place of a cause.
 *
 * @claim "First words that make the words after a marker a next step" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 */
const NOT_A_CAUSE: readonly string[] = Object.freeze(["try", "please", "retry", "contact", "see", "error", "errors", "unknown", "failed", "failure"]);

/** A failure that leads the text ("Error: …", "Upload failed - …"), held to the same test as a phrase; the group is the marker. */
const LEAD_FAILURE = /^[^\p{L}\p{N}]*(?:\p{L}[\p{L}'’-]*\s+){0,2}(?:error|errors|failed|failure)\s*(:|\s[—–-]\s)/iu;

/**
 * Words before "error" or "failed" that make the text other than a failure: a negation ("No errors") or an action ("Retry failed").
 *
 * @claim "that make the text other than a failure" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 */
const NOT_BARE_LEADS: readonly string[] = Object.freeze(["no", "nothing", "zero", "none", "show", "hide", "retry", "clear"]);

/**
 * The fields of an answer that speak to the agent or the person: a refusal's or an outcome's `error`, `human` (its
 * `reason` and `resume`), next steps and fixes, and in an Ouro AX answer (one with an `ax` field: an outcome, a checks
 * report) its `summary` and each finding's `detail`.
 *
 * @claim "each finding's `detail`" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::walks a value, reading an outcome's error, human reason and summary and a checks report's findings, not the person's data)
 */
const FAILURE_KEYS: ReadonlySet<string> = new Set(["error", "human", "reason", "next", "fix", "resume"]);
const AX_KEYS: ReadonlySet<string> = new Set(["summary", "detail"]);
/** A code or a status ("failed", "not_found"), not copy. */
const TOKEN = /^[a-z][\w.:-]*$/;

/**
 * The vague failure phrase in a message, by its name, or null when there is none or an allow-list entry lets it
 * through. A text that is only "Error" or "Upload failed" is "bare error" or "bare failed".
 *
 * @claim "or null when there is none or an allow-list entry lets it through" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 *
 * @example
 * vagueFailureIn("Couldn't show this picture"); // "couldn't"
 * vagueFailureIn("The photo service says this picture was deleted. Ask its owner to share it again."); // null
 */
function vagueFailureIn(text: string, allow: readonly FailureCopyAllow[] = []): string | null {
  const phrase = phraseIn(text);
  return phrase && !allowedBy(text, allow) ? phrase : null;
}

const SENTENCE_END = /[.!?](?=\s|$)/u;
const WORD = /\p{L}[\p{L}\p{N}'’-]*/gu;
const wordsOf = (text: string) => text.toLowerCase().match(WORD) ?? [];

/**
 * Whether the text after a failure phrase states the cause in the same sentence: after a colon, a dash or "because", a
 * substitution (`${…}`) or at least two words whose first is not in {@link NOT_A_CAUSE}, with no vague phrase in it.
 *
 * @claim "at least two words whose first is not in" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::finds each vague phrase and a bare failure, and lets precise copy and allowed text through)
 *
 * @example
 * statesCause(" send: you're offline. Try again later."); // true
 * statesCause(" send: try again."); // false
 */
function statesCause(rest: string): boolean {
  const sentence = rest.split(SENTENCE_END)[0]!;
  const marker = CAUSE_MARKER.exec(sentence);
  if (!marker) return false;
  const cause = sentence.slice(marker.index + marker[0].length);
  if (cause.includes("${…}")) return true;
  const words = wordsOf(cause);
  return words.length >= 2 && !NOT_A_CAUSE.includes(words[0]!) && !VAGUE_FAILURE_PHRASES.some(([, pattern]) => pattern.test(cause));
}

function phraseIn(text: string): string | null {
  const trimmed = text.trim();
  if (TOKEN.test(trimmed)) return null;
  const found = VAGUE_FAILURE_PHRASES.find(([, pattern]) =>
    [...text.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].some((match) => !statesCause(text.slice(match.index + match[0].length))),
  );
  if (found) return found[0];
  const word = (failure: string) => (/\berrors?\b/i.test(failure) ? "bare error" : "bare failed");
  const lead = LEAD_FAILURE.exec(trimmed);
  if (lead && !wordsOf(lead[0]).some((w) => NOT_BARE_LEADS.includes(w))) return statesCause(trimmed.slice(lead[0].length - lead[1]!.length)) ? null : word(lead[0]);
  if (!BARE_FAILURE.test(trimmed)) return null;
  if (wordsOf(trimmed).slice(0, -1).some((w) => NOT_BARE_LEADS.includes(w))) return null;
  return word(trimmed);
}

const allowedBy = (text: string, allow: readonly FailureCopyAllow[]) => allow.find((entry) => text.includes(entry.match)) ?? null;

/**
 * Every vague failure message in a value: a message, a `help --json`, an outcome, a refusal or a checks report. A
 * finding an allow-list entry lets through carries the entry. With `messagesOnly`, only what is under
 * {@link FAILURE_KEYS}, and an Ouro AX answer's `summary` and `detail`; a `code` is never read.
 *
 * @claim "a `code` is never read" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::walks a value, reading an outcome's error, human reason and summary and a checks report's findings, not the person's data)
 * @claim "Every vague failure message in a value" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::walks a value, reading an outcome's error, human reason and summary and a checks report's findings, not the person's data)
 *
 * @example
 * vagueFailuresIn({ ax: "outcome/1", state: "failed", summary: "Not sent", error: { code: "send_failed", message: "Something went wrong" } }, { messagesOnly: true });
 * // [{ phrase: "something went wrong", where: "error.message", text: "Something went wrong", allowed: null }]
 */
function vagueFailuresIn(value: unknown, options: VagueFailuresOptions = {}): VagueFailureFinding[] {
  const out: VagueFailureFinding[] = [];
  const visit = (v: unknown, where: string, speaks: boolean, ax: boolean): void => {
    if (typeof v === "string") {
      const phrase = speaks ? phraseIn(v) : null;
      if (phrase) out.push({ phrase, where, text: v, allowed: allowedBy(v, options.allow ?? []) });
      return;
    }
    if (Array.isArray(v)) return v.forEach((x, i) => visit(x, `${where}[${i}]`, speaks, ax));
    if (typeof v !== "object" || v === null) return;
    const record = v as Record<string, unknown>;
    const inAx = ax || typeof record["ax"] === "string";
    for (const [k, x] of Object.entries(record)) {
      if (k === "code") continue;
      visit(x, where ? `${where}.${k}` : k, speaks || FAILURE_KEYS.has(k) || (inAx && AX_KEYS.has(k)), inAx);
    }
  };
  visit(value, "", !options.messagesOnly, false);
  return out;
}

/**
 * An allow-list read from JSON, checked: a list of `{ match, reason }`, each with a non-empty `match` and a `reason`.
 * Throws naming each entry that is not one, with the fix.
 *
 * @claim "each with a non-empty `match` and a `reason`" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::an allow-list needs a match and a reason in every entry)
 * @claim "Throws naming each entry that is not one" registry/ouro/ax/precise-copy.test.mts verify:testExists(registry/ouro/ax/precise-copy.test.mts::an allow-list needs a match and a reason in every entry)
 *
 * @example
 * checkFailureCopyAllow([{ match: "could not be charged", reason: "names the card service and its answer" }]);
 */
function checkFailureCopyAllow(value: unknown): FailureCopyAllow[] {
  const shape = '{ "match": "<part of the text>", "reason": "<why this wording is precise>" }';
  if (!Array.isArray(value)) throw new Error(`the failure copy allow-list is a list. Fix: [${shape}].`);
  const problems = value.flatMap((entry: unknown, i: number) => {
    const e = entry as Partial<FailureCopyAllow> | null;
    const ok = typeof e === "object" && e !== null && typeof e.match === "string" && e.match.length > 0 && typeof e.reason === "string" && e.reason.trim().length > 0;
    return ok ? [] : [`entry ${i} ${JSON.stringify(entry)} needs a non-empty "match" and a "reason". Fix: ${shape}.`];
  });
  if (problems.length) throw new Error(`the failure copy allow-list has ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.join("\n")}`);
  return value as FailureCopyAllow[];
}
