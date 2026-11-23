export { BASE_EXIT_CODES, defineExitCodes, FINDINGS_EXIT_CODE };
export type { ExitCode, ExitTable };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * A tool's exit codes as one table: the overview, every command's footer, `help --json` and the MCP error shape read
 * it, so the numbers never drift. Codes 0, 1 and 2 mean the same thing in every Ouro AX tool.
 *
 * @claim "so the numbers never drift" registry/ouro/ax/help.ts verify:fileLine(registry/ouro/ax/help.ts, /cli\.exits\.line\(\)/)
 * @claim "mean the same thing in every Ouro AX tool" registry/ouro/ax/exit-codes.test.mts verify:testExists(registry/ouro/ax/exit-codes.test.mts::a gap, a renamed base code, a short table or a repeated name fails with the fix)
 */
interface ExitCode {
  code: number;
  /** A slug an error names its exit by, such as "usage" or "unavailable". */
  name: string;
  /** A few words for the one-line summary. */
  short: string;
  /** The full meaning, for `help exit-codes`. */
  meaning: string;
}

const BASE_EXIT_CODES: readonly ExitCode[] = Object.freeze([
  { code: 0, name: "ok", short: "ok", meaning: "ok" },
  { code: 1, name: "error", short: "error", meaning: "error: the message says what to do" },
  { code: 2, name: "usage", short: "usage", meaning: "usage: a missing or wrong argument; nothing was done" },
]);

/**
 * The code a check or doctor tool declares beside the base codes: its checks ran and found a problem, with a fix
 * beside it. A check that threw before finishing is a crash and exits with the base `error` code instead, so an agent tells "the
 * tool found something" from "the tool broke" by the code alone.
 *
 * @claim "exits with the base `error` code instead" registry/ouro/ax/checks.test.mts verify:testExists(registry/ouro/ax/checks.test.mts::findings exit with the declared findings code and a check that couldn't run exits 1, never the same code)
 */
const FINDINGS_EXIT_CODE: ExitCode = Object.freeze({ code: 3, name: "findings", short: "findings", meaning: "findings: a check found a problem; its fix says what to do" });

interface ExitTable {
  readonly codes: readonly ExitCode[];
  /** The number for a name; throws for a name the table does not have, so a typo fails in tests, not in an agent's run. */
  code(name: string): number;
  /** Whether the table has a code by this name. */
  has(name: string): boolean;
  /** `Exit codes: 0 ok, 1 error, 2 usage, ...` */
  line(): string;
}

/**
 * The tool's table: the base codes (their meanings may be reworded, never their names) then its own, numbered from 3
 * with no gaps.
 *
 * @claim "numbered from 3 with" registry/ouro/ax/exit-codes.test.mts verify:testExists(registry/ouro/ax/exit-codes.test.mts::a gap, a renamed base code, a short table or a repeated name fails with the fix)
 */
function defineExitCodes(codes: readonly ExitCode[] = BASE_EXIT_CODES): ExitTable {
  codes.forEach((entry, i) => {
    if (entry.code !== i) throw new Error(`exit codes: code ${entry.code} is at position ${i}. Fix: number the codes 0, 1, 2, ... with no gaps.`);
    const base = BASE_EXIT_CODES[i];
    if (base && entry.name !== base.name) throw new Error(`exit codes: code ${i} is named "${entry.name}". Fix: name it "${base.name}", as every Ouro AX tool does.`);
  });
  if (codes.length < BASE_EXIT_CODES.length) throw new Error("exit codes: the table needs 0 ok, 1 error and 2 usage. Fix: start from BASE_EXIT_CODES.");
  const names = new Map(codes.map((entry) => [entry.name, entry.code]));
  if (names.size !== codes.length) throw new Error("exit codes: two codes share a name. Fix: give each code its own name.");
  const frozen = Object.freeze(codes.map((entry) => Object.freeze({ ...entry })));
  return {
    codes: frozen,
    code(name) {
      const found = names.get(name);
      if (found === undefined) throw new Error(`exit codes: no code named "${name}". Fix: one of ${[...names.keys()].join(", ")}.`);
      return found;
    },
    has: (name) => names.has(name),
    line: () => `Exit codes: ${frozen.map((entry) => `${entry.code} ${entry.short}`).join(", ")}.`,
  };
}
