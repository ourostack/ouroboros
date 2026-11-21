"use strict";
const err = (code, means, fix) => ({ code, means, fix });
exports.noteTools = [
  {
    tool: { type: "function", function: { name: "read_note", description: "Read one note.", parameters: {} } },
    handler: () => "note",
    riskProfile: { mutates: "none", risk: "low" },
    ax: { id: "tool:read_note", group: "notes", when: "Look up a note you saved earlier before answering from memory.", effect: "read", errors: [err("note-missing", "No note has that id.", "List the notes and pass an id from the list.")] },
  },
  { tool: { type: "function", function: { name: "save_note", description: "Save a note.", parameters: {} } }, handler: () => "saved" },
  {
    tool: { type: "function", function: { name: "ping", description: "Ping.", parameters: {} } },
    handler: () => "pong",
    riskProfile: () => ({ mutates: "none", risk: "low" }),
    ax: { id: "tool:ping", group: "notes", when: "Check the fixture runtime answers before a longer job starts.", effect: "read", errors: [err("invalid-arguments", "The call's arguments don't match the schema.", "Send only the documented arguments.")] },
  },
];
