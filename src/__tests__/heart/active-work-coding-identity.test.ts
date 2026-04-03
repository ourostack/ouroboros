import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../nerves/runtime"
import type { ActiveWorkFrame } from "../../heart/active-work"
import type { CodingIdentityPacket } from "../../repertoire/coding/context-pack"
import type { InnerJob } from "../../heart/daemon/thoughts"
import type { CodingSession } from "../../repertoire/coding/types"

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

function makeSession(overrides: Partial<CodingSession> = {}): CodingSession {
  return {
    id: "coding-001",
    runner: "codex",
    workdir: "/Users/test/Projects/ouro",
    taskRef: "task-123",
    checkpoint: "implementing feature",
    artifactPath: "/path/to/artifact",
    status: "running",
    stdoutTail: "",
    stderrTail: "",
    pid: 1234,
    startedAt: "2026-03-21T00:00:00.000Z",
    lastActivityAt: "2026-03-21T00:05:00.000Z",
    endedAt: null,
    restartCount: 0,
    lastExitCode: null,
    lastSignal: null,
    failure: null,
    ...overrides,
  }
}

function makeFrame(overrides: Partial<ActiveWorkFrame> = {}): ActiveWorkFrame {
  return {
    currentSession: { friendId: "friend-1", channel: "cli" as any, key: "session", sessionPath: "/tmp/s.json" },
    currentObligation: null,
    mustResolveBeforeHandoff: false,
    centerOfGravity: "inward-work",
    inner: { status: "idle", hasPending: false, job: makeIdleJob() },
    bridges: [],
    taskPressure: { compactBoard: "", liveTaskNames: [], activeBridges: [] },
    friendActivity: { freshestForCurrentFriend: null, otherLiveSessionsForCurrentFriend: [] },
    codingSessions: [makeSession()],
    otherCodingSessions: [],
    pendingObligations: [],
    bridgeSuggestion: null,
    ...overrides,
  }
}

describe("active-work coding identity rendering", () => {
  let formatActiveWorkFrame: (frame: ActiveWorkFrame, options?: { obligationDetailsRenderedElsewhere?: boolean }) => string

  beforeAll(async () => {
    const mod = await import("../../heart/active-work")
    formatActiveWorkFrame = mod.formatActiveWorkFrame
  })

  it("renders coding identity section when codingIdentity is present on a coding session", () => {
    const frame = makeFrame({
      codingSessions: [
        makeSession({
          codingIdentity: {
            repoPath: "/Users/test/Projects/ouro",
            worktreePath: "/Users/test/worktrees/feat-branch",
            branch: "feat/self-fix",
            commit: "abc1234",
            dirty: true,
            dirtyFiles: [" M src/file.ts"],
            taskRef: "task-123",
            verificationCommands: ["npm test"],
            verificationStatus: "not-verified",
          },
        }),
      ],
    })

    const result = formatActiveWorkFrame(frame)
    expect(result).toContain("feat/self-fix")
    expect(result).toContain("abc1234")
    expect(result).toContain("dirty")
  })

  it("renders verified status distinctly from not-verified", () => {
    const frame = makeFrame({
      codingSessions: [
        makeSession({
          codingIdentity: {
            repoPath: "/Users/test/Projects/ouro",
            worktreePath: "/Users/test/Projects/ouro",
            branch: "feat/fix",
            commit: "def5678",
            dirty: false,
            dirtyFiles: [],
            taskRef: "task-456",
            verificationCommands: ["npm test"],
            verificationStatus: "verified-pass",
          },
        }),
      ],
    })

    const result = formatActiveWorkFrame(frame)
    expect(result).toContain("verified-pass")
    expect(result).not.toContain("not-verified")
  })

  it("renders verification-failed status", () => {
    const frame = makeFrame({
      codingSessions: [
        makeSession({
          codingIdentity: {
            repoPath: "/Users/test/Projects/ouro",
            worktreePath: "/Users/test/Projects/ouro",
            branch: "feat/broken",
            commit: "bad0000",
            dirty: true,
            dirtyFiles: [" M broken.ts"],
            taskRef: null,
            verificationCommands: ["npm test"],
            verificationStatus: "verified-fail",
          },
        }),
      ],
    })

    const result = formatActiveWorkFrame(frame)
    expect(result).toContain("verified-fail")
  })

  it("omits coding identity section when no codingIdentity on sessions", () => {
    const frame = makeFrame({
      codingSessions: [makeSession()],
    })

    const result = formatActiveWorkFrame(frame)
    // Should still render coding work section but not identity specifics
    expect(result).toContain("live coding work")
    expect(result).not.toContain("## coding identity")
  })
})
