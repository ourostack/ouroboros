import { describe, expect, it } from "vitest"
import { DisclosureTracker, disclosureTimings, type DisclosureHost } from "../../../senses/voice/local-audio-disclosure"

function setup() {
  let clock = 5_000
  const timers: Array<{ at: number; cb: () => void; cleared: boolean }> = []
  const requests: Array<Record<string, unknown>> = []
  const marks: string[] = []
  const spoken: number[] = []
  let failed = 0
  let queued = false
  const body = { instructions: "say it" }
  const host: DisclosureHost = {
    request: (b) => { requests.push(b) },
    isQueued: () => queued,
    sendMark: (name) => { marks.push(name) },
    onSpoken: (at) => { spoken.push(at) },
    onFailed: () => { failed++ },
  }
  const tracker = new DisclosureTracker({
    body, host,
    now: () => clock,
    setTimer: (cb, ms) => { const t = { at: clock + ms, cb, cleared: false }; timers.push(t); return t },
    clearTimer: (h) => { (h as { cleared: boolean }).cleared = true },
  })
  const advance = (ms: number): void => {
    const target = clock + ms
    for (;;) {
      const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      due.cleared = true
      clock = Math.max(clock, due.at)
      due.cb()
    }
    clock = target
  }
  const speakAttempt = (id: string, status = "completed", transcript = "I'm slugger, an AI assistant; I'm transcribing.") => {
    tracker.noteSent(body)
    tracker.handleRealtimeEvent({ type: "response.created", response: { id } })
    tracker.handleRealtimeEvent({ type: "response.output_audio.delta", response_id: id, item_id: `item-${id}`, delta: "AAAA" })
    if (transcript) tracker.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: id, item_id: `item-${id}`, transcript })
    tracker.handleRealtimeEvent({ type: "response.done", response: { id, status } })
  }
  return { tracker, body, requests, marks, spoken, advance, speakAttempt, setQueued: (v: boolean) => { queued = v }, failed: () => failed, timers, now: () => clock }
}

describe("DisclosureTracker", () => {
  it("is spoken only after the response completes, its transcript is done and its audio has played out", () => {
    const t = setup()
    t.tracker.start()
    expect(t.requests).toEqual([t.body])
    t.speakAttempt("r1")
    expect(t.spoken).toEqual([])
    expect(t.marks).toHaveLength(1)
    expect(t.tracker.noteMark("someone-else")).toBe(false)
    t.advance(1_000)
    expect(t.tracker.noteMark(t.marks[0]!)).toBe(true)
    expect(t.spoken).toEqual([6_000])
    expect(t.tracker.isSpoken()).toBe(true)
    expect(t.failed()).toBe(0)
    // Nothing fires afterwards, even past the deadline.
    t.advance(60_000)
    expect(t.failed()).toBe(0)
    expect(t.requests).toHaveLength(1)
  })

  it("ignores events of other responses", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "other" } })
    t.tracker.noteSent(t.body)
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r1" } })
    t.tracker.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: "other", transcript: "x" })
    t.tracker.handleRealtimeEvent({ type: "response.done", response: { id: "other", status: "completed" } })
    t.tracker.handleRealtimeEvent({ type: "session.updated" })
    t.tracker.handleRealtimeEvent({ type: "response.created", response: {} })
    expect(t.marks).toEqual([])
    // A second created while one is already tracked does not replace it.
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r2" } })
    t.tracker.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "I'm an A.I. assistant" })
    t.tracker.handleRealtimeEvent({ type: "response.done", response: { id: "r1", status: "completed" } })
    expect(t.marks).toHaveLength(1)
  })

  it("does not take someone else's request for its own", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.noteSent({ instructions: "different" })
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "x" } })
    t.tracker.handleRealtimeEvent({ type: "response.done", response: { id: "x", status: "completed" } })
    expect(t.marks).toEqual([])
  })

  it.each(["cancelled", "incomplete", "failed"])("asks again after a %s response", (status) => {
    const t = setup()
    t.tracker.start()
    t.speakAttempt("r1", status)
    expect(t.marks).toEqual([])
    expect(t.requests).toHaveLength(1)
    t.advance(disclosureTimings.retryDelayMs)
    expect(t.requests).toHaveLength(2)
    t.speakAttempt("r2")
    t.tracker.noteMark(t.marks[0]!)
    expect(t.spoken).toHaveLength(1)
  })

  it("asks again when the response finished without an audio transcript", () => {
    const t = setup()
    t.tracker.start()
    t.speakAttempt("r1", "completed", "")
    expect(t.marks).toEqual([])
    t.advance(disclosureTimings.retryDelayMs)
    expect(t.requests).toHaveLength(2)
  })

  it("asks again when the response answered the room instead of saying it is an AI", () => {
    const t = setup()
    t.tracker.start()
    t.speakAttempt("r1", "completed", "Sure, the answer is four.")
    expect(t.marks).toEqual([])
    t.advance(disclosureTimings.retryDelayMs)
    expect(t.requests).toHaveLength(2)
  })

  it("asks again when a barge-in cut its audio, even if the response itself completed", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.noteSent(t.body)
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r1" } })
    t.tracker.noteCleared()
    t.tracker.handleRealtimeEvent({ type: "response.output_audio_transcript.done", response_id: "r1", transcript: "I'm sl" })
    t.tracker.handleRealtimeEvent({ type: "response.done", response: { id: "r1", status: "completed" } })
    expect(t.marks).toEqual([])
    t.advance(disclosureTimings.retryDelayMs)
    expect(t.requests).toHaveLength(2)
  })

  it("asks again when the playout mark comes back after a clear (Twilio-style marks fire on clear)", () => {
    const t = setup()
    t.tracker.start()
    t.speakAttempt("r1")
    t.tracker.noteCleared()
    expect(t.tracker.noteMark(t.marks[0]!)).toBe(true)
    expect(t.spoken).toEqual([])
    t.advance(disclosureTimings.retryDelayMs)
    expect(t.requests).toHaveLength(2)
    // A clear before any request, or after being spoken, changes nothing.
    t.speakAttempt("r2")
    t.tracker.noteMark(t.marks[1]!)
    t.tracker.noteCleared()
    expect(t.tracker.isSpoken()).toBe(true)
  })

  it("re-requests when its request was dropped from the gate, but not while it is still queued", () => {
    const t = setup()
    t.tracker.start()
    t.setQueued(true)
    t.advance(disclosureTimings.createWaitMs)
    expect(t.requests).toHaveLength(1)
    t.setQueued(false)
    t.advance(disclosureTimings.createWaitMs)
    expect(t.requests).toHaveLength(2)
  })

  it("re-requests when the request went out but no response ever started and nothing holds it", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.noteSent(t.body)
    t.advance(disclosureTimings.createWaitMs)
    expect(t.requests).toHaveLength(2)
  })

  it("stops waiting for the created event once the response starts", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.noteSent(t.body)
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r1" } })
    t.advance(disclosureTimings.createWaitMs * 2)
    expect(t.requests).toHaveLength(1)
  })

  it("gives up after the deadline: the join leaves", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.noteSent(t.body)
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r1" } })
    t.advance(disclosureTimings.deadlineMs)
    expect(t.failed()).toBe(1)
    expect(t.tracker.isSpoken()).toBe(false)
    // After failure nothing else happens.
    t.tracker.handleRealtimeEvent({ type: "response.done", response: { id: "r1", status: "completed" } })
    t.tracker.noteCleared()
    t.advance(60_000)
    expect(t.failed()).toBe(1)
    expect(t.marks).toEqual([])
  })

  it("stop cancels every timer and ignores later events", () => {
    const t = setup()
    t.tracker.start()
    t.tracker.stop()
    t.advance(60_000)
    expect(t.failed()).toBe(0)
    expect(t.requests).toHaveLength(1)
    t.tracker.handleRealtimeEvent({ type: "response.created", response: { id: "r1" } })
    expect(t.tracker.noteMark("disclosure-1")).toBe(false)
    // Stopping twice, or after speaking, is fine.
    t.tracker.stop()
  })

  it("keeps the 20 second deadline from the spec", () => {
    expect(disclosureTimings.deadlineMs).toBe(20_000)
  })
})

describe("DisclosureTracker defaults", () => {
  it("uses real timers by default and unrefs them", () => {
    const host: DisclosureHost = { request: () => undefined, isQueued: () => false, sendMark: () => undefined, onSpoken: () => undefined, onFailed: () => undefined }
    const tracker = new DisclosureTracker({ body: {}, host })
    tracker.start()
    tracker.stop()
    expect(tracker.isSpoken()).toBe(false)
  })
})
