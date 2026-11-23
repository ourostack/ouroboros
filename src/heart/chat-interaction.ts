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

/**
 * How a sense finds an earlier message from the id its app sends: its own record of what the agent sent, or its app's
 * history. Returns what it knows, or null when it does not know the message. It may throw; the resolver treats that as unknown.
 */
export type ChatMessageLookup = (id: string) => Promise<Omit<ChatMessageRef, "id"> | null> | Omit<ChatMessageRef, "id"> | null

/**
 * Fill in the message a reaction or edit points at, so the agent reads what was reacted to instead of a bare id.
 * Every sense calls this with its own lookup; what the sense already knows wins over the lookup. A lookup that fails
 * leaves the target as it was, and the renderer then says plainly that the message could not be found.
 */
export async function resolveChatMessageRef(
  target: ChatMessageRef,
  lookup: ChatMessageLookup,
  /** The id to look up when it differs from the one shown to the agent (BlueBubbles shows "guid X"). */
  lookupId: string | undefined = target.id,
): Promise<ChatMessageRef> {
  if (target.text?.trim() || !lookupId) return target
  let found: Omit<ChatMessageRef, "id"> | null = null
  try {
    found = await lookup(lookupId)
  } catch (error) {
    emitNervesEvent({ level: "warn", component: "senses", event: "senses.chat_interaction_target_lookup_failed", message: "could not look up the message a reaction or edit points at", meta: { reason: error instanceof Error ? error.message : String(error) } })
  }
  const text = found?.text?.trim()
  emitNervesEvent({ component: "senses", event: "senses.chat_interaction_target_resolved", message: "looked up the message a reaction or edit points at", meta: { found: Boolean(text) } })
  if (!text) return target
  const fromAgent = target.fromAgent ?? found?.fromAgent
  return { ...target, text, ...(typeof fromAgent === "boolean" ? { fromAgent } : {}) }
}

/** `resolveChatMessageRef` for a whole interaction; returns the same object when nothing was found. */
export async function resolveChatInteractionTarget(
  interaction: ChatInteraction,
  lookup: ChatMessageLookup,
  lookupId?: string,
): Promise<ChatInteraction> {
  const target = await resolveChatMessageRef(interaction.target, lookup, lookupId ?? interaction.target.id)
  return target === interaction.target ? interaction : { ...interaction, target }
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
