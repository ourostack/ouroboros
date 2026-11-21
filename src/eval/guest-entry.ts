/**
 * The agent container's command, `node dist/eval/guest-entry.js`, run only inside the eval sandbox: one Telegram turn
 * read from the turn file the sandbox mounts at `/eval/turn.json`, with its provider served by the host over stdin
 * and stdout (see `sandbox/guest.ts`). It takes no arguments, so it is no command an agent's shell is offered.
 */
import { emitNervesEvent } from "../nerves/runtime"
import { runGuest } from "./sandbox/guest"
import { runTelegramTurn } from "./transport/telegram-turn"

void runGuest({ stdin: process.stdin, stdout: process.stdout, turnFile: "/eval/turn.json", runTurn: runTelegramTurn }).then((outcome) => {
  process.exit(outcome.ok ? 0 : 1)
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.guest_entry_error", message: "sandbox guest failed outside its turn", meta: { error: String(error) } })
  process.exit(1)
})
