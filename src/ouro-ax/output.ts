export { emptyText, page, render, truncate };
export type { Page, Truncated };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

/**
 * One result, two renderings: `--json` prints the data, text prints what the command's text() makes of the same data.
 * Long results are cut predictably, and lists page with a cursor, so an agent can read a long answer in pieces.
 *
 * @claim "One result, two renderings" registry/ouro/ax/output.test.mts verify:testExists(registry/ouro/ax/output.test.mts::one result renders as JSON or as its text, with one trailing newline)
 */

/**
 * What stdout gets for a result: the JSON document, or the text. Always one trailing newline.
 *
 * @claim "Always one trailing newline" registry/ouro/ax/output.test.mts verify:testExists(registry/ouro/ax/output.test.mts::one result renders as JSON or as its text, with one trailing newline)
 */
function render<R>(result: R, options: { json: boolean; text?: (result: R) => string }): string {
  const body = options.json || !options.text ? JSON.stringify(result, null, 2) : options.text(result);
  return body.endsWith("\n") ? body : `${body}\n`;
}

interface Truncated {
  text: string;
  truncated: boolean;
  /** The whole length, in characters. */
  total: number;
}

/**
 * Cuts text to at most `max` characters at a line break where it can, and says so on its last line with how to get the
 * rest.
 */
function truncate(text: string, max: number, more: string = "ask for less, such as a smaller limit"): Truncated {
  if (text.length <= max) return { text, truncated: false, total: text.length };
  const note = `\n[truncated: ${max} of ${text.length} characters shown; ${more}]`;
  const room = Math.max(0, max - note.length);
  const cut = text.lastIndexOf("\n", room);
  return { text: text.slice(0, cut > room / 2 ? cut : room) + note, truncated: true, total: text.length };
}

interface Page<T> {
  items: T[];
  total: number;
  /** Pass it back as `cursor` for the next page; null on the last. */
  nextCursor: string | null;
}

/** One page of a list. The cursor is the next item's offset, so it is stable while the list is. */
function page<T>(items: readonly T[], options: { limit: number; cursor?: string | null }): Page<T> {
  const start = options.cursor ? Number.parseInt(options.cursor, 10) : 0;
  if (!Number.isSafeInteger(start) || start < 0 || start > items.length) throw new Error(`cursor "${options.cursor}" is not one this list gave. Fix: start again without a cursor.`);
  const end = Math.min(items.length, start + Math.max(1, options.limit));
  return { items: items.slice(start, end), total: items.length, nextCursor: end < items.length ? String(end) : null };
}

/**
 * The text for a list that came back empty: what is empty, by the filter that emptied it ("Nothing unread."), never
 * "nothing held yet" when the filter is why, then the command to run next. A tool's voice may add its `empty` line after.
 *
 * @claim "by the filter that emptied it" registry/ouro/ax/output.test.mts verify:testExists(registry/ouro/ax/output.test.mts::an empty list says what is empty and what to run next)
 */
function emptyText(what: string, next?: { command: string; why: string }): string {
  const fact = `Nothing ${what.replace(/[.\s]+$/, "")}.`;
  return next ? `${fact}\nNext: ${next.command}  (${next.why})` : fact;
}
