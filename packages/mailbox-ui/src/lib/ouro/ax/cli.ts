export { dispatch, isEmptyResult, printResult, quietPipes, runCli };
export type { CliIo, RunOptions };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { checksText, isChecksReport } from "./checks.ts";
import { checkOwner, flagsOf, findCommand, invocation, parse, type ArgSpec, type Cli, type CommandDef, type Input, type InputValue, type Parsed, type RunContext } from "./command.ts";
import { DRY_RUN_FLAG } from "./effects.ts";
import { AxError, errorJson, errorLine, errorMessage, isAxError, type AxErrorShape } from "./problem.ts";
import { commandManifest, helpJson, renderCommand, renderOverview, type OverviewOptions } from "./help.ts";
import { isOutcome, outcome, outcomeExit, outcomeText, type Outcome } from "./outcome.ts";
import { render } from "./output.ts";
import { terminalStyle } from "./terminal.ts";
import { isWait, waitExit, waitText } from "./wait.ts";
import { createVoice, type Voice, type VoiceMemory, type VoiceSlot } from "./voice.ts";

/**
 * The whole front door for a tool built on the kit: parse, help, run (or, on `--dry-run`, plan), print the result as
 * text or `--json`, and turn every failure into the one error line and its exit code. An outcome or a wait sets the
 * exit code from its state.
 *
 * @claim "turn every failure into" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::an error is one stderr line with the fix and its exit code; --json also prints the error shape)
 */
interface CliIo {
  /** `isTTY` says stdout is a terminal, the one place a voice line may print. */
  stdout: { write(s: string): unknown; isTTY?: boolean };
  stderr: { write(s: string): unknown };
  stdin?: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>;
}

interface RunOptions {
  overview?: OverviewOptions;
  /** Help topics that are not commands, as finished text. */
  topics?: Readonly<Record<string, string>>;
  /** The environment the voice reads `CI` from; defaults to the process's. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Keeps the last variant of a voice slot between runs, so variants rotate across runs too. */
  voiceMemory?: VoiceMemory;
}

async function readAll(stream: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array> | undefined): Promise<string> {
  if (!stream) return "";
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of stream) text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

/** Replaces the one "-" value with stdin's text; a second "-" is a usage error. */
async function withStdin(cli: Cli, cmd: CommandDef, input: Input, stdin: () => Promise<string>): Promise<Input> {
  const out: Record<string, InputValue> = { ...input };
  const stdinNames = [...(cmd.args ?? []).filter((a: ArgSpec) => a.stdin).map((a) => a.name), ...Object.entries(flagsOf(cli, cmd)).filter(([, s]) => s.stdin).map(([n]) => n)];
  const dashes = stdinNames.filter((n) => out[n] === "-");
  if (dashes.length > 1) throw new AxError({ code: "two-stdin", exit: cli.exits.code("usage"), thing: cmd.name, problem: `only one "-" (stdin) per command, and ${dashes.map((n) => n).join(" and ")} both ask for it`, fix: `${invocation(cli, cmd)} ... with the shorter text on the command line` });
  for (const n of dashes) out[n] = (await stdin()).replace(/\r?\n$/, "");
  return out;
}

/**
 * Runs a parsed command as runCli does, for a tool that reads stdin and prints errors its own way: on `--dry-run` the
 * command's plan(), refused ("no-preview") when it has none, else its run(). A self-scoped command is refused first
 * when its item is not the calling agent's (`checkOwner`). It prints nothing and reads no stdin.
 *
 * @claim "It prints nothing and reads" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::dispatch runs the plan or run() with the tool's own context, and prints nothing)
 * @claim "on `--dry-run` the command's plan()" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::dispatch runs the plan or run() with the tool's own context, and prints nothing)
 */
async function dispatch<C extends RunContext>(cli: Cli<C>, parsed: Parsed, ctx: C): Promise<unknown> {
  const cmd = parsed.command as CommandDef<unknown, C>;
  const dryRun = parsed.input[DRY_RUN_FLAG] === true;
  if (dryRun && !cmd.plan) throw new AxError({ code: "no-preview", exit: cli.exits.code("usage"), thing: `${cmd.name} --${DRY_RUN_FLAG}`, problem: "this command has no preview, so nothing was done", fix: null });
  if (!dryRun && !cmd.run) throw new AxError({ code: "not-runnable", exit: cli.exits.code("error"), thing: cmd.name, problem: "this command has no run() in its definition", fix: null });
  await checkOwner(cli, cmd, parsed.input, ctx);
  return dryRun ? cmd.plan!(parsed.input, ctx) : cmd.run!(parsed.input, ctx);
}

/** Whether a result is an empty list: an empty array, or a page (`{ items }`) whose items are empty. */
function isEmptyResult(result: unknown): boolean {
  if (Array.isArray(result)) return result.length === 0;
  const items = typeof result === "object" && result !== null ? (result as { items?: unknown }).items : undefined;
  return Array.isArray(items) && items.length === 0;
}

/**
 * Prints a command's result as runCli does and returns the exit code: an outcome by its state (a refusal or failure in
 * text is the one error line on stderr), a wait by its state, a checks report (ax-checks) by its verdict, with its text
 * styled for stdout and every check under `--verbose`, anything else as its text or `--json`, with the exit code its
 * command's `exit` names (0 when it names none). A report whose checks
 * all ran and passed may get the voice's `healthy` line. Given the
 * process's voice, a voice line may follow the text on stdout, never before it: after a done or queued outcome, an
 * empty list, or the summary command.
 *
 * @claim "never before it" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a voice line follows the fact it adds to: a done outcome, an empty list, the summary, and one celebration at most)
 * @claim "may get the voice's `healthy` line" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a command that returns a checks report prints its verdict first, styled for stdout, and exits with its code)
 * @claim "a checks report (ax-checks) by its verdict" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a command that returns a checks report prints its verdict first, styled for stdout, and exits with its code)
 */
function printResult(
  cli: Cli,
  cmd: CommandDef,
  input: Input,
  result: unknown,
  json: boolean,
  io: Pick<CliIo, "stdout" | "stderr">,
  voice?: Voice,
  env: Readonly<Record<string, string | undefined>> = processEnv(),
): number {
  const say = (slot: VoiceSlot, outcome?: Outcome) => {
    const line = json || !voice ? null : voice.line(slot, outcome);
    if (line !== null) io.stdout.write(`${line}\n`);
  };
  if (isOutcome(result)) {
    const exit = outcomeExit(result, cli.exits, cli.outcomeExits);
    if (!json && result.error && (result.state === "refused" || result.state === "failed")) io.stderr.write(`${outcomeText(result, cli.name)}\n`);
    else {
      io.stdout.write(render(result, { json, text: (o) => outcomeText(o, cli.name) }));
      if (result.state === "done" || result.state === "queued") say("done", result);
    }
    return exit;
  }
  if (isChecksReport(result)) {
    const style = terminalStyle(io.stdout, env);
    // The --verbose hint is offered only by a command that takes the flag.
    const command = "verbose" in flagsOf(cli, cmd) ? { command: invocation(cli, cmd) } : {};
    io.stdout.write(render(result, { json, text: (r) => checksText(r, style, { ...command, verbose: input["verbose"] === true }) }));
    if (result.verdict === "passed" && result.counts.passed && !result.counts.skipped) say("healthy");
    return result.exitCode;
  }
  const own = cmd.text;
  const text = own ? (r: unknown) => own.call(cmd, r, input) : isWait(result) ? () => waitText(result) : undefined;
  const exit = isWait(result) ? waitExit(result, cli.exits, cli.waitExits) : dataExit(cli, cmd, result, input);
  io.stdout.write(render(result, { json, ...(text ? { text } : {}) }));
  if (isWait(result)) return exit;
  if (isEmptyResult(result)) say("empty");
  else if (cmd.summarizes) say("summary");
  return exit;
}

/**
 * The exit code a data result's command names in the tool's table, or 0 when it names none.
 *
 * @claim "or 0 when it names none" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a data result exits with the code its command names in the tool's table, and --json prints the data unchanged)
 */
function dataExit(cli: Cli, cmd: CommandDef, result: unknown, input: Input): number {
  if (!cmd.exit) return 0;
  const name = cmd.exit(result, input);
  if (!cli.exits.has(name)) throw new AxError({ code: "bad-exit", exit: cli.exits.code("error"), thing: cmd.name, problem: `its exit "${name}" is not one of the tool's exit codes`, fix: `name one of ${cli.exits.codes.map((code) => code.name).join(", ")}` });
  return cli.exits.code(name);
}

/** The process's environment, read without Node's types so the kit also type-checks without them. */
// Node always has a process; the fallback is for a runtime without one.
/* node:coverage ignore next */
const processEnv = (): Readonly<Record<string, string | undefined>> => (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

async function runCli(cli: Cli, argv: readonly string[], io: CliIo, options: RunOptions = {}): Promise<number> {
  let json = argv.includes("--json");
  try {
    const parsed = parse(cli, argv);
    json = parsed.json;
    const voice = createVoice(cli.voice, {
      tty: io.stdout.isTTY === true,
      json,
      quiet: parsed.kind === "run" ? parsed.input["quiet"] === true : argv.includes("--quiet"),
      env: options.env ?? processEnv(),
      ...(options.voiceMemory ? { memory: options.voiceMemory } : {}),
    });
    if (parsed.kind === "help") {
      const topic = parsed.topic;
      if (topic === undefined) {
        if (parsed.json) io.stdout.write(`${JSON.stringify(helpJson(cli), null, 2)}\n`);
        else {
          const banner = voice.line("banner");
          io.stdout.write(`${banner === null ? "" : `${banner}\n`}${renderOverview(cli, options.overview)}`);
        }
        return 0;
      }
      const found = parsed.command ? { command: parsed.command } : cli.single ? null : findCommand(cli, topic.split(" "));
      if (found) {
        io.stdout.write(parsed.json ? `${JSON.stringify(commandManifest(cli, found.command), null, 2)}\n` : renderCommand(cli, found.command));
        return 0;
      }
      if (Object.hasOwn(cli.personOnly, topic)) {
        const p = cli.personOnly[topic]!;
        io.stdout.write(parsed.json ? `${JSON.stringify({ name: topic, reason: p.reason, how: p.how }, null, 2)}\n` : `${cli.name} ${topic}: only the person does this, never you.\n  Why: ${p.reason}\n  How the person does it: ${p.how}\n`);
        return 0;
      }
      const text = options.topics && Object.hasOwn(options.topics, topic) ? options.topics[topic] : undefined;
      if (text !== undefined) {
        io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
        return 0;
      }
      throw new AxError({ code: "unknown-topic", exit: cli.exits.code("usage"), thing: "help", problem: `there is no help for "${topic}"`, fix: `${cli.name} --help` });
    }
    const cmd = parsed.command;
    let taken = false;
    const stdin = async () => {
      if (taken) throw new AxError({ code: "two-stdin", exit: cli.exits.code("usage"), thing: cmd.name, problem: 'stdin was already read; only one "-" per command', fix: null });
      taken = true;
      return readAll(io.stdin);
    };
    const input = await withStdin(cli, cmd, parsed.input, stdin);
    const result = await dispatch(cli, { ...parsed, input }, { stdin, json });
    return printResult(cli, cmd, input, result, json, io, voice, options.env ?? processEnv());
  } catch (e) {
    const shape: AxErrorShape = isAxError(e) ? e.shape : { code: "error", exit: cli.exits.code("error"), thing: cli.name, problem: e instanceof Error ? e.message : String(e), fix: null };
    io.stderr.write(`${errorLine(cli.name, shape)}\n`);
    // A person-only word, or another agent's item, is a refusal of an action, so --json answers with its outcome, which
    // carries the same error.
    if (json) io.stdout.write(`${JSON.stringify(shape.code === "person-only" || shape.code === "not-yours" ? outcome({ action: shape.thing, state: "refused", summary: errorMessage(shape), error: shape }) : errorJson(shape), null, 2)}\n`);
    return shape.exit;
  }
}

/** A stream that reports its errors as events, as Node's process.stdout and process.stderr do. */
interface ErrorEvents {
  on(event: "error", listener: (error: { code?: string }) => void): unknown;
}

/**
 * Ends the tool quietly when whatever reads its output goes away, as in `tool help | head -1`: on `EPIPE` it exits with
 * the exit code so far (0 when none was set) and prints nothing, instead of a stack trace. Call it once in the tool's
 * bin, before runCli: `quietPipes(process)`. Any other stream error is thrown as before.
 *
 * @claim "prints nothing, instead of a stack trace" registry/ouro/ax/cli.test.mts verify:testExists(registry/ouro/ax/cli.test.mts::a closed pipe ends the tool quietly with the exit code so far, and any other stream error still throws)
 */
function quietPipes(proc: { stdout: ErrorEvents; stderr: ErrorEvents; exitCode?: number | string | null | undefined; exit(code?: number): unknown }): void {
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on("error", (error) => {
      if (error.code !== "EPIPE") throw error;
      proc.exit(typeof proc.exitCode === "number" ? proc.exitCode : 0);
    });
  }
}
