export { devCommandIn, devCommandsIn, MESSAGE_KEYS, sourceCheckoutTexts };
export type { DevCommand, DevCommandFinding, DevCommandsOptions };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * A message for an agent or a person names only what the installed tool runs: never a developer command, a repository
 * path or a step that only works in a source checkout. An agent passes a next step on to the person, who has the
 * installed tool and no checkout, so a step such as `npm run writes -- on` fails for them and leaves both stuck. A step
 * that only a source checkout shows is marked `sourceCheckout: true`, and only then is it exempt.
 *
 * Developer commands: `npm`, `pnpm`, `yarn` and `bun` scripts and installs (a global install is fine), `npx` of a dev
 * tool or a file, `node`, `tsx` or another interpreter given a file in the repository, `git`, `make`, `cargo` and the
 * other build tools, and a script run by its path. Repository paths: `src/`, `scripts/`, `registry/`, `packages/`,
 * `apps/`, `.github/`, `node_modules/`, and in a command root files such as `package.json`. A web address is never a path.
 *
 * @claim "fails for them and leaves both stuck" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::finds developer commands and repository paths in a command and in prose)
 * @claim "never a developer command, a repository path or a step that only works in a source checkout" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::finds developer commands and repository paths in a command and in prose)
 * @claim "and only then is it exempt" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::walks a value, reads command and fix as commands, and skips what is marked sourceCheckout)
 * @claim "A web address is never a path" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::leaves alone what an installed tool runs, prose, global installs and web addresses)
 */
interface DevCommand {
  /** The words that gave it away, as the message has them. */
  match: string;
  kind: "command" | "path";
}

interface DevCommandFinding extends DevCommand {
  /** Where in the value, such as `next[0].command`; "" for a string on its own. */
  where: string;
  /** The whole message the match is in. */
  text: string;
}

interface DevCommandsOptions {
  /** Read only what is under {@link MESSAGE_KEYS}, as in a read's `--json`, whose other fields are the person's data. */
  messagesOnly?: boolean;
}

/** The fields of an answer that speak to the agent or the person: next steps, a human's resume step, an error and a fix. */
const MESSAGE_KEYS: ReadonlySet<string> = new Set(["next", "human", "error", "fix", "resume"]);

/** Fields that hold one command, read as a command (so `make test` counts) rather than as prose. */
const COMMAND_KEYS: ReadonlySet<string> = new Set(["command", "fix"]);

const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Subcommands of a package manager that run a project's scripts or install its dependencies. */
const SCRIPT_SUBS = new Set(["run", "run-script", "test", "t", "start", "stop", "restart", "ci", "clean-install", "install", "i", "add", "link", "rebuild", "build", "dev", "lint"]);
/** Subcommands of pnpm, yarn and bun that work outside a checkout; any other runs a project script. */
const RUNNER_SAFE = new Set(["create", "global", "help", "view", "info"]);
const EXECUTE_SUBS = new Set(["dlx", "exec", "x"]);
const EXECUTORS = new Set(["npx", "bunx"]);
const DEV_TOOLS = new Set(["tsx", "ts-node", "vitest", "jest", "mocha", "tsc", "eslint", "oxlint", "prettier", "biome", "playwright", "vite", "turbo", "nx", "lerna", "changeset"]);
const INTERPRETERS = new Set(["node", "tsx", "ts-node", "deno", "python", "python3", "ruby", "perl", "bash", "sh", "zsh", "pwsh"]);
const BUILD_TOOLS = new Set(["make", "cargo", "just", "gradle", "gradlew", "mvn", "rake", "cmake", "ninja"]);
/** Words that follow "make" in a sentence ("make sure") rather than in a command. */
const FILLER = new Set(["sure", "it", "a", "an", "the", "this", "that", "them", "you", "your", "one", "sense"]);
const GO_SUBS = new Set(["run", "build", "test", "generate", "vet", "mod"]);
const GIT_SUBS = new Set(["clone", "pull", "push", "fetch", "checkout", "switch", "commit", "add", "stash", "rebase", "merge", "reset", "restore", "status", "log", "diff", "branch", "worktree", "submodule", "tag", "cherry-pick"]);

/** Where prose may start a command: the words above that are not also ordinary English. A start is read to the end of its clause. */
const PROSE_HEAD = /(?<![\w./@-])(?:npm|pnpm|yarn|bun|npx|bunx|node|tsx|git)\s+\S/g;
/** A clause ends at punctuation before a space or the end (so `x.mjs` stays whole), or at a joining word. */
const CLAUSE_END = /[.,;:!?)](?=\s|$)|\s(?:and|then|or|so|to)\s/;
const URL = /\b[a-z][\w+.-]*:\/\/\S+/gi;
const CODE_SPAN = /`([^`\n]+)`/g;
const REPO_PATH = /(?<![\w./~@:$-])(?:\.\/)?(?:src|scripts|registry|packages|apps|\.github|node_modules)\/(?:[\w.@/-]*[\w@/-])?/g;
/** A repository's root files, a path only in a command: in prose they may be the person's own project's. */
const ROOT_FILE = /(?<![\w./~@:$-])(?:package(?:-lock)?\.json|pnpm-(?:lock|workspace)\.yaml|yarn\.lock|tsconfig(?:\.[\w-]+)?\.json|Makefile|Cargo\.toml|go\.mod|pyproject\.toml)(?![\w-])/g;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|py|sh|rb|pl|ps1)$/;
/** Flags of a package manager that take a value, so the value is not read as its subcommand. */
const VALUE_FLAGS = new Set(["-w", "--workspace", "--prefix", "-C", "--dir", "--cwd", "--filter", "-F"]);

/** A relative word: not a flag, an absolute, home or `$VAR` path, a scope or a `jsr:`/`npm:` specifier. */
const isRelative = (word: string) => !/^[-/~@$]|^[a-z]+:/i.test(word);
/** A word that names a file in the repository rather than an installed thing: relative, with a slash or a script's extension. */
const isRepoFile = (word: string) => isRelative(word) && (word.includes("/") || SCRIPT_FILE.test(word));

/** The first word that is not a flag or a flag's value, and the words after it. */
function subOf(args: readonly string[]): [string, string[]] {
  for (let i = 0; i < args.length; i++) {
    if (!args[i]!.startsWith("-")) return [args[i]!, args.slice(i + 1)];
    if (VALUE_FLAGS.has(args[i]!)) i++;
  }
  return ["", []];
}

/** What `npx` and its kin run: a dev tool, or a file of the repository; the arguments after it are its own. */
const executesDev = (args: readonly string[]) => {
  const [pkg] = subOf(args);
  return DEV_TOOLS.has(pkg) || isRepoFile(pkg);
};

/**
 * Whether one command, a single segment of a command line, needs a source checkout. `strict` reads it as a command field or a code span,
 * where `make test` and `pnpm writes` are commands; in prose only the unmistakable forms count.
 */
function isDevSegment(segment: string, strict: boolean): boolean {
  const words = segment.split(/\s+/).map((w) => w.replace(/^["']|["']$/g, "")).filter(Boolean);
  while (words[0] === "$" || /^\w+=/.test(words[0] ?? "")) words.shift();
  const [head = "", ...rest] = words;
  const [sub, more] = subOf(rest);
  const global = rest.some((w) => w === "-g" || w === "--global" || w === "--location=global");
  if (head.includes("/")) return isRepoFile(head);
  if (BUILD_TOOLS.has(head)) return !FILLER.has(sub);
  if (head === "git") return strict || GIT_SUBS.has(sub);
  if (head === "go") return GO_SUBS.has(sub);
  if (EXECUTORS.has(head)) return executesDev(rest);
  if (RUNNERS.has(head)) {
    if (EXECUTE_SUBS.has(sub)) return executesDev(more);
    if (global) return false;
    // Bare `yarn` installs a project's dependencies; `pnpm --version` names no project.
    if (head === "npm" || !strict) return SCRIPT_SUBS.has(sub);
    return sub ? !RUNNER_SAFE.has(sub) : !rest.length;
  }
  if (INTERPRETERS.has(head)) return rest.some((w) => isRelative(w) && SCRIPT_FILE.test(w));
  return false;
}

/** The commands in a command line that only work in a source checkout. */
function devSegments(line: string, strict: boolean): DevCommand[] {
  return line
    .split(/&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter((s) => isDevSegment(s, strict))
    .map((match) => ({ match, kind: "command" as const }));
}

/** The developer commands and repository paths in one message; `asCommand` also reads the whole text as a command. */
function devCommandsInText(text: string, asCommand: boolean): DevCommand[] {
  const plain = text.replace(URL, " ");
  const found: DevCommand[] = [];
  const add = (f: DevCommand) => void (found.some((g) => g.match.includes(f.match) || f.match.includes(g.match)) || found.push(f));
  if (asCommand) devSegments(plain, true).forEach(add);
  for (const span of plain.matchAll(CODE_SPAN)) devSegments(span[1]!, true).forEach(add);
  const prose = plain.replace(CODE_SPAN, " ");
  for (const m of prose.matchAll(PROSE_HEAD)) {
    const clause = prose.slice(m.index!).split(/\n/)[0]!.split(CLAUSE_END)[0]!.trim();
    if (isDevSegment(clause, false)) add({ match: clause, kind: "command" });
  }
  for (const m of plain.matchAll(REPO_PATH)) add({ match: m[0], kind: "path" });
  if (asCommand) for (const m of plain.matchAll(ROOT_FILE)) add({ match: m[0], kind: "path" });
  return found;
}

/**
 * The first developer command or repository path in a message, or null. Pass `asCommand` for a field that holds one
 * command, such as a next step's `command`.
 *
 * @example
 * devCommandIn("Writes are off. Run npm run writes -- on, then try again.");
 * // { match: "npm run writes -- on", kind: "command" }
 * devCommandIn("notes sync", true); // null
 */
function devCommandIn(text: string, asCommand = false): DevCommand | null {
  return devCommandsInText(text, asCommand)[0] ?? null;
}

/** Calls `visit` with the strings in a value, their path and key, and whether an object marked `sourceCheckout: true` holds them. */
function walk(value: unknown, visit: (text: string, where: string, key: string, marked: boolean) => void, marked = false, where = "", key = ""): void {
  if (typeof value === "string") return visit(value, where, key, marked);
  if (Array.isArray(value)) return value.forEach((v, i) => walk(v, visit, marked, `${where}[${i}]`, key));
  if (typeof value !== "object" || value === null) return;
  const mark = marked || (value as Record<string, unknown>)["sourceCheckout"] === true;
  for (const [k, v] of Object.entries(value)) walk(v, visit, mark, where ? `${where}.${k}` : k, k);
}

/**
 * Every developer command and repository path in a value: a message, a `help --json`, an outcome, an error or a
 * checks report. `command` and `fix` strings are read as commands, everything else but a step's `why` as prose; an object marked
 * `sourceCheckout: true` is skipped with all it holds. With `messagesOnly`, only what is under {@link MESSAGE_KEYS}.
 *
 * @claim "Every developer command and repository path in a value" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::walks a value, reads command and fix as commands, and skips what is marked sourceCheckout)
 * @claim "`command` and `fix` strings are read as commands" registry/ouro/ax/dev-commands.test.mts verify:testExists(registry/ouro/ax/dev-commands.test.mts::walks a value, reads command and fix as commands, and skips what is marked sourceCheckout)
 *
 * @example
 * devCommandsIn({ next: [{ command: "npm run writes -- on", why: "Turn writes on" }] });
 * // [{ match: "npm run writes -- on", kind: "command", where: "next[0].command", text: "npm run writes -- on" }]
 */
function devCommandsIn(value: unknown, options: DevCommandsOptions = {}): DevCommandFinding[] {
  const out: DevCommandFinding[] = [];
  const read = (text: string, where: string, key: string) => {
    for (const f of devCommandsInText(text, COMMAND_KEYS.has(key))) out.push({ ...f, where, text });
  };
  walk(value, (text, where, key, marked) => {
    if (marked || key === "why") return;
    if (!options.messagesOnly) return read(text, where, key);
    if (where.split(/[.[]/).some((part) => MESSAGE_KEYS.has(part))) read(text, where, key);
  });
  return out;
}

/** The strings a value marks `sourceCheckout: true`, so a checker can let the same words pass in the text output. */
function sourceCheckoutTexts(value: unknown): string[] {
  const out: string[] = [];
  walk(value, (text, _where, _key, marked) => void (marked && out.push(text)));
  return out;
}
