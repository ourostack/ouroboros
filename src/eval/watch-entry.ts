/**
 * `npm run eval:watch -- --agent-root <path> [--out <folder>]`: one Watch run over a live agent's logs (see
 * `watch/run-watch.ts` and `watch/cli.ts`). It reads the agent's nerves logs read-only, keeps private rows under
 * `~/.ouro-eval/watch/<agent>/` (or `--out`), and prints counts a day by channel as JSON. It runs at the lowest CPU
 * priority, refuses every write under `~/AgentBundles/` and the agent's folder, sends nothing and makes no model call.
 * A scheduler should run `nice -n 19 node dist/eval/watch-entry.js` on a built tree: the npm script builds first.
 */
import os from "node:os"
import { emitNervesEvent } from "../nerves/runtime"
import { lowerPriority, watchCli } from "./watch/cli"

lowerPriority()
const code = watchCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  homedir: os.homedir(),
})
// stderr's last line names the failure for a script: 2 bad arguments, 3 the kill switch, 1 a run refused or failed.
if (code !== 0) process.stderr.write(`code: ${code === 2 ? "usage" : code === 3 ? "stopped" : "watch-failed"}\n`)
emitNervesEvent({ component: "eval", event: "eval.watch_entry_exit", message: "Watch's command finished", meta: { code } })
process.exitCode = code
