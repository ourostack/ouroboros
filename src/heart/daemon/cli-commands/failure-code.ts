// The last stderr line of a failed `node dist/...` program (see entry-points.ts): `code: <code>`, but only for a code
// that program's card names. Any other code, such as Node's ENOENT, could say something about the host the program
// keeps private, and no card tells an agent what to do about it, so the line is left out.

/** `code: <code>\n` when the failure carries one of the door's card codes, otherwise "". */
export function failureCodeLine(error: unknown, codes: readonly string[]): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && codes.includes(code) ? `code: ${code}\n` : ""
}
