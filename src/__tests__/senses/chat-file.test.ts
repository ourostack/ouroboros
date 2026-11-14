import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { readChatFile } from "../../senses/chat-file"

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-file-"))

function write(name: string, contents: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, contents)
  return file
}

describe("readChatFile", () => {
  it("reads the file with its name and a content type from its extension", async () => {
    expect(await readChatFile(write("Photo.PNG", "png"), 100)).toEqual({ name: "Photo.PNG", contentType: "image/png", bytes: Buffer.from("png") })
    expect((await readChatFile(write("notes.unknownext", "x"), 100)).contentType).toBe("application/octet-stream")
  })

  it("refuses a folder, an empty file, and a file larger than the chat takes", async () => {
    await expect(readChatFile(dir, 100)).rejects.toThrow(`${dir} is not a file`)
    const empty = write("empty.txt", "")
    await expect(readChatFile(empty, 100)).rejects.toThrow(`${empty} is empty`)
    await expect(readChatFile(write("big.pdf", "x".repeat(2_500_000)), 1_000_000)).rejects.toThrow("big.pdf is 2.5 MB; this chat takes files up to 1.0 MB")
  })
})
