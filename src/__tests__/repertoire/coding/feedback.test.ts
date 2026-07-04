import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "slugger"),
  getAgentRoot: vi.fn(() => "/Users/test/AgentBundles/slugger.ouro"),
}))

vi.mock("../../../arc/obligations", () => ({
  advanceObligation: vi.fn(),
}))

vi.mock("../../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn().mockResolvedValue(null),
  requestPrivateWake: vi.fn().mockResolvedValue(null),
}))

import { attachCodingSessionFeedback, formatCodingTail } from "../../../repertoire/coding/feedback"
import { advanceObligation } from "../../../arc/obligations"
import { requestInnerWake, requestPrivateWake } from "../../../heart/daemon/socket-client"
import { createLogger, type LogEvent } from "../../../nerves"
import { setRuntimeLogger } from "../../../nerves/runtime"
import type { CodingSession, CodingSessionUpdate } from "../../../repertoire/coding/types"

afterEach(() => {
  setRuntimeLogger(null)
})

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "coding-001",
    runner: "codex",
    workdir: "/Users/test/repo",
    taskRef: "task-1",
    scopeFile: undefined,
    stateFile: undefined,
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: 1234,
    startedAt: "2026-03-05T23:50:00.000Z",
    lastActivityAt: "2026-03-05T23:50:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    checkpoint: null,
    artifactPath: undefined,
    ...overrides,
  }
}

function originSessionId(session: CodingSession): string {
  return session.originSession
    ? `${session.originSession.friendId}/${session.originSession.channel}/${session.originSession.key}`
    : "detached"
}

function expectCodingFeedbackPrivateWake(input: {
  callNumber?: number
  kind: CodingSessionUpdate["kind"]
  session: CodingSession
}): void {
  const callNumber = input.callNumber ?? 1
  const obligationId = input.session.obligationId ?? "missing-obligation"
  expect(requestPrivateWake).toHaveBeenNthCalledWith(callNumber, "slugger", undefined, {
    reason: "coding feedback private attention",
    triggerSource: "coding-feedback",
    budgetClass: "interactive",
    idempotencyKey: `coding-feedback:slugger:${obligationId}:${input.session.id}:${input.kind}`,
    originRefs: [
      { kind: "coding-session", id: input.session.id },
      { kind: "coding-update", id: input.kind },
      { kind: "obligation", id: obligationId },
      { kind: "session", id: originSessionId(input.session) },
    ],
  })
  expect(requestInnerWake).not.toHaveBeenCalled()
}

describe("coding feedback relay", () => {
  it("sends a start message immediately and formats terminal updates", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 started")

    await listener?.({
      kind: "completed",
      session: makeSession({
        status: "completed",
        stdoutTail: "OpenAI Codex v0.104.0\n--------\ncodex\nhi\ntokens used\n3,815\nhi",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      }),
    })

    expect(target.send).toHaveBeenLastCalledWith("codex coding-001 completed: hi")
  })

  it("filters banner noise and deduplicates repeated progress updates", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "progress",
      session: makeSession(),
      stream: "stdout",
      text: "OpenAI Codex v0.104.0\n--------\nworkdir: /Users/test/repo\n",
    })
    await Promise.resolve()
    expect(target.send).not.toHaveBeenCalled()

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "tests green" }),
      stream: "stdout",
      text: "tests green",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledWith("codex coding-001: tests green")

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "tests green" }),
      stream: "stdout",
      text: "tests green",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledTimes(1)

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "main" }),
      stream: "stdout",
      text: "main",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledTimes(1)

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "}," }),
      stream: "stdout",
      text: "},",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledTimes(1)

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "Respond with exactly: hi" }),
      stream: "stderr",
      text: "Respond with exactly: hi",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledTimes(1)
  })

  it("renders coding tails in a readable block", () => {
    const rendered = formatCodingTail(
      makeSession({
        status: "failed",
        checkpoint: "apply_patch blew up",
        artifactPath: "/Users/test/AgentBundles/slugger.ouro/state/coding/sessions/coding-001.md",
        stdoutTail: "stdout payload",
        stderrTail: "stderr payload",
      }),
    )

    expect(rendered).toContain("sessionId: coding-001")
    expect(rendered).toContain("status: failed")
    expect(rendered).toContain("checkpoint: apply_patch blew up")
    expect(rendered).toContain("artifactPath: /Users/test/AgentBundles/slugger.ouro/state/coding/sessions/coding-001.md")
    expect(rendered).toContain("[stdout]")
    expect(rendered).toContain("stdout payload")
    expect(rendered).toContain("[stderr]")
    expect(rendered).toContain("stderr payload")
  })

  it("renders empty coding tails with explicit placeholders", () => {
    const rendered = formatCodingTail(
      makeSession({
        checkpoint: null,
        stdoutTail: "",
        stderrTail: "",
      }),
    )

    expect(rendered).toContain("checkpoint: (empty)")
    expect(rendered).toContain("artifactPath: (none)")
    expect(rendered).toContain("[stdout]\n(empty)")
    expect(rendered).toContain("[stderr]\n(empty)")
  })

  it("prefers session checkpoints when formatting update messages", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "waiting_input",
      session: makeSession({
        status: "waiting_input",
        checkpoint: "needs review on the failing coverage branch",
        stdoutTail: "OpenAI Codex v0.104.0\n--------\nstatus: NEEDS_REVIEW",
      }),
      stream: "stdout",
      text: "OpenAI Codex v0.104.0\n--------\nstatus: NEEDS_REVIEW",
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 waiting: needs review on the failing coverage branch")
  })

  it("supports kill updates, send failures, and manual unsubscribe", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockRejectedValue(new Error("send failed")) }

    const stop = attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    await Promise.resolve()

    await listener?.({
      kind: "killed",
      session: makeSession({ status: "killed", pid: null, endedAt: "2026-03-05T23:55:00.000Z" }),
    })
    await Promise.resolve()
    await Promise.resolve()

    stop()
    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "thinking" }),
      stream: "stdout",
      text: "thinking",
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 started")
    expect(target.send).toHaveBeenCalledWith("codex coding-001 killed")
    expect(target.send).toHaveBeenCalledTimes(2)
  })

  it("logs string send failures without crashing the relay", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockRejectedValue("plain string failure") }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    await Promise.resolve()

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "tests green" }),
      stream: "stdout",
      text: "tests green",
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 started")
    expect(target.send).toHaveBeenCalledWith("codex coding-001: tests green")
  })

  it("formats waiting, stalled, failed, and clipped terminal messages without snippets", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "waiting_input",
      session: makeSession({ status: "waiting_input" }),
    })
    await listener?.({
      kind: "stalled",
      session: makeSession({ status: "stalled" }),
    })
    await listener?.({
      kind: "failed",
      session: makeSession({ status: "failed", pid: null, endedAt: "2026-03-05T23:55:00.000Z" }),
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenNthCalledWith(1, "codex coding-001 waiting")
    expect(target.send).toHaveBeenNthCalledWith(2, "codex coding-001 stalled")
    expect(target.send).toHaveBeenNthCalledWith(3, "codex coding-001 failed")
  })

  it("formats waiting, stalled, and failed updates with meaningful snippets", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "waiting_input",
      session: makeSession({ status: "waiting_input", stdoutTail: "need your approval" }),
    })
    await listener?.({
      kind: "stalled",
      session: makeSession({ status: "stalled", stderrTail: "still indexing" }),
    })
    expect(target.send).toHaveBeenNthCalledWith(1, "codex coding-001 waiting: need your approval")
    expect(target.send).toHaveBeenNthCalledWith(2, "codex coding-001 stalled: still indexing")
  })

  it("formats failed updates with a meaningful snippet", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "failed",
      session: makeSession({
        status: "failed",
        stderrTail: "exit 1",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      }),
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 failed: exit 1")
  })

  it("clips long completed snippets", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: makeSession({
        status: "completed",
        stdoutTail: "x".repeat(400),
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      }),
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith(
      expect.stringMatching(/^codex coding-001 completed: x{10,}\.\.\.$/),
    )
  })

  it("formats completed updates without a snippet", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: makeSession({
        status: "completed",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      }),
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 completed")
  })

  it("handles terminal updates emitted during subscription before unsubscribe is replaced", async () => {
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession()
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        void cb({
          kind: "completed",
          session: makeSession({
            status: "completed",
            stdoutTail: "done",
            pid: null,
            endedAt: "2026-03-05T23:55:00.000Z",
          }),
        })
        return () => undefined
      }),
    }

    attachCodingSessionFeedback(manager, session, target)
    await Promise.resolve()

    expect(target.send).toHaveBeenNthCalledWith(1, "codex coding-001 started")
    expect(target.send).toHaveBeenNthCalledWith(2, "codex coding-001 completed: done")
  })

  it("includes the originating live session in feedback messages when coding work belongs to a return loop", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & {
      originSession?: { friendId: string; channel: string; key: string }
      obligationId?: string
    }
    session.originSession = { friendId: "ari", channel: "bluebubbles", key: "chat" }
    session.obligationId = "ob-1"

    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 for bluebubbles/chat started")

    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        stdoutTail: "opened PR #123",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenLastCalledWith(
      "codex coding-001 for bluebubbles/chat completed: opened PR #123\ncurrent artifact: PR #123\nnext: wait for checks, merge PR #123, then update runtime",
    )
  })

  it("turns opened-pr milestones into concrete report-back messages and merge-state obligation updates", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & {
      originSession?: { friendId: string; channel: string; key: string }
      obligationId?: string
    }
    session.originSession = { friendId: "ari", channel: "bluebubbles", key: "chat" }
    session.obligationId = "ob-6"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        stdoutTail: "opened PR #123",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenLastCalledWith(
      "codex coding-001 for bluebubbles/chat completed: opened PR #123\ncurrent artifact: PR #123\nnext: wait for checks, merge PR #123, then update runtime",
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-6",
      expect.objectContaining({
        status: "waiting_for_merge",
        currentSurface: { kind: "merge", label: "PR #123" },
        currentArtifact: "PR #123",
        nextAction: "wait for checks, merge PR #123, then update runtime",
      }),
    )
  })

  it("turns merged-pr milestones into runtime-update report-back messages", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & {
      originSession?: { friendId: string; channel: string; key: string }
      obligationId?: string
    }
    session.originSession = { friendId: "ari", channel: "bluebubbles", key: "chat" }
    session.obligationId = "ob-7"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        stdoutTail: "merged PR #123",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenLastCalledWith(
      "codex coding-001 for bluebubbles/chat completed: merged PR #123\ncurrent artifact: PR #123\nnext: update runtime, verify version/changelog, then re-observe",
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-7",
      expect.objectContaining({
        status: "updating_runtime",
        currentSurface: { kind: "runtime", label: "ouro up" },
        currentArtifact: "PR #123",
        nextAction: "update runtime, verify version/changelog, then re-observe",
      }),
    )
  })

  it("recognizes pull-request URLs and landed wording in obligation-bound report-backs", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & {
      originSession?: { friendId: string; channel: string; key: string }
      obligationId?: string
    }
    session.originSession = { friendId: "ari", channel: "bluebubbles", key: "chat" }
    session.obligationId = "ob-8"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        stdoutTail: "landed https://github.com/ourostack/ouroboros/pull/124",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenLastCalledWith(
      "codex coding-001 for bluebubbles/chat completed: landed https://github.com/ourostack/ouroboros/pull/124\ncurrent artifact: PR #124\nnext: update runtime, verify version/changelog, then re-observe",
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-8",
      expect.objectContaining({
        status: "updating_runtime",
        currentSurface: { kind: "runtime", label: "ouro up" },
        currentArtifact: "PR #124",
      }),
    )
  })

  it("falls back safely when coding updates are malformed or milestone-less", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & {
      originSession?: { friendId: string; channel: string; key: string }
      obligationId?: string
    }
    session.originSession = { friendId: "ari", channel: "cli", key: "session" }
    session.obligationId = "ob-9"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        stdoutTail: "done and dusted",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await listener?.({
      kind: "unknown" as never,
      session: {
        ...(session as CodingSession),
        status: "running",
      },
    })
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledTimes(1)
    expect(target.send).toHaveBeenCalledWith("codex coding-001 for cli/session completed: done and dusted")
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-9",
      expect.objectContaining({
        status: "investigating",
        currentSurface: { kind: "coding", label: "codex coding-001" },
      }),
    )
  })

  it("requests private attention when an obligation-bound coding session needs the loop to continue", async () => {
    async function attachAndEmit(update: CodingSessionUpdate): Promise<void> {
      let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
      const manager = {
        subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
          listener = cb
          return () => undefined
        }),
      }
      const target = { send: vi.fn().mockResolvedValue(undefined) }
      attachCodingSessionFeedback(manager, update.session, target)
      await Promise.resolve()
      await listener?.(update)
      await Promise.resolve()
    }

    const baseSession = makeSession({
      originSession: { friendId: "ari", channel: "cli", key: "session" },
      obligationId: "ob-4",
    })

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestPrivateWake).mockClear()

    await attachAndEmit({
      kind: "progress",
      session: { ...baseSession, stdoutTail: "thinking" },
      stream: "stdout",
      text: "thinking",
    })

    expect(requestInnerWake).not.toHaveBeenCalled()
    expect(requestPrivateWake).not.toHaveBeenCalled()

    const updates = [
      {
        kind: "waiting_input",
        session: { ...baseSession, status: "waiting_input" },
      },
      {
        kind: "stalled",
        session: { ...baseSession, status: "stalled" },
      },
      {
        kind: "completed",
        session: {
          ...baseSession,
          status: "completed",
          pid: null,
          endedAt: "2026-03-05T23:55:00.000Z",
        },
      },
      {
        kind: "failed",
        session: {
          ...baseSession,
          status: "failed",
          pid: null,
          endedAt: "2026-03-05T23:56:00.000Z",
        },
      },
      {
        kind: "killed",
        session: {
          ...baseSession,
          status: "killed",
          pid: null,
          endedAt: "2026-03-05T23:57:00.000Z",
        },
      },
    ] satisfies CodingSessionUpdate[]

    for (const update of updates) {
      await attachAndEmit(update)
    }

    expect(requestPrivateWake).toHaveBeenCalledTimes(5)
    updates.forEach((update, index) => {
      expectCodingFeedbackPrivateWake({ callNumber: index + 1, kind: update.kind, session: update.session })
    })
  })

  it("does not request private attention for coding sessions without an obligation", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestPrivateWake).mockClear()
    attachCodingSessionFeedback(manager, makeSession(), target)
    await Promise.resolve()

    await listener?.({
      kind: "completed",
      session: makeSession({
        status: "completed",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      }),
    })
    await Promise.resolve()

    expect(requestInnerWake).not.toHaveBeenCalled()
    expect(requestPrivateWake).not.toHaveBeenCalled()
  })

  it("updates obligation notes for progress, waiting, stalled, failed, and killed coding states", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & { obligationId?: string }
    session.obligationId = "ob-2"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()

    await listener?.({
      kind: "progress",
      session: { ...(session as CodingSession), stdoutTail: "thinking" },
      stream: "stdout",
      text: "thinking",
    })
    await listener?.({
      kind: "waiting_input",
      session: { ...(session as CodingSession), status: "waiting_input" },
    })
    await listener?.({
      kind: "stalled",
      session: { ...(session as CodingSession), status: "stalled" },
    })
    await listener?.({
      kind: "failed",
      session: { ...(session as CodingSession), status: "failed", pid: null, endedAt: "2026-03-05T23:55:00.000Z" },
    })
    await listener?.({
      kind: "killed",
      session: { ...(session as CodingSession), status: "killed", pid: null, endedAt: "2026-03-05T23:56:00.000Z" },
    })
    await Promise.resolve()

    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session progress: thinking" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session waiting for input" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session stalled" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session failed" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-2",
      expect.objectContaining({ latestNote: "coding session killed" }),
    )
  })

  it("covers snippet and no-snippet obligation note branches during feedback syncing", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & { obligationId?: string }
    session.obligationId = "ob-3"

    vi.mocked(advanceObligation).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()

    await listener?.({
      kind: "progress",
      session: { ...(session as CodingSession) },
      stream: "stdout",
      text: "OpenAI Codex v0.104.0\n--------\n",
    })
    await listener?.({
      kind: "waiting_input",
      session: { ...(session as CodingSession), status: "waiting_input", stdoutTail: "need approval" },
    })
    await listener?.({
      kind: "stalled",
      session: { ...(session as CodingSession), status: "stalled", stderrTail: "still indexing" },
    })
    await listener?.({
      kind: "completed",
      session: { ...(session as CodingSession), status: "completed", pid: null, endedAt: "2026-03-05T23:55:00.000Z" },
    })
    await listener?.({
      kind: "failed",
      session: { ...(session as CodingSession), status: "failed", stderrTail: "apply_patch blew up", pid: null, endedAt: "2026-03-05T23:56:00.000Z" },
    })
    await Promise.resolve()

    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-3",
      expect.objectContaining({ latestNote: undefined }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-3",
      expect.objectContaining({ latestNote: "coding session waiting: need approval" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-3",
      expect.objectContaining({ latestNote: "coding session stalled: still indexing" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-3",
      expect.objectContaining({ latestNote: "coding session completed; merge/update still pending" }),
    )
    expect(advanceObligation).toHaveBeenCalledWith(
      "/Users/test/AgentBundles/slugger.ouro",
      "ob-3",
      expect.objectContaining({ latestNote: "coding session failed: apply_patch blew up" }),
    )
  })

  it("keeps relaying feedback when default policy denies private wake execution", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession({
      originSession: { friendId: "ari", channel: "cli", key: "session" },
      obligationId: "ob-10",
    })

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestPrivateWake).mockClear()
    vi.mocked(requestPrivateWake).mockResolvedValueOnce({
      ok: true,
      message: "private-runtime wake denied for slugger: default policy",
      data: {
        decision: {
          executable: false,
          deniedReason: "default policy",
        },
      },
    })
    attachCodingSessionFeedback(manager, session, target)
    await Promise.resolve()
    target.send.mockClear()

    const waitingUpdate = {
      kind: "waiting_input",
      session: { ...session, status: "waiting_input" },
    } satisfies CodingSessionUpdate
    await listener?.(waitingUpdate)
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith(
      "codex coding-001 for cli/session waiting\nnext: answer codex coding-001 and continue",
    )
    expectCodingFeedbackPrivateWake({ kind: "waiting_input", session: waitingUpdate.session })
  })

  it("uses the same private wake idempotency key for duplicate obligation feedback updates", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession({
      originSession: { friendId: "ari", channel: "cli", key: "session" },
      obligationId: "ob-11",
    })

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestPrivateWake).mockClear()
    attachCodingSessionFeedback(manager, session, target)
    await Promise.resolve()
    target.send.mockClear()

    const waitingUpdate = {
      kind: "waiting_input",
      session: { ...session, status: "waiting_input" },
    } satisfies CodingSessionUpdate
    await listener?.(waitingUpdate)
    await listener?.(waitingUpdate)
    await Promise.resolve()

    expect(requestPrivateWake).toHaveBeenCalledTimes(2)
    expectCodingFeedbackPrivateWake({ callNumber: 1, kind: "waiting_input", session: waitingUpdate.session })
    expectCodingFeedbackPrivateWake({ callNumber: 2, kind: "waiting_input", session: waitingUpdate.session })
    expect(vi.mocked(requestPrivateWake).mock.calls[0]?.[2]?.idempotencyKey).toBe(
      vi.mocked(requestPrivateWake).mock.calls[1]?.[2]?.idempotencyKey,
    )
  })

  it("keeps relaying feedback when an obligation private wake request fails", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }
    const session = makeSession() as CodingSession & { obligationId?: string }
    session.obligationId = "ob-5"
    const events: LogEvent[] = []

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestPrivateWake).mockClear()
    vi.mocked(requestPrivateWake)
      .mockRejectedValueOnce("wake failed")
      .mockRejectedValueOnce(new Error("wake failed error"))
    setRuntimeLogger(createLogger({ level: "debug", sinks: [(entry) => events.push(entry)] }))
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()
    target.send.mockClear()

    await listener?.({
      kind: "waiting_input",
      session: { ...(session as CodingSession), status: "waiting_input" },
    })
    await listener?.({
      kind: "stalled",
      session: { ...(session as CodingSession), status: "stalled" },
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 waiting")
    expect(target.send).toHaveBeenCalledWith("codex coding-001 stalled")
    expect(requestPrivateWake).toHaveBeenCalledTimes(2)
    expectCodingFeedbackPrivateWake({ callNumber: 1, kind: "waiting_input", session: session as CodingSession })
    expectCodingFeedbackPrivateWake({ callNumber: 2, kind: "stalled", session: session as CodingSession })
    expect(requestInnerWake).not.toHaveBeenCalled()
    expect(events.filter((event) => event.event === "repertoire.coding_feedback_wake_error")).toEqual([
      expect.objectContaining({
        level: "warn",
        component: "repertoire",
        message: "coding feedback wake request failed",
        meta: {
          sessionId: "coding-001",
          kind: "waiting_input",
          reason: "wake failed",
        },
      }),
      expect.objectContaining({
        level: "warn",
        component: "repertoire",
        message: "coding feedback wake request failed",
        meta: {
          sessionId: "coding-001",
          kind: "stalled",
          reason: "wake failed error",
        },
      }),
    ])
  })
})
