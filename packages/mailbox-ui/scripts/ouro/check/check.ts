import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "./register.ts";

// The command. register.ts resolves #ouro-ax/ before run.ts, which imports the Ouro AX kit by that name, is loaded.
/* node:coverage disable */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  await (await import("./run.ts")).runScript(process.argv.slice(2));
}
/* node:coverage enable */
