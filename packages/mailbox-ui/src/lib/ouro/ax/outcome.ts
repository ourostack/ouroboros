export { DEFAULT_OUTCOME_EXITS, isGenericAudience, isOutcome, nextStep, OUTCOME_STATES, OUTCOME_VERSION, outcome, outcomeExit, outcomeText, validateOutcome };
export type { AxRef, NextStep, Outcome, OutcomeExits, OutcomeFields, OutcomeHuman, OutcomeState, Postcondition, Receipt, Validation };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { ONLY_YOU, type Audience, type Effect } from "./effects.ts";
import { errorLine, errorMessage, type AxErrorBody, type AxErrorShape } from "./problem.ts";
import type { ExitTable } from "./exit-codes.ts";

/**
 * The outcome of an action: what became of it, who can see it, whether that was checked, how to find it again and what
 * to run next, in one shape over a CLI's `--json`, an HTTP route and an MCP tool.
 */
const OUTCOME_VERSION = "outcome/1";

/**
 * What became of an action.
 * - `done`: it happened; the postcondition says how that is known.
 * - `queued`: accepted, not performed yet; `receipt.id` and `next` follow it.
 * - `planned`: a dry run; nothing happened.
 * - `needs-human`: only a person can take the next step; `human` says why and how to resume.
 * - `uncertain`: it may or may not have happened; reconcile before any retry.
 * - `refused`: checked and not done, with the reason; nothing happened.
 * - `failed`: tried and proven not done.
 */
const OUTCOME_STATES = Object.freeze(["done", "queued", "planned", "needs-human", "uncertain", "refused", "failed"] as const);
type OutcomeState = (typeof OUTCOME_STATES)[number];

/** A thing an agent holds a reference to: a conversation, a message, a meeting, a request. `id` is what the tool takes back. */
interface AxRef {
  kind: string;
  id: string;
  name?: string;
}

/**
 * The check that the effect holds, made apart from the transport's answer. `holds` is null while the effect cannot be
 * observed yet; `how` names what was read.
 */
interface Postcondition {
  checked: boolean;
  holds: boolean | null;
  how: string;
}

/** A durable record of the request: the id that finds it again, when, by whom and why. */
interface Receipt {
  id: string;
  at: string;
  by: string;
  why: string | null;
}

/** One next valid action: an exact command an agent can run, and why it would. */
interface NextStep {
  command: string;
  why: string;
  /**
   * The step only works in a source checkout (a repository script, say), and the tool shows it only there. Without
   * it, a step may not ask for a developer command or a repository path (ax-dev-commands), since an agent passes it
   * on to a person who has the installed tool.
   */
  sourceCheckout?: true;
}

/** Why only a person can go on, and the step that resumes once they have. */
interface OutcomeHuman {
  reason: string;
  resume: NextStep;
}

/** The envelope an action returns. */
interface Outcome {
  ax: typeof OUTCOME_VERSION;
  action: string;
  effect: Effect;
  audience: Audience;
  target: AxRef | null;
  state: OutcomeState;
  summary: string;
  postcondition: Postcondition;
  receipt: Receipt | null;
  next: NextStep[];
  error?: AxErrorBody;
  human?: OutcomeHuman;
}

/** Problems that make an envelope untrustworthy are errors; honest gaps are warnings. */
interface Validation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** An exact next step. */
function nextStep(command: string, why: string): NextStep {
  return { command, why };
}

/** What {@link outcome} takes: the action, its state and summary, and whatever else is known. */
type OutcomeFields = Pick<Outcome, "action" | "state" | "summary"> & {
  effect?: Effect;
  audience?: Audience;
  target?: AxRef | null;
  postcondition?: Postcondition;
  receipt?: Receipt | null;
  next?: NextStep[];
  error?: AxErrorShape;
  human?: OutcomeHuman;
};

/**
 * Builds an outcome with honest defaults: private, only you, nothing checked, no receipt and no next steps. Pass what is
 * known; {@link validateOutcome} says what is missing.
 *
 * @example
 * outcome({ action: "message.send", effect: "others", audience: { only: false, who: 'everyone in "Design sync"' },
 *   state: "queued", summary: 'Queued for "Design sync".',
 *   receipt: { id: "a1b2c3", at: new Date().toISOString(), by: "agent:planner", why: "Jo asked" },
 *   next: [nextStep("tool outcome a1b2c3 --timeout 60s", "wait until it is sent")] });
 *
 * @claim "Builds an outcome with honest defaults" registry/ouro/ax/outcome.test.mts verify:testExists(registry/ouro/ax/outcome.test.mts::outcome fills honest defaults: private, only you, nothing checked, no receipt; an error gets its message)
 */
function outcome(fields: OutcomeFields): Outcome {
  const { action, state, summary, effect = "private", audience = ONLY_YOU, target = null, postcondition, receipt = null, next = [], error, human } = fields;
  return {
    ax: OUTCOME_VERSION,
    action,
    effect,
    audience: { ...audience },
    target,
    state,
    summary,
    postcondition: postcondition ?? { checked: false, holds: null, how: "not checked" },
    receipt,
    next,
    ...(error ? { error: { ...error, message: errorMessage(error) } } : {}),
    ...(human ? { human } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStep = (v: unknown): v is NextStep => isRecord(v) && isText(v["command"]) && isText(v["why"]);

/**
 * Whether an audience's `who` names no one in particular ("other people", "someone", "everyone"), so an agent reading
 * the JSON learns less than one reading the text.
 *
 * @claim "names no one in particular" registry/ouro/ax/outcome.test.mts verify:testExists(registry/ouro/ax/outcome.test.mts::an action for other people that names no one is warned about)
 */
function isGenericAudience(who: string): boolean {
  return /^(?:other people|others|people|someone|somebody|anyone|anybody|everyone|everybody|the audience|recipients|users?)\.?$/i.test(who.trim());
}

/** Whether a value is an outcome of this version (its shape only; {@link validateOutcome} checks its meaning). */
function isOutcome(v: unknown): v is Outcome {
  return isRecord(v) && v["ax"] === OUTCOME_VERSION && (OUTCOME_STATES as readonly unknown[]).includes(v["state"]);
}

/**
 * Checks an outcome's meaning, not only its shape:
 * - `done` never rests on a postcondition that failed; one not checked is a warning.
 * - `refused` and `failed` carry an error and never claim the effect holds.
 * - `queued` and `uncertain` carry a receipt and a next step, and `uncertain` cannot claim to know.
 * - an effect other people see carries a receipt with a why, unless nothing happened, and an audience that is not only you.
 * - `needs-human` carries the reason and the step that resumes.
 * - a next step is an exact command with its why.
 *
 * @claim "never claim the effect holds" registry/ouro/ax/outcome.test.mts verify:testExists(registry/ouro/ax/outcome.test.mts::the rules: done, queued, uncertain, refused, failed, needs-human, planned and effects other people see)
 */
function validateOutcome(v: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isOutcome(v)) return { ok: false, errors: [`not an ${OUTCOME_VERSION} envelope: ax must be "${OUTCOME_VERSION}" and state one of ${OUTCOME_STATES.join(", ")}`], warnings };
  if (!isText(v.action)) errors.push("action is empty");
  if (v.effect !== "private" && v.effect !== "others") errors.push('effect is "private" or "others"');
  if (!isRecord(v.audience) || typeof v.audience.only !== "boolean" || !isText(v.audience.who)) errors.push("audience needs only (true or false) and who (words)");
  else if (v.effect === "others" && v.audience.only) errors.push("an effect other people see cannot have an audience of only you");
  else if (v.effect === "others" && isGenericAudience(v.audience.who)) warnings.push(`audience.who is "${v.audience.who}", which names no one: say who will see it, as the text does (everyone in "Design sync", Jo Park)`);
  if (v.target !== null && !(isRecord(v.target) && isText(v.target.kind) && isText(v.target.id))) errors.push("target is null or { kind, id }");
  if (!isText(v.summary)) errors.push("summary is empty");
  const p: unknown = v.postcondition;
  const pOk = isRecord(p) && typeof p["checked"] === "boolean" && (p["holds"] === null || typeof p["holds"] === "boolean") && isText(p["how"]);
  if (!pOk) errors.push("postcondition needs checked, holds (true, false or null) and how");
  const holds = pOk ? p["holds"] : null;
  if (!Array.isArray(v.next) || !v.next.every(isStep)) errors.push("every next step needs a command and a why");
  const r: unknown = v.receipt;
  const rOk = r === null || (isRecord(r) && isText(r["id"]) && isText(r["at"]) && isText(r["by"]) && (r["why"] === null || typeof r["why"] === "string"));
  if (!rOk) errors.push("receipt needs id, at, by and why (or null)");
  const why = rOk && r !== null ? r["why"] : null;
  const hasReceipt = rOk && r !== null;
  const hasNext = Array.isArray(v.next) && v.next.length > 0;
  const e: unknown = v.error;
  const hasError = isRecord(e) && isText(e["code"]) && isText(e["message"]);
  if (e !== undefined && !hasError) errors.push("error needs a code and a message");
  switch (v.state) {
    case "done":
      if (holds === false) errors.push("done, but the postcondition does not hold");
      if (pOk && p["checked"] === false) warnings.push("done without an independent check: say what it rests on in postcondition.how");
      if (hasError) errors.push("done carries an error");
      break;
    case "queued":
    case "uncertain":
      if (!hasReceipt) errors.push(`${v.state} needs a receipt, so the request can be found again`);
      if (!hasNext) errors.push(`${v.state} needs a next step`);
      if (v.state === "uncertain" && holds !== null) errors.push("uncertain, but the postcondition claims to know");
      break;
    case "refused":
    case "failed":
      if (!hasError) errors.push(`${v.state} needs an error with a code and a message`);
      if (holds === true) errors.push(`${v.state}, but the postcondition says the effect holds`);
      if (!hasNext && !(hasError && isRecord(e) && isText(e["fix"]))) warnings.push(`${v.state} without a next step or a fix: say what to do instead`);
      break;
    case "needs-human":
      if (!isRecord(v.human) || !isText(v.human.reason) || !isStep(v.human.resume)) errors.push("needs-human needs human.reason and human.resume");
      break;
    case "planned":
      if (holds === true) errors.push("planned, but the postcondition says the effect holds");
      break;
  }
  if (v.effect === "others" && (v.state === "done" || v.state === "queued" || v.state === "uncertain") && !isText(why)) errors.push("an effect other people see needs a receipt with a why");
  return { ok: errors.length === 0, errors, warnings };
}

/** Exit code names by outcome state, in the tool's table. */
type OutcomeExits = Readonly<Record<OutcomeState, string>>;

/**
 * The default: what was done, queued, planned or handed to the person exits `ok` (the outcome says which); a refusal
 * exits `usage`; a failure or an uncertain result exits `error`. A tool with its own codes (such as "possibly done")
 * passes its own names.
 */
const DEFAULT_OUTCOME_EXITS: OutcomeExits = Object.freeze({ done: "ok", queued: "ok", planned: "ok", "needs-human": "ok", uncertain: "error", refused: "usage", failed: "error" });

/** The exit code an outcome gives: a refusal's or failure's own error exit, else its state's name in the table. */
function outcomeExit(o: Outcome, exits: ExitTable, names: OutcomeExits = DEFAULT_OUTCOME_EXITS): number {
  if ((o.state === "refused" || o.state === "failed") && o.error) return o.error.exit;
  return exits.code(names[o.state]);
}

/**
 * The outcome as text for a person: the summary, what was checked (or why it is not checked yet), what only the person
 * can do, then the next steps.
 * A refusal or failure with an error is the one error line, as every Ouro AX error is.
 *
 * @claim "as every Ouro AX error is" registry/ouro/ax/outcome.test.mts verify:testExists(registry/ouro/ax/outcome.test.mts::outcomeText: the summary, the check, the receipt, the person's step and the next steps; a refusal is its error line)
 */
function outcomeText(o: Outcome, tool: string): string {
  if ((o.state === "refused" || o.state === "failed") && o.error) return errorLine(tool, o.error);
  const lines = [o.summary];
  const how = o.postcondition.how.replace(/[.\s]+$/, "");
  if (o.postcondition.checked && o.postcondition.holds !== null) lines.push(`Checked: ${how}${o.postcondition.holds === false ? " (it does not hold)" : ""}.`);
  else if (how !== "not checked") lines.push(`Not checked yet: ${how}.`);
  if (o.receipt) lines.push(`Receipt: ${o.receipt.id}`);
  if (o.human) lines.push(`Needs the person: ${o.human.reason.replace(/[.\s]+$/, "")}. Then: ${o.human.resume.command}`);
  for (const n of o.next) lines.push(`Next: ${n.command}  (${n.why})`);
  return lines.join("\n");
}
