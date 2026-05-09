// Regression for the post-#699 near-duplicate BlueBubbles delivery class
// (2026-05-09 05:24–05:28 UTC, friend chat:any;-;ari@mendelow.me).
//
// Symptom: a single inbound iMessage produced two near-identical answers
// (evt-001814 + evt-001818, both starting "yep — I looked it up… Assuming
// you mean AMC's The Audacity…") and then three overlapping inner/status
// surface updates about the same duplicate issue (evt-001820, evt-001821,
// evt-001823). PR #699 normalized only whitespace + case, so the LLM's
// slight rephrasings on a settle/recovery loop bypassed it; sendStatus had
// no dedupe at all, so status surface text was completely uncovered.
//
// The guard added by this fix:
//   1. Token-set Jaccard similarity (>= 0.7) catches near-duplicates from
//      the same turn even when the exact bytes differ.
//   2. sendStatus consults the same per-turn dedupe state, so status-style
//      outward messages can no longer slip past the speak/settle guard.

import { describe, it, expect, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

vi.mock("../../../senses/commands", () => ({
  getDebugMode: () => false,
}))

import {
  createBlueBubblesCallbacks,
  jaccardSimilarity,
  tokenizeForDedupe,
} from "../../../senses/bluebubbles/index"
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

const CHAT = { chatGuid: "iMessage;-;ari@mendelow.me" }

const AUDACITY_A
  = "yep — I looked it up. Assuming you mean AMC's The Audacity, the executives are composites of Silicon Valley founders — there's a Duncan Park figure who reads as Adam Neumann-ish."
const AUDACITY_B
  = "yep — looked it up. Assuming you mean AMC's The Audacity, the executives are composites of Silicon Valley founders — Duncan Park reads as Adam Neumann-ish."

describe("BlueBubbles near-duplicate outward send guard (post-#699 evt-001814/001818)", () => {
  it("suppresses an LLM rephrasing of the same answer across two flushNow calls", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    callbacks.onTextChunk(AUDACITY_A)
    await callbacks.flushNow!()

    // PR #699's exact-norm dedupe lets this through — the bytes differ. The
    // Jaccard guard treats it as a near-duplicate.
    callbacks.onTextChunk(AUDACITY_B)
    await callbacks.flushNow!()

    const audacitySends = sendText.mock.calls.filter((call) =>
      typeof call[0]?.text === "string" && call[0].text.includes("Audacity"),
    )
    expect(audacitySends).toHaveLength(1)

    const suppressed = (emitNervesEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.event === "bluebubbles.duplicate_outward_suppressed",
    )
    expect(suppressed).toBeDefined()

    await callbacks.finish()
  })

  it("suppresses a near-duplicate split across speak (flushNow) and settle (flush)", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    callbacks.onTextChunk(AUDACITY_A)
    await callbacks.flushNow!()

    callbacks.onTextChunk(AUDACITY_B)
    await callbacks.flush()

    const audacitySends = sendText.mock.calls.filter((call) =>
      typeof call[0]?.text === "string" && call[0].text.includes("Audacity"),
    )
    expect(audacitySends).toHaveLength(1)

    await callbacks.finish()
  })

  it("preserves distinct long replies that share a topic but differ substantively", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    // Two genuinely different long answers that happen to mention overlapping
    // proper nouns. The guard must not collapse these — the user explicitly
    // asked for two different facts and both deserve to land.
    const FIRST = "Adam Neumann founded WeWork in 2010 with Miguel McKelvey, raising the company's valuation to $47B before stepping down in 2019 amid governance concerns."
    const SECOND = "Travis Kalanick co-founded Uber in 2009 with Garrett Camp, scaling rapidly across global markets before resigning the CEO role in 2017 after investor pressure."

    callbacks.onTextChunk(FIRST)
    await callbacks.flushNow!()

    callbacks.onTextChunk(SECOND)
    await callbacks.flush()

    const sends = sendText.mock.calls.map((call) => call[0]?.text).filter(
      (text): text is string => typeof text === "string" && (text.includes("WeWork") || text.includes("Uber")),
    )
    expect(sends).toEqual([FIRST, SECOND])

    await callbacks.finish()
  })

  it("does not over-suppress short distinct replies that have low token count", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    // Each is below the fuzzy-mode minimum token count, so fuzzy never
    // engages. They should all deliver because their exact norms differ.
    callbacks.onTextChunk("ok")
    await callbacks.flushNow!()

    callbacks.onTextChunk("got it")
    await callbacks.flushNow!()

    callbacks.onTextChunk("on it")
    await callbacks.flush()

    const sends = sendText.mock.calls
      .map((call) => call[0]?.text)
      .filter((text: string) => ["ok", "got it", "on it"].includes(text))
    expect(sends).toEqual(["ok", "got it", "on it"])

    await callbacks.finish()
  })

  it("does not compare a later long reply against previous short-token sends", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    callbacks.onTextChunk("ok")
    await callbacks.flushNow!()

    const LONG_REPLY = "ok — the plan is check coverage fix branch and then rerun verification"
    callbacks.onTextChunk(LONG_REPLY)
    await callbacks.flush()

    const sends = sendText.mock.calls.map((call) => call[0]?.text)
    expect(sends).toContain("ok")
    expect(sends).toContain(LONG_REPLY)

    await callbacks.finish()
  })
})

describe("BlueBubbles status surface dedupe (post-#699 evt-001820/001821/001823)", () => {
  it("suppresses a status surface that near-duplicates an already-spoken answer", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    // Agent delivers the answer.
    callbacks.onTextChunk(AUDACITY_A)
    await callbacks.flushNow!()

    // Then a tool failure or watchdog tries to surface a status that is a
    // near-rephrasing of the answer (this is the evt-001820/001821/001823
    // shape — the agent reflects on the duplicate it just sent).
    callbacks.onError(new Error(AUDACITY_B), "transient")

    await callbacks.flush()

    const audacitySends = sendText.mock.calls.filter((call) =>
      typeof call[0]?.text === "string" && call[0].text.includes("Audacity"),
    )
    expect(audacitySends).toHaveLength(1)

    const suppressed = (emitNervesEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0]?.event === "bluebubbles.duplicate_outward_suppressed" && call[0]?.meta?.site === "status",
    )
    expect(suppressed).toBeDefined()

    await callbacks.finish()
  })

  it("collapses repeated status messages within a turn", async () => {
    const { client, sendText } = makeStubClient()
    const callbacks = createBlueBubblesCallbacks(client as never, CHAT, TOP_LEVEL_REPLY_TARGET, false)

    callbacks.onModelStart()

    // Two onError calls with the same status text. Pre-fix sendStatus had no
    // dedupe, so both would land. After the fix, the second is suppressed.
    callbacks.onError(new Error("network blip — retrying"), "transient")
    callbacks.onError(new Error("network blip — retrying"), "transient")

    await callbacks.flush()

    const sends = sendText.mock.calls.filter((call) =>
      typeof call[0]?.text === "string" && call[0].text.includes("network blip"),
    )
    expect(sends).toHaveLength(1)

    await callbacks.finish()
  })
})

describe("near-duplicate similarity primitives", () => {
  it("tokenizes case-insensitively and ignores punctuation", () => {
    const tokens = tokenizeForDedupe("Yep — I looked IT up… Assuming you mean AMC's, ok?")
    expect(tokens.has("yep")).toBe(true)
    expect(tokens.has("looked")).toBe(true)
    expect(tokens.has("amc's")).toBe(true)
    expect(tokens.has("—")).toBe(false)
  })

  it("returns an empty token set for punctuation-only text", () => {
    expect(tokenizeForDedupe("— … !!!").size).toBe(0)
  })

  it("reports high similarity for near-duplicate answer rephrasings", () => {
    const a = tokenizeForDedupe(AUDACITY_A)
    const b = tokenizeForDedupe(AUDACITY_B)
    expect(jaccardSimilarity(a, b)).toBeGreaterThanOrEqual(0.7)
  })

  it("reports low similarity for distinct messages", () => {
    const a = tokenizeForDedupe("what time should we meet at the bar tonight")
    const b = tokenizeForDedupe("did you finish the design review on the new component")
    expect(jaccardSimilarity(a, b)).toBeLessThan(0.3)
  })

  it("returns 0 for empty token sets", () => {
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0)
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0)
  })
})
