// The fixture product's entry-point declarations, built form.
exports.ENTRY_POINTS = [
  { name: "node dist/stats-main.js summary", effect: "private", readOnly: true, summary: "Summarise the stats.", ax: { id: "cli:node dist/stats-main.js summary", group: "stats", when: "Pick this to see how many sessions ran today before digging into one of them.", effect: "read", errors: [{ code: "no-stats", means: "No sessions were recorded yet.", fix: "Run a session first, then summarise." }] } },
  { name: "node dist/lone-entry.js", effect: "private", summary: "Print the argument count." },
];
exports.STALE = [...exports.ENTRY_POINTS, { name: "node dist/gone.js", effect: "private", summary: "Gone." }];
