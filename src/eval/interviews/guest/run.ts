/**
 * What runs in the agent container for a U or X interview conversation (`interview-guest-entry.js`): the neutral loop
 * with one arm's tools, its provider served by the host over stdin and stdout as in the eval's own guest. The turn
 * file names the arm and gives the label line, the case's conversation and the user messages; the system prompt is
 * the Butler's persona from the mounted bundle (the same in every arm) and the label line.
 *
 * The answer is the conversation's timeline and, per user turn, where it starts, its final reply and its outcome. The
 * first turn's reply and outcome are the job's, so the eval's readback scores it unchanged.
 */
import fs from "node:fs"
import path from "node:path"
import type { Readable, Writable } from "node:stream"
import type OpenAI from "openai"
import { emitNervesEvent } from "../../../nerves/runtime"
import { createProxyRuntime, createStreamChannel, type GuestOutcome } from "../../transport/provider-proxy"
import type { Product } from "../protocol"
import { buildArm, type Arm } from "./arms"
import { booksCore, type BooksCore } from "./books-core"
import { messageOf, runConversation } from "./loop"

export type InterviewTurnFile = {
  product: Product
  arm: string
  labelLine: string
  prefix: OpenAI.ChatCompletionMessageParam[]
  userText: string
  followUps: string[]
}

/** The persona's files, in the order the system prompt puts them. */
export const PERSONA_FILES = ["IDENTITY.md", "SOUL.md", "LORE.md", "ASPIRATIONS.md", "TACIT.md"]
/** The household's names, the same in every arm: the eval's synthetic owner, and the Butler's own name. */
const HOUSE_NAMES: Readonly<Record<string, string>> = { owner: "Ari", butler: "Butler", household: "the household" }

export function personaPrompt(bundle: string): string {
  const parts = PERSONA_FILES.map((name) => path.join(bundle, "psyche", name)).filter((file) => fs.existsSync(file)).map((file) => fs.readFileSync(file, "utf8").trim())
  return parts.join("\n\n").replace(/\{\{(owner|butler|household)\}\}/g, (_match, key: string) => HOUSE_NAMES[key]!)
}

function readTurnFile(file: string): InterviewTurnFile {
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<InterviewTurnFile>
  if (typeof value.product !== "string" || typeof value.arm !== "string" || typeof value.labelLine !== "string" || !Array.isArray(value.prefix)
    || typeof value.userText !== "string" || !Array.isArray(value.followUps)) {
    throw new Error(`${file} needs product, arm, labelLine, prefix, userText and followUps`)
  }
  return value as InterviewTurnFile
}

/** What an arm builder gets: the mounted bundle, and the books core when a test gives its own. */
export type ArmContext = { bundle: string; core?: BooksCore }
export type ArmBuilder = (arm: string, context: ArmContext) => Arm

/** Each product's arm builder in the guest; a product without one is refused. */
export const ARM_BUILDERS: Partial<Record<Product, ArmBuilder>> = {
  X: (arm, context) => buildArm(arm, context.core ?? booksCore({ home: path.join(context.bundle, "books") })),
}

export async function runInterviewGuest(input: { stdin: Readable; stdout: Writable; turnFile: string; bundle: string; core?: BooksCore; builders?: Partial<Record<Product, ArmBuilder>> }): Promise<GuestOutcome> {
  emitNervesEvent({ component: "eval", event: "eval.interview_guest_start", message: "interview guest starting a conversation", meta: {} })
  const channel = createStreamChannel(input.stdin, input.stdout)
  let outcome: GuestOutcome
  try {
    const turn = readTurnFile(input.turnFile)
    const builders = input.builders ?? ARM_BUILDERS
    const builder = Object.hasOwn(builders, turn.product) ? builders[turn.product] : undefined
    if (!builder) throw new Error(`no arms for product ${turn.product} in the guest`)
    const arm = builder(turn.arm, { bundle: input.bundle, ...(input.core ? { core: input.core } : {}) })
    const runtime = await createProxyRuntime(channel)
    const system = `${personaPrompt(input.bundle)}\n\n${turn.labelLine}`
    const conversation = await runConversation({ runtime, product: turn.product, system, prefix: turn.prefix, userTexts: [turn.userText, ...turn.followUps], arm })
    const job = conversation.turns[0]!
    // A product graded in the container grades once the whole conversation (the job and its debrief) has ended.
    // A grader that fails is the job's failure, reported as the grade, not the loss of the conversation.
    let grade: unknown
    try {
      grade = arm.grade ? await arm.grade() : undefined
    } catch (error) {
      grade = { error: messageOf(error) }
    }
    outcome = { ok: true, result: { timeline: conversation.timeline, finalReply: job.finalReply, outcome: job.outcome, turns: conversation.turns, ...(grade !== undefined ? { grade } : {}) } }
    emitNervesEvent({ component: "eval", event: "eval.interview_guest_end", message: "interview guest finished its conversation", meta: { turns: conversation.turns.length } })
  } catch (error) {
    outcome = { ok: false, error: messageOf(error) }
    emitNervesEvent({ component: "eval", level: "error", event: "eval.interview_guest_error", message: "interview guest could not run its conversation", meta: { error: outcome.error } })
  }
  channel.send({ type: "done", outcome })
  await new Promise<void>((resolve) => input.stdout.write("", () => resolve()))
  return outcome
}
