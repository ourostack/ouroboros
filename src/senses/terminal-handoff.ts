/**
 * Lets a hidden terminal prompt (for example the hatchling vault unlock secret) borrow the
 * terminal from a live full-screen session. While the prompt runs, the session's owner stops
 * repainting and stops reading stdin, so the prompt is visible and keystrokes reach only it.
 */
import { emitNervesEvent } from "../nerves/runtime"

export interface TerminalOwner {
  /** Stop repainting and release stdin. Resolves once nothing else reads keystrokes. */
  suspend(): Promise<void>
  /** Take the terminal back. */
  resume(): void
}

let currentOwner: TerminalOwner | null = null

/** Register the live session that owns the terminal. Returns a release function. */
export function claimTerminal(owner: TerminalOwner): () => void {
  currentOwner = owner
  return () => {
    if (currentOwner === owner) currentOwner = null
  }
}

/** Run `prompt` with the terminal handed to it, then give the terminal back. */
export async function withTerminalHandedOff<T>(prompt: () => Promise<T>): Promise<T> {
  const owner = currentOwner
  if (!owner) return prompt()
  emitNervesEvent({
    component: "senses",
    event: "senses.terminal_handed_off",
    message: "live session suspended for a terminal prompt",
    meta: {},
  })
  await owner.suspend()
  try {
    return await prompt()
  } finally {
    owner.resume()
    emitNervesEvent({
      component: "senses",
      event: "senses.terminal_taken_back",
      message: "live session resumed after a terminal prompt",
      meta: {},
    })
  }
}
