import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { buildAwaitTurnMessage } from "../../senses/await-turn-message"

describe("buildAwaitTurnMessage", () => {
  it("renders first-check message when never checked", () => {
    const result = buildAwaitTurnMessage({
      awaitName: "hey_export",
      condition: "HEY export download visible",
      body: undefined,
      lastCheckedAt: null,
      lastObservation: null,
      checkedCount: 0,
      checkpoint: undefined,
      now: () => new Date("2026-05-10T20:00:00.000Z"),
    })
    expect(result).toContain("await tick: hey_export — HEY export download visible")
    expect(result).not.toContain("\ncondition: HEY export download visible")
    expect(result).toContain("history: never checked")
    expect(result).toContain("call resolve_await")
  })

  it("includes the body when present (what would count as ready)", () => {
    const result = buildAwaitTurnMessage({
      awaitName: "x",
      condition: "c",
      body: "the download link must be in the email",
      lastCheckedAt: null,
      lastObservation: null,
      checkedCount: 0,
      checkpoint: undefined,
      now: () => new Date(),
    })
    expect(result).toContain("what would count as ready:")
    expect(result).toContain("the download link must be in the email")
  })

  it("omits body section when body is empty/whitespace/undefined", () => {
    const r1 = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: "  ", lastCheckedAt: null, lastObservation: null,
      checkedCount: 0, checkpoint: undefined, now: () => new Date(),
    })
    expect(r1).not.toContain("what would count as ready")
  })

  it("includes history line with age and observation when checked previously", () => {
    const base = new Date("2026-05-10T20:00:00.000Z").getTime()
    const result = buildAwaitTurnMessage({
      awaitName: "x",
      condition: "c",
      body: undefined,
      lastCheckedAt: new Date(base - 5 * 60_000).toISOString(),
      lastObservation: "no download yet",
      checkedCount: 3,
      checkpoint: undefined,
      now: () => new Date(base),
    })
    expect(result).toContain("checked 3x so far")
    expect(result).toContain("last checked 5m ago")
    expect(result).toContain('last observation: "no download yet"')
  })

  it("falls back to '(none yet)' for missing observation", () => {
    const base = new Date("2026-05-10T20:00:00.000Z").getTime()
    const result = buildAwaitTurnMessage({
      awaitName: "x",
      condition: "c",
      body: undefined,
      lastCheckedAt: new Date(base - 60_000).toISOString(),
      lastObservation: null,
      checkedCount: 1,
      checkpoint: undefined,
      now: () => new Date(base),
    })
    expect(result).toContain("last observation: (none yet)")
  })

  it("formats age across all unit boundaries", () => {
    const base = new Date("2026-05-10T20:00:00.000Z").getTime()
    const sub = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: undefined,
      lastCheckedAt: new Date(base - 30_000).toISOString(),
      lastObservation: null, checkedCount: 1, checkpoint: undefined, now: () => new Date(base),
    })
    expect(sub).toContain("last checked <1m ago")
    const hour = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: undefined,
      lastCheckedAt: new Date(base - 90 * 60_000).toISOString(),
      lastObservation: null, checkedCount: 1, checkpoint: undefined, now: () => new Date(base),
    })
    expect(hour).toContain("last checked 1h ago")
    const day = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: undefined,
      lastCheckedAt: new Date(base - 2 * 24 * 60 * 60_000).toISOString(),
      lastObservation: null, checkedCount: 1, checkpoint: undefined, now: () => new Date(base),
    })
    expect(day).toContain("last checked 2d ago")
  })

  it("treats invalid lastCheckedAt as unknown age", () => {
    const result = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: undefined,
      lastCheckedAt: "garbage", lastObservation: null, checkedCount: 1,
      checkpoint: undefined, now: () => new Date(),
    })
    expect(result).toContain("last checked (unknown)")
  })

  it("includes checkpoint when provided", () => {
    const result = buildAwaitTurnMessage({
      awaitName: "x", condition: "c", body: undefined,
      lastCheckedAt: null, lastObservation: null, checkedCount: 0,
      checkpoint: "last looked at the inbox",
      now: () => new Date(),
    })
    expect(result).toContain("last checkpoint: last looked at the inbox")
  })
})
