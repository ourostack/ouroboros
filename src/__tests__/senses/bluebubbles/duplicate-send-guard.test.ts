// Regression test for the 2026-05-08 06:18 class of duplicate-send incidents.
//
// Symptom: a single inbound BlueBubbles message produced four near-identical
// outward replies in the same minute. The agent looped through speak/settle
// boundaries multiple times within one inbound turn and each pass delivered a
// fresh iMessage to the friend. PR #690's meta-leakage guard does not cover
// this — these were ordinary outward answers, not internal text.
//
// The guard added by this fix is per-turn: a single createBlueBubblesCallbacks
// lifetime corresponds to one inbound turn, and within that lifetime identical
// outward text bodies are sent at most once. Distinct content is unaffected.

import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../senses/commands", () => ({
  getDebugMode: () => false,
}))

import { createBlueBubblesCallbacks } from "../../../senses/bluebubbles/index"
import { emitNervesEvent } from "../../../nerves/runtime"

type SendTextArgs = { chat: unknown; text: string; replyToMessageGuid?: string }

function makeStubClient() {
  const sendText = vi.fn(async (_args: SendTextArgs) => ({ messageGuid: "g" }))
  const setTyping = vi.fn(async () => undefined)
  const markChatRead = vi.fn(async () => undefined)
  return {
    client: {
      sendText,
      setTyping,
      markChatRead,
      // Unused stubs — satisfy structural shape without pulling the real client.
      editMessage: vi.fn(),
      checkHealth: vi.fn(),
      listRecentMessages: vi.fn(),
      repairEvent: vi.fn(),
      getMessageText: vi.fn(),
    },
    sendText,
  }
}

const TOP_LEVEL_REPLY_TARGET = {
  getReplyToMessageGuid: () => undefined,
  setSelection: () => "noop",
}

const CHAT = { chatGuid: "iMessage;-;+15555550100" }

describe("BlueBubbles duplicate outward send guard (2026-05-08 06:18 incident)", () => {
  it("delivers identical outward text only once across mid-turn flushes", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    // First speak: agent commits an outward draft mid-turn.
    callbacks.onTextChunk("here is what I think")
    await callbacks.flushNow!()

    // Second speak with the SAME body — the bug class. Could come from:
    // a settle retry-rejected after speak, the agent re-emitting the same
    // line; or a tool-boundary refinement that ends up with the same text.
    callbacks.onTextChunk("here is what I think")
    await callbacks.flushNow!()

    // End-of-turn flush with the same body again.
    callbacks.onTextChunk("here is what I think")
    await callbacks.flush()

    const outwardSends = sendText.mock.calls.filter((call) => call[0]?.text === "here is what I think")
    expect(outwardSends).toHaveLength(1)

    // Surfacing the suppression as a nerves event keeps the regression
    // observable to operators after the guard fires.
    const suppressed = (emitNervesEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.event === "bluebubbles.duplicate_outward_suppressed",
    )
    expect(suppressed).toBeDefined()

    await callbacks.finish()
  })

  it("still delivers distinct outward content within the same turn", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    callbacks.onTextChunk("first take")
    await callbacks.flushNow!()

    callbacks.onTextChunk("second, refined take")
    await callbacks.flushNow!()

    callbacks.onTextChunk("final answer")
    await callbacks.flush()

    const outwardSends = sendText.mock.calls
      .map((call) => call[0]?.text)
      .filter((text: string) => ["first take", "second, refined take", "final answer"].includes(text))
    expect(outwardSends).toEqual(["first take", "second, refined take", "final answer"])

    await callbacks.finish()
  })

  it("ignores trivial whitespace differences when deduping outward text", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    callbacks.onTextChunk("ok, sounds good")
    await callbacks.flushNow!()

    callbacks.onTextChunk("ok, sounds good\n")
    await callbacks.flushNow!()

    callbacks.onTextChunk("  ok, sounds good  ")
    await callbacks.flush()

    const outwardSends = sendText.mock.calls.filter((call) => /ok, sounds good/.test(call[0]?.text ?? ""))
    expect(outwardSends).toHaveLength(1)

    await callbacks.finish()
  })

  it("dedupes per turn — a fresh callbacks lifetime can re-send the same body", async () => {
    const { client, sendText } = makeStubClient()

    const first = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)
    first.onModelStart()
    first.onTextChunk("on it")
    await first.flush()
    await first.finish()

    const second = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)
    second.onModelStart()
    second.onTextChunk("on it")
    await second.flush()
    await second.finish()

    const outward = sendText.mock.calls.filter((call) => call[0]?.text === "on it")
    expect(outward).toHaveLength(2)
  })

  it("logs duplicate suppression even when chat identity is unavailable", async () => {
    const { client } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, {}, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()
    callbacks.onTextChunk("same line")
    await callbacks.flushNow!()

    callbacks.onTextChunk("same line")
    await callbacks.flushNow!()

    const suppressed = (emitNervesEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) =>
        call[0]?.event === "bluebubbles.duplicate_outward_suppressed" && call[0]?.meta?.messageLength === "same line".length,
    )
    expect(suppressed?.[0]?.meta).toMatchObject({
      site: "flushNow",
      chatGuid: null,
      messageLength: "same line".length,
    })

    await callbacks.finish()
  })
})
