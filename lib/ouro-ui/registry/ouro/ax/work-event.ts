export { actorOf, checkWorkEvent, foldWork, WORK_EVENT_VERSION, WORK_KINDS, workEventOf };
export type { WorkActor, WorkEvent, WorkFold, WorkKind };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { Effect } from "./effects.ts";
import type { AxRef, Outcome } from "./outcome.ts";

/**
 * An attributed work event: who acted and for whom, on what, why, with which receipt, when. An agent interface emits
 * them for its actions, handoffs, waits and returns, so the person sees what their agents did and a value stream can be
 * measured from it.
 */
const WORK_EVENT_VERSION = "work-event/1";

/**
 * The moments where an agent and a person meet over a piece of work: an agent acted, handed the work to the person,
 * waited (on a person or on anything else), asked for the person's attention, had it sent back, or it was finished.
 */
const WORK_KINDS = Object.freeze(["action", "handoff", "wait", "attention", "return", "done"] as const);
type WorkKind = (typeof WORK_KINDS)[number];

/**
 * One work event. `actor` is `agent:<name>`, `agent` or `person`; `onBehalfOf` names the person an agent acts for
 * (null when the person acts). `why` is the stated reason. `receipt` is the action's receipt id; `correlation` ties the
 * events of one piece of work together. `detail` carries a wait's `phase` (`start` or `end`), a return's `cause` or a
 * done's `evidence`.
 */
interface WorkEvent {
  ax: typeof WORK_EVENT_VERSION;
  id: string;
  at: string;
  kind: WorkKind;
  actor: string;
  onBehalfOf: string | null;
  target: AxRef | null;
  why: string | null;
  effect: Effect;
  receipt: string | null;
  correlation: string | null;
  verb?: string;
  detail?: Record<string, unknown>;
}

/** An actor string read as who acts: a named agent, an unnamed agent, or the person. */
type WorkActor = { kind: "agent"; name: string | null } | { kind: "person" };

/** The actor string read as who acts; anything else is null. */
function actorOf(actor: string): WorkActor | null {
  if (actor === "person") return { kind: "person" };
  if (actor === "agent") return { kind: "agent", name: null };
  const m = /^agent:([A-Za-z0-9._-]{1,64})$/.exec(actor);
  return m ? { kind: "agent", name: m[1]! } : null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const textOrNull = (v: unknown) => typeof v === "string" || v === null;

/** Whether a value is a work event; when not, the first problem and its fix, so a tool that emits events can repair them from the message alone. */
function checkWorkEvent(v: unknown): { ok: true; event: WorkEvent } | { ok: false; problem: string; fix: string } {
  const no = (problem: string, fix: string) => ({ ok: false as const, problem, fix });
  if (!isRecord(v)) return no("a work event is an object", `{ ax: "${WORK_EVENT_VERSION}", id, at, kind, actor, onBehalfOf, target, why, effect, receipt, correlation }`);
  if (v["ax"] !== WORK_EVENT_VERSION) return no(`ax is ${JSON.stringify(v["ax"])}`, `ax: "${WORK_EVENT_VERSION}"`);
  if (typeof v["id"] !== "string" || !v["id"]) return no("id is missing", 'id: "<the source row\'s id, as a string>"');
  if (typeof v["at"] !== "string" || Number.isNaN(Date.parse(v["at"]))) return no(`at is ${JSON.stringify(v["at"])}`, 'at: "<an ISO 8601 time>"');
  if (!(WORK_KINDS as readonly unknown[]).includes(v["kind"])) return no(`kind is ${JSON.stringify(v["kind"])}`, `kind: one of ${WORK_KINDS.join(", ")}`);
  const who = typeof v["actor"] === "string" ? actorOf(v["actor"]) : null;
  if (!who) return no(`actor is ${JSON.stringify(v["actor"])}`, 'actor: "agent:<name>", "agent" or "person"');
  if (who.kind === "agent" && (typeof v["onBehalfOf"] !== "string" || !v["onBehalfOf"])) return no("an agent's event names no person", 'onBehalfOf: "<the person the agent acts for>"');
  if (who.kind === "person" && v["onBehalfOf"] !== null) return no("the person acts on their own behalf", "onBehalfOf: null");
  const t = v["target"];
  if (t !== null && !(isRecord(t) && typeof t["kind"] === "string" && typeof t["id"] === "string")) return no("target is not { kind, id } or null", 'target: { kind: "conversation", id: "<id>" }');
  if (!textOrNull(v["why"])) return no("why is not text or null", "why: \"<the stated reason>\" or null");
  if (v["effect"] !== "private" && v["effect"] !== "others") return no(`effect is ${JSON.stringify(v["effect"])}`, 'effect: "private" or "others"');
  if (!textOrNull(v["receipt"])) return no("receipt is not text or null", 'receipt: "<the action\'s receipt id>" or null');
  if (!textOrNull(v["correlation"])) return no("correlation is not text or null", 'correlation: "<the id that ties this work together>" or null');
  const detail = v["detail"];
  if (v["kind"] === "wait" && !(isRecord(detail) && (detail["phase"] === "start" || detail["phase"] === "end"))) return no("a wait has no phase", 'detail: { phase: "start" } or { phase: "end" }');
  return { ok: true, event: v as unknown as WorkEvent };
}

/**
 * The work event an outcome makes: an action, attributed to the actor, with the outcome's target, effect, why and
 * receipt. A planned or refused outcome changed nothing, so it makes none.
 *
 * @claim "so it makes none" registry/ouro/ax/work-event.test.mts verify:testExists(registry/ouro/ax/work-event.test.mts::workEventOf: an action or handoff from an outcome, attributed; nothing for a plan or a refusal)
 */
function workEventOf(o: Outcome, who: { id: string; actor: string; onBehalfOf: string | null; correlation?: string | null; at?: string }): WorkEvent | null {
  if (o.state === "planned" || o.state === "refused") return null;
  return {
    ax: WORK_EVENT_VERSION,
    id: who.id,
    at: who.at ?? o.receipt?.at ?? new Date().toISOString(),
    kind: o.state === "needs-human" ? "handoff" : "action",
    actor: who.actor,
    onBehalfOf: who.onBehalfOf,
    target: o.target,
    why: o.receipt?.why ?? null,
    effect: o.effect,
    receipt: o.receipt?.id ?? null,
    correlation: who.correlation ?? null,
    verb: o.action,
    detail: { state: o.state },
  };
}

/**
 * One target's work, counted from its own events: actions, handoffs, returns, attention asked, waits and how long the
 * finished ones lasted. A figure nothing measured is null, never 0.
 *
 * @claim "is null, never 0" registry/ouro/ax/work-event.test.mts verify:testExists(registry/ouro/ax/work-event.test.mts::foldWork keeps an open wait and an open handoff apart per target; a wait end with no start counts nothing)
 */
interface WorkFold {
  target: AxRef | null;
  agents: string[];
  actions: number;
  handoffs: number;
  /** Handed to the person and not yet done or sent back. */
  openHandoff: boolean;
  returns: number;
  attention: number;
  waits: number;
  /**
   * Time spent in finished waits, from paired start and end events; null when no wait ended.
   *
   * @claim "null when no wait ended" registry/ouro/ax/work-event.test.mts verify:testExists(registry/ouro/ax/work-event.test.mts::foldWork keeps an open wait and an open handoff apart per target; a wait end with no start counts nothing)
   */
  waitedMs: number | null;
  /** A wait still open at the last event: when it started. */
  waitingSince: string | null;
  done: boolean;
  firstAt: string;
  lastAt: string;
}

/**
 * Work events folded per target, in the order each target first appears.
 *
 * @claim "in the order each target first appears" registry/ouro/ax/work-event.test.mts verify:testExists(registry/ouro/ax/work-event.test.mts::foldWork keeps an open wait and an open handoff apart per target; a wait end with no start counts nothing)
 */
function foldWork(events: readonly WorkEvent[]): WorkFold[] {
  const folds = new Map<string, WorkFold & { open: Map<string, number> }>();
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of sorted) {
    const key = e.target ? `${e.target.kind}\u0000${e.target.id}` : "";
    let f = folds.get(key);
    if (!f) {
      f = { target: e.target, agents: [], actions: 0, handoffs: 0, openHandoff: false, returns: 0, attention: 0, waits: 0, waitedMs: null, waitingSince: null, done: false, firstAt: e.at, lastAt: e.at, open: new Map() };
      folds.set(key, f);
    }
    f.lastAt = e.at;
    if (e.actor !== "person" && !f.agents.includes(e.actor)) f.agents.push(e.actor);
    if (e.kind === "action") f.actions++;
    else if (e.kind === "handoff") {
      f.handoffs++;
      f.openHandoff = true;
      f.done = false;
    } else if (e.kind === "return") {
      f.returns++;
      f.openHandoff = false;
    } else if (e.kind === "done") {
      f.done = true;
      f.openHandoff = false;
    } else if (e.kind === "attention") f.attention++;
    else if (e.detail?.["phase"] === "start") {
      f.waits++;
      f.open.set(e.actor, Date.parse(e.at));
    } else {
      const since = f.open.get(e.actor);
      if (since !== undefined) {
        f.waitedMs = (f.waitedMs ?? 0) + Math.max(0, Date.parse(e.at) - since);
        f.open.delete(e.actor);
      }
    }
  }
  return [...folds.values()].map(({ open, ...f }) => {
    const earliest = [...open.values()].sort((a, b) => a - b)[0];
    return { ...f, waitingSince: earliest === undefined ? null : new Date(earliest).toISOString() };
  });
}
