export { createProgress, FRAMES, hasAnsi, markOf, MARKS, nextStepsText, paint, stripAnsi, terminalStyle, timeText };
export type { Mark, Paint, Progress, ProgressOptions, ProgressStream, TerminalStyle, Timers };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { NextStep } from "./outcome.ts";
import { isCi } from "./voice.ts";

/**
 * What a terminal shows a person, with a plain fallback off a terminal: colour, status marks, the time something
 * took, next steps and a progress line for anything slow. Colour is on only for a terminal; `NO_COLOR` always turns it
 * off, and `FORCE_COLOR` turns it on for a capture. Off a terminal, the marks are words and nothing is redrawn, so a pipe,
 * a log or an agent gets plain text with no escape codes.
 *
 * @claim "`NO_COLOR` always turns it off" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::colour only on a terminal: NO_COLOR always wins, FORCE_COLOR turns it on for a capture, TERM=dumb and CI are no terminal)
 * @claim "nothing is redrawn" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::off a terminal, progress is one plain line for a step still running after the slow mark, and no escape codes)
 */
interface TerminalStyle {
  /** The stream is a terminal a person is looking at: `TERM` is not `dumb`, and `CI` is not set. */
  tty: boolean;
  /** ANSI colour is on. */
  color: boolean;
  /** Status marks are symbols (✓ ✗ ! ○ ·); otherwise they are words (ok, FAIL, warn, skip, plan). */
  symbols: boolean;
}

/** A variable is set to something other than "", "0" or "false". */
const truthy = (value: string | undefined) => value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());

/**
 * The style for one stream: a terminal gets colour and symbols; a pipe, or a terminal in CI (the `CI` variable set),
 * gets words and no colour. `NO_COLOR` (set and not empty) always turns colour off, and `FORCE_COLOR` or
 * `CLICOLOR_FORCE` turns colour and symbols on off a terminal and in CI, for a screenshot or a capture.
 *
 * @claim "gets words and no colour" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::colour only on a terminal: NO_COLOR always wins, FORCE_COLOR turns it on for a capture, TERM=dumb and CI are no terminal)
 * @claim "always turns colour off" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::colour only on a terminal: NO_COLOR always wins, FORCE_COLOR turns it on for a capture, TERM=dumb and CI are no terminal)
 */
function terminalStyle(stream: { isTTY?: boolean }, env: Readonly<Record<string, string | undefined>>): TerminalStyle {
  const tty = stream.isTTY === true && env["TERM"] !== "dumb" && !isCi(env);
  const forced = truthy(env["FORCE_COLOR"]) || truthy(env["CLICOLOR_FORCE"]);
  const noColor = (env["NO_COLOR"] ?? "") !== "";
  return { tty, color: !noColor && (tty || forced), symbols: tty || forced };
}

type Paint = Record<"bold" | "dim" | "red" | "green" | "yellow" | "cyan", (text: string) => string>;

const CODES: Readonly<Record<keyof Paint, string>> = Object.freeze({ bold: "1", dim: "2", red: "31", green: "32", yellow: "33", cyan: "36" });

/**
 * The colours, as functions that wrap text in their escape codes when the style has colour, and return it unchanged
 * when it doesn't.
 *
 * @claim "return it unchanged when it doesn't" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::paint wraps text in escape codes only with colour, and stripAnsi takes them out)
 */
function paint(style: Pick<TerminalStyle, "color">): Paint {
  const wrap = (code: string) => (text: string) => (style.color && text !== "" ? `\x1b[${code}m${text}\x1b[0m` : text);
  return Object.fromEntries(Object.entries(CODES).map(([name, code]) => [name, wrap(code)])) as Paint;
}

// The escape is built from its code so the pattern holds no control character.
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^\\u0007]*\\u0007`, "g");

/** The text with its ANSI escape sequences taken out. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Whether text holds an escape character: what the X-ray looks for in piped output.
 *
 * @claim "what the X-ray looks for in piped output" registry/ouro/ax/xray.ts verify:fileLine(registry/ouro/ax/xray.ts, /hasAnsi\(/)
 */
function hasAnsi(text: string): boolean {
  return text.includes(ESC);
}

type Mark = "passed" | "failed" | "errored" | "warned" | "skipped" | "planned";

/** A state's mark, as a symbol on a terminal and as a word elsewhere, and its colour. */
const MARKS: Readonly<Record<Mark, { symbol: string; word: string; color: keyof Paint }>> = Object.freeze({
  passed: { symbol: "✓", word: "ok", color: "green" },
  failed: { symbol: "✗", word: "FAIL", color: "red" },
  errored: { symbol: "⊘", word: "ERROR", color: "red" },
  warned: { symbol: "!", word: "warn", color: "yellow" },
  skipped: { symbol: "○", word: "skip", color: "dim" },
  planned: { symbol: "·", word: "plan", color: "dim" },
});

/**
 * A state's mark: its symbol in its colour on a terminal, else its word, so a reader without colour still tells a
 * failure from a pass.
 *
 * @claim "still tells a failure from a pass" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::a mark is a coloured symbol on a terminal and a word elsewhere)
 */
function markOf(state: Mark, style: TerminalStyle): string {
  const mark = MARKS[state];
  return paint(style)[mark.color](style.symbols ? mark.symbol : mark.word);
}

/**
 * How long something took, for a person: tenths of a second under a minute (`0.4s`, `14.2s`), then minutes and seconds
 * (`1m 05s`).
 *
 * @claim "tenths of a second under a minute" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::timeText gives tenths of a second under a minute, then minutes and seconds)
 */
function timeText(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The next steps, under a `Next` heading: each step's reason, then its command on the line below, indented and alone,
 * so it can be copied whole. An empty string for an empty list.
 *
 * @claim "so it can be copied whole" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::next steps put each command alone on its line, under its reason)
 */
function nextStepsText(steps: readonly NextStep[], style: TerminalStyle): string {
  if (!steps.length) return "";
  const p = paint(style);
  return [p.bold("Next"), ...steps.flatMap((s) => [`  ${s.why}`, `    ${p.cyan(s.command)}`])].join("\n");
}

/** The clock and timers progress uses; tests pass held ones. */
interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

/** Where progress goes: stderr, so stdout keeps only the result. */
interface ProgressStream {
  write(text: string): unknown;
  isTTY?: boolean;
}

interface ProgressOptions {
  env: Readonly<Record<string, string | undefined>>;
  /** Turn progress off, as under `--json` or `--quiet`. */
  off?: boolean;
  /**
   * A step running this long gets a plain line off a terminal, 2000 by default.
   *
   * @claim "2000 by default" registry/ouro/ax/terminal.ts verify:fileLine(registry/ouro/ax/terminal.ts, /options\.slowMs \?\? 2000/)
   */
  slowMs?: number;
  /**
   * The spinner waits this long before it draws, so a fast step never flickers, 150 by default.
   *
   * @claim "so a fast step never flickers" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::on a terminal, the spinner draws after the delay, redraws in place, and is wiped on stop)
   * @claim "150 by default" registry/ouro/ax/terminal.ts verify:fileLine(registry/ouro/ax/terminal.ts, /options\.delayMs \?\? 150/)
   */
  delayMs?: number;
  /**
   * Between spinner frames, 80 by default.
   *
   * @claim "80 by default" registry/ouro/ax/terminal.ts verify:fileLine(registry/ouro/ax/terminal.ts, /options\.frameMs \?\? 80/)
   */
  frameMs?: number;
  timers?: Timers;
}

/** One running step: start it, then stop it when it ends. */
interface Progress {
  /** Shows that `label` is running; `at` is its place, as in "4 of 12". Starting a step stops the last. */
  start(label: string, at?: { index: number; total: number }): void;
  /** Takes the progress line away, leaving the stream as it was. */
  stop(): void;
}

/** The spinner's frames, on a terminal. */
const FRAMES = Object.freeze(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);

const realTimers = (): Timers => ({
  now: () => Date.now(),
  setTimeout: (fn, ms) => unref(setTimeout(fn, ms)),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => unref(setInterval(fn, ms)),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
});
/** A progress timer is unref'd, so the process can exit while one is set. */
const unref = <T,>(h: T): T => ((h as { unref?: () => void }).unref?.(), h);

/**
 * Progress for anything slow, on stderr. On a terminal, a spinner line with the step, its place and the time so far,
 * drawn only once a step has run past a short delay, redrawn in place and wiped when it ends, with spaces rather than
 * escape codes. Off a terminal or in CI, one plain line for a step still running after the slow mark, and nothing
 * else. With `off`, nothing.
 *
 * @claim "wiped when it ends" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::on a terminal, the spinner draws after the delay, redraws in place, and is wiped on stop)
 * @claim "one plain line for a step still running" registry/ouro/ax/terminal.test.mts verify:testExists(registry/ouro/ax/terminal.test.mts::off a terminal, progress is one plain line for a step still running after the slow mark, and no escape codes)
 */
function createProgress(stream: ProgressStream, options: ProgressOptions): Progress {
  const timers = options.timers ?? realTimers();
  const style = terminalStyle(stream, options.env);
  const spinner = style.tty;
  const slowMs = options.slowMs ?? 2000;
  const delayMs = options.delayMs ?? 150;
  const frameMs = options.frameMs ?? 80;
  let timer: unknown = null;
  let frames: unknown = null;
  let drawn = 0;
  const wipe = () => {
    if (drawn) stream.write(`\r${" ".repeat(drawn)}\r`);
    drawn = 0;
  };
  const stop = () => {
    if (timer !== null) timers.clearTimeout(timer);
    if (frames !== null) timers.clearInterval(frames);
    timer = frames = null;
    wipe();
  };
  if (options.off) return { start() {}, stop() {} };
  return {
    start(label, at) {
      stop();
      const began = timers.now();
      const place = at ? `${at.index} of ${at.total}` : "";
      if (spinner) {
        let frame = 0;
        const draw = () => {
          const line = `${FRAMES[frame++ % FRAMES.length]} ${label}  ${place ? `${place} · ` : ""}${timeText(timers.now() - began)}`;
          stream.write(`\r${line}${" ".repeat(Math.max(0, drawn - line.length))}`);
          drawn = Math.max(drawn, line.length);
        };
        timer = timers.setTimeout(() => {
          timer = null;
          draw();
          frames = timers.setInterval(draw, frameMs);
        }, delayMs);
      } else {
        timer = timers.setTimeout(() => {
          timer = null;
          stream.write(`Still running: ${label}${place ? ` (${place})` : ""}, ${timeText(timers.now() - began)} so far\n`);
        }, slowMs);
      }
    },
    stop,
  };
}
