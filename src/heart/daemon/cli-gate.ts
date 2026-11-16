import { emitNervesEvent } from "../../nerves/runtime"
import { usage } from "./cli-parse"
import { CLI_COMMANDS, type CliCommandDeclaration } from "./cli-manifest"

// The flag and argument gate in front of the legacy dispatcher, in the Ouro AX kit's terms: an unknown flag is
// refused with the nearest real one, a command that reaches other people needs --why, and --dry-run says who
// will see it without doing it. The commands still do their own work.

const GLOBAL_FLAGS = ["--json", "--help", "--why", "--why-file", "--agent"];
const GLOBAL_VALUE_FLAGS = ["--why", "--why-file", "--agent"];

// Every flag the CLI's parser and dispatcher read: the literals in cli-parse.ts, cli-exec.ts, cli-help.ts and
// cli-defaults.ts. cli-gate-flags.test.ts fails when a literal is added or removed, so the gate never refuses a flag
// the CLI reads.
export const PARSER_FLAGS: readonly string[] = [
  "--account", "--action", "--admission", "--agent", "--alert-file", "--allow-send", "--answers", "--api-key",
  "--api-key-file", "--apply", "--args", "--await", "--backup", "--base-url", "--binding", "--cadence", "--card-url",
  "--category", "--channel", "--clone", "--clone-path", "--component", "--context", "--cooldown-minutes",
  "--credential-item", "--delegated", "--deployment", "--did", "--discover", "--dry-run", "--email", "--endpoint",
  "--event", "--event-type", "--evidence", "--exit-code", "--expires", "--external-id", "--facing", "--file",
  "--fixture", "--follow", "--force", "--foreground", "--format", "--friend", "--friend-id", "--from", "--full",
  "--generate-unlock-secret", "--github-token", "--habit", "--help", "--home", "--host", "--host-stall-observed",
  "--human", "--id", "--identity-file", "--idle-silence-ms", "--ids", "--init", "--initiative", "--input-file", "--into",
  "--item", "--json", "--keep-versions", "--key", "--keys-dir", "--lane", "--last", "--latest", "--legacy",
  "--legacy-root", "--level", "--limit", "--manifest", "--max-duration-ms", "--max-old-space-size", "--message-guid",
  "--migration-path", "--min-mem-available-mb", "--mode", "--model", "--name", "--native", "--no-chat",
  "--no-delegated-source", "--no-repair", "--no-send", "--no-wake", "--note", "--notify-session", "--oauth-token",
  "--observe-only", "--occasion", "--oom-score-adj", "--operation-id", "--output", "--output-file", "--owner-alone",
  "--owner-email", "--owner-name", "--participants", "--path", "--payload", "--persist", "--port", "--prefix", "--print",
  "--priority", "--process", "--profile", "--provider", "--public-field", "--public-url", "--question", "--reason",
  "--replay-output", "--repo-path", "--report", "--report-title", "--request-id", "--require-sense", "--reserve-mb",
  "--role", "--root", "--rotate-missing-mail-keys", "--run-id", "--scope", "--secret-field", "--secret-file", "--server",
  "--session", "--setup-token", "--silent-consent", "--since", "--socket", "--source", "--state", "--store", "--strict",
  "--summary", "--surface", "--switch", "--task", "--template", "--text", "--title", "--to", "--tool", "--trigger",
  "--trust", "--ttl-minutes", "--type", "--uid", "--unattended", "--upstream", "--username", "--value", "--value-file",
  "--verify", "--version", "--web", "--which", "--workbench-mcp", "--yes",
];

export type GateResult = { kind: "pass"; args: string[] } | { kind: "refuse"; message: string } | { kind: "preview"; text: string };

interface CommandShape {
  declaration: CliCommandDeclaration;
  words: string[];
  flags: Map<string, boolean>;
  positionals: number;
}

function usageLinesFor(name: string): string[] {
  const words = name.split(" ");
  const last = words[words.length - 1]!;
  const head = words.slice(0, -1).map((word) => `${word} `).join("");
  return usage()
    .split("\n")
    .filter((line) => {
      if (!line.startsWith(`  ouro ${head}`)) return false;
      const word = line.slice(`  ouro ${head}`.length).split(/[\s[<(]/)[0] ?? "";
      return word.split("|").includes(last);
    });
}

function shapeOf(declaration: CliCommandDeclaration): CommandShape {
  const flags = new Map<string, boolean>();
  let positionals = 0;
  for (const line of usageLinesFor(declaration.name)) {
    for (const match of line.matchAll(/(?<![\w-])(--[a-z][\w-]*)( <[^>]+>)?/g)) flags.set(match[1]!, Boolean(match[2]));
    const bare = line.replace(/\[[^\]]*\]/g, " ").replace(/(?<![\w-])--[a-z][\w-]*( <[^>]+>)?/g, " ");
    const after = bare.split(/\s+/).filter((token) => token.startsWith("<") && !token.includes("|"));
    positionals = Math.max(positionals, after.length);
  }
  return { declaration, words: declaration.name.split(" "), flags, positionals };
}

const SHAPES = CLI_COMMANDS.map(shapeOf);

function nearestFlag(flag: string, known: string[]): string | null {
  let best: { name: string; distance: number } | null = null;
  for (const candidate of known) {
    const distance = editDistance(flag, candidate);
    if (distance <= 2 && (best === null || distance < best.distance)) best = { name: candidate, distance };
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length]!;
}

function matchCommand(args: string[]): CommandShape | null {
  let best: CommandShape | null = null;
  for (const shape of SHAPES) {
    const matches = shape.words.every((word, index) => args[index] === word);
    if (matches && (best === null || shape.words.length > best.words.length)) best = shape;
  }
  return best;
}

function refuse(name: string, message: string): GateResult {
  emitNervesEvent({
    level: "warn",
    component: "daemon",
    event: "daemon.cli_flag_gate_refused",
    message: "the flag gate refused a command",
    meta: { command: name },
  });
  return { kind: "refuse", message };
}

/** Checks a command line against its declaration; a pass returns the words the legacy dispatcher should read. */
export function gateCommandArgs(args: string[]): GateResult {
  const shape = matchCommand(args);
  if (!shape) return { kind: "pass", args };
  const { declaration, words, flags } = shape;
  const name = declaration.name;
  const others = declaration.effect === "others";
  const known = [...new Set([...PARSER_FLAGS, ...GLOBAL_FLAGS, ...flags.keys()])];
  const rest = args.slice(words.length);

  for (let index = 0; index < rest.length; index++) {
    const token = rest[index]!;
    if (!token.startsWith("--")) continue;
    if (known.includes(token)) continue;
    const suggestion = nearestFlag(token, known);
    const fix = suggestion
      ? `use ${suggestion}`
      : `drop ${token}; \`ouro ${name} --help\` lists its flags`;
    return refuse(name, `Unknown flag ${token} for "ouro ${name}". Fix: ${fix}.`);
  }

  if (others) {
    const valued = new Set([...GLOBAL_VALUE_FLAGS, ...[...flags].filter(([, takes]) => takes).map(([flag]) => flag)]);
    let extra = 0;
    for (let index = 0; index < rest.length; index++) {
      const token = rest[index]!;
      if (token.startsWith("-")) {
        if (valued.has(token)) index++;
        continue;
      }
      extra++;
    }
    if (shape.positionals === 0 && extra > 0) {
      return refuse(
        name,
        `"ouro ${name}" takes no words after its command. Fix: run \`ouro ${name} --help\` and drop the extra words.`,
      );
    }
    if (!rest.includes("--why") && !rest.includes("--why-file")) {
      return refuse(
        name,
        `ouro ${name} needs --why: other people will see this, so say who asked you and what they said. Fix: add --why "<who asked you, and what they said>" to the command.`,
      );
    }
    if (rest.includes("--dry-run")) {
      const json = rest.includes("--json");
      const text = json
        ? JSON.stringify({ state: "preview", command: name, effect: declaration.effect, dryRun: true, summary: declaration.summary })
        : `Would ${declaration.summary.replace(/\.$/, "").toLowerCase()}. Other people will see this when it runs; nothing was sent or changed. Run it again without --dry-run to do it.`;
      return { kind: "preview", text };
    }
  }

  return { kind: "pass", args: withoutWhy(args) };
}

function withoutWhy(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--why" || args[index] === "--why-file") {
      index++;
      continue;
    }
    out.push(args[index]!);
  }
  return out;
}
