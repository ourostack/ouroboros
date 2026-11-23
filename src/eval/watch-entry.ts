/**
 * `npm run eval:watch -- --agent-root <path> [--out <folder>]`: one Watch run over a live agent's logs (see
 * `watch/run-watch.ts` and `watch/cli.ts`). It reads the agent's nerves logs read-only, keeps private rows under
 * `~/.ouro-eval/watch/<agent>/` (or `--out`), and prints counts a day by channel as JSON. It runs at the lowest CPU
 * priority, refuses every write under `~/AgentBundles/` and the agent's folder, sends nothing and makes no model call.
 * A scheduler should run `nice -n 19 node dist/eval/watch-entry.js` on a built tree: the npm script builds first.
 */
import os from "node:os"
import { lowerPriority, watchCli } from "./watch/cli"

lowerPriority()
process.exitCode = watchCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  homedir: os.homedir(),
})
