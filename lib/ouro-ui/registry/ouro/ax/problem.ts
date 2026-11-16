export { AxError, commandLine, didYouMean, errorJson, errorLine, errorMessage, isAxError, shellWord };
export type { AxErrorBody, AxErrorShape };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * One error shape for every agent surface: the CLI's stderr line, its `--json` error and an MCP tool error all carry
 * the same fields, so an agent learns one repair loop. The line mirrors Ouro HX's dev message format:
 * `<tool>: <thing>: <what's wrong>. Fix: <exact code>.`
 *
 * @claim "tool error all carry" registry/ouro/ax/problem.test.mts verify:testExists(registry/ouro/ax/problem.test.mts::AxError carries the shape, its exit and the same message; errorJson adds the message)
 */
interface AxErrorShape {
  /** A stable slug an agent can branch on, such as "unknown-flag", "missing-arg" or "needs-why". */
  code: string;
  /** The process exit code. */
  exit: number;
  /** What the error is about: a command ("send"), a flag ("send --why") or a tool. */
  thing: string;
  /** What's wrong, in the agent's words. */
  problem: string;
  /** The exact code to run instead, or null when nothing the agent runs can fix it. */
  fix: string | null;
}

/** The error the kit's primitives throw: its message is the one line, its shape the data. */
class AxError extends Error {
  readonly shape: AxErrorShape;
  constructor(shape: AxErrorShape) {
    super(errorMessage(shape));
    this.name = "AxError";
    this.shape = shape;
  }
  get exit(): number {
    return this.shape.exit;
  }
}

function isAxError(value: unknown): value is AxError {
  return value instanceof AxError;
}

const sentence = (text: string) => text.trim().replace(/[.\s]+$/, "");

/** `<thing>: <problem>. Fix: <fix>.`, without the tool's prefix (a CLI adds its own). */
function errorMessage(shape: Pick<AxErrorShape, "thing" | "problem" | "fix">): string {
  const head = `${shape.thing}: ${sentence(shape.problem)}.`;
  return shape.fix === null ? head : `${head} Fix: ${sentence(shape.fix)}.`;
}

/** The one stderr line: `<tool>: <thing>: <problem>. Fix: <fix>.` Line breaks in any part become spaces. */
function errorLine(tool: string, shape: Pick<AxErrorShape, "thing" | "problem" | "fix">): string {
  return `${tool}: ${errorMessage(shape)}`.replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * The error as data: its shape plus the one-line message. Outcomes, `--json` and MCP all carry this.
 *
 * @claim "and MCP all carry this" registry/ouro/ax/outcome.test.mts verify:testExists(registry/ouro/ax/outcome.test.mts::outcome fills honest defaults: private, only you, nothing checked, no receipt; an error gets its message)
 */
type AxErrorBody = AxErrorShape & { message: string };

/** The `--json` and MCP form: `{ error: { code, exit, thing, problem, fix, message } }`. */
function errorJson(shape: AxErrorShape): { error: AxErrorBody } {
  return { error: { ...shape, message: errorMessage(shape) } };
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!;
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length]!;
}

/**
 * The candidate an agent most likely meant: the nearest within two edits, else a unique prefix; null when neither applies.
 *
 * @claim "the nearest within two edits" registry/ouro/ax/problem.test.mts verify:testExists(registry/ouro/ax/problem.test.mts::didYouMean: the nearest within a couple of edits, else a unique prefix, else null)
 */
function didYouMean(word: string, candidates: readonly string[]): string | null {
  if (word === "") return null;
  let best: string | null = null;
  let bestDistance = Math.min(3, Math.max(2, Math.floor(word.length / 2)) + 1);
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  if (best) return best;
  const prefixed = candidates.filter((c) => c.startsWith(word) || word.startsWith(c));
  return prefixed.length === 1 ? prefixed[0]! : null;
}

/** Quotes a word for a POSIX shell only when it needs it, so a fix copies and runs as printed. */
function shellWord(word: string): string {
  if (/^<[^>\s]+>$/.test(word) || /^[A-Za-z0-9_./:@#,=+-]+$/.test(word)) return word;
  return `"${word.replace(/(["\\$`])/g, "\\$1")}"`;
}

/**
 * A command line from words, each quoted only when it needs it.
 *
 * @claim "each quoted only when" registry/ouro/ax/problem.test.mts verify:testExists(registry/ouro/ax/problem.test.mts::commandLine quotes only what a shell would split or expand)
 */
function commandLine(words: readonly string[]): string {
  return words.map(shellWord).join(" ");
}
