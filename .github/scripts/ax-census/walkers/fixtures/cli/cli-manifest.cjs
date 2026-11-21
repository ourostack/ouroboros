// The fixture CLI's declarations, built form: one entry per command, each with its door card.
const errors = (code, means, fix) => [{ code, means, fix }];
exports.serverErrors = [{ code: "unknown-door", means: "No fixture command has those words.", fix: "Run fixture help to list the commands." }];
exports.COMMANDS = [
  { name: "up", effect: "private", summary: "Start the fixture daemon.", ax: { id: "cli:up", group: "life", when: "Pick this first on a fresh machine, before anything that needs the background runtime.", effect: "write", errors: errors("daemon-down", "The daemon never answered after starting.", "Read its log, then start it again.") } },
  { name: "stop", effect: "private", summary: "Stop the fixture daemon.", ax: { id: "cli:stop", group: "life", when: "Pick this before replacing the install, so nothing holds the old files open.", effect: "write", aliases: ["down"], errors: errors("daemon-down", "Nothing was running to stop.", "Carry on; the runtime is already off.") } },
  { name: "down", effect: "private", summary: "Stop the fixture daemon." },
  { name: "friend list", effect: "private", readOnly: true, summary: "List friends.", ax: { id: "cli:friend list", group: "people", when: "Pick this to find a person's id before showing or changing their record.", effect: "read", errors: errors("no-friend", "The agent knows nobody yet.", "Add someone with friend create.") } },
  { name: "secret rotate", effect: "others", summary: "Rotate the shared secret.", example: "secret rotate 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", ax: { id: "cli:secret rotate", group: "life", when: "Pick this after a leak, because every paired device must re-pair afterwards.", effect: "read", errors: errors("bad-hex", "The secret wasn't 64 hex characters.", "Pass the 64-character hex value the vault printed.") } },
  { name: "seal", effect: "private", summary: "Seal the store.", example: "seal 123456" },
];
// A declaration no walked path reaches.
exports.STALE = [...exports.COMMANDS, { name: "nope", effect: "private", summary: "Nothing." }];
// An alias given a card of its own, an example that doesn't parse, and one that names another command.
exports.BAD = [
  { name: "stop", effect: "private", summary: "Stop.", ax: { id: "cli:stop", group: "life", when: "x", effect: "write", errors: [] } },
  { name: "down", effect: "private", summary: "Stop.", ax: { id: "cli:down", group: "life", when: "x", effect: "write", errors: [] } },
  { name: "seal", effect: "private", summary: "Seal.", example: "seal now" },
  { name: "tool run", effect: "private", summary: "Run a tool.", example: "up --name x" },
  { name: "up", effect: "private", summary: "Up." },
  { name: "up", effect: "private", summary: "Up again." },
];
exports.NOT_A_LIST = { name: "up" };
