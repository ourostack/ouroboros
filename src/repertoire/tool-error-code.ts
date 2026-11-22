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
