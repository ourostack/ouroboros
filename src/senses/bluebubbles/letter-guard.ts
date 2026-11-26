// Only Ouro writes letters into the person's chat (design §3.4, R5-5, R6-M1, R8-M2). The chat a letter is delivered
// to, the one-to-one chat with a handle in the agent's answering.json, takes no agent text that could pass for a
// letter code or Ouro's option block once folded, so the agent can't restate a letter in its own words and steer the
// answer. Only mailbox_deliver (and later the receipts) carry the mark that lets Ouro's own text through.
import * as path from "path"
import { checkAnsweringHandles, normalizeAnsweringHandle } from "../../heart/letters/answering"
import { hasLetterCode } from "../../heart/letters/letter"
import { LetterStore } from "../../heart/letters/store"
import { getPrivateRuntimePendingDir, queuePendingMessageOnce } from "../../mind/pending"
import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesChatRef } from "./model"

/** The mark on a send whose text Ouro rendered itself: a letter, or a receipt for one. */
export const OURO_LETTER_SEND: unique symbol = Symbol("ouro letter send")
export type OuroLetterSend = typeof OURO_LETTER_SEND

/**
 * The handles whose one-to-one chats letters go to, normalised: each person's handle in answering.json, and the
 * handle frozen on every letter still open, since its answer comes from that chat even after the person's handle
 * changes. Null when answering.json doesn't read, so the guard fails closed rather than off.
 */
export function answeringHandleSet(agentRoot: string): Set<string> | null {
  const lettersDir = path.join(agentRoot, "state", "letters")
  const current = checkAnsweringHandles(lettersDir)
  if (current === null) return null
  const frozen = new LetterStore(lettersDir).loadOpen().flatMap((stored) => stored.letter.answeringHandle ?? [])
  return new Set([...Object.values(current), ...frozen])
}

/** The handle in a one-to-one chat GUID (`iMessage;-;+1555…`), `group` for a group GUID (`;+;`), or null for neither. */
function guidHandle(raw: string | undefined): string | "group" | null {
  if (!raw) return null
  if (raw.includes(";+;")) return "group"
  const parts = raw.split(";-;")
  return parts.length === 2 ? parts[1] : null
}

/**
 * The handle of a one-to-one chat, normalised, or null for a group or a chat with no handle. Any field may carry a
 * chat GUID, since the client sends to an identifier that is a GUID as it is; the GUID's own shape decides whether
 * it is one-to-one, ahead of `isGroup`, which a display name alone can set.
 */
export function oneToOneHandle(chat: BlueBubblesChatRef): string | null {
  const target = chat.sendTarget.kind === "chat_identifier" ? chat.sendTarget.value : undefined
  const fields = [chat.chatGuid, chat.chatIdentifier, target]
  const fromGuid = fields.map(guidHandle).find((found) => found !== null)
  if (fromGuid === "group") return null
  if (fromGuid === undefined && chat.isGroup) return null
  const raw = fromGuid ?? fields.find((field) => field)
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
 * an edit can't turn a message into a letter. When answering.json doesn't read, every one-to-one chat counts.
 */
export function letterChatRefusal(input: { what: string; chat: BlueBubblesChatRef | null; text: string; mark?: OuroLetterSend }, agentRoot: string | (() => string)): string | null {
  if (input.mark === OURO_LETTER_SEND || !hasLetterCode(input.text)) return null
  // The agent's root is found only for text that names a code, which is rare.
  const handles = answeringHandleSet(typeof agentRoot === "string" ? agentRoot : agentRoot())
  if (handles !== null && handles.size === 0) return null
  if (input.chat === null) return refusal(input.what, null)
  const handle = oneToOneHandle(input.chat)
  if (handle === null) return null
  if (handles === null) return refusal(input.what, null)
  return handles.has(handle) ? refusal(input.what, handle) : null
}

/**
 * Tells the agent, in its private runtime, that its reply to a message was refused for naming a letter code. The
 * reply never left, so the person heard nothing until the agent says it again without the code.
 */
export function tellAgentReplyRefused(agent: string, agentRoot: string, messageGuid: string, refusalText: string): void {
  queuePendingMessageOnce(getPrivateRuntimePendingDir(agent, agentRoot), {
    from: agent,
    friendId: "self",
    channel: "inner",
    key: "dialog",
    content: `my iMessage reply wasn't sent, so they haven't heard back from me: ${refusalText}`,
    timestamp: Date.now(),
    packetId: `letter-guard:${messageGuid}`,
  })
}
