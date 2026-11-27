import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../nerves/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../nerves/runtime")>("../../nerves/runtime")
  return { ...actual, emitNervesEvent: (...args: Parameters<typeof actual.emitNervesEvent>) => { mockEmitNervesEvent(...args); return actual.emitNervesEvent(...args) } }
})

import { createKeepInTouch, KEEP_IN_TOUCH_MAX_HOLDS, KEEP_IN_TOUCH_TIMING, offersMidTurnSpeech } from "../../heart/keep-in-touch"

function clock(start = 1_000_000) {
  let at = start
  return { now: () => at, advance: (ms: number) => { at += ms } }
}

function guard(channel = "bluebubbles", overrides: { speakOffered?: boolean; answersAPerson?: boolean } = {}) {
  const time = clock()
  const keep = createKeepInTouch({ channel, speakOffered: true, answersAPerson: true, startedAt: time.now(), now: time.now, ...overrides })
  return { keep, time }
}

describe("keep in touch", () => {
  beforeEach(() => mockEmitNervesEvent.mockReset())

  it("offers mid-turn speech on iMessage as well as every chat-style channel", () => {
    expect(offersMidTurnSpeech({ channel: "bluebubbles", chatStyle: false })).toBe(true)
    expect(offersMidTurnSpeech({ channel: "teams", chatStyle: true })).toBe(true)
    expect(offersMidTurnSpeech({ channel: "mail", chatStyle: false })).toBe(false)
    expect(offersMidTurnSpeech(undefined)).toBe(false)
  })

  it("guards only person-facing chats where speak is on the menu", () => {
    expect(guard("cli").keep).toBeNull()
    expect(guard("mail").keep).toBeNull()
    expect(guard("bluebubbles", { speakOffered: false }).keep).toBeNull()
    expect(guard("bluebubbles", { answersAPerson: false }).keep).toBeNull()
    expect(createKeepInTouch({ speakOffered: true, answersAPerson: true, startedAt: 0 })).toBeNull()
    for (const channel of ["bluebubbles", "teams", "telegram", "voice"]) expect(guard(channel).keep, channel).not.toBeNull()
  })

  it("lets a quick turn work and answer without an ack", () => {
    const { keep, time } = guard()
    time.advance(KEEP_IN_TOUCH_TIMING.bluebubbles!.ackAfterMs - 1)
    expect(keep!.hold(["shell"])).toBeNull()
    expect(mockEmitNervesEvent).not.toHaveBeenCalled()
  })

  it("holds work once the person has waited past the ack bound with nothing said", () => {
    const { keep, time } = guard()
    time.advance(20_000)
    expect(keep!.hold(["shell", "read_file"])).toEqual({ kind: "ack", quietMs: 20_000 })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "engine.keep_in_touch_held", meta: { channel: "bluebubbles", kind: "ack", quietMs: 20_000 },
    }))
  })

  it("never holds a batch that speaks before its work, or has no work", () => {
    const { keep, time } = guard()
    time.advance(60_000)
    expect(keep!.hold(["speak", "shell"])).toBeNull()
    expect(keep!.hold(["settle"])).toBeNull()
    expect(keep!.hold(["ponder", "find_tools"])).toBeNull()
    expect(keep!.hold([])).toBeNull()
  })

  it("holds a batch whose speak comes after the work, since the ack would wait on it", () => {
    const { keep, time } = guard()
    time.advance(60_000)
    expect(keep!.hold(["shell", "speak"])?.kind).toBe("ack")
  })

  it("asks for a progress update only after the long interval since the last speak", () => {
    const { keep, time } = guard()
    time.advance(20_000)
    keep!.spoke()
    time.advance(KEEP_IN_TOUCH_TIMING.bluebubbles!.updateEveryMs - 1)
    expect(keep!.hold(["shell"])).toBeNull()
    time.advance(1)
    expect(keep!.hold(["shell"])).toEqual({ kind: "update", quietMs: KEEP_IN_TOUCH_TIMING.bluebubbles!.updateEveryMs })
  })

  it("uses voice's shorter bounds", () => {
    const { keep, time } = guard("voice")
    time.advance(5_000)
    expect(keep!.hold(["web_search"])?.kind).toBe("ack")
  })

  it("lets work through after repeated holds so a model that won't speak can't stall the turn", () => {
    const { keep, time } = guard()
    time.advance(30_000)
    for (let i = 0; i < KEEP_IN_TOUCH_MAX_HOLDS; i++) expect(keep!.hold(["shell"])).not.toBeNull()
    expect(keep!.hold(["shell"])).toBeNull()
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn", event: "engine.keep_in_touch_released",
      meta: { channel: "bluebubbles", kind: "ack", quietMs: 30_000, holds: KEEP_IN_TOUCH_MAX_HOLDS },
    }))
    time.advance(10 * 60_000)
    expect(keep!.hold(["shell"])).toBeNull()
  })

  it("a speak resets the hold count", () => {
    const { keep, time } = guard()
    time.advance(30_000)
    expect(keep!.hold(["shell"])).not.toBeNull()
    keep!.spoke()
    time.advance(KEEP_IN_TOUCH_TIMING.bluebubbles!.updateEveryMs)
    expect(keep!.hold(["shell"])).not.toBeNull()
    expect(keep!.hold(["shell"])).not.toBeNull()
  })

  it("stops holding once a speak couldn't be delivered", () => {
    const { keep, time } = guard()
    keep!.undeliverable()
    time.advance(60_000)
    expect(keep!.hold(["shell"])).toBeNull()
  })

  it("defaults to the wall clock", () => {
    const keep = createKeepInTouch({ channel: "teams", speakOffered: true, answersAPerson: true, startedAt: Date.now() - 60_000 })
    expect(keep!.hold(["shell"])?.kind).toBe("ack")
  })
})
