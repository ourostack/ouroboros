/**
 * The agent container's command for an H interview conversation, `node dist/eval/h-guest-entry.js`, run only inside
 * the eval sandbox: the arm's own agent loop, from the turn file the sandbox mounts at `/eval/turn.json`, its provider
 * served by the host over stdin and stdout (see `interviews/guest/h/run.ts`). It takes no arguments, so it is no
 * command an agent's shell is offered.
 */
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { runHGuest } from "./interviews/guest/h/run"
import { mountedAgentRoot } from "./sandbox/guest"

// The bundle is whichever one the sandbox mounted, so this command is the same for every agent.
void Promise.resolve().then(() => runHGuest({ stdin: process.stdin, stdout: process.stdout, turnFile: "/eval/turn.json", bundle: mountedAgentRoot(getAgentBundlesRoot()) })).then((outcome) => {
  process.exit(outcome.ok ? 0 : 1)
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.h_guest_entry_error", message: "H guest failed outside its conversation", meta: { error: String(error) } })
  process.exit(1)
})
