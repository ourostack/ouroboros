// Writes the Ouro AX inventory of the ouro CLI: the command names its declarations list, the same names `help --json`
// prints. Run after `npm run build`, so it reads the built declarations.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CLI_COMMANDS } = require("../../dist/heart/daemon/cli-manifest.js");

const cli = [...new Set(CLI_COMMANDS.map((command) => command.name))].sort();
process.stdout.write(`${JSON.stringify({ cli }, null, 2)}\n`);
