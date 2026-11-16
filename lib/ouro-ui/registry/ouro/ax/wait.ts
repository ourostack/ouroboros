export { DEFAULT_WAIT_EXITS, formatDuration, isWait, parseDuration, validateWait, wait, WAIT_FLAGS, WAIT_STATES, WAIT_VERSION, waitExit, waitFor, waitText };
export type { AxEvent, Fresh, Wait, WaitExits, WaitFields, WaitForOptions, WaitRead, WaitState };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { ExitTable } from "./exit-codes.ts";
import type { AxRef, NextStep, Validation } from "./outcome.ts";

/**
 * A typed wait: the agent names a reference it already holds, the tool waits (polling, if it must, where the agent
 * cannot see it) until something happens or the time limit passes, and returns what happened with the cursor that
 * resumes the wait. The agent waits with one call instead of a polling loop of its own.
 */
const WAIT_VERSION = "wait/1";

/**
 * How a wait ended.
 * - `satisfied`: it happened; `events` holds what happened.
 * - `waiting`: still waiting (a stream's first line); keep reading or resume.
 * - `timed-out`: nothing happened in time; `resume` waits again from the same cursor.
 * - `gone`: what was awaited cannot happen any more (deleted, left, closed).
 */
const WAIT_STATES = Object.freeze(["satisfied", "waiting", "timed-out", "gone"] as const);
type WaitState = (typeof WAIT_STATES)[number];

/** One thing that happened, with the cursor that resumes after it. */
interface AxEvent {
  cursor: string;
  type: string;
  at: string;
  by: string;
  target: AxRef | null;
  summary: string;
  data?: Record<string, unknown>;
}

/** How current the source is, so an agent can tell "nothing happened" from "nothing was seen". */
interface Fresh {
  state: string;
  asOf: string | null;
}

/** The envelope a wait returns. */
interface Wait {
  ax: typeof WAIT_VERSION;
  /** What is awaited, in words: "a reply in Design sync". */
  for: string;
  target: AxRef | null;
  state: WaitState;
  /** When the wait started, as an ISO time. */
  since: string;
  /** When it gives up, as an ISO time; null when it waits without a limit. */
  until: string | null;
  /** Where to resume: events after this one are new. */
  cursor: string | null;
  events: AxEvent[];
  fresh: Fresh | null;
  /** The exact command that waits again from the cursor; required while the wait can go on. */
  resume: NextStep | null;
  /** Why it is gone, or anything else the agent should know about how it ended; null when there is nothing to add. */
  reason: string | null;
  /** Where an agent can subscribe instead of waiting, such as a callback URL, or null. */
  callback: string | null;
  next: NextStep[];
}

/** What {@link wait} takes. */
type WaitFields = Pick<Wait, "for" | "state" | "since"> & Partial<Omit<Wait, "ax" | "for" | "state" | "since">>;

/** Builds a wait; a `timed-out` or `waiting` wait needs `resume`, which {@link validateWait} checks. */
function wait(fields: WaitFields): Wait {
  const { for: what, state, since, target = null, until = null, cursor = null, events = [], fresh = null, resume = null, reason = null, callback = null, next = [] } = fields;
  return { ax: WAIT_VERSION, for: what, target, state, since, until, cursor, events, fresh, resume, reason, callback, next };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isStep = (v: unknown): v is NextStep => isRecord(v) && isText(v["command"]) && isText(v["why"]);

/** Whether a value is a wait of this version (its shape only). */
function isWait(v: unknown): v is Wait {
  return isRecord(v) && v["ax"] === WAIT_VERSION && (WAIT_STATES as readonly unknown[]).includes(v["state"]);
}

/** Checks a wait: one that can go on names how to resume it, and a satisfied one carries what happened. */
function validateWait(v: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isWait(v)) return { ok: false, errors: [`not a ${WAIT_VERSION} envelope: ax must be "${WAIT_VERSION}" and state one of ${WAIT_STATES.join(", ")}`], warnings };
  if (!isText(v.for)) errors.push("for is empty: say what is awaited");
  if (!isText(v.since)) errors.push("since is empty");
  if (!Array.isArray(v.events)) errors.push("events is a list");
  else if (v.state === "satisfied" && v.events.length === 0) errors.push("satisfied, but no event says what happened");
  if ((v.state === "waiting" || v.state === "timed-out") && !isStep(v.resume)) errors.push(`${v.state} needs resume: the exact command that waits again from the cursor`);
  else if (v.resume !== null && !isStep(v.resume)) errors.push("resume needs a command and a why");
  if (v.state !== "gone" && v.cursor === null) warnings.push("no cursor: a resumed wait may miss or repeat events");
  if (v.fresh === null) warnings.push("no freshness: nothing seen is not the same as nothing happened");
  if (!Array.isArray(v.next) || !v.next.every(isStep)) errors.push("every next step needs a command and a why");
  return { ok: errors.length === 0, errors, warnings };
}

/** Exit code names by wait state, in the tool's table. */
type WaitExits = Readonly<Record<WaitState, string>>;

/**
 * The default: a satisfied or open wait exits `ok`; a wait that timed out or can no longer happen exits `error`.
 *
 * @claim "a wait that timed out or can no longer happen exits" registry/ouro/ax/wait.test.mts verify:testExists(registry/ouro/ax/wait.test.mts::waitExit and waitText)
 */
const DEFAULT_WAIT_EXITS: WaitExits = Object.freeze({ satisfied: "ok", waiting: "ok", "timed-out": "error", gone: "error" });

/** The exit code a wait gives, by its state's name in the tool's table. */
function waitExit(w: Wait, exits: ExitTable, names: WaitExits = DEFAULT_WAIT_EXITS): number {
  return exits.code(names[w.state]);
}

/** The wait as text: what happened (one line per event), or that nothing did, then how to resume. */
function waitText(w: Wait): string {
  const head = { satisfied: `Happened: ${w.for}.`, waiting: `Waiting for ${w.for}.`, "timed-out": `Nothing yet: ${w.for}, waited until ${w.until ?? "the limit"}.`, gone: `It can't happen any more: ${w.for}${w.reason ? `: ${w.reason.replace(/[.\s]+$/, "")}` : ""}.` }[w.state];
  const lines = [head, ...w.events.map((e) => `${e.at} ${e.by}: ${e.summary}`)];
  if (w.fresh && w.fresh.state !== "live") lines.push(`Freshness: ${w.fresh.state}${w.fresh.asOf ? ` as of ${w.fresh.asOf}` : ""}.`);
  if (w.resume) lines.push(`Resume: ${w.resume.command}  (${w.resume.why})`);
  for (const n of w.next) lines.push(`Next: ${n.command}  (${n.why})`);
  return lines.join("\n");
}

const UNITS: Readonly<Record<string, number>> = Object.freeze({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 });

/**
 * "90s", "2m", "1h", "500ms" or a bare number of seconds, as milliseconds; null when it is none of these.
 *
 * @claim "or a bare number of seconds" registry/ouro/ax/wait.test.mts verify:testExists(registry/ouro/ax/wait.test.mts::parseDuration and formatDuration read and write the same durations)
 */
function parseDuration(text: string): number | null {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/.exec(text);
  if (!m) return null;
  return Math.round(Number(m[1]) * (UNITS[m[2] ?? "s"]!));
}

/** Milliseconds as the shortest exact duration {@link parseDuration} reads back: "2m", "90s", "500ms". */
function formatDuration(ms: number): string {
  for (const unit of ["h", "m", "s"] as const) {
    const size = UNITS[unit]!;
    if (ms >= size && ms % size === 0) return `${ms / size}${unit}`;
  }
  return `${ms}ms`;
}

/**
 * The flags a wait command takes, shaped as `ax-command` flags: how long to wait and where to resume from. Spread them
 * into a command's `flags`.
 */
const WAIT_FLAGS = Object.freeze({
  timeout: { type: "string", placeholder: "<duration>", description: 'How long to wait, such as "90s" or "5m"; then it exits with a resume command.' },
  cursor: { type: "string", placeholder: "<cursor>", description: "Resume from this cursor (a wait's resume command gives it); without it, only what happens from now counts." },
} as const);

/** What one read of the source returns: the events after the cursor, the new cursor, freshness, and whether the target is gone. */
interface WaitRead {
  events: AxEvent[];
  cursor: string | null;
  fresh?: Fresh | null;
  /** Why the awaited thing cannot happen any more; null or absent while it still can. */
  gone?: string | null;
}

/** What {@link waitFor} takes. */
interface WaitForOptions {
  for: string;
  target: AxRef | null;
  /** Resume from here; null waits for what happens from now on. */
  cursor?: string | null;
  timeoutMs: number;
  /** Reads the events after a cursor; given null, it returns the current cursor (its events are ignored). */
  read(cursor: string | null): Promise<WaitRead>;
  /** Which events end the wait; by default, any. */
  match?(event: AxEvent): boolean;
  /** The command that resumes from a cursor. */
  resume(cursor: string | null): NextStep;
  /** Next steps once it is satisfied. */
  next?(events: readonly AxEvent[]): NextStep[];
  callback?: string | null;
  intervalMs?: number;
  now?(): number;
  sleep?(ms: number): Promise<void>;
  /** Stops the wait, such as when the caller hung up: it ends as `gone` with the reason "stopped". */
  signal?: AbortSignal;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Waits on a reference until a matching event, a time limit or the target is gone, reading the source as often as
 * `intervalMs` allows, and returns the typed wait. Inside the tool, so the agent makes one call instead of a loop.
 */
async function waitFor(options: WaitForOptions): Promise<Wait> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const interval = Math.max(1, options.intervalMs ?? 1000);
  const match = options.match ?? (() => true);
  const started = now();
  const deadline = started + Math.max(0, options.timeoutMs);
  const base = { for: options.for, target: options.target, since: new Date(started).toISOString(), until: new Date(deadline).toISOString(), callback: options.callback ?? null };
  let cursor = options.cursor ?? null;
  let fresh: Fresh | null = null;
  if (cursor === null) {
    const first = await options.read(null);
    cursor = first.cursor;
    fresh = first.fresh ?? null;
  }
  const stopped = () => wait({ ...base, state: "gone", cursor, fresh, reason: "stopped", next: [] });
  for (;;) {
    if (options.signal?.aborted) return stopped();
    const read = await options.read(cursor);
    cursor = read.cursor ?? cursor;
    fresh = read.fresh ?? fresh;
    if (read.gone) return wait({ ...base, state: "gone", cursor, fresh, reason: read.gone, next: options.next?.([]) ?? [] });
    const events = read.events.filter(match);
    if (events.length > 0) return wait({ ...base, state: "satisfied", cursor, fresh, events, next: options.next?.(events) ?? [] });
    const left = deadline - now();
    if (left <= 0) return wait({ ...base, state: "timed-out", cursor, fresh, resume: options.resume(cursor) });
    await sleep(Math.min(interval, left));
    if (options.signal?.aborted) return stopped();
  }
}
