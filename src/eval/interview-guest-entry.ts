/**
 * The agent container's command for a U or X interview conversation, `node dist/eval/interview-guest-entry.js`, run
 * only inside the eval sandbox: the neutral loop with one arm's tools, from the turn file the sandbox mounts at
 * `/eval/turn.json`, its provider served by the host over stdin and stdout (see `interviews/guest/run.ts`). It takes
 * no arguments, so it is no command an agent's shell is offered.
 */
import { getAgentBundlesRoot } from "../heart/identity"
import { emitNervesEvent } from "../nerves/runtime"
import { runInterviewGuest } from "./interviews/guest/run"
import { mountedAgentRoot } from "./sandbox/agent-profile"

// The bundle is whichever one the sandbox mounted, so this command is the same for every agent.
void Promise.resolve().then(() => runInterviewGuest({ stdin: process.stdin, stdout: process.stdout, turnFile: "/eval/turn.json", bundle: mountedAgentRoot(getAgentBundlesRoot()) })).then((outcome) => {
  process.exit(outcome.ok ? 0 : 1)
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.interview_guest_entry_error", message: "interview guest failed outside its conversation", meta: { error: String(error) } })
  process.exit(1)
})
