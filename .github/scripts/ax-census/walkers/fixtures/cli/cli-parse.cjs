// Built stand-in for cli-parse.ts and cli-tool.ts.
function extractAgent(args) {
  const at = args.indexOf("--agent");
  if (at === -1) return { rest: args };
  return { agent: args[at + 1], rest: [...args.slice(0, at), ...args.slice(at + 2)] };
}
function parseFriend(args) {
  const { agent, rest } = extractAgent(args);
  const [sub, ...tail] = rest;
  if (sub === "list") return { kind: "friend.list" };
  if (sub === "show") {
    if (!agent || tail.length !== 1) throw new Error("Usage: friend show <id> --agent <name>");
    return { kind: "friend.show", id: tail[0] };
  }
  throw new Error("Usage: friend list|show");
}
function normalizeTarget(value) {
  if (value === "providers" || value === "provider") return "providers";
  if (value === "mail") return "mail";
  return undefined;
}
function parseConnect(args) {
  const target = args[0] ? normalizeTarget(args[0]) : undefined;
  return { kind: "connect", ...(target ? { target } : {}) };
}
function parseWork(args) {
  switch (args[0]) {
    case "card": return { kind: "work.card" };
    case "gauntlet": return { kind: "work.gauntlet" };
  }
  throw new Error("Usage: work card|gauntlet");
}
const MODES = { shadow: true, live: true };
function parseMode(args) {
  const mode = args[0];
  if (!Object.hasOwn(MODES, mode)) throw new Error("Usage: mode shadow|live");
  return { kind: mode === "live" ? "mode.live" : "mode.shadow" };
}
function parseVault(verb, args) {
  if (verb === "lock") return { kind: "vault.lock" };
  for (const token of args) if (token === "--yes") return { kind: "vault.unlock" };
  throw new Error("vault unlock needs --yes");
}
function parseToolCommand(args) {
  const sub = args[0];
  if (sub === "run") {
    const at = args.indexOf("--name");
    if (at === -1 || !args[at + 1]) throw new Error("Usage: tool run --name <name>");
    return { kind: "tool.run", name: args[at + 1] };
  }
  throw new Error("Usage: tool run --name <name>");
}
function parseCommand(args) {
  const [head, second] = args;
  if (!head) return { kind: "up" };
  if (head === "--agent" && second) return parseCommand(args.slice(2));
  if (head === "up") return { kind: "up" };
  if (head === "stop" || head === "down") return { kind: "stop" };
  if (head === "friend") return parseFriend(args.slice(1));
  if (head === "connect") return parseConnect(args.slice(1));
  if (head === "work") return parseWork(args.slice(1));
  if (head === "mode") return parseMode(args.slice(1));
  if (["lock", "unlock"].includes(head)) return parseVault(head, args.slice(1));
  if (head === "tool") return parseToolCommand(args.slice(1));
  if (head === "secret") {
    if (args[1] === "rotate") {
      if (!/^[a-f0-9]{64}$/.test(args[2] ?? "")) throw new Error("Usage: secret rotate <64 hex>");
      return { kind: "secret.rotate" };
    }
    throw new Error("Usage: secret rotate <64 hex>");
  }
  if (args.includes("hidden")) return { kind: "hidden" };
  throw new Error(`Unknown command '${args.join(" ")}'`);
}
exports.parseCommand = parseCommand;
