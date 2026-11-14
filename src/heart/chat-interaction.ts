import { emitNervesEvent } from "../nerves/runtime"

// Every chat app lets people edit a message and react to one. Each sense maps its app's event to a ChatInteraction,
// and this file says it to the agent the same way everywhere. The agent always sees it and decides what to do.

/** The earlier message an edit or reaction points at. Text and authorship are whatever the sense could recover. */
export interface ChatMessageRef {
  id?: string
  text?: string
  /** True when the agent sent it, false when the person did, unknown otherwise. */
  fromAgent?: boolean
}

export type ChatInteraction =
  | {
      kind: "reaction"
      /** What the person reacted with: an emoji, or the app's name for it (iMessage's "love"). */
      label: string
      /** The app's own past-tense verb when it has one ("loved"); otherwise "reacted with <label>". */
      verb?: string
      removed: boolean
      target: ChatMessageRef
    }
  | { kind: "edit"; newText: string; previousText?: string; target: ChatMessageRef }

const EXCERPT_MAX_LENGTH = 80

function excerpt(text: string): string {
  return text.length > EXCERPT_MAX_LENGTH ? `${text.slice(0, EXCERPT_MAX_LENGTH - 3)}...` : text
}

function targetPhrase(target: ChatMessageRef, eventName: string): string {
  const text = target.text?.trim()
  if (text) {
    const owner = target.fromAgent === true ? "your" : target.fromAgent === false ? "their" : "a"
    return `${owner} message: "${excerpt(text)}"`
  }
  if (target.fromAgent === true) return "one of your messages (its text was not included)"
  // Say plainly that the referent is missing, so the agent can ask instead of guessing what was meant.
  return target.id
    ? `an unidentified message (target ${target.id}; its text could not be resolved)`
    : `an unidentified message (the ${eventName} carried no target message reference)`
}

/** The words the agent reads for an edit or a reaction. */
export function renderChatInteraction(interaction: ChatInteraction): string {
  emitNervesEvent({ component: "senses", event: "senses.chat_interaction_rendered", message: "chat interaction rendered for the agent", meta: { kind: interaction.kind } })
  if (interaction.kind === "edit") {
    const before = interaction.previousText?.trim()
    const after = interaction.newText.trim()
    if (!after) return "edited their message (the new text could not be read)"
    return before
      ? `edited their message: "${excerpt(before)}" → "${after}"`
      : `edited their message to: "${after}"`
  }
  const phrase = targetPhrase(interaction.target, "reaction")
  if (interaction.removed) return `removed their ${interaction.label} reaction from ${phrase}`
  return interaction.verb ? `${interaction.verb} ${phrase}` : `reacted with ${interaction.label} to ${phrase}`
}
