import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { emitNervesEvent } from "../../nerves/runtime"

export interface FeedbackOrigin { tty: string }
type Inspect = (command: string, args: string[]) => Promise<string>

export async function resolveFeedbackOrigin(inspect: Inspect = async (command, args) => {
  const { stdout } = await promisify(execFile)(command, args, { timeout: 2000, maxBuffer: 4096 })
  return stdout
}): Promise<FeedbackOrigin> {
  const tty = (await inspect("/bin/ps", ["-p", String(process.pid), "-o", "tty="])).trim()
  if (!/^(?:tty[s]?[A-Za-z0-9]+|pts\/[0-9]+)$/.test(tty)) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.shepherd_feedback_origin_unavailable",
      message: "native feedback has no unique controlling terminal", meta: { status: "unavailable" } })
    throw new Error("The calling coding session's controlling terminal is unavailable; feedback was not submitted")
  }
  emitNervesEvent({ component: "senses", event: "senses.shepherd_feedback_origin_resolved",
    message: "resolved the native feedback process terminal", meta: { status: "resolved" } })
  return { tty: `/dev/${tty}` }
}
