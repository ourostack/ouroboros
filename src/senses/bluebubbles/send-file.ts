import { emitNervesEvent } from "../../nerves/runtime"
import type { BlueBubblesChatRef } from "./model"
import type { BlueBubblesClient } from "./client"
import { readChatFile } from "../chat-file"

/** iMessage itself carries files far larger than this; the cap keeps one upload from tying up the turn. */
export const MAX_IMESSAGE_FILE_BYTES = 100_000_000

/** The shared send_file action on iMessage: the file, then its caption as a message of its own. */
export async function sendFileInBlueBubbles(client: BlueBubblesClient, chat: BlueBubblesChatRef, filePath: string, caption: string): Promise<string> {
  if (!client.sendAttachment) throw new Error("this iMessage connection can't send files.")
  const file = await readChatFile(filePath, MAX_IMESSAGE_FILE_BYTES)
  await client.sendAttachment({ chat, file })
  emitNervesEvent({ component: "senses", event: "senses.bluebubbles_file_sent", message: "sent a file over iMessage", meta: { contentType: file.contentType } })
  const text = caption.trim()
  if (text) await client.sendText({ chat, text })
  return `sent ${file.name}`
}
