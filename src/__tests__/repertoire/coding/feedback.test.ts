import { describe, expect, it, vi } from "vitest"

import { attachCodingSessionFeedback, formatCodingTail } from "../../../repertoire/coding/feedback"
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
})
