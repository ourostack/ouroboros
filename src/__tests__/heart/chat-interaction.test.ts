import { describe, expect, it } from "vitest"

import { renderChatInteraction, resolveChatInteractionTarget, resolveChatMessageRef, type ChatInteraction } from "../../heart/chat-interaction"

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

  it("still says the target was the agent's when only that is known", () => {
    expect(renderChatInteraction({ kind: "reaction", label: "👍", removed: false, target: { id: "7", fromAgent: true } }))
      .toBe("reacted with 👍 to one of your messages (its text was not included)")
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

describe("resolveChatInteractionTarget", () => {
  const tapback: ChatInteraction = { kind: "reaction", label: "love", verb: "loved", removed: false, target: { id: "guid ABC" } }

  it("names the reacted-to message from the sense's lookup, by the lookup id", async () => {
    const seen: string[] = []
    const named = await resolveChatInteractionTarget(tapback, (id) => { seen.push(id); return { text: "are voice notes working?", fromAgent: true } }, "ABC")
    expect(seen).toEqual(["ABC"])
    expect(renderChatInteraction(named)).toBe('loved your message: "are voice notes working?"')
  })

  it("looks up by the shown id when no lookup id is given, and accepts async lookups", async () => {
    const named = await resolveChatInteractionTarget({ kind: "reaction", label: "👍", removed: false, target: { id: "9" } }, async (id) => ({ text: `message ${id}`, fromAgent: false }))
    expect(renderChatInteraction(named)).toBe('reacted with 👍 to their message: "message 9"')
  })

  it("keeps what the sense already knew and never asks again", async () => {
    const known: ChatInteraction = { kind: "reaction", label: "👍", removed: false, target: { id: "1", text: "known" } }
    let asked = false
    expect(await resolveChatInteractionTarget(known, () => { asked = true; return null })).toBe(known)
    expect(asked).toBe(false)
  })

  it("lets the sense's own authorship win over the lookup's", async () => {
    const ref = await resolveChatMessageRef({ id: "1", fromAgent: true }, () => ({ text: "hi", fromAgent: false }))
    expect(ref).toEqual({ id: "1", text: "hi", fromAgent: true })
    expect(await resolveChatMessageRef({ id: "1" }, () => ({ text: "hi" }))).toEqual({ id: "1", text: "hi" })
  })

  it("returns the interaction unchanged when there is nothing to look up or nothing is found", async () => {
    const bare: ChatInteraction = { kind: "reaction", label: "👍", removed: false, target: {} }
    expect(await resolveChatInteractionTarget(bare, () => ({ text: "never" }))).toBe(bare)
    expect(await resolveChatInteractionTarget(tapback, () => null)).toBe(tapback)
    expect(await resolveChatInteractionTarget(tapback, () => ({ text: "   " }))).toBe(tapback)
  })

  it("treats a failing lookup as unknown, so the agent hears the message could not be resolved", async () => {
    const thrown = await resolveChatInteractionTarget(tapback, () => { throw new Error("server down") })
    expect(renderChatInteraction(thrown)).toBe("loved an unidentified message (target guid ABC; its text could not be resolved)")
    const rejected = await resolveChatInteractionTarget(tapback, () => Promise.reject("nope"))
    expect(rejected).toBe(tapback)
  })
})
