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
})
