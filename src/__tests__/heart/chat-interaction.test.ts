import { describe, expect, it } from "vitest"

import { renderChatInteraction } from "../../heart/chat-interaction"

describe("renderChatInteraction", () => {
  it("says who wrote the reacted-to message when the sense knows", () => {
    expect(renderChatInteraction({ kind: "reaction", label: "❤️", removed: false, target: { text: "dinner at 7?", fromAgent: true } }))
      .toBe('reacted with ❤️ to your message: "dinner at 7?"')
    expect(renderChatInteraction({ kind: "reaction", label: "👍", removed: false, target: { text: "on my way", fromAgent: false } }))
      .toBe('reacted with 👍 to their message: "on my way"')
    expect(renderChatInteraction({ kind: "reaction", label: "😂", removed: false, target: { text: "a joke" } }))
      .toBe('reacted with 😂 to a message: "a joke"')
  })

  it("uses the app's own verb and reports removals", () => {
    expect(renderChatInteraction({ kind: "reaction", label: "love", verb: "loved", removed: false, target: { text: "hi", fromAgent: true } }))
      .toBe('loved your message: "hi"')
    expect(renderChatInteraction({ kind: "reaction", label: "👍", removed: true, target: { text: "hi", fromAgent: true } }))
      .toBe('removed their 👍 reaction from your message: "hi"')
  })

  it("names a missing referent plainly instead of guessing", () => {
    expect(renderChatInteraction({ kind: "reaction", label: "🔥", removed: false, target: { id: "42" } }))
      .toBe("reacted with 🔥 to an unidentified message (target 42; its text could not be resolved)")
    expect(renderChatInteraction({ kind: "reaction", label: "🔥", removed: false, target: {} }))
      .toBe("reacted with 🔥 to an unidentified message (the reaction carried no target message reference)")
  })

  it("shortens a long target to an excerpt", () => {
    const rendered = renderChatInteraction({ kind: "reaction", label: "👀", removed: false, target: { text: "x".repeat(200), fromAgent: true } })
    expect(rendered).toBe(`reacted with 👀 to your message: "${"x".repeat(77)}..."`)
  })

  it("shows an edit with or without the earlier text", () => {
    expect(renderChatInteraction({ kind: "edit", newText: "7:30 instead", previousText: "7 works", target: {} }))
      .toBe('edited their message: "7 works" → "7:30 instead"')
    expect(renderChatInteraction({ kind: "edit", newText: " 7:30 instead ", target: {} }))
      .toBe('edited their message to: "7:30 instead"')
    expect(renderChatInteraction({ kind: "edit", newText: "  ", previousText: "7 works", target: {} }))
      .toBe("edited their message (the new text could not be read)")
  })
})
