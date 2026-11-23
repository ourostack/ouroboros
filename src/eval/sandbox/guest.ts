/**
 * What runs inside the agent container: one Telegram turn whose provider is served by the host over the container's
 * stdin and stdout. The turn's input (the case prefix and the owner's last message) is a read-only file the sandbox
 * mounts. The guest's last line on stdout is a `done` message with the turn's result, or why it could not run; the
 * host builds the scored observation from its own sources and uses this result only for the replies and their order.
 */
import fs from "node:fs"
import type { Readable, Writable } from "node:stream"
import { getAgentRoot } from "../../heart/identity"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Case } from "../domain/case"
import { createProxyRuntime, createStreamChannel, type GuestOutcome } from "../transport/provider-proxy"
import type { runTelegramTurn } from "../transport/telegram-turn"

export type GuestTurnFile = { prefix: Case["prefix"]; userText: string }

export type GuestInput = {
  stdin: Readable
  stdout: Writable
  turnFile: string
  /** `runTelegramTurn` in the container; a test passes its own. */
  runTurn: typeof runTelegramTurn
  /** The agent's bundle: in the container, the one `--agent` names. Without it, the Butler's. */
  agentRoot?: string
}

function readTurnFile(file: string): GuestTurnFile {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<GuestTurnFile>
  if (!Array.isArray(value.prefix) || typeof value.userText !== "string") throw new Error(`${file} needs a prefix list and a userText string`)
  return { prefix: value.prefix, userText: value.userText }
}

export async function runGuest(input: GuestInput): Promise<GuestOutcome> {
  emitNervesEvent({ component: "eval", event: "eval.guest_start", message: "sandbox guest starting a turn", meta: {} })
  const channel = createStreamChannel(input.stdin, input.stdout)
  let outcome: GuestOutcome
  try {
    const turn = readTurnFile(input.turnFile)
    const providerRuntime = await createProxyRuntime(channel)
    const result = await input.runTurn({ agentRoot: input.agentRoot ?? getAgentRoot("sanctuary"), prefix: turn.prefix, userText: turn.userText, providerRuntime })
    outcome = { ok: true, result }
    emitNervesEvent({ component: "eval", event: "eval.guest_end", message: "sandbox guest finished its turn", meta: { outcome: result.outcome } })
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    emitNervesEvent({ component: "eval", level: "error", event: "eval.guest_error", message: "sandbox guest could not run its turn", meta: { error: outcome.error } })
  }
  channel.send({ type: "done", outcome })
  await new Promise<void>((resolve) => input.stdout.write("", () => resolve()))
  return outcome
}
