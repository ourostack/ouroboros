export { AX_ACTION_ATTRIBUTE, bindAx, defineComponentAx, expectAxRendered, isReservedPersonOnly, READ_CONSENTS, RESERVED_PERSON_ONLY };
export type { AxAction, AxAgentAction, AxBindings, AxPersonOnlyAction, AxRead, AxScope, ComponentAx, ReadConsent, ReadTwin, Rendered, UiEntry };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { Effect } from "./effects.ts";

/**
 * A component's agent side: what an agent may read from it and which of its actions an agent may take, each bound to the
 * CLI command that does the same (its twin). `defineComponentAx` declares it once beside the component; the app binds
 * the twins with `bindAx`, because a component does not know the app's command names; the entries `bindAx` returns go
 * into the X-ray's inventory under `ui`, and the X-ray checks every twin from outside. Declare it beside the component
 * whose actions it names, such as `CallControls`, rather than the generic `Toolbar` that holds it: a container exports
 * one only when it has agent reads or actions of its own. A component imports `defineComponentAx` from the kit's
 * `ouro/ax/component` under the registry alias, which the shadcn CLI rewrites to the app's lib alias
 * (`@/lib/ouro/ax/component`), and its item brings `ax-component` with it. The path is not spelled out here, since an
 * installed file may not name the registry.
 *
 * @claim "which the shadcn CLI rewrites to the app's lib alias" scripts/install-check.test.mjs verify:testExists(scripts/install-check.test.mjs::an installed file must equal its source once import paths are mapped to the app's aliases)
 * @claim "its item brings `ax-component` with it" scripts/registry.test.mjs verify:testExists(scripts/registry.test.mjs::a component that imports the ax kit lists the ax item in its registryDependencies)
 *
 * @claim "each bound to the CLI command that does the same" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::bindAx needs a twin for every read and agent action, refuses one for a person-only action, and returns the inventory entries)
 * @claim "the X-ray checks every twin from outside" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the calling components' twins conform: each twin is listed with its effect, person-only words refuse, and listening reads wait for a follow)
 */
const READ_CONSENTS = Object.freeze(["none", "listening"] as const);

/**
 * What a read needs before an agent gets its content: `none`, or `listening`, for what people say (captions, a
 * transcript), which an agent reads only once the person has asked it to follow that meeting. Until then the twin
 * answers `needs-human`, never the content.
 */
type ReadConsent = (typeof READ_CONSENTS)[number];

const MEDIA = "You can't turn on the person's microphone, camera or screen; only they can.";

/**
 * The canonical ids of the actions that are the person's own, whatever the component: their microphone (`unmute`),
 * camera (`camera`, `camera-on`) and screen (`share`), answering, joining or declining a call (`answer`, `decline`), who comes in
 * from the lobby (`admit`), and what is recorded (`record`), each with the reason to declare it with. Aliases count too
 * (`isReservedPersonOnly`): declaring one `agent: true` throws, and the X-ray fails a `ui` entry with one that is not
 * person-only. The reverse stays an agent's, since an agent may always reduce what the person exposes: `mute`,
 * `camera-off`, `stop-share`.
 *
 * @claim "each with the reason to declare it with" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::a reserved action is always the person's: declaring it agent: true throws with its reason)
 * @claim "declaring one `agent: true` throws" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::a reserved action is always the person's: declaring it agent: true throws with its reason)
 * @claim "the X-ray fails a `ui` entry with one that is not" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a call tool that breaks the component claims fails each, with what it saw)
 * @claim "an agent may always reduce what the person exposes" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::reserved ids are matched by meaning: every alias and case is the person's, and what reduces exposure stays an agent's)
 */
const RESERVED_PERSON_ONLY: Readonly<Record<string, string>> = Object.freeze({
  unmute: MEDIA,
  camera: MEDIA,
  "camera-on": MEDIA,
  share: MEDIA,
  answer: "You can't answer, join or decline a call for the person; only they can.",
  decline: "You can't answer, join or decline a call for the person; only they can.",
  admit: "You can't admit anyone from the lobby for the person; only they can.",
  record: "You can't start recording or transcription for the person; only they can.",
});

// Reducing words: off, stop, end, disable and mute.
const REDUCING = ["off", "stop", "end", "disable", "mute"];
// Turn-on words, which keep a reducing word from freeing an id.
const TURN_ON = ["on", "toggle", "resume", "start", "enable", "unmute", "un"];
/** The words that may sit beside a device or capture noun without changing what the id turns on. */
const ON = [...TURN_ON, "turn"];
// Device and capture nouns, keyed by the canonical id they mean.
const DEVICES: Readonly<Record<string, readonly string[]>> = {
  unmute: ["mic", "microphone", "audio", "mute"],
  camera: ["camera", "cam", "webcam", "video"],
  share: ["screen", "screenshare", "share", "sharing"],
  record: ["transcript", "transcription", "transcribe", "record", "recording"],
};
/** The call verbs, which are the person's only alone or beside a call word, since `share-link` is not a call. */
const CALL_VERBS: Readonly<Record<string, readonly string[]>> = {
  share: ["share", "sharing", "present", "presenting"],
  answer: ["answer", "accept", "pickup"],
  decline: ["decline", "reject"],
  record: ["record", "recording"],
};
const CALL_WORDS = ["call", "meeting", "ring", "lobby", "screen", "room", "video", "audio", "incoming", "from", "the"];
const CALL_NOUNS = CALL_WORDS.filter((x) => x !== "incoming" && x !== "from" && x !== "the");

// Every word the matcher reads, so a run-together word splits only into words it can match.
const VOCABULARY: ReadonlySet<string> = new Set([
  ...REDUCING,
  ...TURN_ON,
  ...ON,
  ...Object.values(DEVICES).flat(),
  ...Object.values(CALL_VERBS).flat(),
  ...CALL_WORDS,
  "un", "mute", "pick", "up", "let", "in", "letin", "admit", "all", "join", "turn", "share", "screen",
]);

// The fewest vocabulary words that `word` is made of, the first one the longest, or undefined when no split uses only them.
function knownParts(word: string): string[] | undefined {
  const n = word.length;
  // `split.get(i)` holds the fewest vocabulary words that `word.slice(i)` is made of; it is absent when none is.
  const split = new Map<number, string[]>([[n, []]]);
  for (let start = n - 1; start >= 0; start--) {
    for (let end = n; end > start; end--) {
      const rest = split.get(end);
      if (rest === undefined || !VOCABULARY.has(word.slice(start, end))) continue;
      const best = split.get(start);
      if (best === undefined || rest.length + 1 < best.length) split.set(start, [word.slice(start, end), ...rest]);
    }
  }
  return split.get(0);
}

// An id's words, lower case: `shareScreen`, `share_screen`, `sharescreen` and `Share Screen` become `share screen`;
// `startsharescreen` becomes `start share screen`, since each word it is made of is one the matcher knows. A word the
// matcher knows, such as `screenshare`, is never split. `un mute`, `pick up` and `let in` each become one word.
const wordsOfId = (id: string) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter(Boolean)
    .flatMap((word) => knownParts(word) ?? [word])
    .join(" ")
    .replace(/\bun mute\b/g, "unmute")
    .replace(/\bpick up\b/g, "pickup")
    .replace(/\blet in\b/g, "letin")
    .split(" ");

/** The canonical reserved id an action id means, or null: `share-screen` means `share`, `camera-off` nothing. */
function reservedAs(id: string): string | null {
  const w = wordsOfId(id);
  const has = (words: readonly string[]) => words.some((x) => w.includes(x));
  const only = (allowed: readonly string[]) => w.every((x) => allowed.includes(x));
  // `mute-off` turns the microphone on, whatever its reducing words.
  if (w.includes("mute") && has(REDUCING.filter((x) => x !== "mute"))) return "unmute";
  if (has(REDUCING) && !has(TURN_ON)) return null;
  if (has(["unmute", "mute"])) return "unmute";
  for (const [canonical, nouns] of Object.entries(DEVICES)) {
    if (has(nouns) && (w.includes("toggle") || only([...nouns, ...ON]))) return canonical;
  }
  // Who comes in is the person's, whoever it is: `admit-all`, `admit-guest`.
  if (has(["admit", "letin"])) return "admit";
  // Joining shows the person to others, as answering does, but `join-channel` is not a call.
  if (w.includes("join") && has(CALL_NOUNS) && only(["join", ...ON, ...CALL_WORDS])) return "answer";
  for (const [canonical, verbs] of Object.entries(CALL_VERBS)) {
    if (has(verbs) && only([...verbs, ...ON, ...CALL_WORDS])) return canonical;
  }
  return null;
}

/**
 * Whether an action id is reserved for the person, by meaning rather than spelling: `Unmute`, `mic-on`, `share-screen`,
 * `startRecording` and `pick_up` are. So is a bare device or capture (`mic`, `camera`, `video`, `screen`, `transcript`)
 * alone or turned on, started, resumed or enabled, and any toggle of one (`toggle-mic`, `mute-toggle`), since a toggle
 * can turn it on. Admitting is the person's whoever it admits (`admit-all`, `let-in-guest`). A call verb (answer, accept,
 * decline, reject, share, record) is the person's alone or beside a call word (`accept-call`, `record-meeting`), and
 * join only beside one (`join-meeting`), so `answer-message`, `share-link`, `record-note` and `join-channel` stay an
 * agent's. A run-together word is split into the words the matcher knows, so `startsharescreen` reads as `start share screen`
 * and is reserved, while a word it cannot split, such as `sharelink`, is read whole. An id that only reduces what the person exposes (with off, stop, end, disable or mute in it and no on,
 * toggle, resume, start, enable or unmute, such as `mute`, `camera-off` or `stop-share`) is not reserved, but
 * `mute-off` is, since it unmutes. Captions are not reserved: they are the person's own and private, and a component
 * declares its captions action person-only itself. The declaration and the X-ray both ask it.
 *
 * @claim "is not reserved, but `mute-off` is, since it unmutes" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::reserved ids are matched by meaning: every alias and case is the person's, and what reduces exposure stays an agent's)
 * @claim "by meaning rather than spelling" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::reserved ids are matched by meaning: every alias and case is the person's, and what reduces exposure stays an agent's)
 * @claim "`startsharescreen` reads as `start share screen`" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::reserved ids are matched by meaning: every alias and case is the person's, and what reduces exposure stays an agent's)
 * @claim "a word it cannot split, such as `sharelink`, is read whole" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::reserved ids are matched by meaning: every alias and case is the person's, and what reduces exposure stays an agent's)
 */
function isReservedPersonOnly(id: string): boolean {
  return reservedAs(id) !== null;
}

/** Something an agent may read from the component, with the fields its twin's `--json` carries. */
interface AxRead {
  id: string;
  summary?: string;
  fields: readonly string[];
  consent: ReadConsent;
  /**
   * Why a field named like speech (`text`, `caption`, `transcript`) is not what people say, so the read may declare
   * `consent: "none"`. Leave it out for a read that carries speech, and declare `consent: "listening"`.
   */
  notSpeech?: string;
  /**
   * The read also streams, and its stream delivers lines only on a words trigger (such as `--on mention`): asked for
   * every line, it refuses. Bind the untriggered request as the read's `push` twin and the trigger as its `trigger`.
   *
   * @claim "asked for every line, it refuses" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::the calling components' twins conform: each twin is listed with its effect, person-only words refuse, and listening reads wait for a follow)
   */
  push?: "filtered";
}

interface AxActionBase {
  id: string;
  summary: string;
  effect: Effect;
}

/**
 * Whose item an agent action may act on: `self`, only the calling agent's own, such as its own row in AgentPresence.
 * An action without a scope acts on any item.
 */
type AxScope = "self";

/** An action an agent may take; the app binds its CLI twin. */
interface AxAgentAction extends AxActionBase {
  agent: true;
  personOnly?: never;
  /**
   * `"self"`: an agent may take it only on its own item. `bindAx` then needs a twin that says who is calling
   * (`--agent <me>`), the twin's command declares `self` (ax-command), so the kit refuses another agent's item before
   * anything runs, and the X-ray checks that the twin refuses a stranger.
   *
   * @claim "`bindAx` then needs a twin that says who is calling" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::a self-scoped action is an agent's, and bindAx needs its twin to say who is calling)
   * @claim "the X-ray checks that the twin refuses a stranger" registry/ouro/ax/xray.test.mts verify:testExists(registry/ouro/ax/xray.test.mts::a self-scoped twin that does not check the owner fails ui.self-scope-refuses, with what it saw)
   */
  scope?: AxScope;
}

/**
 * An action only the person takes, with the reason in one line, said to you, the agent ("You can't turn on the
 * person's camera; only they can."): `bindAx` refuses a twin for it and asks for the CLI words that refuse.
 */
interface AxPersonOnlyAction extends AxActionBase {
  personOnly: string;
  agent?: never;
  scope?: never;
}

/** An action: either `agent: true` or `personOnly: "<why>"`, exactly one; a missing or doubled choice is a type error. */
type AxAction = AxAgentAction | AxPersonOnlyAction;

interface ComponentAx {
  readonly component: string;
  readonly reads: readonly AxRead[];
  readonly actions: readonly AxAction[];
}

/**
 * A read's twin: the read command, or, for a read with `push: "filtered"`, the read, the untriggered stream (`push`,
 * which must refuse) and the words trigger that makes it deliver (`trigger`, such as `--on mention`).
 */
type ReadTwin = string | { read: string; push: string; trigger: string };

/**
 * The app's commands for a component's twins, by read and action id, written as an agent types them, with a
 * reference as a placeholder (`"call mute <meeting>"`). `refuseAs` names, for every person-only action, the CLI words an
 * agent might try, which refuse (`"call unmute"`).
 *
 * @claim "for every person-only action" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::bindAx needs a twin for every read and agent action, refuses one for a person-only action, and returns the inventory entries)
 */
interface AxBindings {
  reads?: Readonly<Record<string, ReadTwin>>;
  actions?: Readonly<Record<string, string>>;
  refuseAs?: Readonly<Record<string, string>>;
}

/** One line of the X-ray inventory's `ui` list: a bound read or action. */
interface UiEntry {
  component: string;
  kind: "read" | "action";
  id: string;
  effect?: Effect;
  twin?: string;
  personOnly?: string;
  consent?: ReadConsent;
  fields?: string[];
  push?: string;
  trigger?: string;
  refuseAs?: string;
  scope?: AxScope;
}

// A twin's `--agent <placeholder>`: who is calling, filled in by the agent.
const AGENT_WORDS = /(?:^|\s)--agent\s+<[^<>\s]+>(?:\s|$)/;

// Field names that carry what people say: a read of them waits for a follow, so it never declares consent "none".
const SPEECH_FIELDS = /^(?:text|captions?|transcripts?|utterances?|said)$/i;

const oneLine = (v: unknown): v is string => typeof v === "string" && v.trim() !== "" && !/[\r\n]/.test(v);

/**
 * Declares a component's agent side and checks it: unique read and action ids, a field list on each read, a known
 * consent and effect, each action either `agent: true` or `personOnly` with a one-line reason, never both or neither,
 * a reserved id (`isReservedPersonOnly`) never `agent: true`, and a scope only `"self"`, only on an agent action. A
 * problem throws one line with its fix.
 *
 * @example
 * const mediaTileAx = defineComponentAx({
 *   component: "MediaTile",
 *   reads: [{ id: "participant", summary: "Who is in the tile, and their state.", fields: ["name", "muted", "camera", "speaking", "handRaised", "connection"], consent: "none" }],
 *   actions: [{ id: "pin", summary: "Keep this tile in the person's main view.", effect: "private", agent: true }],
 * });
 * const theirs = "You can't turn on the person's microphone, camera or screen; only they can.";
 * const callControlsAx = defineComponentAx({
 *   component: "CallControls",
 *   reads: [],
 *   actions: [
 *     { id: "mute", summary: "Mute the person's microphone.", effect: "others", agent: true },
 *     { id: "leave", summary: "Leave the call.", effect: "others", agent: true },
 *     { id: "raise-hand", summary: "Raise the person's hand.", effect: "others", agent: true },
 *     { id: "lower-hand", summary: "Lower the person's hand.", effect: "others", agent: true },
 *     { id: "unmute", summary: "Turn the person's microphone on.", effect: "others", personOnly: theirs },
 *     { id: "camera", summary: "Turn the person's camera on.", effect: "others", personOnly: theirs },
 *     { id: "share", summary: "Share the person's screen.", effect: "others", personOnly: theirs },
 *     { id: "captions", summary: "Turn captions on.", effect: "private", personOnly: "You can't turn the person's captions on or off; only they can." },
 *   ],
 * });
 *
 * @claim "never both or neither" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::an action is agent or person-only, exactly one, and every problem throws one line with its fix)
 */
function defineComponentAx(def: { component: string; reads: readonly AxRead[]; actions: readonly AxAction[] }): ComponentAx {
  const name = def.component;
  const fail = (thing: string, problem: string, fix: string) => new Error(`${name}${thing ? ` ${thing}` : ""}: ${problem}. Fix: ${fix}.`);
  if (!oneLine(name)) throw fail("", "the component has no name", 'component: "<the component\'s export name>"');
  const reads = new Set<string>();
  for (const r of def.reads) {
    if (!oneLine(r.id)) throw fail("read", "a read has no id", 'id: "<what the agent reads, in a word>"');
    const thing = `read "${r.id}"`;
    if (reads.has(r.id)) throw fail(thing, "the id is used twice", "give each read its own id");
    reads.add(r.id);
    if (!Array.isArray(r.fields) || r.fields.length === 0 || !r.fields.every(oneLine)) throw fail(thing, "it lists no fields", 'fields: ["<a field its twin\'s --json carries>"]');
    if (!(READ_CONSENTS as readonly unknown[]).includes(r.consent)) throw fail(thing, `consent is ${JSON.stringify(r.consent)}`, 'consent: "none", or "listening" for what people say');
    const spoken = r.fields.find((f) => SPEECH_FIELDS.test(f));
    if (r.consent === "none" && spoken !== undefined && r.notSpeech === undefined) throw fail(thing, `field "${spoken}" carries what people say, and the read declares consent "none"`, 'consent: "listening", or notSpeech: "<why this field is not speech>"');
    if (r.notSpeech !== undefined && !oneLine(r.notSpeech)) throw fail(thing, "notSpeech needs a one-line reason", 'notSpeech: "<why this field is not speech>"');
    if (r.push !== undefined && r.push !== "filtered") throw fail(thing, `push is ${JSON.stringify(r.push)}`, 'push: "filtered", or leave it out');
  }
  const ids = new Set<string>();
  for (const a of def.actions) {
    if (!oneLine(a.id)) throw fail("action", "an action has no id", 'id: "<the action, in a word>"');
    const thing = `action "${a.id}"`;
    if (ids.has(a.id)) throw fail(thing, "the id is used twice", "give each action its own id");
    ids.add(a.id);
    if (a.effect !== "private" && a.effect !== "others") throw fail(thing, `effect is ${JSON.stringify(a.effect)}`, 'effect: "private" or "others"');
    const raw = a as { agent?: unknown; personOnly?: unknown };
    if (raw.agent !== undefined && raw.personOnly !== undefined) throw fail(thing, "it says both agent and personOnly", "keep one: agent: true, or personOnly with its reason");
    if (raw.personOnly !== undefined && !oneLine(raw.personOnly)) throw fail(thing, "personOnly needs a one-line reason", 'personOnly: "You can\'t <do it> for the person; only they can."');
    if (raw.personOnly === undefined && raw.agent !== true) throw fail(thing, "it says neither agent: true nor personOnly", 'add agent: true, or personOnly: "You can\'t <do it> for the person; only they can."');
    const scope = (a as { scope?: unknown }).scope;
    if (scope !== undefined && scope !== "self") throw fail(thing, `scope is ${JSON.stringify(scope)}`, 'scope: "self", for an action an agent takes only on its own item, or leave it out');
    if (scope !== undefined && raw.agent !== true) throw fail(thing, "it is the person's, so it has no scope", "drop scope, which is for an agent action");
    if (raw.agent === true && isReservedPersonOnly(a.id)) throw fail(thing, "it is the person's own, so it is never an agent action", `personOnly: ${JSON.stringify(RESERVED_PERSON_ONLY[reservedAs(a.id)!])}`);
  }
  return Object.freeze({ component: name, reads: Object.freeze([...def.reads]), actions: Object.freeze([...def.actions]) });
}

/**
 * Binds a component's twins to the app's commands and returns its entries for the X-ray inventory (`ui`). It throws when
 * a read or an agent action has no twin, a read with `push: "filtered"` has no stream, a person-only action is given a
 * twin or has no `refuseAs` words, `refuseAs` names an action that is not person-only, a `scope: "self"` action's twin
 * does not say who is calling (`--agent <me>`), or a binding names nothing the component declares. A scoped action's
 * entry carries its scope.
 *
 * @example
 * const ui = [
 *   ...bindAx(mediaTileAx, { reads: { participant: "call participants <meeting>" }, actions: { pin: "call pin <participant>" } }),
 *   ...bindAx(callControlsAx, {
 *     actions: { mute: "call mute <meeting>", leave: "call leave <meeting>", "raise-hand": "call raise-hand <meeting>", "lower-hand": "call lower-hand <meeting>" },
 *     refuseAs: { unmute: "call unmute", camera: "call camera", share: "call share", captions: "call captions on" },
 *   }),
 * ];
 * writeFileSync("inventory.json", JSON.stringify({ cli: commandNames, ui }));
 *
 * @claim "a person-only action is given a twin" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::bindAx needs a twin for every read and agent action, refuses one for a person-only action, and returns the inventory entries)
 * @claim "does not say who is calling" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::a self-scoped action is an agent's, and bindAx needs its twin to say who is calling)
 */
function bindAx(ax: ComponentAx, bindings: AxBindings): UiEntry[] {
  const fail = (thing: string, problem: string, fix: string) => new Error(`${ax.component} ${thing}: ${problem}. Fix: ${fix}.`);
  const reads = bindings.reads ?? {};
  const actions = bindings.actions ?? {};
  const refuseAs = bindings.refuseAs ?? {};
  for (const key of Object.keys(reads)) if (!ax.reads.some((r) => r.id === key)) throw fail(`read "${key}"`, "the component declares no such read", `bind one of ${ax.reads.map((r) => `"${r.id}"`).join(", ") || "none"}`);
  for (const key of [...Object.keys(actions), ...Object.keys(refuseAs)]) if (!ax.actions.some((a) => a.id === key)) throw fail(`action "${key}"`, "the component declares no such action", `bind one of ${ax.actions.map((a) => `"${a.id}"`).join(", ") || "none"}`);
  const entries: UiEntry[] = [];
  for (const r of ax.reads) {
    const thing = `read "${r.id}"`;
    const twin = reads[r.id];
    const read = typeof twin === "string" ? twin : twin?.read;
    if (!oneLine(read)) throw fail(thing, "it has no twin", `reads: { "${r.id}": "<the CLI read that gives ${r.fields.join(", ")}>" }`);
    const push = typeof twin === "object" ? twin.push : undefined;
    const trigger = typeof twin === "object" ? twin.trigger : undefined;
    if (r.push === "filtered" && (!oneLine(push) || !oneLine(trigger))) throw fail(thing, "it streams, but its stream or trigger is not bound", `reads: { "${r.id}": { read: "${read}", push: "<the stream asked for every line>", trigger: "<the words trigger, such as --on mention>" } }`);
    if (r.push === undefined && push !== undefined) throw fail(thing, "a stream is bound, but the read does not declare push", 'add push: "filtered" to the read');
    entries.push({ component: ax.component, kind: "read", id: r.id, twin: read, consent: r.consent, fields: [...r.fields], ...(push === undefined ? {} : { push, trigger: trigger! }) });
  }
  for (const a of ax.actions) {
    const thing = `action "${a.id}"`;
    const twin = actions[a.id];
    const words = refuseAs[a.id];
    if (a.agent) {
      if (!oneLine(twin)) throw fail(thing, "an agent action has no twin", `actions: { "${a.id}": "<the CLI command that does it>" }`);
      if (words !== undefined) throw fail(thing, "refuseAs is for a person-only action, and this one is the agent's", `bind it under actions, or make it personOnly`);
      if (a.scope === "self" && !AGENT_WORDS.test(twin)) throw fail(thing, "an agent takes it only on its own item, and its twin does not say who is calling", `actions: { "${a.id}": "${twin} --agent <me>" }`);
      entries.push({ component: ax.component, kind: "action", id: a.id, effect: a.effect, twin, ...(a.scope ? { scope: a.scope } : {}) });
    } else {
      if (twin !== undefined) throw fail(thing, "it is the person's, so it has no twin", `move "${twin}" to refuseAs, where its words refuse`);
      if (!oneLine(words)) throw fail(thing, "a person-only action needs the CLI words an agent might try, which refuse", `refuseAs: { "${a.id}": "<the CLI words an agent might try>" }`);
      entries.push({ component: ax.component, kind: "action", id: a.id, effect: a.effect, personOnly: a.personOnly, refuseAs: words });
    }
  }
  return entries;
}

/** The attribute a component renders on the control for an action it declares, holding the action's id. */
const AX_ACTION_ATTRIBUTE = "data-ax-action";

/** What `expectAxRendered` looks in: a rendered element or document. */
interface Rendered {
  querySelector(selectors: string): unknown;
}

/**
 * Asserts that a rendered component links its declaration to its controls: each declared action (or each of `ids`, for
 * a state that shows only some) is a control in `container` carrying `data-ax-action="<id>"`. It throws one line
 * naming the actions with no such control.
 *
 * @claim "each declared action (or each of `ids`" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::expectAxRendered finds each declared action's control by data-ax-action, and names the ones it misses)
 *
 * @example
 * render(<CallControls />);
 * expectAxRendered(callControlsAx, document.body);
 *
 * @claim "It throws one line naming the actions with no such control" registry/ouro/ax/component.test.mts verify:testExists(registry/ouro/ax/component.test.mts::expectAxRendered finds each declared action's control by data-ax-action, and names the ones it misses)
 */
function expectAxRendered(ax: ComponentAx, container: Rendered, options: { ids?: readonly string[] } = {}): void {
  const ids = options.ids ?? ax.actions.map((a) => a.id);
  const unknown = ids.filter((id) => !ax.actions.some((a) => a.id === id));
  if (unknown.length) throw new Error(`${ax.component}: it declares no action ${unknown.map((id) => `"${id}"`).join(", ")}. Fix: check one of ${ax.actions.map((a) => `"${a.id}"`).join(", ") || "none"}.`);
  const missing = ids.filter((id) => container.querySelector(`[${AX_ACTION_ATTRIBUTE}=${JSON.stringify(id)}]`) === null);
  if (missing.length) throw new Error(`${ax.component}: no rendered control carries ${missing.map((id) => `${AX_ACTION_ATTRIBUTE}="${id}"`).join(", ")}. Fix: render each action's control with ${AX_ACTION_ATTRIBUTE}="<its id>".`);
}
