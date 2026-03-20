import { describe, expect, it, vi } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import type { PendingMessage } from "../../mind/pending"
import type { ThoughtTurn } from "../../heart/daemon/thoughts"
import type { InnerDialogRuntimeState } from "../../heart/daemon/thoughts"
import { deriveInnerJob } from "../../heart/daemon/thoughts"
import type { InnerJob, InnerJobStatus } from "../../heart/daemon/thoughts"

type PendingMessagePick = Pick<PendingMessage, "content" | "timestamp" | "from" | "delegatedFrom" | "obligationStatus"> & { mode?: "reflect" | "plan" | "relay" }

function makePending(overrides: Partial<PendingMessagePick> = {}): PendingMessagePick {
  return {
    from: "alex",
    content: "can you think about naming conventions?",
    timestamp: 1000,
    ...overrides,
  }
}

function makeDelegatedPending(overrides: Partial<PendingMessagePick> = {}): PendingMessagePick {
  return makePending({
    delegatedFrom: { friendId: "alex", channel: "teams", key: "session1" },
    obligationStatus: "pending",
    ...overrides,
  })
}

function makeTurn(overrides: Partial<ThoughtTurn> = {}): ThoughtTurn {
  return {
    type: "heartbeat",
    prompt: "...time passing",
    response: "nothing new",
    tools: [],
    ...overrides,
  }
}

function makeTurnWithProcessedPending(response = "i thought about it"): ThoughtTurn {
  return makeTurn({
    prompt: "[pending from alex]: can you think about naming conventions?\n\n...time passing",
    response,
  })
}

describe("InnerJob type", () => {
  it("exports InnerJobStatus type with all lifecycle values", () => {
    // Type-level check: if these assignments compile, the type is correct
    const statuses: InnerJobStatus[] = ["idle", "queued", "running", "surfaced", "returned", "abandoned"]
    expect(statuses).toHaveLength(6)
  })
})

describe("deriveInnerJob", () => {
  it("returns idle when no pending, runtime idle, no turns", () => {
    const job = deriveInnerJob([], [], { status: "idle" })

    expect(job.status).toBe("idle")
    expect(job.content).toBeNull()
    expect(job.origin).toBeNull()
    expect(job.mode).toBe("reflect")
    expect(job.obligationStatus).toBeNull()
    expect(job.surfacedResult).toBeNull()
    expect(job.queuedAt).toBeNull()
    expect(job.startedAt).toBeNull()
    expect(job.surfacedAt).toBeNull()
  })

  it("returns queued when delegated pending + runtime idle", () => {
    const pending = makeDelegatedPending()
    const job = deriveInnerJob([pending], [], { status: "idle" })

    expect(job.status).toBe("queued")
    expect(job.origin).toEqual({ friendId: "alex", channel: "teams", key: "session1" })
    expect(job.content).toBe("can you think about naming conventions?")
    expect(job.obligationStatus).toBe("pending")
    expect(job.queuedAt).toBe(1000)
  })

  it("returns running when pending + runtime running", () => {
    const pending = makeDelegatedPending()
    const runtime: InnerDialogRuntimeState = { status: "running", startedAt: "2026-01-01T00:00:00Z" }
    const job = deriveInnerJob([pending], [], runtime)

    expect(job.status).toBe("running")
    expect(job.origin).toEqual({ friendId: "alex", channel: "teams", key: "session1" })
    expect(job.startedAt).toBe("2026-01-01T00:00:00Z")
  })

  it("returns running when runtime running with no delegated history", () => {
    const runtime: InnerDialogRuntimeState = { status: "running" }
    const job = deriveInnerJob([], [], runtime)

    expect(job.status).toBe("running")
    expect(job.origin).toBeNull()
  })

  it("returns surfaced when no pending, idle runtime, last turn processed pending with response", () => {
    const turn = makeTurnWithProcessedPending("i thought about it and naming should be consistent")
    const job = deriveInnerJob([], [turn], { status: "idle" })

    expect(job.status).toBe("surfaced")
    expect(job.surfacedResult).toBe("i thought about it and naming should be consistent")
  })

  it("carries through mode reflect from pending", () => {
    const pending = makeDelegatedPending({ mode: "reflect" })
    const job = deriveInnerJob([pending], [], { status: "idle" })

    expect(job.mode).toBe("reflect")
  })

  it("carries through mode plan from pending", () => {
    const pending = makeDelegatedPending({ mode: "plan" })
    const job = deriveInnerJob([pending], [], { status: "idle" })

    expect(job.mode).toBe("plan")
  })

  it("carries through mode relay from pending", () => {
    const pending = makeDelegatedPending({ mode: "relay" })
    const job = deriveInnerJob([pending], [], { status: "idle" })

    expect(job.mode).toBe("relay")
  })

  it("defaults to mode reflect when pending has no mode", () => {
    const pending = makeDelegatedPending()
    // explicitly no mode field
    const job = deriveInnerJob([pending], [], { status: "idle" })

    expect(job.mode).toBe("reflect")
  })

  it("takes the first delegated pending for origin/content when multiple exist", () => {
    const first = makeDelegatedPending({ content: "first question", timestamp: 1000 })
    const second = makePending({ content: "second message", timestamp: 2000 })
    const third = makeDelegatedPending({
      content: "third question",
      timestamp: 3000,
      delegatedFrom: { friendId: "bob", channel: "slack", key: "session2" },
    })

    const job = deriveInnerJob([first, second, third], [], { status: "idle" })

    expect(job.origin).toEqual({ friendId: "alex", channel: "teams", key: "session1" })
    expect(job.content).toBe("first question")
  })

  it("returns surfaced status (not returned) when no pending, idle, last turn has response", () => {
    // deriveInnerJob cannot detect "returned" -- always returns "surfaced"
    const turn = makeTurnWithProcessedPending("my conclusion")
    const job = deriveInnerJob([], [turn], { status: "idle" })

    expect(job.status).toBe("surfaced")
    // never returns "returned" or "abandoned"
    expect(job.status).not.toBe("returned")
    expect(job.status).not.toBe("abandoned")
  })

  it("treats null runtime state as idle", () => {
    const job = deriveInnerJob([], [], null)

    expect(job.status).toBe("idle")
  })

  it("treats undefined runtime state as idle", () => {
    const job = deriveInnerJob([], [], undefined)

    expect(job.status).toBe("idle")
  })
})
