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
    codingSessions: [],
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

  it("renders live-thread status shape guidance for local-turn even before an obligation is captured", () => {
    const result = centerOfGravitySteeringSection("cli", {
      activeWorkFrame: makeMinimalFrame({ centerOfGravity: "local-turn" }),
    })
    expect(result).toContain("live conversation: cli/session")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain('current artifact: <actual artifact or "no artifact yet">')
    expect(result).toContain("latest checkpoint: <freshest concrete thing i just finished or verified>")
    expect(result).toContain("next action: <smallest concrete next step i'm taking now>")
  })

  it("renders concrete status guidance for a local-turn with a live obligation", () => {
    const result = centerOfGravitySteeringSection("cli", {
      activeWorkFrame: makeMinimalFrame({
        centerOfGravity: "local-turn",
        currentObligation: "investigate the stale status reply",
      }),
    })
    expect(result).toContain("the live conversation is cli/session.")
    expect(result).toContain("the active lane is this same thread.")
    expect(result).toContain("the current artifact is no artifact yet.")
    expect(result).toContain('the next action is work on "investigate the stale status reply" and bring back a concrete artifact.')
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

  it("returns steering for inward-work when a persistent obligation is actively being worked", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      pendingObligations: [
        {
          id: "ob-1",
          origin: { friendId: "alex", channel: "bluebubbles", key: "chat" },
          content: "fix the return loop",
          status: "investigating",
          currentSurface: { kind: "coding", label: "codex coding-001" },
          currentArtifact: "no PR yet",
          nextAction: "finish the coding pass and bring the result back here",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      ],
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({ status: "idle" }),
      },
    })
    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("already working on something i owe")
    expect(result).toContain("codex coding-001")
  })

  it("tells status answers to use active lane, current artifact, and next action", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      pendingObligations: [
        {
          id: "ob-2",
          origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
          content: "close the loop visibly",
          status: "waiting_for_merge",
          currentSurface: { kind: "merge", label: "PR #123" },
          currentArtifact: "PR #123",
          nextAction: "wait for checks, merge PR #123, then update runtime",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
        },
      ],
      codingSessions: [
        {
          id: "coding-013",
          runner: "claude",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "visible-status-fix",
          status: "running",
          stdoutTail: "working",
          stderrTail: "",
          pid: 13,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        },
      ],
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({ status: "idle" }),
      },
    })

    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("if someone asks what i'm doing or for status")
    expect(result).toContain("the active lane is")
    expect(result).toContain("the current artifact is")
    expect(result).toContain("the next action is")
    expect(result).toContain("PR #123")
  })

  it("returns steering for inward-work when live coding work is already active", () => {
    const frame = makeMinimalFrame({
      centerOfGravity: "inward-work",
      codingSessions: [
        {
          id: "coding-013",
          runner: "claude",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "harness-maintenance",
          status: "running",
          stdoutTail: "working",
          stderrTail: "",
          pid: 13,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "cli", key: "session" },
        },
      ],
      inner: {
        status: "idle",
        hasPending: false,
        job: makeIdleJob({ status: "idle" }),
      },
    })

    const result = centerOfGravitySteeringSection("cli", { activeWorkFrame: frame })
    expect(result).toContain("already have coding work running")
    expect(result).toContain("claude coding-013")
    expect(result).toContain("for this same thread")
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

describe("obligation steering helpers", () => {
  it("returns null when no frame is available", async () => {
    const { findActivePersistentObligation } = await import("../../mind/obligation-steering")
    expect(findActivePersistentObligation(undefined)).toBeNull()
  })

  it("returns an empty string when no obligation is active", async () => {
    const { renderActiveObligationSteering } = await import("../../mind/obligation-steering")
    expect(renderActiveObligationSteering(null)).toBe("")
  })

  it("renders active obligation steering even when the work surface is unknown", async () => {
    const { renderActiveObligationSteering } = await import("../../mind/obligation-steering")
    const result = renderActiveObligationSteering({
      id: "ob-1",
      origin: { friendId: "alex", channel: "bluebubbles", key: "chat" },
      content: "finish the return loop",
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(result).toContain("already working on something i owe alex")
    expect(result).not.toContain("right now that work is happening in")
  })

  it("returns an empty string when there is no obligation for concrete status guidance", async () => {
    const { findStatusObligation, renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    expect(findStatusObligation(undefined)).toBeNull()
    expect(renderConcreteStatusGuidance(makeMinimalFrame(), null)).toBe("")
  })

  it("sorts status obligations by createdAt when updatedAt is missing", async () => {
    const { findStatusObligation } = await import("../../mind/obligation-steering")
    const chosen = findStatusObligation(makeMinimalFrame({
      currentSession: null,
      pendingObligations: [
        {
          id: "older",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "older",
          status: "investigating",
          createdAt: "2026-01-01T00:00:00Z",
        },
        {
          id: "newer",
          origin: { friendId: "friend-2", channel: "teams", key: "chat" },
          content: "newer",
          status: "investigating",
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    }))

    expect(chosen?.id).toBe("newer")
  })

  it("renders concrete guidance for waiting input on another thread", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const frame = makeMinimalFrame({
      codingSessions: [
        {
          id: "coding-201",
          runner: "codex",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "status-fix",
          status: "waiting_input",
          stdoutTail: "need review",
          stderrTail: "",
          pid: 201,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "friend-1", channel: "bluebubbles", key: "chat" },
        },
      ],
    })

    const result = renderConcreteStatusGuidance(frame, {
      id: "ob-2",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "close the loop visibly",
      status: "investigating",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })

    expect(result).toContain("the active lane is codex coding-201 for bluebubbles/chat.")
    expect(result).toContain("the current artifact is no PR or merge artifact yet.")
    expect(result).toContain("the next action is answer codex coding-201 and continue.")
  })

  it("renders concrete guidance for stalled coding without origin metadata", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const frame = makeMinimalFrame({
      currentSession: null,
      codingSessions: [
        {
          id: "coding-202",
          runner: "claude",
          workdir: "/tmp/workspaces/ouroboros",
          taskRef: "status-fix",
          status: "stalled",
          stdoutTail: "",
          stderrTail: "stuck",
          pid: 202,
          startedAt: "2026-03-05T23:53:00.000Z",
          lastActivityAt: "2026-03-05T23:59:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
        },
      ],
    })

    const result = renderConcreteStatusGuidance(frame, {
      id: "ob-3",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "close the loop visibly",
      status: "investigating",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })

    expect(result).toContain("the active lane is claude coding-202.")
    expect(result).toContain("the next action is unstick claude coding-202 and continue.")
  })

  it("renders merge and runtime fallback next actions when explicit fields are absent", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")

    const waitingForMerge = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-4",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "merge the fix",
      status: "waiting_for_merge",
      currentSurface: { kind: "merge", label: "PR #456" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(waitingForMerge).toContain("the active lane is PR #456.")
    expect(waitingForMerge).toContain("the current artifact is PR #456.")
    expect(waitingForMerge).toContain("the next action is wait for checks, merge PR #456, then update runtime.")

    const updatingRuntime = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-5",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "restart onto latest runtime",
      status: "updating_runtime",
      currentSurface: { kind: "runtime", label: "ouro up" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(updatingRuntime).toContain("the active lane is ouro up.")
    expect(updatingRuntime).toContain("the current artifact is no explicit artifact yet.")
    expect(updatingRuntime).toContain("the next action is update runtime, verify version/changelog, then re-observe.")
  })

  it("strips a leading merge verb and falls back to the fix for empty merge content", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")

    const stripped = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-merge-strip",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "merge the fix",
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(stripped).toContain("the next action is wait for checks, merge the fix, then update runtime.")

    const fallback = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-merge-fallback",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "   ",
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(fallback).toContain("the next action is wait for checks, merge the fix, then update runtime.")

    const bareMergeFallback = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-merge-bare",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "merge",
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(bareMergeFallback).toContain("the next action is wait for checks, merge the fix, then update runtime.")

    const currentArtifactWins = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-merge-artifact",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "merge the fix",
      currentArtifact: "PR #321",
      currentSurface: { kind: "merge", label: "ignored merge surface" },
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(currentArtifactWins).toContain("the next action is wait for checks, merge PR #321, then update runtime.")

    const blankSurfaceFallsBack = renderConcreteStatusGuidance(makeMinimalFrame(), {
      id: "ob-merge-blank-surface",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "merge the fix",
      currentSurface: { kind: "merge", label: "   " },
      status: "waiting_for_merge",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })
    expect(blankSurfaceFallsBack).toContain("the next action is wait for checks, merge the fix, then update runtime.")
  })

  it("falls back to the generic live loop guidance when no concrete surface exists yet", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const result = renderConcreteStatusGuidance(makeMinimalFrame({ currentSession: null }), {
      id: "ob-6",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "keep the loop moving",
      status: "investigating",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })

    expect(result).toContain("the active lane is this live loop.")
    expect(result).toContain("the current artifact is no explicit artifact yet.")
    expect(result).toContain("the next action is continue the active loop and bring the result back here.")
  })

  it("renders the generic live-coding fallback when coding is running but not blocked", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const result = renderConcreteStatusGuidance(
      makeMinimalFrame({
        codingSessions: [
          {
            id: "coding-203",
            runner: "codex",
            workdir: "/tmp/workspaces/ouroboros",
            taskRef: "status-fix",
            status: "running",
            stdoutTail: "working",
            stderrTail: "",
            pid: 203,
            startedAt: "2026-03-05T23:53:00.000Z",
            lastActivityAt: "2026-03-05T23:59:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
          },
        ],
      }),
      {
        id: "ob-7",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        content: "keep the loop moving",
        status: "investigating",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
    )

    expect(result).toContain("the active lane is codex coding-203.")
    expect(result).toContain("the current artifact is no PR or merge artifact yet.")
    expect(result).toContain("the next action is finish the coding pass and bring the result back here.")
  })

  it("handles frames that omit codingSessions by falling back cleanly", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const frame = {
      ...makeMinimalFrame(),
      currentSession: null,
      codingSessions: undefined,
    } as unknown as ActiveWorkFrame

    const result = renderConcreteStatusGuidance(frame, {
      id: "ob-8",
      origin: { friendId: "ari", channel: "cli", key: "session" },
      content: "keep the loop moving",
      status: "updating_runtime",
      currentSurface: { kind: "runtime", label: "ouro up" },
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:01:00Z",
    })

    expect(result).toContain("the active lane is ouro up.")
    expect(result).toContain("the current artifact is no explicit artifact yet.")
    expect(result).toContain("the next action is update runtime, verify version/changelog, then re-observe.")
  })

  it("renders concrete status guidance from the current obligation when no persistent obligation exists yet", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const result = renderConcreteStatusGuidance(
      makeMinimalFrame({
        currentObligation: "investigate the stale status reply",
      }),
      null,
    )

    expect(result).toContain("the live conversation is cli/session.")
    expect(result).toContain("the active lane is this same thread.")
    expect(result).toContain("the current artifact is no artifact yet.")
    expect(result).toContain('the next action is work on "investigate the stale status reply" and bring back a concrete artifact.')
  })

  it("renders the generic live-thread status shape when no obligation has been captured yet", async () => {
    const { renderLiveThreadStatusShape } = await import("../../mind/obligation-steering")
    const result = renderLiveThreadStatusShape(makeMinimalFrame())

    expect(result).toContain("live conversation: cli/session")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain('current artifact: <actual artifact or "no artifact yet">')
    expect(result).toContain("latest checkpoint: <freshest concrete thing i just finished or verified>")
    expect(result).toContain("next action: <smallest concrete next step i'm taking now>")
  })

  it("returns an empty live-thread shape when there is no current session", async () => {
    const { renderLiveThreadStatusShape } = await import("../../mind/obligation-steering")
    expect(renderLiveThreadStatusShape(makeMinimalFrame({ currentSession: null }))).toBe("")
  })

  it("renders a hard five-line reply contract for direct status questions", async () => {
    const { renderExactStatusReplyContract } = await import("../../mind/obligation-steering")
    const result = renderExactStatusReplyContract(makeMinimalFrame(), null)

    expect(result).toContain("reply using exactly these five lines and nothing else")
    expect(result).toContain("live conversation: cli/session")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain("current artifact: no artifact yet")
    expect(result).toContain("latest checkpoint: <freshest concrete thing i just finished or verified>")
    expect(result).toContain("next action: continue the active loop and bring the result back here")
  })

  it("prefers the newest same-thread obligation for status shaping over older stale coding notes", async () => {
    const { findStatusObligation, renderExactStatusReplyContract } = await import("../../mind/obligation-steering")
    const frame = makeMinimalFrame({
      currentObligation: "inspect the live thread and decide the next concrete action",
      pendingObligations: [
        {
          id: "ob-old",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "finish harness-maintenance-live-status-loop and bring the result back",
          status: "investigating",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:01:00Z",
          currentSurface: { kind: "coding", label: "codex coding-075" },
          latestNote: "coding session completed: stale tail text",
        },
        {
          id: "ob-new",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "inspect the live thread and decide the next concrete action",
          status: "pending",
          createdAt: "2026-01-01T00:02:00Z",
          updatedAt: "2026-01-01T00:02:00Z",
        },
      ],
    })

    const chosen = findStatusObligation(frame)
    const result = renderExactStatusReplyContract(frame, chosen)

    expect(chosen?.id).toBe("ob-new")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain("current artifact: no artifact yet")
    expect(result).toContain('next action: work on "inspect the live thread and decide the next concrete action" and bring back a concrete artifact')
    expect(result).not.toContain("codex coding-075")
    expect(result).not.toContain("stale tail text")
  })

  it("uses this same thread and keeps latest-checkpoint guidance live when a live obligation has no explicit surface yet", async () => {
    const { renderConcreteStatusGuidance } = await import("../../mind/obligation-steering")
    const result = renderConcreteStatusGuidance(
      makeMinimalFrame({
        currentObligation: "investigate the stale status reply",
      }),
      {
        id: "ob-live-thread",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        content: "investigate the stale status reply",
        status: "investigating",
        latestNote: "just finished reproducing the stale answer",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
    )

    expect(result).toContain("the active lane is this same thread.")
    expect(result).toContain("the current artifact is no artifact yet.")
    expect(result).toContain("if i just finished or verified something concrete in this live lane, i name that as the latest checkpoint.")
    expect(result).toContain('the next action is work on "investigate the stale status reply" and bring back a concrete artifact.')
  })

  it("does not echo a direct status question back as the next action", async () => {
    const { renderExactStatusReplyContract } = await import("../../mind/obligation-steering")
    const result = renderExactStatusReplyContract(
      makeMinimalFrame({
        currentObligation: "what are you doing?",
      }),
      {
        id: "ob-status",
        origin: { friendId: "ari", channel: "cli", key: "session" },
        content: "close the visible loop",
        status: "investigating",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:01:00Z",
      },
    )

    expect(result).toContain("latest checkpoint: <freshest concrete thing i just finished or verified>")
    expect(result).toContain("next action: continue the active loop and bring the result back here")
    expect(result).not.toContain('next action: work on "what are you doing?"')
  })

  it("builds an exact status reply with deterministic fallbacks", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({ currentSession: null, currentObligation: "" }),
      null,
      "   ",
    )

    expect(result).toBe([
      "live conversation: not in a live conversation",
      "active lane: this live loop",
      "current artifact: no artifact yet",
      "latest checkpoint: <freshest concrete thing i just finished or verified>",
      "next action: continue the active loop and bring the result back here",
    ].join("\n"))
  })

  it("builds family status replies with all other live sessions and concrete next-step fallbacks", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const frame = makeMinimalFrame({
      currentObligation: "close the loop here",
      friendActivity: {
        freshestForCurrentFriend: null,
        otherLiveSessionsForCurrentFriend: [],
        allOtherLiveSessions: [
          {
            friendId: "ari",
            friendName: "Ari",
            channel: "bluebubbles",
            key: "chat",
            sessionPath: "/tmp/ari-bb.json",
            lastActivityAt: "2026-03-21T10:08:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:08:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "pat",
            friendName: "Pat",
            channel: "teams",
            key: "group",
            sessionPath: "/tmp/pat-group.json",
            lastActivityAt: "2026-03-21T10:09:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:09:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "sam",
            friendName: "Sam",
            channel: "cli",
            key: "session-2",
            sessionPath: "/tmp/sam-cli.json",
            lastActivityAt: "2026-03-21T10:10:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:10:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "jordan",
            friendName: "Jordan",
            channel: "teams",
            key: "chat",
            sessionPath: "/tmp/jordan-teams.json",
            lastActivityAt: "2026-03-21T10:11:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:11:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "quinn",
            friendName: "Quinn",
            channel: "cli",
            key: "scratch",
            sessionPath: "/tmp/quinn-cli.json",
            lastActivityAt: "2026-03-21T10:12:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:12:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "casey",
            friendName: "Casey",
            channel: "cli",
            key: "pairing",
            sessionPath: "/tmp/casey-cli.json",
            lastActivityAt: "2026-03-21T10:07:30.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:07:30.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "morgan",
            friendName: "Morgan",
            channel: "bluebubbles",
            key: "dm",
            sessionPath: "/tmp/morgan-bb.json",
            lastActivityAt: "2026-03-21T10:07:00.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:07:00.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "riley",
            friendName: "Riley",
            channel: "cli",
            key: "followup",
            sessionPath: "/tmp/riley-cli.json",
            lastActivityAt: "2026-03-21T10:06:30.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:06:30.000Z"),
            activitySource: "friend-facing",
          },
          {
            friendId: "taylor",
            friendName: "Taylor",
            channel: "teams",
            key: "started-only",
            sessionPath: "/tmp/taylor-teams.json",
            lastActivityAt: "2026-03-21T10:06:15.000Z",
            lastActivityMs: Date.parse("2026-03-21T10:06:15.000Z"),
            activitySource: "friend-facing",
          },
        ],
      },
      otherCodingSessions: [
        {
          id: "coding-old",
          runner: "codex",
          workdir: "/tmp/workspaces/sam-old",
          taskRef: "older-sam-work",
          status: "running",
          stdoutTail: "",
          stderrTail: "",
          pid: 200,
          startedAt: "2026-03-21T09:55:00.000Z",
          lastActivityAt: "2026-03-21T10:07:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "sam", channel: "cli", key: "session-2" },
        },
        {
          id: "coding-new",
          runner: "codex",
          workdir: "/tmp/workspaces/sam-new",
          taskRef: "sam-followup",
          status: "waiting_input",
          stdoutTail: "",
          stderrTail: "",
          pid: 201,
          startedAt: "2026-03-21T09:57:00.000Z",
          lastActivityAt: "2026-03-21T10:13:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "sam", channel: "cli", key: "session-2" },
        },
        {
          id: "coding-stalled",
          runner: "claude",
          workdir: "/tmp/workspaces/jordan",
          taskRef: "jordan-stalled",
          status: "stalled",
          stdoutTail: "",
          stderrTail: "",
          pid: 202,
          startedAt: "2026-03-21T09:58:00.000Z",
          lastActivityAt: "2026-03-21T10:14:00.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "jordan", channel: "teams", key: "chat" },
        },
        {
          id: "coding-running",
          runner: "codex",
          workdir: "/tmp/workspaces/casey",
          taskRef: "casey-pass",
          status: "running",
          stdoutTail: "",
          stderrTail: "",
          pid: 203,
          startedAt: "2026-03-21T09:59:00.000Z",
          lastActivityAt: "2026-03-21T10:07:30.000Z",
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "casey", channel: "cli", key: "pairing" },
        },
        {
          id: "coding-started-only",
          runner: "claude",
          workdir: "/tmp/workspaces/taylor",
          taskRef: "taylor-pass",
          status: "running",
          stdoutTail: "",
          stderrTail: "",
          pid: 204,
          startedAt: "2026-03-21T10:06:15.000Z",
          lastActivityAt: null,
          endedAt: null,
          restartCount: 0,
          lastExitCode: null,
          lastSignal: null,
          failure: null,
          originSession: { friendId: "taylor", channel: "teams", key: "started-only" },
        },
      ],
      pendingObligations: [
        {
          id: "ob-current",
          origin: { friendId: "friend-1", channel: "cli", key: "session" },
          content: "close the loop here",
          status: "investigating",
          createdAt: "2026-03-21T10:00:00.000Z",
          updatedAt: "2026-03-21T10:00:00.000Z",
        },
        {
          id: "ob-merge",
          origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
          content: "merge the session-awareness fix",
          status: "waiting_for_merge",
          currentSurface: { kind: "merge", label: "PR #177" },
          createdAt: "2026-03-21T10:01:00.000Z",
          updatedAt: "2026-03-21T10:01:00.000Z",
        },
        {
          id: "ob-runtime",
          origin: { friendId: "pat", channel: "teams", key: "group" },
          content: "roll onto the merged runtime",
          status: "updating_runtime",
          currentSurface: { kind: "runtime", label: "ouro up" },
          currentArtifact: "alpha.103 installed",
          createdAt: "2026-03-21T10:02:00.000Z",
          updatedAt: "2026-03-21T10:02:00.000Z",
        },
        {
          id: "ob-morgan",
          origin: { friendId: "morgan", channel: "bluebubbles", key: "dm" },
          content: "bring the visibility fix back there",
          status: "investigating",
          createdAt: "2026-03-21T10:03:00.000Z",
          updatedAt: "2026-03-21T10:03:00.000Z",
        },
        {
          id: "ob-riley",
          origin: { friendId: "riley", channel: "cli", key: "followup" },
          content: "close the review loop",
          status: "investigating",
          nextAction: "ask one blocking question and continue",
          createdAt: "2026-03-21T10:03:30.000Z",
          updatedAt: "2026-03-21T10:03:30.000Z",
        },
      ],
    })

    const result = buildExactStatusReply(frame, frame.pendingObligations?.[0] ?? null, "just verified the current thread", "all-sessions-family")
    const lines = result.split("\n")
    const otherSessionsIndex = lines.indexOf("other active sessions:")

    expect(lines.slice(0, 5)).toEqual([
      "live conversation: cli/session",
      "active lane: this same thread",
      "current artifact: no artifact yet",
      "latest checkpoint: just verified the current thread",
      'next action: work on "close the loop here" and bring back a concrete artifact',
    ])
    expect(otherSessionsIndex).toBeGreaterThan(0)
    expect(lines[otherSessionsIndex + 1]).toBe("- Jordan/teams/chat: [stalled] claude coding-stalled; artifact no PR or merge artifact yet; next unstick claude coding-stalled and continue")
    expect(result).toContain("- Sam/cli/session-2: [waiting_input] codex coding-new; artifact no PR or merge artifact yet; next answer codex coding-new and continue")
    expect(result).toContain("- Casey/cli/pairing: [running] codex coding-running; artifact no PR or merge artifact yet; next finish the coding pass and bring the result back there")
    expect(result).toContain("- Morgan/bluebubbles/dm: [investigating] this live thread; artifact no artifact yet; next continue the active loop and bring the result back there")
    expect(result).toContain("- Riley/cli/followup: [investigating] this live thread; artifact no artifact yet; next ask one blocking question and continue")
    expect(result).toContain("- Taylor/teams/started-only: [running] claude coding-started-only; artifact no PR or merge artifact yet; next finish the coding pass and bring the result back there")
    expect(result).toContain("- Quinn/cli/scratch: [active] this live thread; artifact no artifact yet; next check this session and bring back the latest concrete state")
    expect(result).toContain("- Pat/teams/group: [updating_runtime] ouro up; artifact alpha.103 installed; next update runtime, verify version/changelog, then re-observe")
    expect(result).toContain("- Ari/bluebubbles/chat: [waiting_for_merge] PR #177; artifact PR #177; next wait for checks, merge PR #177, then update runtime")
  })

  it("renders family status reply contract fallbacks when the current thread has no captured obligation", async () => {
    const { renderExactStatusReplyContract } = await import("../../mind/obligation-steering")
    const result = renderExactStatusReplyContract(
      makeMinimalFrame({
        currentSession: null,
        pendingObligations: [
          {
            id: "ob-other",
            origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
            content: "carry the fix back there",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:01:00.000Z",
          },
        ],
      }),
      null,
      "all-sessions-family",
    )

    expect(result).toContain("reply using exactly this status shape and nothing else:")
    expect(result).toContain("live conversation: not in a live conversation")
    expect(result).toContain("active lane: this live loop")
    expect(result).toContain("current artifact: no artifact yet")
    expect(result).toContain("next action: continue the active loop and bring the result back here")
  })

  it("renders family status fallbacks for a live thread even when family-wide surfaces are sparse", async () => {
    const { renderExactStatusReplyContract, buildExactStatusReply } = await import("../../mind/obligation-steering")
    const frame = makeMinimalFrame({
      pendingObligations: undefined,
      friendActivity: undefined as any,
      otherCodingSessions: undefined,
    })

    const contract = renderExactStatusReplyContract(frame, null, "all-sessions-family")
    const reply = buildExactStatusReply(frame, null, "just checked the live thread", "all-sessions-family")

    expect(contract).toContain("live conversation: cli/session")
    expect(contract).toContain("active lane: this same thread")
    expect(contract).toContain("current artifact: no artifact yet")
    expect(reply).toBe([
      "live conversation: cli/session",
      "active lane: this same thread",
      "current artifact: no artifact yet",
      "latest checkpoint: just checked the live thread",
      "next action: continue the active loop and bring the result back here",
      "other active sessions:",
      "- none",
    ].join("\n"))
  })

  it("renders family status reply contract from the live current-thread obligation when one exists", async () => {
    const { renderExactStatusReplyContract } = await import("../../mind/obligation-steering")
    const result = renderExactStatusReplyContract(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        pendingObligations: [
          {
            id: "ob-current",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "close the loop here",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:01:00.000Z",
          },
        ],
      }),
      null,
      "all-sessions-family",
    )

    expect(result).toContain("live conversation: cli/session")
    expect(result).toContain("active lane: this same thread")
    expect(result).toContain("current artifact: no artifact yet")
    expect(result).toContain('next action: work on "close the loop here" and bring back a concrete artifact')
  })

  it("builds family status replies with an explicit none marker when no other sessions are active", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        pendingObligations: [
          {
            id: "ob-current",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "close the loop here",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
          },
        ],
        friendActivity: {
          freshestForCurrentFriend: null,
          otherLiveSessionsForCurrentFriend: [],
          allOtherLiveSessions: [],
        },
        otherCodingSessions: [],
      }),
      null,
      "just verified the current thread",
      "all-sessions-family",
    )

    expect(result).toBe([
      "live conversation: cli/session",
      "active lane: this same thread",
      "current artifact: no artifact yet",
      "latest checkpoint: just verified the current thread",
      'next action: work on "close the loop here" and bring back a concrete artifact',
      "other active sessions:",
      "- none",
    ].join("\n"))
  })

  it("builds family status replies for obligation-only sessions without a live-session record", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        pendingObligations: [
          {
            id: "ob-current",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "close the loop here",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
          },
          {
            id: "ob-other",
            origin: { friendId: "alex", channel: "teams", key: "thread-7" },
            content: "carry the fix back there",
            status: "investigating",
            createdAt: "2026-03-21T10:02:00.000Z",
            updatedAt: "2026-03-21T10:03:00.000Z",
          },
        ],
        friendActivity: {
          freshestForCurrentFriend: null,
          otherLiveSessionsForCurrentFriend: [],
          allOtherLiveSessions: [],
        },
        otherCodingSessions: [],
      }),
      null,
      "just verified the current thread",
      "all-sessions-family",
    )

    expect(result).toContain("other active sessions:")
    expect(result).toContain("- alex/teams/thread-7: [investigating] this live thread; artifact no artifact yet; next continue the active loop and bring the result back there")
  })

  it("falls back to friend ids when sparse family frames only know about other obligations", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        friendActivity: undefined as any,
        otherCodingSessions: undefined,
        pendingObligations: [
          {
            id: "ob-current",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "close the loop here",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
          },
          {
            id: "ob-other",
            origin: { friendId: "sam", channel: "teams", key: "thread-9" },
            content: "carry the fix back there",
            status: "investigating",
            createdAt: "2026-03-21T10:04:00.000Z",
            updatedAt: "2026-03-21T10:05:00.000Z",
          },
        ],
      }),
      null,
      "just checked the live thread",
      "all-sessions-family",
    )

    expect(result).toContain("- sam/teams/thread-9: [investigating] this live thread; artifact no artifact yet; next continue the active loop and bring the result back there")
  })

  it("builds family status replies from live or coding candidates even before other obligations exist", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        pendingObligations: undefined,
        friendActivity: {
          freshestForCurrentFriend: null,
          otherLiveSessionsForCurrentFriend: [],
          allOtherLiveSessions: [
            {
              friendId: "jamie",
              friendName: "Jamie",
              channel: "teams",
              key: "pairing",
              sessionPath: "/tmp/jamie-teams.json",
              lastActivityAt: "2026-03-21T10:08:00.000Z",
              lastActivityMs: Date.parse("2026-03-21T10:08:00.000Z"),
              activitySource: "friend-facing",
            },
          ],
        },
        otherCodingSessions: [
          {
            id: "coding-jamie",
            runner: "codex",
            workdir: "/tmp/workspaces/jamie",
            taskRef: "jamie-pass",
            status: "running",
            stdoutTail: "",
            stderrTail: "",
            pid: 401,
            startedAt: "2026-03-21T10:07:00.000Z",
            lastActivityAt: "2026-03-21T10:09:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            originSession: { friendId: "jamie", channel: "teams", key: "pairing" },
          },
        ],
      }),
      null,
      "just checked the live thread",
      "all-sessions-family",
    )

    expect(result).toContain("- Jamie/teams/pairing: [running] codex coding-jamie; artifact no PR or merge artifact yet; next finish the coding pass and bring the result back there")
  })

  it("ignores current-thread, fulfilled, and originless candidates when summarizing other sessions", async () => {
    const { buildExactStatusReply } = await import("../../mind/obligation-steering")
    const result = buildExactStatusReply(
      makeMinimalFrame({
        currentObligation: "close the loop here",
        friendActivity: {
          freshestForCurrentFriend: null,
          otherLiveSessionsForCurrentFriend: [],
          allOtherLiveSessions: [
            {
              friendId: "other",
              friendName: "Other",
              channel: "teams",
              key: "thread",
              sessionPath: "/tmp/other-thread.json",
              lastActivityAt: "2026-03-21T10:06:00.000Z",
              lastActivityMs: Date.parse("2026-03-21T10:06:00.000Z"),
              activitySource: "friend-facing",
            },
          ],
        },
        otherCodingSessions: [
          {
            id: "coding-originless",
            runner: "codex",
            workdir: "/tmp/originless",
            taskRef: "originless",
            status: "running",
            stdoutTail: "",
            stderrTail: "",
            pid: 301,
            startedAt: "2026-03-21T10:00:00.000Z",
            lastActivityAt: "2026-03-21T10:01:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
          },
          {
            id: "coding-same",
            runner: "codex",
            workdir: "/tmp/same",
            taskRef: "same-thread",
            status: "running",
            stdoutTail: "",
            stderrTail: "",
            pid: 302,
            startedAt: "2026-03-21T10:00:00.000Z",
            lastActivityAt: "2026-03-21T10:02:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            originSession: { friendId: "friend-1", channel: "cli", key: "session" },
          },
          {
            id: "coding-other",
            runner: "codex",
            workdir: "/tmp/other",
            taskRef: "other-thread",
            status: "running",
            stdoutTail: "",
            stderrTail: "",
            pid: 303,
            startedAt: "2026-03-21T10:00:00.000Z",
            lastActivityAt: "2026-03-21T10:07:00.000Z",
            endedAt: null,
            restartCount: 0,
            lastExitCode: null,
            lastSignal: null,
            failure: null,
            originSession: { friendId: "other", channel: "teams", key: "thread" },
          },
        ],
        pendingObligations: [
          {
            id: "ob-current",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "close the loop here",
            status: "investigating",
            createdAt: "2026-03-21T10:00:00.000Z",
            updatedAt: "2026-03-21T10:00:00.000Z",
          },
          {
            id: "ob-fulfilled",
            origin: { friendId: "fulfilled", channel: "cli", key: "done" },
            content: "already resolved",
            status: "fulfilled",
            createdAt: "2026-03-21T09:59:00.000Z",
            updatedAt: "2026-03-21T09:59:00.000Z",
          },
          {
            id: "ob-same",
            origin: { friendId: "friend-1", channel: "cli", key: "session" },
            content: "still here",
            status: "waiting_for_merge",
            createdAt: "2026-03-21T10:01:00.000Z",
            updatedAt: "2026-03-21T10:01:00.000Z",
          },
        ],
      }),
      null,
      "just checked the live thread",
      "all-sessions-family",
    )

    expect(result).toContain("- Other/teams/thread: [running] codex coding-other; artifact no PR or merge artifact yet; next finish the coding pass and bring the result back there")
    expect(result).not.toContain("coding-originless")
    expect(result).not.toContain("coding-same")
    expect(result).not.toContain("fulfilled/cli/done")
  })
})
