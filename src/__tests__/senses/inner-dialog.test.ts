import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type OpenAI from "openai"

const mockBuildSystem = vi.fn()
const mockRunAgent = vi.fn()
const mockSessionPath = vi.fn()
const mockLoadSession = vi.fn()
const mockPostTurn = vi.fn()
const mockGetAgentRoot = vi.fn()
const mockGetAgentName = vi.fn()
const mockDrainPending = vi.fn()
const mockGetPendingDir = vi.fn()
const mockGetInnerDialogPendingDir = vi.fn()
const mockGetDeferredReturnDir = vi.fn()
const mockHandleInboundTurn = vi.fn()
const mockGetChannelCapabilities = vi.fn()
const mockEnforceTrustGate = vi.fn()
const mockAccumulateFriendTokens = vi.fn()
const mockEmitNervesEvent = vi.fn()
const mockListSessionActivity = vi.fn()
const mockFindFreshestFriendSession = vi.fn()
const mockGetBridge = vi.fn()
const mockSendProactiveBlueBubblesMessageToSession = vi.fn()

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
}))

vi.mock("../../heart/core", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
}))

vi.mock("../../heart/config", () => ({
  sessionPath: (...args: any[]) => mockSessionPath(...args),
}))

vi.mock("../../mind/context", () => ({
  loadSession: (...args: any[]) => mockLoadSession(...args),
  postTurn: (...args: any[]) => mockPostTurn(...args),
}))

vi.mock("../../heart/identity", () => ({
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
  getAgentName: (...args: any[]) => mockGetAgentName(...args),
}))

vi.mock("../../mind/pending", () => ({
  drainPending: (...args: any[]) => mockDrainPending(...args),
  getPendingDir: (...args: any[]) => mockGetPendingDir(...args),
  getInnerDialogPendingDir: (...args: any[]) => mockGetInnerDialogPendingDir(...args),
  getDeferredReturnDir: (...args: any[]) => mockGetDeferredReturnDir(...args),
  INNER_DIALOG_PENDING: { friendId: "self", channel: "inner", key: "dialog" },
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
}))

vi.mock("../../mind/friends/channel", () => ({
  getChannelCapabilities: (...args: any[]) => mockGetChannelCapabilities(...args),
}))

vi.mock("../../senses/trust-gate", () => ({
  enforceTrustGate: (...args: any[]) => mockEnforceTrustGate(...args),
}))

vi.mock("../../mind/friends/tokens", () => ({
  accumulateFriendTokens: (...args: any[]) => mockAccumulateFriendTokens(...args),
}))

vi.mock("../../heart/session-activity", () => ({
  listSessionActivity: (...args: any[]) => mockListSessionActivity(...args),
  findFreshestFriendSession: (...args: any[]) => mockFindFreshestFriendSession(...args),
}))

vi.mock("../../heart/bridges/manager", () => ({
  createBridgeManager: () => ({
    getBridge: (...args: any[]) => mockGetBridge(...args),
  }),
}))

vi.mock("../../senses/bluebubbles", () => ({
  sendProactiveBlueBubblesMessageToSession: (...args: any[]) =>
    mockSendProactiveBlueBubblesMessageToSession(...args),
}))

import {
  buildInnerDialogBootstrapMessage,
  buildNonCanonicalCleanupNudge,
  buildInstinctUserMessage,
  buildTaskTriggeredMessage,
  readTaskFile,
  deriveResumeCheckpoint,
  loadInnerDialogInstincts,
  runInnerDialogTurn,
} from "../../senses/inner-dialog"

describe("inner dialog runtime", () => {
  let sessionFile: string
  let agentRoot: string

  const innerCapabilities = {
    channel: "inner",
    senseType: "internal",
    availableIntegrations: [],
    supportsMarkdown: true,
    supportsStreaming: false,
    supportsRichCards: false,
    maxMessageLength: Infinity,
  }

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inner-dialog-test-"))
    sessionFile = path.join(tmp, "inner-dialog-session.json")
    agentRoot = path.join(tmp, "agent-root")
    fs.mkdirSync(path.join(agentRoot, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "Keep improving the harness.", "utf8")

    mockBuildSystem.mockReset().mockResolvedValue("system prompt")
    mockRunAgent.mockReset().mockImplementation(async (_messages: any, callbacks: any) => {
      callbacks?.onModelStart?.()
      callbacks?.onModelStreamStart?.()
      callbacks?.onTextChunk?.("inner-dialog text chunk")
      callbacks?.onReasoningChunk?.("inner-dialog reasoning chunk")
      callbacks?.onToolStart?.("memory_search")
      callbacks?.onToolEnd?.("memory_search", true)
      callbacks?.onError?.(new Error("inner-dialog synthetic callback error"))
      return { usage: undefined }
    })
    mockSessionPath.mockReset().mockReturnValue(sessionFile)
    mockLoadSession.mockReset().mockReturnValue(null)
    mockPostTurn.mockReset().mockImplementation(() => {})
    mockGetAgentRoot.mockReset().mockReturnValue(agentRoot)
    mockGetAgentName.mockReset().mockReturnValue("test-agent")
    mockDrainPending.mockReset().mockReturnValue([])
    mockGetPendingDir.mockReset().mockReturnValue("/tmp/fake-pending-dir")
    mockGetInnerDialogPendingDir.mockReset().mockReturnValue("/tmp/fake-pending-dir")
    mockGetDeferredReturnDir.mockReset().mockReturnValue("/tmp/fake-deferred-returns")
    mockGetChannelCapabilities.mockReset().mockReturnValue(innerCapabilities)
    mockEnforceTrustGate.mockReset().mockReturnValue({ allowed: true })
    mockAccumulateFriendTokens.mockReset().mockResolvedValue(undefined)
    mockEmitNervesEvent.mockReset()
    mockListSessionActivity.mockReset().mockReturnValue([])
    mockFindFreshestFriendSession.mockReset().mockReturnValue(null)
    mockGetBridge.mockReset().mockReturnValue(null)
    mockSendProactiveBlueBubblesMessageToSession.mockReset().mockResolvedValue({
      delivered: false,
      reason: "unsupported-channel",
    })

    // Default handleInboundTurn: simulate pipeline running agent and returning result.
    mockHandleInboundTurn.mockReset().mockImplementation(async (input: any) => {
      const resolvedContext = await input.friendResolver.resolve()
      const session = await input.sessionLoader.loadOrCreate()
      const sessionMessages = session.messages
      for (const m of input.messages) sessionMessages.push(m)

      // Simulate runAgent appending assistant message
      const result = await input.runAgent(
        sessionMessages,
        input.callbacks,
        input.channel,
        input.signal,
        input.runAgentOptions,
      )
      sessionMessages.push({ role: "assistant", content: "Noted. I will continue autonomous work." })

      input.postTurn(sessionMessages, session.sessionPath, result?.usage)
      await input.accumulateFriendTokens(input.friendStore, resolvedContext.friend.id, result?.usage)

      return {
        resolvedContext,
        gateResult: { allowed: true },
        usage: result?.usage,
        sessionPath: session.sessionPath,
        messages: sessionMessages,
      }
    })
  })

  // ── Pure function tests (adapter concerns, no pipeline) ──────────

  it("builds bootstrap message with aspirations and state summary", () => {
    const message = buildInnerDialogBootstrapMessage("Learn and help Ari.", "No prior session found.")
    expect(message).toContain("waking up.")
    expect(message).toContain("## what matters to me")
    expect(message).toContain("Learn and help Ari.")
    expect(message).toContain("## what i know so far")
    expect(message).toContain("No prior session found.")
    expect(message).toContain("what needs my attention?")
  })

  it("omits aspirations section when aspirations are empty", () => {
    const message = buildInnerDialogBootstrapMessage("", "No prior session found.")
    expect(message).not.toContain("## what matters to me")
    expect(message).toContain("## what i know so far")
    expect(message).toContain("what needs my attention?")
  })

  it("omits state summary section when state summary is empty", () => {
    const message = buildInnerDialogBootstrapMessage("Learn things.", "")
    expect(message).toContain("## what matters to me")
    expect(message).not.toContain("## what i know so far")
    expect(message).toContain("what needs my attention?")
  })

  it("returns minimal bootstrap when both aspirations and state are empty", () => {
    const message = buildInnerDialogBootstrapMessage("", "")
    expect(message).toBe("waking up.\n\nwhat needs my attention?")
  })

  it("returns default instincts with first-person awareness framing", () => {
    const instincts = loadInnerDialogInstincts()
    expect(instincts.length).toBeGreaterThan(0)
    expect(instincts[0].prompt).toContain("stirring")
    expect(instincts[0].prompt).not.toContain("Heartbeat instinct:")
  })

  it("uses instinct text to produce user-role prompts (not hardcoded continue)", () => {
    const text = buildInstinctUserMessage(
      [{ id: "backlog", prompt: "Instinct: review pending tasks.", enabled: true }],
      "heartbeat",
      { cycleCount: 3, resting: true },
    )
    expect(text).toContain("Instinct: review pending tasks.")
    expect(text.toLowerCase()).not.toBe("continue")
  })

  it("falls back to default instinct when no enabled instinct is available", () => {
    const text = buildInstinctUserMessage(
      [{ id: "disabled", prompt: "disabled", enabled: false }],
      "instinct",
      { cycleCount: 4, resting: false },
    )
    expect(text).toContain("stirring")
  })

  it("returns empty cleanup nudge when no non-canonical files are found", () => {
    expect(buildNonCanonicalCleanupNudge([])).toBe("")
  })

  it("caps cleanup nudge path list and includes overflow count", () => {
    const paths = Array.from({ length: 21 }, (_value, idx) => `legacy/path-${idx}.txt`)
    const nudge = buildNonCanonicalCleanupNudge(paths)
    expect(nudge).toContain("legacy/path-0.txt")
    expect(nudge).toContain("legacy/path-19.txt")
    expect(nudge).toContain("... (1 more)")
  })

  it("default instinct message uses first-person awareness language", () => {
    const instincts = loadInnerDialogInstincts()
    const text = buildInstinctUserMessage(
      instincts,
      "heartbeat",
      { cycleCount: 2, resting: false },
    )
    expect(text).not.toContain("Heartbeat instinct:")
    expect(text).not.toContain("check what changed")
    expect(text).not.toContain("Orient yourself")
    expect(text).toContain("stirring")
  })

  it("instinct message for heartbeat reason uses awareness framing", () => {
    const text = buildInstinctUserMessage(
      [{ id: "heartbeat_checkin", prompt: "...time passing. anything stirring?", enabled: true }],
      "heartbeat",
      { cycleCount: 3, resting: true },
    )
    expect(text).toContain("stirring")
    expect(text).not.toContain("Instinct:")
  })

  // ── Task-triggered message tests ──────────────────────────────────

  it("builds task-triggered message with task content and checkpoint", () => {
    const msg = buildTaskTriggeredMessage(
      "habits/daily-standup",
      "---\ntype: habit\ncadence: 0 9 * * *\n---\nSummarize yesterday.",
      "standup sent yesterday",
    )
    expect(msg).toContain("a task needs my attention.")
    expect(msg).toContain("## task: habits/daily-standup")
    expect(msg).toContain("Summarize yesterday.")
    expect(msg).toContain("last i remember: standup sent yesterday")
  })

  it("shows fallback when task file is not found", () => {
    const msg = buildTaskTriggeredMessage("habits/missing", "", "some checkpoint")
    expect(msg).toContain("(task file not found)")
    expect(msg).toContain("last i remember: some checkpoint")
  })

  it("omits checkpoint line when no checkpoint is provided", () => {
    const msg = buildTaskTriggeredMessage("ongoing/review", "task body here")
    expect(msg).not.toContain("last i remember")
  })

  // ── readTaskFile tests ──────────────────────────────────────────

  it("reads task file from agent root tasks directory", () => {
    const tasksDir = path.join(agentRoot, "tasks", "habits")
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(path.join(tasksDir, "daily-standup.md"), "---\ntype: habit\n---\nDo standup.", "utf8")

    const content = readTaskFile(agentRoot, "habits/daily-standup")
    expect(content).toContain("Do standup.")
  })

  it("finds task file by stem across collection subdirectories", () => {
    const habitsDir = path.join(agentRoot, "tasks", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(path.join(habitsDir, "2026-0311-0900-daily-standup.md"), "---\ntype: habit\n---\nDo standup.", "utf8")

    // Scheduler sends bare stem, not collection-prefixed path
    const content = readTaskFile(agentRoot, "2026-0311-0900-daily-standup")
    expect(content).toContain("Do standup.")
  })

  it("finds task in one-shots collection by stem", () => {
    const dir = path.join(agentRoot, "tasks", "one-shots")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "2026-0312-0900-remind-ari.md"), "---\ntype: one-shot\n---\nRemind Ari about PR.", "utf8")

    const content = readTaskFile(agentRoot, "2026-0312-0900-remind-ari")
    expect(content).toContain("Remind Ari about PR.")
  })

  it("returns empty string when task file does not exist", () => {
    expect(readTaskFile(agentRoot, "nonexistent-task")).toBe("")
  })

  // ── Checkpoint derivation tests ──────────────────────────────────

  it("returns fallback checkpoint when assistant content is non-text object", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: { kind: "object-content" } as unknown as OpenAI.ChatCompletionMessageParam["content"],
      },
    ])
    expect(checkpoint).toBe("no prior checkpoint recorded")
  })

  it("returns fallback checkpoint when there is no assistant message", () => {
    expect(deriveResumeCheckpoint([])).toBe("no prior checkpoint recorded")
  })

  it("accepts string segments inside structured assistant content arrays", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: ["checkpoint: Unit 4 coverage hardening"] as unknown as OpenAI.ChatCompletionMessageParam["content"],
      },
    ])
    expect(checkpoint).toBe("Unit 4 coverage hardening")
  })

  it("falls back when explicit checkpoint marker has no payload", () => {
    const checkpoint = deriveResumeCheckpoint([{ role: "assistant", content: "checkpoint:   " }])
    expect(checkpoint).toBe("no prior checkpoint recorded")
  })

  it("falls back when assistant content is all whitespace", () => {
    const checkpoint = deriveResumeCheckpoint([{ role: "assistant", content: "   \n  \n   " }])
    expect(checkpoint).toBe("no prior checkpoint recorded")
  })

  it("derives and truncates checkpoint text from structured assistant content arrays", () => {
    const longLine = "A".repeat(250)
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: [42, { text: longLine }] as unknown as OpenAI.ChatCompletionMessageParam["content"],
      },
    ])
    expect(checkpoint.endsWith("...")).toBe(true)
    expect(checkpoint.length).toBe(220)
  })

  it("skips structured content parts that do not contain text", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: [{ kind: "noop" }, { text: "checkpoint: Unit 3 refactor pass" }] as unknown as OpenAI.ChatCompletionMessageParam["content"],
      },
    ])
    expect(checkpoint).toBe("Unit 3 refactor pass")
  })

  // ── Pipeline integration tests ──────────────────────────────────

  it("calls handleInboundTurn instead of inline lifecycle", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
  })

  it("passes channel 'inner' and senseType 'internal' capabilities to pipeline", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.channel).toBe("inner")
    expect(input.capabilities).toEqual(expect.objectContaining({ senseType: "internal", channel: "inner" }))
  })

  it("does not call runAgent directly — pipeline handles it", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "system", content: "system prompt" }],
    })

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockRunAgent).not.toHaveBeenCalled()
  })

  it("does not call postTurn directly — pipeline handles it", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "system", content: "system prompt" }],
    })

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockPostTurn).not.toHaveBeenCalled()
  })

  it("passes pending dir for self/inner/dialog to pipeline", async () => {
    mockGetInnerDialogPendingDir.mockReturnValue("/tmp/pending/test-agent/self/inner/dialog")

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })

    expect(mockGetInnerDialogPendingDir).toHaveBeenCalledWith("test-agent")
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.pendingDir).toBe("/tmp/pending/test-agent/self/inner/dialog")
  })

  it("injects drainPending, runAgent, postTurn, accumulateFriendTokens, enforceTrustGate into pipeline", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(typeof input.drainPending).toBe("function")
    expect(typeof input.runAgent).toBe("function")
    expect(typeof input.postTurn).toBe("function")
    expect(typeof input.accumulateFriendTokens).toBe("function")
    expect(typeof input.enforceTrustGate).toBe("function")
  })

  it("passes toolChoiceRequired: true and skipConfirmation: true in runAgentOptions", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions).toEqual(expect.objectContaining({
      toolChoiceRequired: true,
      skipConfirmation: true,
    }))
  })

  it("passes empty continuity ingress text to the shared pipeline for inner dialog", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect((input as any).continuityIngressTexts).toEqual([])
  })

  it("routes delegated inner completions to the freshest attached bridge session before plain recency", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    const cliPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "cli", "session")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "bluebubbles" && key === "chat" ? bluebubblesPendingDir : cliPendingDir,
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
        lastActivityAt: "2026-03-13T20:05:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
        activitySource: "friend-facing",
      },
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        lastActivityAt: "2026-03-13T20:01:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "keep cli and bluebubbles aligned",
      summary: "shared relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        },
      ],
      task: null,
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "formal little blokes" }],
      completion: { answer: "formal little blokes", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "think about penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
            bridgeId: "bridge-1",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: true,
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith({
      friendId: "friend-1",
      sessionKey: "chat",
      text: "formal little blokes",
    })
    expect(fs.existsSync(bluebubblesPendingDir)).toBe(false)
    expect(fs.existsSync(cliPendingDir)).toBe(false)
  })

  it("falls back to queued session delivery when proactive BlueBubbles delivery does not succeed", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "bluebubbles" && key === "chat" ? bluebubblesPendingDir : "/tmp/unused",
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        lastActivityAt: "2026-03-13T20:01:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockFindFreshestFriendSession.mockReturnValue({
      friendId: "friend-1",
      friendName: "Ari",
      channel: "bluebubbles",
      key: "chat",
      sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      lastActivityAt: "2026-03-13T20:01:00.000Z",
      lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
      activitySource: "friend-facing",
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "fallback still lands" }],
      completion: { answer: "fallback still lands", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "think about penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: false,
      reason: "send_error",
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const routedFiles = fs.readdirSync(bluebubblesPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(bluebubblesPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("fallback still lands")
  })

  it("persists delegated completions when no live outward session is available", async () => {
    const deferredDir = path.join(agentRoot, "state", "pending-returns", "friend-1")
    mockGetDeferredReturnDir.mockReturnValue(deferredDir)
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "nothing to send yet" }],
      completion: { answer: "i sat with it and landed on penguins", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "think about penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
          },
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const deferredFiles = fs.readdirSync(deferredDir)
    expect(deferredFiles.length).toBe(1)
    const deferredPayload = JSON.parse(fs.readFileSync(path.join(deferredDir, deferredFiles[0]), "utf8"))
    expect(deferredPayload.content).toBe("i sat with it and landed on penguins")
  })

  it("falls back to queued bridge-session delivery when proactive BlueBubbles send fails for the bridge target", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "bluebubbles" && key === "chat" ? bluebubblesPendingDir : "/tmp/unused",
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        lastActivityAt: "2026-03-13T20:01:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:01:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "keep bluebubbles aligned",
      summary: "shared relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        },
      ],
      task: null,
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "bridge fallback lands" }],
      completion: { answer: "bridge fallback lands", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "think about penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
            bridgeId: "bridge-1",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: false,
      reason: "send_error",
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const routedFiles = fs.readdirSync(bluebubblesPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(bluebubblesPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("bridge fallback lands")
  })

  it("routes delegated completions to the freshest active friend-facing session when bridge preference is unavailable", async () => {
    const cliPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "cli", "session")
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "cli" && key === "session" ? cliPendingDir : bluebubblesPendingDir,
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
        lastActivityAt: "2026-03-13T20:05:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "keep cli and bluebubbles aligned",
      summary: "shared relay",
      lifecycle: "cancelled",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        {
          friendId: "friend-1",
          channel: "bluebubbles",
          key: "chat",
          sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        },
      ],
      task: null,
    })
    mockFindFreshestFriendSession.mockReturnValue({
      friendId: "friend-1",
      friendName: "Ari",
      channel: "cli",
      key: "session",
      sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      lastActivityAt: "2026-03-13T20:05:00.000Z",
      lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
      activitySource: "friend-facing",
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "cli got it" }],
      completion: { answer: "cli got it", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "reflect on penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
            bridgeId: "bridge-1",
          },
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const routedFiles = fs.readdirSync(cliPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(cliPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("cli got it")
    expect(fs.existsSync(bluebubblesPendingDir)).toBe(false)
  })

  it("delivers delegated completions directly to the freshest active BlueBubbles session when no bridge applies", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "bluebubbles" && key === "chat" ? bluebubblesPendingDir : "/tmp/unused",
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "bluebubbles",
        key: "chat",
        sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
        lastActivityAt: "2026-03-13T20:05:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockFindFreshestFriendSession.mockReturnValue({
      friendId: "friend-1",
      friendName: "Ari",
      channel: "bluebubbles",
      key: "chat",
      sessionPath: "/tmp/state/sessions/friend-1/bluebubbles/chat.json",
      lastActivityAt: "2026-03-13T20:05:00.000Z",
      lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
      activitySource: "friend-facing",
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "bluebubbles got it live" }],
      completion: { answer: "bluebubbles got it live", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "reflect on penguins",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({
      delivered: true,
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith({
      friendId: "friend-1",
      sessionKey: "chat",
      text: "bluebubbles got it live",
    })
    expect(fs.existsSync(bluebubblesPendingDir)).toBe(false)
  })

  it("falls back to friend recency when an active bridge does not include a matching attached outward session", async () => {
    const cliPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "cli", "session")
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) =>
      channel === "cli" && key === "session" ? cliPendingDir : bluebubblesPendingDir,
    )
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "cli",
        key: "session",
        sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
        lastActivityAt: "2026-03-13T20:05:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "keep cli and bluebubbles aligned",
      summary: "shared relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        {
          friendId: "friend-1",
          channel: "teams",
          key: "conversation",
          sessionPath: "/tmp/state/sessions/friend-1/teams/conversation.json",
        },
      ],
      task: null,
    })
    mockFindFreshestFriendSession.mockReturnValue({
      friendId: "friend-1",
      friendName: "Ari",
      channel: "cli",
      key: "session",
      sessionPath: "/tmp/state/sessions/friend-1/cli/session.json",
      lastActivityAt: "2026-03-13T20:05:00.000Z",
      lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
      activitySource: "friend-facing",
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "cli still got it" }],
      completion: { answer: "cli still got it", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "reflect on penguins more",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "bluebubbles",
            key: "chat",
            bridgeId: "bridge-1",
          },
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const routedFiles = fs.readdirSync(cliPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(cliPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("cli still got it")
    expect(fs.existsSync(bluebubblesPendingDir)).toBe(false)
  })

  it("passes bootstrap user message with aspirations on fresh session", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.messages).toHaveLength(1)
    expect(input.messages[0].role).toBe("user")
    const content = String(input.messages[0].content)
    expect(content).toContain("waking up.")
    expect(content).toContain("Keep improving the harness.")
    expect(content).toContain("what needs my attention?")
  })

  it("passes instinct user message as pipeline input.messages on resumed session", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "I will rest until heartbeat." },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "backlog", prompt: "Instinct: review pending tasks.", enabled: true }],
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.messages).toHaveLength(1)
    expect(input.messages[0].role).toBe("user")
    expect(String(input.messages[0].content)).toContain("Instinct: review pending tasks.")
  })

  it("includes checkpoint context in instinct message on resumed session", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: "checkpoint: Unit 2b editing src/repertoire/tools.ts and src/__tests__/repertoire/tools.test.ts",
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "resume", prompt: "what was i working on?", enabled: true }],
      now: () => new Date("2026-03-06T12:06:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("what was i working on?")
    expect(content).toContain("last i remember:")
    expect(content).toContain("Unit 2b editing src/repertoire/tools.ts")
  })

  // ── TaskId passthrough tests ──────────────────────────────────────

  it("builds task-triggered user message when taskId is provided on resumed session", async () => {
    const tasksDir = path.join(agentRoot, "tasks", "habits")
    fs.mkdirSync(tasksDir, { recursive: true })
    fs.writeFileSync(path.join(tasksDir, "daily-standup.md"), "---\ntype: habit\ncadence: 0 9 * * *\n---\nSummarize yesterday's work.", "utf8")

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: standup sent" },
      ],
    })

    await runInnerDialogTurn({
      reason: "instinct",
      taskId: "habits/daily-standup",
      now: () => new Date("2026-03-06T09:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("a task needs my attention.")
    expect(content).toContain("## task: habits/daily-standup")
    expect(content).toContain("Summarize yesterday's work.")
    expect(content).toContain("last i remember: standup sent")
  })

  it("shows task-not-found fallback when task file is missing", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })

    await runInnerDialogTurn({
      reason: "instinct",
      taskId: "habits/nonexistent",
      now: () => new Date("2026-03-06T09:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("(task file not found)")
  })

  it("ignores taskId on fresh session (uses bootstrap instead)", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      taskId: "habits/daily-standup",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("waking up.")
    expect(content).not.toContain("a task needs my attention.")
  })

  // ── Session loader tests ──────────────────────────────────────────

  it("session loader returns system prompt on fresh session", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [],
    })

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const session = await input.sessionLoader.loadOrCreate()
    expect(session.messages).toHaveLength(1)
    expect(session.messages[0]).toMatchObject({ role: "system", content: "system prompt" })
    expect(session.sessionPath).toBe(sessionFile)
  })

  it("session loader returns existing messages on resumed session", async () => {
    const existingMessages = [
      { role: "system", content: "system prompt" },
      { role: "assistant", content: "I was working on tasks." },
    ]
    mockLoadSession.mockReturnValue({ messages: existingMessages })

    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const session = await input.sessionLoader.loadOrCreate()
    expect(session.messages).toHaveLength(2)
    expect(session.messages[0]).toMatchObject({ role: "system" })
    expect(session.messages[1]).toMatchObject({ role: "assistant" })
  })

  it("calls buildSystem('inner', ...) for fresh session system prompt", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-10T01:00:00.000Z"),
    })

    expect(mockBuildSystem).toHaveBeenCalledTimes(1)
    expect(mockBuildSystem.mock.calls[0][0]).toBe("inner")
  })

  it("uses bootstrap with empty aspirations when aspirations file is missing", async () => {
    fs.unlinkSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"))

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:01:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("waking up.")
    expect(content).not.toContain("## what matters to me")
  })

  it("injects non-canonical cleanup nudge on boot when bundle scan finds legacy files", async () => {
    const legacyDir = path.join(agentRoot, "teams-app")
    fs.mkdirSync(legacyDir, { recursive: true })
    fs.writeFileSync(path.join(legacyDir, "manifest.json"), "{}", "utf8")

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:02:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const bootstrap = String(input.messages[0].content)
    expect(bootstrap).toContain("distill anything valuable into your memory system and remove these files")
    expect(bootstrap).toContain("teams-app/manifest.json")
  })

  it("uses default reason/clock/instinct loading when options are omitted", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready for next cycle" },
      ],
    })

    await runInnerDialogTurn()

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("stirring")
    expect(content).toContain("last i remember: ready for next cycle")
  })

  // ── Return value propagation ──────────────────────────────────────

  it("returns messages, usage, and sessionPath from pipeline result", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: { input_tokens: 100, output_tokens: 50, reasoning_tokens: 10, total_tokens: 160 },
      sessionPath: sessionFile,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up" },
        { role: "assistant", content: "ready" },
      ],
    })

    const result = await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.sessionPath).toBe(sessionFile)
    expect(result.usage).toEqual(expect.objectContaining({ total_tokens: 160 }))
    expect(result.messages).toBeDefined()
  })

  it("marks runtime state as running during the turn and idle afterward", async () => {
    const runtimePath = path.join(path.dirname(sessionFile), "runtime.json")
    let runtimeDuringTurn: Record<string, unknown> | null = null

    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      runtimeDuringTurn = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as Record<string, unknown>
      return {
        resolvedContext: await input.friendResolver.resolve(),
        gateResult: { allowed: true },
        usage: undefined,
        sessionPath: sessionFile,
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "waking up" },
          { role: "assistant", content: "ready" },
        ],
      }
    })

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(runtimeDuringTurn).toEqual(expect.objectContaining({
      status: "running",
      reason: "boot",
      startedAt: "2026-03-06T12:00:00.000Z",
    }))
    expect(JSON.parse(fs.readFileSync(runtimePath, "utf8"))).toEqual(expect.objectContaining({
      status: "idle",
      lastCompletedAt: "2026-03-06T12:00:00.000Z",
    }))
  })

  it("restores idle runtime state even when the turn throws", async () => {
    const runtimePath = path.join(path.dirname(sessionFile), "runtime.json")
    mockHandleInboundTurn.mockRejectedValueOnce(new Error("turn exploded"))

    await expect(runInnerDialogTurn({
      reason: "instinct",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })).rejects.toThrow("turn exploded")

    expect(JSON.parse(fs.readFileSync(runtimePath, "utf8"))).toEqual(expect.objectContaining({
      status: "idle",
      lastCompletedAt: "2026-03-06T12:00:00.000Z",
    }))
  })

  it("emits a warning when runtime state writes fail", async () => {
    const blockedParent = path.join(path.dirname(sessionFile), "runtime-parent-blocker")
    fs.writeFileSync(blockedParent, "not a directory", "utf8")

    mockSessionPath.mockReturnValue(path.join(blockedParent, "inner-dialog-session.json"))

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const warnings = mockEmitNervesEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.event === "senses.inner_dialog_runtime_state_error")

    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.inner_dialog_runtime_state_error",
      message: "failed to write inner dialog runtime state",
      meta: expect.objectContaining({
        path: path.join(blockedParent, "runtime.json"),
        error: expect.any(String),
      }),
    })]))
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.inner_dialog_runtime_state_error",
      meta: expect.objectContaining({
        status: "running",
        reason: "boot",
      }),
    })]))
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.inner_dialog_runtime_state_error",
      meta: expect.objectContaining({
        status: "idle",
        reason: null,
      }),
    })]))
  })

  it("returns empty messages and fallback sessionPath when pipeline returns undefined", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: false, reason: "stranger_silent_drop" },
      usage: undefined,
      sessionPath: undefined,
      messages: undefined,
    })

    const result = await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.messages).toEqual([])
    expect(result.sessionPath).toBe(sessionFile)
    expect(result.usage).toBeUndefined()
  })

  it("provides a friendResolver that resolves to a self-referencing context", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const resolved = await input.friendResolver.resolve()
    expect(resolved.friend).toBeDefined()
    expect(resolved.friend.id).toBeTruthy()
    expect(resolved.channel).toEqual(expect.objectContaining({ senseType: "internal" }))
  })

  it("provides a no-op friendStore with all methods returning safe defaults", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const store = input.friendStore
    expect(store).toBeDefined()

    // Exercise all store methods to verify no-op behavior
    expect(await store.get("any")).toBeNull()
    await expect(store.put("any", {} as any)).resolves.toBeUndefined()
    await expect(store.delete("any")).resolves.toBeUndefined()
    expect(await store.findByExternalId("local", "any")).toBeNull()
  })

  it("passes signal through to pipeline when provided", async () => {
    const controller = new AbortController()

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
      signal: controller.signal,
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.signal).toBe(controller.signal)
  })

  // ── Nerves event enrichment ──────────────────────────────────────

  it("emits nerves event with assistant preview and token counts", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: { input_tokens: 500, output_tokens: 100, reasoning_tokens: 20, total_tokens: 620 },
      sessionPath: sessionFile,
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "waking up" },
        { role: "assistant", content: "checked the billing fix. tests pass." },
      ],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall).toBeDefined()
    const meta = nervesCall![0].meta
    expect(meta.assistantPreview).toBe("checked the billing fix. tests pass.")
    expect(meta.promptTokens).toBe(500)
    expect(meta.completionTokens).toBe(100)
    expect(meta.totalTokens).toBe(620)
  })

  it("emits nerves event with taskId when task-triggered", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })

    await runInnerDialogTurn({
      reason: "instinct",
      taskId: "habits/daily-standup",
      now: () => new Date("2026-03-06T09:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall).toBeDefined()
    expect(nervesCall![0].meta.taskId).toBe("habits/daily-standup")
  })

  it("emits nerves event with tool call names from assistant messages", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "query_session", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "send_message", arguments: "{}" } },
          ],
        },
        { role: "assistant", content: "done" },
      ],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall![0].meta.toolCalls).toEqual(["query_session", "send_message"])
  })

  it("omits optional nerves meta fields when not available", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "system", content: "system prompt" }],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall).toBeDefined()
    const meta = nervesCall![0].meta
    expect(meta.assistantPreview).toBeUndefined()
    expect(meta.toolCalls).toBeUndefined()
    expect(meta.promptTokens).toBeUndefined()
    expect(meta.taskId).toBeUndefined()
  })

  it("truncates long assistant preview in nerves event", async () => {
    const longResponse = "A".repeat(200)
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [
        { role: "assistant", content: longResponse },
      ],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    const preview = nervesCall![0].meta.assistantPreview
    expect(preview.length).toBe(120)
    expect(preview.endsWith("...")).toBe(true)
  })

  it("skips tool calls without function name in nerves event", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "custom", custom: { name: "custom_tool" } },
            { id: "tc_2", type: "function", function: { name: "", arguments: "{}" } },
            { id: "tc_3", type: "function", function: { name: "valid_tool", arguments: "{}" } },
          ],
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall![0].meta.toolCalls).toEqual(["valid_tool"])
  })

  it("deduplicates tool call names in nerves event", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "tc_1", type: "function", function: { name: "memory_search", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "memory_search", arguments: "{}" } },
          ],
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.inner_dialog_turn",
    )
    expect(nervesCall![0].meta.toolCalls).toEqual(["memory_search"])
  })
})
