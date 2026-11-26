import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { writeAnsweringHandle } from "../../../heart/letters/answering"
import { sendFileInBlueBubbles } from "../../../senses/bluebubbles/send-file"
import type { BlueBubblesClient } from "../../../senses/bluebubbles/client"

const chat = { chatGuid: "iMessage;-;friend", isGroup: false, sessionKey: "chat:friend", sendTarget: { kind: "chat_guid", value: "iMessage;-;friend" }, participantHandles: [] } as any

function fixture(name: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bb-send-file-"))
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents)
  return file
}

describe("sendFileInBlueBubbles", () => {
  it("sends the file, then its caption as a message of its own", async () => {
    const sendAttachment = vi.fn(async () => undefined)
    const sendText = vi.fn(async () => ({ messageGuid: "m" }))
    const client = { sendAttachment, sendText } as unknown as BlueBubblesClient
    expect(await sendFileInBlueBubbles(client, chat, fixture("menu.pdf", "%PDF"), "  tonight's menu  ", "/no/root")).toBe("sent menu.pdf")
    expect(sendAttachment).toHaveBeenCalledWith({ chat, file: { name: "menu.pdf", contentType: "application/pdf", bytes: Buffer.from("%PDF") } })
    expect(sendText).toHaveBeenCalledWith({ chat, text: "tonight's menu" })
    sendText.mockClear()
    expect(await sendFileInBlueBubbles(client, chat, fixture("photo.JPG", "jpg"), " ", "/no/root")).toBe("sent photo.JPG")
    expect(sendText).not.toHaveBeenCalled()
  })

  it("refuses a caption naming a letter code in the letters chat before the file goes", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bb-send-file-root-"))
    writeAnsweringHandle(path.join(agentRoot, "state", "letters"), "friend-ari", "ari@x.io")
    const sendAttachment = vi.fn(async () => undefined)
    const client = { sendAttachment, sendText: vi.fn() } as unknown as BlueBubblesClient
    const pinned = { ...chat, chatGuid: "iMessage;-;ari@x.io" }
    await expect(sendFileInBlueBubbles(client, pinned, fixture("a.png", "x"), "re L7", agentRoot)).rejects.toThrow(/^This caption names a letter code/)
    expect(sendAttachment).not.toHaveBeenCalled()
    expect(await sendFileInBlueBubbles(client, pinned, fixture("a.png", "x"), "", agentRoot)).toBe("sent a.png")
    fs.rmSync(agentRoot, { recursive: true, force: true })
  })

  it("fails when this connection can't send files", async () => {
    await expect(sendFileInBlueBubbles({} as BlueBubblesClient, chat, "/nowhere", "", "/no/root")).rejects.toThrow("this iMessage connection can't send files.")
  })
})
