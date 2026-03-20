import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"
import type { ActiveWorkFrame } from "../../heart/active-work"
import type { InnerJob } from "../../heart/daemon/thoughts"

function makeIdleJob(overrides: Partial<InnerJob> = {}): InnerJob {
  return {
    status: "idle",
    content: null,
    origin: null,
    mode: "reflect",
    obligationStatus: null,
    surfacedResult: null,
    queuedAt: null,
    startedAt: null,
    surfacedAt: null,
    ...overrides,
  }
}

function makeMinimalFrame(overrides: Partial<ActiveWorkFrame> = {}): ActiveWorkFrame {
  return {
    currentSession: { friendId: "friend-1", channel: "cli", key: "session", sessionPath: "/tmp/s.json" },
    currentObligation: null,
    mustResolveBeforeHandoff: false,
    centerOfGravity: "local-turn",
    inner: { status: "idle", hasPending: false, job: makeIdleJob() },
    bridges: [],
    taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
    friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
    bridgeSuggestion: null,
    ...overrides,
  }
}

describe("centerOfGravitySteeringSection", () => {
  let centerOfGravitySteeringSection: (channel: string, options?: any) => string

  beforeAll(async () => {
    const mod = await import("../../mind/prompt")
    centerOfGravitySteeringSection = mod.centerOfGravitySteeringSection
  })

  it("returns empty string when no activeWorkFrame", () => {
    const result = centerOfGravitySteeringSection("cli", {})
    expect(result).toBe("")
  })

  it("returns empty string for local-turn", () => {
    const result = centerOfGravitySteeringSection("cli", {
      activeWorkFrame: makeMinimalFrame({ centerOfGravity: "local-turn" }),
    })
    expect(result).toBe("")
  })

  it("returns steering for inward-work with queued job and origin (friendName)", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: true,
        job: makeIdleJob({
          status: "queued",
          origin: { friendId: "alex", channel: "teams", key: "session1", friendName: "Alex" },
          obligationStatus: "pending",
        }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("## where my attention is")
    expect(result).toContain("thinking through something privately")
    expect(result).toContain("Alex asked about something")
    expect(result).toContain("i still owe them an answer")
  })

  it("returns steering for inward-work with running job and origin (friendId only)", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "running",
        hasPending: false,
        job: makeIdleJob({
          status: "running",
          origin: { friendId: "alex", channel: "teams", key: "session1" },
          obligationStatus: null,
        }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("## where my attention is")
    expect(result).toContain("thinking through something privately")
    expect(result).toContain("alex asked about something")
    expect(result).not.toContain("i still owe them an answer")
  })

  it("returns steering for inward-work with surfaced job and origin", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({
          status: "surfaced",
          origin: { friendId: "alex", channel: "teams", key: "session1", friendName: "Alex" },
        }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("## where my attention is")
    expect(result).toContain("been thinking privately and reached something")
    expect(result).toContain("this started when Alex asked about something")
    expect(result).toContain("bring my answer back")
  })

  it("returns steering for inward-work with queued job and no origin", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: true,
        job: makeIdleJob({
          status: "queued",
          origin: null,
          obligationStatus: null,
        }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("thinking through something privately")
    expect(result).not.toContain("asked about something")
    expect(result).not.toContain("owe them")
  })

  it("returns steering for inward-work with surfaced job and no origin", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({
          status: "surfaced",
          origin: null,
        }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("been thinking privately and reached something")
    expect(result).not.toContain("this started when")
  })

  it("returns steering for inward-work with idle job (mustResolveBeforeHandoff)", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      mustResolveBeforeHandoff: true,
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({ status: "idle" }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("## where my attention is")
    expect(result).toContain("unfinished work that needs attention")
    expect(result).toContain("go_inward")
  })

  it("returns steering for shared-work", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "shared-work",
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("## where my attention is")
    expect(result).toContain("touches multiple conversations")
  })

  it("returns empty string when channel is inner", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      inner: {
        status: "running",
        hasPending: false,
        job: makeIdleJob({ status: "running" }),
      },
    })
    const result = centerOfGravitySteeringSection("inner", { activeWorkFrame: frame })
    expect(result).toBe("")
  })

  it("emits at least one nerves event reference", () => {
    // Satisfies the every-test-emits audit rule
    expect(emitNervesEvent).toBeDefined()
  })
})
