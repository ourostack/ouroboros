/**
 * What runs in the agent container for an H interview conversation (`h-guest-entry.js`, pre-registration v2 product
 * H). H compares whole harnesses, so each arm runs its own agent loop, not the neutral loop: the ouro arm is the
 * harness's own Telegram turn on the mounted bundle, with the label line added to its system prompt and the debrief
 * sent as the owner's next message in the same chat. The other arms' runners are given by arm. Every arm's provider
 * is the host's, served over stdin and stdout, so the host still scans, gates and meters every call.
 *
 * The answer is the conversation's timeline and, per user turn, where it starts, its reply, its outcome and its
 * model calls, as every interview guest gives it; the first turn's reply and outcome are the job's.
 */
import fs from "node:fs"
import type { Readable, Writable } from "node:stream"
import type { ProviderRuntime } from "../../../../heart/core"
import { emitNervesEvent } from "../../../../nerves/runtime"
import type { Case } from "../../../domain/case"
import { createProxyRuntime, createStreamChannel, type GuestOutcome } from "../../../transport/provider-proxy"
import { runTelegramTurn } from "../../../transport/telegram-turn"

export type HTurnFile = {
  product: "H"
  arm: string
  labelLine: string
  prefix: Case["prefix"]
  userText: string
  followUps: string[]
}

/** One H arm's agent loop: the whole conversation, the job and then each follow-up, on the host's provider. */
export type HArmRunner = (input: { turn: HTurnFile; bundle: string; providerRuntime: ProviderRuntime }) => Promise<unknown>

/** The ouro arm: the harness's own turn, unchanged but for the label line and the later message. */
export function ouroArm(runTurn: typeof runTelegramTurn = runTelegramTurn): HArmRunner {
  return ({ turn, bundle, providerRuntime }) => runTurn({
    agentRoot: bundle, prefix: turn.prefix, userText: turn.userText, providerRuntime, systemLine: turn.labelLine, followUps: turn.followUps,
  })
}

/** The H arms this guest runs. */
export const H_ARMS: Readonly<Record<string, HArmRunner>> = { ouro: ouroArm() }

function readTurnFile(file: string): HTurnFile {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HTurnFile>
  if (value.product !== "H" || typeof value.arm !== "string" || typeof value.labelLine !== "string" || !Array.isArray(value.prefix)
    || typeof value.userText !== "string" || !Array.isArray(value.followUps)) {
    throw new Error(`${file} needs product H, arm, labelLine, prefix, userText and followUps`)
  }
  return value as HTurnFile
}

export async function runHGuest(input: {
  stdin: Readable
  stdout: Writable
  turnFile: string
  /** The bundle the sandbox mounted. */
  bundle: string
  /** A test's own Telegram turn for the ouro arm. */
  runTurn?: typeof runTelegramTurn
  /** A test's own arms, in place of `H_ARMS`. */
  arms?: Readonly<Record<string, HArmRunner>>
}): Promise<GuestOutcome> {
  emitNervesEvent({ component: "eval", event: "eval.h_guest_start", message: "H guest starting a conversation", meta: {} })
  const channel = createStreamChannel(input.stdin, input.stdout)
  let outcome: GuestOutcome
  try {
    const turn = readTurnFile(input.turnFile)
    const arms = input.arms ?? (input.runTurn ? { ...H_ARMS, ouro: ouroArm(input.runTurn) } : H_ARMS)
    const arm = Object.hasOwn(arms, turn.arm) ? arms[turn.arm] : undefined
    if (!arm) throw new Error(`no H arm ${turn.arm} in the guest`)
    const providerRuntime = await createProxyRuntime(channel)
    outcome = { ok: true, result: await arm({ turn, bundle: input.bundle, providerRuntime }) }
    emitNervesEvent({ component: "eval", event: "eval.h_guest_end", message: "H guest finished its conversation", meta: { arm: turn.arm } })
  } catch (error) {
    outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }
    emitNervesEvent({ component: "eval", level: "error", event: "eval.h_guest_error", message: "H guest could not run its conversation", meta: { error: outcome.error } })
  }
  channel.send({ type: "done", outcome })
  await new Promise<void>((resolve) => input.stdout.write("", () => resolve()))
  return outcome
}
