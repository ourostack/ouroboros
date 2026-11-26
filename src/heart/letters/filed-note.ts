// Filing a letter tells the agent that owns the mailbox (design §3.3: "Letter L7 from <lane>: <subject>"), so it can
// decide whether and when its person sees the letter. The note goes to the agent's own private runtime, the way a
// habit that can't run tells it, and a wake has the agent read it now. It is the harness speaking, never the person.
import * as path from "path"
import { getPrivateRuntimePendingDir, queuePendingMessageOnce } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"
import type { Letter } from "./letter"

/** The note in the agent's own words, the way its private runtime notes read. */
export function letterFiledNote(letter: Letter): string {
  // The lane and subject are the sender's words, quoted as theirs, so they can't read as the agent's own thought.
  const from = letter.from.lane ? ` from the lane ${JSON.stringify(letter.from.lane)}` : ""
  const hold = letter.holdUntil ? `, held until ${letter.holdUntil}` : ""
  const chat = letter.answeringHandle
    ? "mailbox_deliver sends it to their chat"
    : "it can't go to their chat, since they had no answering handle when it was filed"
  return `letter ${letter.code}${from} was filed (${letter.kind}, ${letter.urgency}${hold}); its sender gave it the subject ${JSON.stringify(letter.subject)}. it waits for my person's answer. i decide whether and when they see it: ${chat}; mailbox_read shows it.`
}

/** The private-runtime wake for one filed letter; its idempotency key makes a repeat a duplicate. */
export function letterFiledWake(agent: string, letter: Letter) {
  return {
    kind: "private.wake" as const,
    agent,
    reason: `letter ${letter.code} filed`,
    triggerSource: "letter-filed",
    budgetClass: "interactive",
    idempotencyKey: `letter-filed:${agent}:${letter.id}`,
    originRefs: [{ kind: "letter", id: letter.id }, { kind: "daemon-command", id: "letters.file" }],
  }
}

/**
 * Queues the note for the agent and wakes it. A wake that fails leaves the note queued for the agent's next private
 * turn, so the letter is never lost to it; the failure is logged.
 */
export async function tellAgentLetterFiled(
  agent: string,
  agentRoot: string,
  letter: Letter,
  wake: (command: ReturnType<typeof letterFiledWake>) => Promise<{ ok: boolean; error?: string; message?: string; data?: unknown }>,
): Promise<void> {
  // The queue names a note by its timestamp and packet id, so the letter's own filing time makes a repeat one note.
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agent, agentRoot), {
    from: agent,
    friendId: "self",
    channel: "inner",
    key: "dialog",
    content: letterFiledNote(letter),
    timestamp: Date.parse(letter.createdAt),
    packetId: `letter-filed:${letter.id}`,
  })
  try {
    const answer = await wake(letterFiledWake(agent, letter))
    if (!answer.ok) throw new Error(answer.error ?? "the wake was refused")
    // A wake policy denies still answers ok; only an executable decision woke the agent.
    if ((answer.data as { decision?: { executable?: unknown } } | undefined)?.decision?.executable === false) throw new Error(answer.message ?? "the wake was denied")
    emitNervesEvent({ component: "daemon", event: "letters.filed_told", message: "the agent was told a letter was filed", meta: { code: letter.code } })
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "daemon", event: "letters.filed_wake_failed", message: "a filed letter's note waits for the agent's next private turn", meta: { code: letter.code, error: (error as Error).message } })
  }
}

/** The daemon's onFiled: each agent hears through its own bundle's private runtime. */
export function letterFiledTeller(
  bundlesRoot: string,
  wake: Parameters<typeof tellAgentLetterFiled>[3],
): (agent: string, letter: Letter) => Promise<void> {
  return (agent, letter) => tellAgentLetterFiled(agent, path.join(bundlesRoot, `${agent}.ouro`), letter, wake)
}
