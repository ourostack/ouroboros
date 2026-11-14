import { describe, expect, it, vi } from "vitest"

import { reactInBlueBubbles } from "../../../senses/bluebubbles/reactions"

const chat = { chatGuid: "any;-;someone@example.test", isGroup: false, sessionKey: "chat:any;-;someone@example.test", sendTarget: { kind: "chat_guid", value: "any;-;someone@example.test" } } as never

describe("reactInBlueBubbles", () => {
  it("sends the tapback an emoji or tapback name means", async () => {
    const react = vi.fn(async () => undefined)
    const client = { react } as never
    expect(await reactInBlueBubbles(client, chat, "❤️", "m1")).toBe("reacted with ❤️")
    expect(await reactInBlueBubbles(client, chat, "😂", "m1")).toBe("reacted with 😂")
    expect(await reactInBlueBubbles(client, chat, "question", "m1")).toBe("reacted with question")
    expect(react.mock.calls.map(([params]: any[]) => params.reaction)).toEqual(["love", "laugh", "question"])
    expect((react.mock.calls[0] as any[])[0]).toEqual({ chat, messageGuid: "m1", reaction: "love" })
  })

  it("names the tapbacks iMessage has when asked for another emoji, and says when the connection can't react", async () => {
    const react = vi.fn()
    expect(await reactInBlueBubbles({ react } as never, chat, "🔥", "m1")).toBe("iMessage reactions I can send are ❤️ 👍 👎 😂 ‼️ ❓; 🔥 isn't one of them.")
    expect(react).not.toHaveBeenCalled()
    expect(await reactInBlueBubbles({} as never, chat, "👍", "m1")).toBe("this iMessage connection can't send reactions.")
  })
})
