// Only Ouro writes letters into the person's chat (design §3.4, R5-5, R6-M1, R8-M2). The chat a letter is delivered
// to, the one-to-one chat with a handle in the agent's answering.json, takes no agent text that could pass for a
// letter code or Ouro's option block once folded, so the agent can't restate a letter in its own words and steer the
// answer. Only mailbox_deliver (and later the receipts) carry the mark that lets Ouro's own text through.
import * as path from "path"
import { normalizeAnsweringHandle, readAnsweringHandles } from "../../heart/letters/answering"
import { hasLetterCode } from "../../heart/letters/letter"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesChatRef } from "./model"

/** The mark on a send whose text Ouro rendered itself: a letter, or a receipt for one. */
export const OURO_LETTER_SEND: unique symbol = Symbol("ouro letter send")
export type OuroLetterSend = typeof OURO_LETTER_SEND

/** The handles whose one-to-one chats letters go to, normalised. */
export function answeringHandleSet(agentRoot: string): Set<string> {
  return new Set(Object.values(readAnsweringHandles(path.join(agentRoot, "state", "letters"))))
}

/** The handle of a one-to-one chat, normalised, or null for a group or a chat with no handle. */
export function oneToOneHandle(chat: BlueBubblesChatRef): string | null {
  if (chat.isGroup) return null
  const fromGuid = chat.chatGuid?.split(";-;")[1]
  const fromTarget = chat.sendTarget.kind === "chat_identifier" ? chat.sendTarget.value : undefined
  const raw = fromGuid ?? chat.chatIdentifier ?? fromTarget
  if (!raw) return null
  const checked = normalizeAnsweringHandle(raw)
  return checked.ok ? checked.handle : null
}

function refusal(what: string, handle: string | null): string {
  emitNervesEvent({ level: "warn", component: "senses", event: "senses.bluebubbles_letter_guard", message: "agent text that could pass for a letter was refused", meta: { what, pinned: handle !== null } })
  return `This ${what} names a letter code or Ouro's option block, which only Ouro writes${handle ? ` in ${handle}'s letters chat` : " where letters go"}. Refer to the letter by its subject instead.`
}

/**
 * Why agent text bound for a letters chat is refused, when it folds to a letter code or the option block, or null to
 * let it through. `chat` is null when the send doesn't say its chat (an edit), and then any letters chat counts, so
 * an edit can't turn a message into a letter.
 */
export function letterChatRefusal(input: { what: string; chat: BlueBubblesChatRef | null; text: string; mark?: OuroLetterSend }, agentRoot: string): string | null {
  if (input.mark === OURO_LETTER_SEND || !hasLetterCode(input.text)) return null
  const handles = answeringHandleSet(agentRoot)
  if (handles.size === 0) return null
  if (input.chat === null) return refusal(input.what, null)
  const handle = oneToOneHandle(input.chat)
  return handle !== null && handles.has(handle) ? refusal(input.what, handle) : null
}
