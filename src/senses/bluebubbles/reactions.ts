import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesChatRef } from "./model"
import type { BlueBubblesClient, BlueBubblesTapback } from "./client"

// iMessage has six classic tapbacks. The agent asks with an emoji; this picks the tapback that emoji means.
const TAPBACKS: Readonly<Record<string, BlueBubblesTapback>> = {
  "❤️": "love", "❤": "love", "👍": "like", "👎": "dislike", "😂": "laugh", "‼️": "emphasize", "‼": "emphasize", "❓": "question",
}

export async function reactInBlueBubbles(client: BlueBubblesClient, chat: BlueBubblesChatRef, emoji: string, messageGuid: string): Promise<string> {
  const reaction = TAPBACKS[emoji] ?? (Object.values(TAPBACKS).includes(emoji as BlueBubblesTapback) ? emoji as BlueBubblesTapback : undefined)
  if (!reaction) return `iMessage reactions I can send are ❤️ 👍 👎 😂 ‼️ ❓; ${emoji} isn't one of them.`
  if (!client.react) return "this iMessage connection can't send reactions."
  await client.react({ chat, messageGuid, reaction })
  emitNervesEvent({ component: "senses", event: "senses.bluebubbles_reaction_sent", message: "sent an iMessage reaction", meta: { reaction } })
  return `reacted with ${emoji}`
}
