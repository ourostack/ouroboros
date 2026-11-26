// What happens once a person's answer is recorded (design §3.4, "Visibility"): the harness sends them a one-line
// receipt in the letters chat, so a misread answer shows at once, and tells the owning agent in its private runtime.
// Both run after the answer is recorded and never undo it; a failure is logged.
import * as path from "path"
import { getPrivateRuntimePendingDir, queuePendingMessageOnce } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Letter } from "./letter"

export interface RecordedAnswer {
  option: string
  label: string
  note?: string
  messageGuid: string
}

/** The receipt the person sees: "Recorded L7 Which name? → 2 Ouro". Only Ouro writes it, so it may name the code. */
export function answerReceipt(letter: Letter, answer: RecordedAnswer): string {
  return `Recorded ${letter.code} ${letter.subject} → ${answer.option} ${answer.label}`
}

/** The agent's note; the subject, label and note are other people's words, so they are quoted as theirs. */
export function letterAnsweredNote(letter: Letter, answer: RecordedAnswer): string {
  const note = answer.note ? `, with the note ${JSON.stringify(answer.note)}` : ""
  return `my person answered letter ${letter.code} (its sender's subject: ${JSON.stringify(letter.subject)}) with option ${answer.option}, ${JSON.stringify(answer.label)}${note}. mailbox_read shows it.`
}

export function letterAnsweredWake(agent: string, letter: Letter) {
  return {
    kind: "private.wake" as const,
    agent,
    reason: `letter ${letter.code} answered`,
    triggerSource: "letter-answered",
    budgetClass: "interactive",
    idempotencyKey: `letter-answered:${agent}:${letter.id}`,
    originRefs: [{ kind: "letter", id: letter.id }, { kind: "daemon-command", id: "letters.answer" }],
  }
}

type Wake = (command: ReturnType<typeof letterAnsweredWake>) => Promise<{ ok: boolean; error?: string; message?: string; data?: unknown }>
type SendReceipt = (request: { agent: string; handle: string; text: string }) => Promise<unknown>

export async function tellLetterAnswered(agent: string, agentRoot: string, letter: Letter, answer: RecordedAnswer, sendReceipt: SendReceipt | undefined, wake: Wake): Promise<void> {
  if (sendReceipt && letter.answeringHandle) {
    try {
      await sendReceipt({ agent, handle: letter.answeringHandle, text: answerReceipt(letter, answer) })
      emitNervesEvent({ component: "daemon", event: "letters.receipt_sent", message: "the person was sent a receipt for their answer", meta: { code: letter.code } })
    } catch (error) {
      emitNervesEvent({ level: "warn", component: "daemon", event: "letters.receipt_failed", message: "the receipt for an answer didn't send; the answer stands", meta: { code: letter.code, error: (error as Error).message } })
    }
  }
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agent, agentRoot), {
    from: agent,
    friendId: "self",
    channel: "inner",
    key: "dialog",
    content: letterAnsweredNote(letter, answer),
    timestamp: Date.now(),
    packetId: `letter-answered:${letter.id}`,
  })
  try {
    const woke = await wake(letterAnsweredWake(agent, letter))
    if (!woke.ok) throw new Error(woke.error ?? "the wake was refused")
    if ((woke.data as { decision?: { executable?: unknown } } | undefined)?.decision?.executable === false) throw new Error(woke.message ?? "the wake was denied")
    emitNervesEvent({ component: "daemon", event: "letters.answered_told", message: "the agent was told its letter was answered", meta: { code: letter.code } })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "letters.answered_wake_failed", message: "an answered letter's note waits for the agent's next private turn", meta: { code: letter.code, error: (error as Error).message } })
  }
}

/** The daemon's onAnswered, over each agent's own bundle. */
export function letterAnsweredTeller(bundlesRoot: string, sendReceipt: SendReceipt | undefined, wake: Wake) {
  return (agent: string, letter: Letter, answer: RecordedAnswer) => tellLetterAnswered(agent, path.join(bundlesRoot, `${agent}.ouro`), letter, answer, sendReceipt, wake)
}
