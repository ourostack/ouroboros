// How the mailbox tells the agent that owns it about a letter: a note in its own private runtime, then a wake so it
// reads the note now. A wake that fails leaves the note queued for the agent's next private turn, so it is never lost.
import { getPrivateRuntimePendingDir, queuePendingMessageOnce } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"

export interface AgentNote {
  content: string
  /** With the timestamp, names the note in the queue, so telling twice is one note. */
  packetId: string
  timestamp: number
}

export type WakeAnswer = { ok: boolean; error?: string; message?: string; data?: unknown }

/** Queues the note and wakes the agent: null once it is woken, or why the wake failed. A failed queue throws. */
export async function queueNoteAndWake(agent: string, agentRoot: string, note: AgentNote, wake: () => Promise<WakeAnswer>): Promise<string | null> {
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agent, agentRoot), {
    from: agent, friendId: "self", channel: "inner", key: "dialog", content: note.content, timestamp: note.timestamp, packetId: note.packetId,
  })
  let problem: string | null = null
  try {
    const answer = await wake()
    // A wake policy denies still answers ok; only an executable decision woke the agent.
    if (!answer.ok) problem = answer.error ?? "the wake was refused"
    else if ((answer.data as { decision?: { executable?: unknown } } | undefined)?.decision?.executable === false) problem = answer.message ?? "the wake was denied"
  } catch (error) {
    problem = (error as Error).message
  }
  emitNervesEvent({ level: "debug", component: "daemon", event: "letters.agent_note_queued", message: "a mailbox note was queued for the agent", meta: { packetId: note.packetId, woken: problem === null } })
  return problem
}
