"use strict";
const define = (name, description, ax) => ({ tool: { type: "function", function: { name, description, parameters: {} } }, handler: () => "rows", riskProfile: { mutates: "durable_state_write", risk: "high", reason: "rows" }, ...(ax ? { ax } : {}) });
exports.rowTools = [
  define("list_rows", "List rows.", { id: "tool:list_rows", group: "notes", when: "Write the current table rows to the scratch ledger before a bulk edit.", effect: "write", errors: [{ code: "invalid-arguments", means: "A row filter isn't a known column.", fix: "Pass a column the table has." }] }),
  define("drop_rows", "Drop rows."),
];
