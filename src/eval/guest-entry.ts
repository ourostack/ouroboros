/**
 * The agent container's command: `node dist/eval/guest-entry.js --agent sanctuary --turn <file>`. It runs one
 * Telegram turn whose provider is served by the host over stdin and stdout, then exits (see `sandbox/guest.ts`).
 */
import { emitNervesEvent } from "../nerves/runtime"
import { runGuest } from "./sandbox/guest"
import { runTelegramTurn } from "./transport/telegram-turn"

const turnFile = process.argv[process.argv.indexOf("--turn") + 1] ?? "/eval/turn.json"

void runGuest({ stdin: process.stdin, stdout: process.stdout, turnFile, runTurn: runTelegramTurn }).then((outcome) => {
  process.exit(outcome.ok ? 0 : 1)
}).catch((error: unknown) => {
  emitNervesEvent({ component: "eval", level: "error", event: "eval.guest_entry_error", message: "sandbox guest failed outside its turn", meta: { error: String(error) } })
  process.exit(1)
})
