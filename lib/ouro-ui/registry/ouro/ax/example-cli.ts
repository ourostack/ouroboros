export { exampleCli, exits, postMessage, resetRooms, rooms, setClock };

// The export list comes first because the shadcn CLI drops comments before a file's
// first statement, which would take the JSDoc below with it.

import { defineCli, defineCommand } from "./command.ts";
import { privateResult } from "./effects.ts";
import { AxError } from "./problem.ts";
import { BASE_EXIT_CODES, defineExitCodes } from "./exit-codes.ts";
import { nextStep, outcome } from "./outcome.ts";
import { formatDuration, parseDuration, WAIT_FLAGS, waitFor, type AxEvent } from "./wait.ts";

/**
 * A small tool built only from the kit, for the tests and as the pattern to copy: commands of both effects, an action
 * that returns an outcome with a preview, a wait on a room, an ambiguous word, a tool-specific exit code and a voice.
 */
const exits = defineExitCodes([...BASE_EXIT_CODES, { code: 3, name: "unavailable", short: "unavailable", meaning: "the service didn't answer" }]);

const rooms: Record<string, { title: string; members: string[]; notes: string[]; messages: AxEvent[] }> = {};

/** Puts the toy's one room back as it started. */
function resetRooms() {
  for (const k of Object.keys(rooms)) delete rooms[k];
  rooms["abc123"] = { title: "Design sync", members: ["Jo Park", "Ana Ruiz", "Kim Ito"], notes: [], messages: [] };
}
resetRooms();

let clock = () => new Date();

/** Sets the clock the toy stamps messages and receipts with: tests pass a fixed one, and `setClock()` puts back the real one. */
function setClock(now: () => Date = () => new Date()) {
  clock = now;
}

const room = (ref: string) => {
  const r = rooms[ref];
  if (!r) throw new AxError({ code: "no-such-room", exit: exits.code("error"), thing: "room", problem: `there is no room "${ref}"`, fix: "notes rooms" });
  return r;
};

/** Someone posts in a room (the tests use it to answer a wait). */
function postMessage(ref: string, by: string, text: string) {
  const r = room(ref);
  r.messages.push({ cursor: String(r.messages.length + 1), type: "message", at: clock().toISOString(), by, target: { kind: "room", id: ref }, summary: text });
}

const everyone = (title: string) => ({ only: false, who: `everyone in "${title}"` });

const exampleCli = defineCli({
  name: "notes",
  about: ["notes: a toy tool built from Ouro AX definitions."],
  exits,
  // A line of character for a person at a terminal, after the facts; never piped, under --json, --quiet or in CI.
  voice: {
    banner: ["Rooms to talk in, notes to keep."],
    done: () => ["Said once, said plainly.", "Posted; the room has it now."],
    empty: ["Nothing yet. Rooms fill up."],
  },
  ambiguous: Object.fromEntries(
    ["edit", "delete", "remove"].map((word) => [word, [{ means: "a note only you see", use: "note {args}" }, { means: "a message other people see", use: "post {args} {flags} --why <why>" }]]),
  ),
  commands: [
    defineCommand({
      name: "rooms",
      summary: "The rooms, with their short ids.",
      effect: "private",
      readOnly: true,
      flags: { limit: { type: "number", description: "At most this many.", min: 1, max: 100 } },
      output: "[ { ref, title } ]",
      examples: ["notes rooms --limit 5"],
      run: (input) => Object.entries(rooms).slice(0, typeof input["limit"] === "number" ? input["limit"] : undefined).map(([ref, r]) => ({ ref, title: r.title })),
      text: (list) => list.map((r) => `[${r.ref}] ${r.title}`).join("\n"),
    }),
    defineCommand({
      name: "note",
      summary: "Add a private note to a room.",
      effect: "private",
      args: [
        { name: "room", description: "The room's short id.", required: true, source: "rooms" },
        { name: "text", description: "The note.", required: true, rest: true, stdin: true },
      ],
      output: "{ room, notes }",
      examples: ['notes note abc123 "check the dates"'],
      run: (input) => {
        const r = room(String(input["room"]));
        r.notes.push(String(input["text"]));
        return { room: r.title, notes: r.notes.length };
      },
      text: (res) => privateResult(`Note added in "${res.room}"`),
    }),
    defineCommand({
      name: "post",
      summary: "Post a message everyone in the room sees.",
      effect: "others",
      args: [
        { name: "room", description: "The room's short id.", required: true, source: "rooms" },
        { name: "text", description: "The message.", required: true, rest: true, stdin: true },
      ],
      flags: { tone: { type: "enum", values: ["plain", "markdown"], description: "How the text is formatted." } },
      output: "an outcome (outcome/1)",
      examples: ['notes post abc123 "Running late" --why "Jo asked: tell the room Jo is running late"', 'notes post abc123 "Running late" --why "Jo asked" --dry-run'],
      plan: (input) => {
        const ref = String(input["room"]);
        const r = room(ref);
        return outcome({ action: "post", effect: "others", audience: everyone(r.title), target: { kind: "room", id: ref, name: r.title }, state: "planned", summary: `Would post to "${r.title}". Everyone in it would see it.` });
      },
      run: (input) => {
        const ref = String(input["room"]);
        const r = room(ref);
        postMessage(ref, "you", String(input["text"]));
        const seen = r.messages.at(-1)?.summary === String(input["text"]);
        return outcome({
          action: "post",
          effect: "others",
          audience: everyone(r.title),
          target: { kind: "room", id: ref, name: r.title },
          state: "done",
          summary: `Posted to "${r.title}". Everyone in it can see it.`,
          postcondition: { checked: true, holds: seen, how: "read the room's last message back" },
          receipt: { id: `m${r.messages.length}`, at: clock().toISOString(), by: "agent", why: String(input["why"]) },
          next: [nextStep(`notes watch ${ref}`, "wait for a reply")],
        });
      },
    }),
    defineCommand({
      name: "watch",
      summary: "Wait for the next message in a room, then print it.",
      effect: "private",
      readOnly: true,
      args: [{ name: "room", description: "The room's short id.", required: true, source: "rooms" }],
      flags: WAIT_FLAGS,
      output: "a wait (wait/1)",
      examples: ["notes watch abc123 --timeout 2m"],
      run: (input) => {
        const ref = String(input["room"]);
        const r = room(ref);
        const timeoutMs = parseDuration(String(input["timeout"] ?? "1s"));
        if (timeoutMs === null) throw new AxError({ code: "bad-value", exit: exits.code("usage"), thing: "watch --timeout", problem: `"${String(input["timeout"])}" is not a duration`, fix: `notes watch ${ref} --timeout 2m` });
        return waitFor({
          for: `a message in "${r.title}"`,
          target: { kind: "room", id: ref, name: r.title },
          cursor: typeof input["cursor"] === "string" ? input["cursor"] : null,
          timeoutMs,
          intervalMs: 5,
          read: async (cursor) => ({ events: r.messages.slice(Number(cursor ?? r.messages.length)), cursor: String(r.messages.length), fresh: { state: "live", asOf: null } }),
          resume: (cursor) => nextStep(`notes watch ${ref} --cursor ${cursor} --timeout ${formatDuration(timeoutMs)}`, "keep waiting from where this wait stopped"),
        });
      },
    }),
  ],
});
