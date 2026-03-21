import { describe, expect, it, vi } from "vitest"

vi.mock("../../../heart/identity", () => ({
  getAgentName: vi.fn(() => "slugger"),
  getAgentRoot: vi.fn(() => "/Users/test/AgentBundles/slugger.ouro"),
}))

vi.mock("../../../heart/obligations", () => ({
  advanceObligation: vi.fn(),
}))

vi.mock("../../../heart/daemon/socket-client", () => ({
  requestInnerWake: vi.fn().mockResolvedValue(null),
}))

import { attachCodingSessionFeedback, formatCodingTail } from "../../../repertoire/coding/feedback"
import { advanceObligation } from "../../../heart/obligations"
import { requestInnerWake } from "../../../heart/daemon/socket-client"
import type { CodingSession, CodingSessionUpdate } from "../../../repertoire/coding/types"

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
    ...overrides,
  }
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
      session: makeSession({ stdoutTail: "thinking" }),
      stream: "stdout",
      text: "thinking",
    })
    await Promise.resolve()
    expect(target.send).toHaveBeenCalledWith("codex coding-001: thinking")

    await listener?.({
      kind: "progress",
      session: makeSession({ stdoutTail: "thinking" }),
      stream: "stdout",
      text: "thinking",
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
        stdoutTail: "stdout payload",
        stderrTail: "stderr payload",
      }),
    )

    expect(rendered).toContain("sessionId: coding-001")
    expect(rendered).toContain("status: failed")
    expect(rendered).toContain("[stdout]")
    expect(rendered).toContain("stdout payload")
    expect(rendered).toContain("[stderr]")
    expect(rendered).toContain("stderr payload")
  })

  it("renders empty coding tails with explicit placeholders", () => {
    const rendered = formatCodingTail(
      makeSession({
        stdoutTail: "",
        stderrTail: "",
      }),
    )

    expect(rendered).toContain("[stdout]\n(empty)")
    expect(rendered).toContain("[stderr]\n(empty)")
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
      session: makeSession({ stdoutTail: "thinking" }),
      stream: "stdout",
      text: "thinking",
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(target.send).toHaveBeenCalledWith("codex coding-001 started")
    expect(target.send).toHaveBeenCalledWith("codex coding-001: thinking")
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

    expect(target.send).toHaveBeenLastCalledWith("codex coding-001 for bluebubbles/chat completed: opened PR #123")
  })

  it("wakes inner dialog when an obligation-bound coding session needs the loop to continue", async () => {
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
    session.obligationId = "ob-4"

    vi.mocked(requestInnerWake).mockClear()
    attachCodingSessionFeedback(manager, session as CodingSession, target)
    await Promise.resolve()

    expect(requestInnerWake).not.toHaveBeenCalled()

    await listener?.({
      kind: "progress",
      session: { ...(session as CodingSession), stdoutTail: "thinking" },
      stream: "stdout",
      text: "thinking",
    })
    await Promise.resolve()
    expect(requestInnerWake).not.toHaveBeenCalled()

    await listener?.({
      kind: "waiting_input",
      session: { ...(session as CodingSession), status: "waiting_input" },
    })
    await listener?.({
      kind: "stalled",
      session: { ...(session as CodingSession), status: "stalled" },
    })
    await listener?.({
      kind: "completed",
      session: {
        ...(session as CodingSession),
        status: "completed",
        pid: null,
        endedAt: "2026-03-05T23:55:00.000Z",
      },
    })
    await listener?.({
      kind: "failed",
      session: {
        ...(session as CodingSession),
        status: "failed",
        pid: null,
        endedAt: "2026-03-05T23:56:00.000Z",
      },
    })
    await listener?.({
      kind: "killed",
      session: {
        ...(session as CodingSession),
        status: "killed",
        pid: null,
        endedAt: "2026-03-05T23:57:00.000Z",
      },
    })
    await Promise.resolve()

    expect(requestInnerWake).toHaveBeenCalledTimes(5)
    expect(requestInnerWake).toHaveBeenNthCalledWith(1, "slugger")
    expect(requestInnerWake).toHaveBeenNthCalledWith(2, "slugger")
    expect(requestInnerWake).toHaveBeenNthCalledWith(3, "slugger")
    expect(requestInnerWake).toHaveBeenNthCalledWith(4, "slugger")
    expect(requestInnerWake).toHaveBeenNthCalledWith(5, "slugger")
  })

  it("does not wake inner dialog for coding sessions without an obligation", async () => {
    let listener: ((update: CodingSessionUpdate) => void | Promise<void>) | undefined
    const manager = {
      subscribe: vi.fn((_sessionId: string, cb: (update: CodingSessionUpdate) => void | Promise<void>) => {
        listener = cb
        return () => undefined
      }),
    }
    const target = { send: vi.fn().mockResolvedValue(undefined) }

    vi.mocked(requestInnerWake).mockClear()
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

  it("keeps relaying feedback when an obligation wake request fails", async () => {
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

    vi.mocked(requestInnerWake).mockClear()
    vi.mocked(requestInnerWake)
      .mockRejectedValueOnce("wake failed")
      .mockRejectedValueOnce(new Error("wake failed error"))
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
    expect(requestInnerWake).toHaveBeenCalledWith("slugger")
  })
})
