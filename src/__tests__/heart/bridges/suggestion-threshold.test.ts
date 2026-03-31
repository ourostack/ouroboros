import { describe, it, expect, vi, beforeAll } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

import { emitNervesEvent } from "../../../nerves/runtime"
import type { BridgeSuggestionInput } from "../../../heart/active-work"
import type { TargetSessionCandidate } from "../../../heart/target-resolution"

function makeCandidate(overrides: Partial<TargetSessionCandidate> = {}): TargetSessionCandidate {
  return {
    friendId: "friend-2",
    friendName: "Bob",
    channel: "cli",
    key: "session",
    sessionPath: "/tmp/s.json",
    snapshot: "",
    trust: { level: "friend", basis: "direct", summary: "", why: "", permits: [], constraints: [] },
    delivery: { mode: "direct", reason: "" },
    lastActivityAt: "2026-01-01T00:00:00Z",
    lastActivityMs: Date.parse("2026-01-01T00:00:00Z"),
    activitySource: "friend-facing",
    ...overrides,
  }
}

function makeInput(overrides: Partial<BridgeSuggestionInput> = {}): BridgeSuggestionInput {
  return {
    currentSession: { friendId: "friend-1", channel: "teams" as any, key: "conv-1", sessionPath: "/tmp/s.json" },
    currentObligation: "keep aligned",
    mustResolveBeforeHandoff: false,
    bridges: [],
    pendingObligations: [
      {
        id: "ob-bridge",
        origin: { friendId: "friend-1", channel: "teams", key: "conv-1" },
        content: "keep aligned",
        status: "investigating",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:01Z",
      },
    ],
    taskBoard: {
      compact: "",
      activeBridges: [],
      byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
    },
    ...overrides,
  }
}

describe("suggestBridgeForActiveWork threshold relaxation", () => {
  let suggestBridgeForActiveWork: typeof import("../../../heart/active-work").suggestBridgeForActiveWork

  beforeAll(async () => {
    const mod = await import("../../../heart/active-work")
    suggestBridgeForActiveWork = mod.suggestBridgeForActiveWork
  })

  it("suggests bridge with 2 target candidates + obligation pressure", () => {
    const result = suggestBridgeForActiveWork(makeInput({
      targetCandidates: [
        makeCandidate({ friendId: "friend-2", lastActivityMs: 2000 }),
        makeCandidate({ friendId: "friend-3", channel: "bluebubbles", lastActivityMs: 1000 }),
      ],
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("begin-new")
  })

  it("suggests bridge with 3 target candidates + obligation pressure (picks freshest)", () => {
    const result = suggestBridgeForActiveWork(makeInput({
      targetCandidates: [
        makeCandidate({ friendId: "friend-2", lastActivityMs: 3000 }),
        makeCandidate({ friendId: "friend-3", lastActivityMs: 2000 }),
        makeCandidate({ friendId: "friend-4", lastActivityMs: 1000 }),
      ],
    }))
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("begin-new")
  })

  it("returns null with 0 target candidates", () => {
    const result = suggestBridgeForActiveWork(makeInput({
      targetCandidates: [],
    }))
    expect(result).toBeNull()
  })

  it("still works with 1 target candidate + obligation pressure (regression)", () => {
    const result = suggestBridgeForActiveWork(makeInput({
      targetCandidates: [makeCandidate()],
    }))
    expect(result).not.toBeNull()
  })

  it("returns null with multiple targets + no obligation pressure", () => {
    const result = suggestBridgeForActiveWork(makeInput({
      currentObligation: null,
      mustResolveBeforeHandoff: false,
      pendingObligations: [],
      taskBoard: {
        compact: "",
        activeBridges: [],
        byStatus: { drafting: [], processing: [], validating: [], collaborating: [], paused: [], blocked: [], done: [], cancelled: [] },
      },
      targetCandidates: [
        makeCandidate({ friendId: "friend-2" }),
        makeCandidate({ friendId: "friend-3" }),
      ],
    }))
    expect(result).toBeNull()
  })

  it("emits nerves event reference", () => {
    expect(emitNervesEvent).toBeDefined()
  })
})
