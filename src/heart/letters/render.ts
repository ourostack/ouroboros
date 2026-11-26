// How a letter reads in chat (design §3.4): plain text the harness writes, never the agent. The sender's fields
// were checked and collapsed to one line each when the letter was filed, so nothing here can fake the option block.
import { emitNervesEvent } from "../../nerves/runtime"
import { LINE_ANCHOR, type Letter } from "./letter"

/** The fixed line above the harness's own option block; sender text containing it is refused at filing. */
export const OPTIONS_LINE = "Options (from Ouro):"

/** A heads-up tells; every other kind asks. */
const VERB: Readonly<Record<Letter["kind"], string>> = { decide: "asks", do: "asks", accept: "asks", know: "says" }

function agentName(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1)
}

/** The answers a person can send, in the form the reader accepts: `"L7 1"`, `"L7 1" or "L7 2"`, and so on. */
function replyLine(letter: Letter): string {
  const answers = letter.options.map((option) => `"${letter.code} ${option.id}"`)
  const spoken = answers.length === 1 ? answers[0] : `${answers.slice(0, -1).join(", ")} or ${answers.at(-1)}`
  return `Reply ${spoken}.`
}

/**
 * The letter as the person reads it. A link shows its label and address; a line anchor is dropped from the
 * address, so the chat never shows a code-shaped `#L12` beside the letter's own code.
 */
export function renderLetter(letter: Letter): string {
  const lines = [`${letter.code} · ${agentName(letter.from.agent)} ${VERB[letter.kind]}: ${letter.subject}`]
  if (letter.whyOnlyYou) lines.push(letter.whyOnlyYou)
  if (letter.body) lines.push(letter.body)
  for (const link of letter.links) lines.push(`${link.label}: ${link.url.replace(LINE_ANCHOR, "")}`)
  lines.push(OPTIONS_LINE)
  for (const option of letter.options) lines.push(`${option.id} ${option.label} — ${option.effect}`)
  lines.push(replyLine(letter))
  const text = lines.join("\n")
  emitNervesEvent({ component: "daemon", event: "letters.rendered", message: "a letter was rendered for chat", meta: { code: letter.code, lines: lines.length } })
  return text
}
