import { describe, expect, it } from "vitest"

import { createProactiveRepetitionGuard } from "../../senses/telegram"

const PROBE = (clock: string) =>
  `Fresh probe at ${clock} UTC confirms media, books, requests, and readarr all returning status 0; Cloudflare tunnel, DDNS, and backing containers are healthy on-box. Second tunnel/DDNS outage in ~30 minutes — needs Ari on the tunnel/DDNS side.`

describe("proactive repetition guard", () => {
  it("suppresses the observed probe storm, which repeated apart from the clock", () => {
    let t = 0
    const guard = createProactiveRepetitionGuard({ windowMs: 900_000, now: () => t })
    // The real sequence: three messages a minute apart, identical but for the time.
    expect(guard.shouldSend(PROBE("05:16:08"))).toBe(true)
    t += 29_000
    expect(guard.shouldSend(PROBE("05:16:37"))).toBe(false)
    t += 31_000
    expect(guard.shouldSend(PROBE("05:17:08"))).toBe(false)
  })

  it("still sends when the substance changes, even by a single number", () => {
    let t = 0
    const guard = createProactiveRepetitionGuard({ windowMs: 900_000, now: () => t })
    expect(guard.shouldSend("Animal Kingdom: 3 of 10 episodes on the shelf.")).toBe(true)
    t += 60_000
    // Counts are the payload. Only clock readings are normalised away.
    expect(guard.shouldSend("Animal Kingdom: 7 of 10 episodes on the shelf.")).toBe(true)
  })

  it("lets a recurring condition through again once the window passes", () => {
    let t = 0
    const guard = createProactiveRepetitionGuard({ windowMs: 900_000, now: () => t })
    expect(guard.shouldSend(PROBE("05:16:08"))).toBe(true)
    t += 899_000
    expect(guard.shouldSend(PROBE("05:31:00"))).toBe(false)
    t += 2_000
    expect(guard.shouldSend(PROBE("05:31:07"))).toBe(true)
  })

  it("normalises ISO timestamps as well as clock times", () => {
    let t = 0
    const guard = createProactiveRepetitionGuard({ windowMs: 900_000, now: () => t })
    expect(guard.shouldSend("Checked at 2026-09-20T05:16:08.000Z — all healthy.")).toBe(true)
    t += 1_000
    expect(guard.shouldSend("Checked at 2026-09-20T05:17:41.000Z — all healthy.")).toBe(false)
  })

  it("works on its defaults, with no options supplied", () => {
    const guard = createProactiveRepetitionGuard()
    const text = "Books is the main problem: calibre-web is still exited."
    expect(guard.shouldSend(text)).toBe(true)
    expect(guard.shouldSend(text)).toBe(false)
    expect(guard.shouldSend("Something else entirely.")).toBe(true)
  })

  it("treats different messages independently and bounds what it remembers", () => {
    let t = 0
    const guard = createProactiveRepetitionGuard({ windowMs: 900_000, now: () => t, maxEntries: 2 })
    expect(guard.shouldSend("first")).toBe(true)
    expect(guard.shouldSend("second")).toBe(true)
    expect(guard.shouldSend("third")).toBe(true)
    // "first" was evicted by the bound, so it is allowed again rather than retained forever.
    expect(guard.shouldSend("first")).toBe(true)
    expect(guard.shouldSend("third")).toBe(false)
  })
})
