/**
 * An error text a tool or the dispatcher returns, ending with the code its Ouro AX card names, so a model can look up
 * the card's fix. The message stays first and unchanged; the code is a suffix. Pass the code as a literal: the AX
 * census counts a card's code as raised only where it appears in the handler's file.
 *
 * It lives apart from tools-base so a tool module can use it without importing tools-base, which imports every tool
 * module and so can't be loaded from one.
 */
export function withCode(message: string, code: string): string {
  return `${message} (code: ${code})`
}

/** A tool call's typed outcome, as the Ouro AX X-ray reads it: an ax-outcome state, the text, and the card's code. */
export interface TypedToolOutcome {
  state: "done" | "refused" | "failed" | "uncertain"
  text: string
  code?: string
}

const STATE_OF = {
  handler_succeeded: "done",
  rejected_before_handler: "refused",
  handler_failed: "failed",
  handler_indeterminate: "uncertain",
} as const

/**
 * The dispatcher's outcome as a typed one: refused before the handler ran, failed, or uncertain when a high-risk call
 * failed partway and nobody can say what it did. The code is the one `withCode` put at the end of the text.
 */
export function typedOutcome(outcome: { kind: keyof typeof STATE_OF; text: string }): TypedToolOutcome {
  const state = STATE_OF[outcome.kind]
  const code = state === "done" ? undefined : /\(code: ([a-z0-9-]+)\)$/.exec(outcome.text)?.[1]
  return code ? { state, text: outcome.text, code } : { state, text: outcome.text }
}
