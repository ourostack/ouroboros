export { checkVoice, checkVoiceLine, createVoice, isCi, VOICE_MAX, voiceLines, voiceOn };
export type { Voice, VoiceDef, VoiceMemory, VoiceOptions, VoiceSlot };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import type { Outcome } from "./outcome.ts";

/**
 * A tool's voice: an optional line of character after the facts, for a person at a terminal, never where an agent parses.
 * The kit prints a voice line only when stdout is a terminal, not under `--json` or `--quiet`, and not when the `CI`
 * environment variable is set; never on stderr and never in an error. Each line is one line of plain ASCII, at most 72
 * characters, and comes after the fact it follows. Variants rotate, and a process celebrates (`done`) at most once.
 *
 * @claim "never on stderr and never in an error" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::the voice speaks only on a terminal: never under --json, --quiet, CI or a pipe, and never in an error)
 * @claim "Each line is one line of plain ASCII, at most 72" registry/ouro/ax/voice.ts verify:fileLine(registry/ouro/ax/voice.ts, /^const VOICE_MAX = 72;$/) verify:testExists(registry/ouro/ax/voice.test.mts::a line is one line of plain ASCII, at most 72 characters, checked when the tool is built)
 * @claim "never where an agent parses" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::the voice speaks only on a terminal: never under --json, --quiet, CI or a pipe, and never in an error)
 * @claim "a process celebrates (`done`) at most once" registry/ouro/ax/voice.test.mts verify:testExists(registry/ouro/ax/voice.test.mts::variants rotate, never the same line twice in a row, and a process celebrates once)
 */
type VoiceSlot = "banner" | "done" | "summary" | "empty" | "healthy";

interface VoiceDef {
  /** Leads the help overview. */
  banner?: readonly string[];
  /** After an action's outcome text, when it is done or queued; return [] to stay quiet for this outcome. */
  done?: (outcome: Outcome) => readonly string[];
  /** After the text of the command marked `summarizes` (the person's day, say). */
  summary?: readonly string[];
  /** After a list that came back empty, once its text has said what is empty. */
  empty?: readonly string[];
  /**
   * After a check command's report (ax-checks) when every check ran and passed.
   *
   * @claim "when every check ran and passed" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a command that returns a checks report prints its verdict first, styled for stdout, and exits with its code)
   */
  healthy?: readonly string[];
}

/**
 * The longest voice line, in characters.
 *
 * @claim "The longest voice line" registry/ouro/ax/voice.test.mts verify:testExists(registry/ouro/ax/voice.test.mts::a line is one line of plain ASCII, at most 72 characters, checked when the tool is built)
 */
const VOICE_MAX = 72;

/** What is wrong with a voice line, or null when it is one line of printable ASCII, at most {@link VOICE_MAX} characters. */
function checkVoiceLine(line: string): string | null {
  if (line.trim() === "") return "is empty";
  if (/[\r\n]/.test(line)) return "is more than one line";
  if (/[^\x20-\x7e]/.test(line)) return "is not plain ASCII (no emoji, curly quotes or tabs)";
  if (line.length > VOICE_MAX) return `is ${line.length} characters; the most is ${VOICE_MAX}`;
  return null;
}

/** Throws at definition time when a fixed voice line breaks the rules; `done` lines are checked as they are made. */
function checkVoice(tool: string, voice: VoiceDef): void {
  for (const slot of ["banner", "summary", "empty", "healthy"] as const) {
    for (const line of voice[slot] ?? []) {
      const problem = checkVoiceLine(line);
      if (problem) throw new Error(`${tool}: the voice's ${slot} line ${JSON.stringify(line)} ${problem}. Fix: one line of plain ASCII, at most ${VOICE_MAX} characters.`);
    }
  }
}

/** The fixed voice lines (banner, summary, empty and healthy), as `help --json` lists them for a checker. */
function voiceLines(voice: VoiceDef): string[] {
  return [...(voice.banner ?? []), ...(voice.summary ?? []), ...(voice.empty ?? []), ...(voice.healthy ?? [])];
}

/**
 * Whether the `CI` environment variable says this is a CI run: set, and not empty, "0" or "false".
 *
 * @claim "set, and not empty" registry/ouro/ax/voice.test.mts verify:testExists(registry/ouro/ax/voice.test.mts::voiceOn: only a terminal, without --json, --quiet or CI)
 */
function isCi(env: Readonly<Record<string, string | undefined>>): boolean {
  const ci = env["CI"];
  return ci !== undefined && !["", "0", "false"].includes(ci.trim().toLowerCase());
}

/** Remembers the variant a slot last used, so a tool that keeps it between runs rotates across runs too. */
interface VoiceMemory {
  last(slot: VoiceSlot): number | null;
  remember(slot: VoiceSlot, index: number): void;
}

interface VoiceOptions {
  /** Whether stdout is a terminal (`process.stdout.isTTY`). */
  tty: boolean;
  json: boolean;
  quiet: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /** Where the last variant is kept; by default, in this process only. */
  memory?: VoiceMemory;
  /** The variant to start from when the memory is empty; by default, from the clock. */
  start?: number;
}

/** Whether a voice line may print: stdout is a terminal, and not `--json`, `--quiet` or CI. */
function voiceOn(options: Pick<VoiceOptions, "tty" | "json" | "quiet" | "env">): boolean {
  return options.tty && !options.json && !options.quiet && !isCi(options.env);
}

interface Voice {
  readonly on: boolean;
  /** The slot's next line, or null when the voice is off, the slot is empty, a `done` line breaks the rules, or this process already celebrated. */
  line(slot: VoiceSlot, outcome?: Outcome): string | null;
}

function processMemory(): VoiceMemory {
  const seen = new Map<VoiceSlot, number>();
  return { last: (slot) => seen.get(slot) ?? null, remember: (slot, index) => void seen.set(slot, index) };
}

/** One process's voice: it rotates the variants of a slot and gives at most one `done` line. */
function createVoice(voice: VoiceDef, options: VoiceOptions): Voice {
  const on = voiceOn(options);
  const memory = options.memory ?? processMemory();
  const start = options.start ?? Math.floor(Date.now() / 1000);
  let celebrated = false;
  return {
    on,
    line(slot, outcome) {
      if (!on) return null;
      const all = slot === "done" ? (outcome && voice.done ? voice.done(outcome) : []) : (voice[slot] ?? []);
      const lines = all.filter((l) => checkVoiceLine(l) === null);
      if (!lines.length || (slot === "done" && celebrated)) return null;
      if (slot === "done") celebrated = true;
      const last = memory.last(slot);
      const index = last === null ? start % lines.length : (last + 1) % lines.length;
      memory.remember(slot, index);
      return lines[index]!;
    },
  };
}
