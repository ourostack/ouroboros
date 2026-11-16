// Writes the Ouro AX inventory of the ouro CLI from its own registration: the command words its usage lists.
// Run after `npm run build`, so it reads the built CLI, never a copy of the list.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { usage } = require("../dist/heart/daemon/cli-parse.js");

const names = new Set();
for (const line of usage().split("\n")) {
  const match = /^ {2}ouro (.+)$/.exec(line);
  if (!match) continue;
  const words = [];
  for (const token of match[1].split(/\s+/)) {
    if (/^[[<(-]/.test(token)) break;
    words.push(token);
  }
  if (words.length === 0) continue;
  const last = words.pop();
  const heads = last.includes("|") ? last.split("|") : [last];
  for (const head of heads) names.add([...words, head].join(" "));
}

process.stdout.write(`${JSON.stringify({ cli: [...names].sort() }, null, 2)}\n`);
