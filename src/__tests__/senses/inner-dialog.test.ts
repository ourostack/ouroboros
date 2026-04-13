import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import type OpenAI from "openai"

const mockBuildSystem = vi.fn()
const mockRunAgent = vi.fn()
const mockSessionPath = vi.fn()
const mockLoadSession = vi.fn()
const mockPostTurnTrim = vi.fn().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 })
const mockDeferPostTurnPersist = vi.fn().mockResolvedValue([])
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
const mockAdvanceObligation = vi.fn()
const mockListActiveObligations = vi.fn(() => [])
const mockBuildHabitTurnMessage = vi.fn(() => "habit turn message")
const mockIndexJournalFiles = vi.fn(async () => 0)
const mockReadJournalFiles = vi.fn(() => [])
const mockReadHealth = vi.fn(() => null)
const mockGetDefaultHealthPath = vi.fn(() => "/tmp/fake-health-path/daemon-health.json")
const mockGetToolsForChannel = vi.fn()

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
  readJournalFiles: (...args: any[]) => mockReadJournalFiles(...args),
  flattenSystemPrompt: (sp: any) => [sp?.stable, sp?.volatile].filter(Boolean).join("\n\n"),
}))

vi.mock("../../heart/core", () => ({
  runAgent: (...args: any[]) => mockRunAgent(...args),
}))

vi.mock("../../heart/config", () => ({
  sessionPath: (...args: any[]) => mockSessionPath(...args),
}))

vi.mock("../../mind/context", () => ({
  loadSession: (...args: any[]) => mockLoadSession(...args),
  postTurnTrim: (...args: any[]) => mockPostTurnTrim(...args),
  deferPostTurnPersist: (...args: any[]) => mockDeferPostTurnPersist(...args),
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
    findBridgesForSession: () => [],
  }),
}))

vi.mock("../../senses/bluebubbles", () => ({
  sendProactiveBlueBubblesMessageToSession: (...args: any[]) =>
    mockSendProactiveBlueBubblesMessageToSession(...args),
}))

vi.mock("../../arc/obligations", async (importOriginal) => ({
  ...await importOriginal() as any,
  advanceReturnObligation: (...args: any[]) => mockAdvanceObligation(...args),
  listActiveReturnObligations: (...args: any[]) => mockListActiveObligations(...args),
}))

vi.mock("../../senses/habit-turn-message", () => ({
  buildHabitTurnMessage: (...args: any[]) => mockBuildHabitTurnMessage(...args),
}))

vi.mock("../../mind/journal-index", () => ({
  indexJournalFiles: (...args: any[]) => mockIndexJournalFiles(...args),
}))

vi.mock("../../heart/daemon/daemon-health", () => ({
  readHealth: (...args: any[]) => mockReadHealth(...args),
  getDefaultHealthPath: (...args: any[]) => mockGetDefaultHealthPath(...args),
}))

vi.mock("../../repertoire/tools", () => ({
  getToolsForChannel: (...args: any[]) => mockGetToolsForChannel(...args),
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

    mockBuildSystem.mockReset().mockResolvedValue({ stable: "system prompt", volatile: "" })
    mockRunAgent.mockReset().mockImplementation(async (_messages: any, callbacks: any) => {
      callbacks?.onModelStart?.()
      callbacks?.onModelStreamStart?.()
      callbacks?.onTextChunk?.("inner-dialog text chunk")
      callbacks?.onReasoningChunk?.("inner-dialog reasoning chunk")
      callbacks?.onToolStart?.("search_notes")
      callbacks?.onToolEnd?.("search_notes", true)
      callbacks?.onError?.(new Error("inner-dialog synthetic callback error"))
      return { usage: undefined }
    })
    mockSessionPath.mockReset().mockReturnValue(sessionFile)
    mockLoadSession.mockReset().mockReturnValue(null)
    mockPostTurnTrim.mockReset().mockReturnValue({ currentMessages: [], trimmedMessages: [], currentIngressTimes: [], maxTokens: 128000, contextMargin: 0 })
    mockDeferPostTurnPersist.mockReset().mockResolvedValue([])
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
    mockAdvanceObligation.mockReset().mockReturnValue(null)
    mockListActiveObligations.mockReset().mockReturnValue([])
    mockBuildHabitTurnMessage.mockReset().mockReturnValue("habit turn message")
    mockIndexJournalFiles.mockReset().mockResolvedValue(0)
    mockReadJournalFiles.mockReset().mockReturnValue([])
    mockReadHealth.mockReset().mockReturnValue(null)
    mockGetDefaultHealthPath.mockReset().mockReturnValue("/tmp/fake-health-path/daemon-health.json")
    mockGetToolsForChannel.mockReset().mockReturnValue([
      { type: "function", function: { name: "read", description: "Read a file", parameters: {} } },
      { type: "function", function: { name: "shell", description: "Run a shell command", parameters: {} } },
      { type: "function", function: { name: "diary_write", description: "Write to diary", parameters: {} } },
    ])

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
    expect(msg).toContain("last checkpoint: standup sent yesterday")
  })

  it("shows fallback when task file is not found", () => {
    const msg = buildTaskTriggeredMessage("habits/missing", "", "some checkpoint")
    expect(msg).toContain("(task file not found)")
    expect(msg).toContain("last checkpoint: some checkpoint")
  })

  it("omits checkpoint line when no checkpoint is provided", () => {
    const msg = buildTaskTriggeredMessage("ongoing/review", "task body here")
    expect(msg).not.toContain("last checkpoint")
  })

  it("omits fallback checkpoint boilerplate from instinct messages", () => {
    const msg = buildInstinctUserMessage(
      [{ id: "backlog", prompt: "Instinct: review pending tasks.", enabled: true }],
      "heartbeat",
      { checkpoint: "no prior checkpoint recorded" },
    )
    expect(msg).toContain("Instinct: review pending tasks.")
    expect(msg).not.toContain("last checkpoint")
    expect(msg).not.toContain("no prior checkpoint recorded")
  })

  it("omits fallback checkpoint boilerplate from task-triggered messages", () => {
    const msg = buildTaskTriggeredMessage("ongoing/review", "task body here", "no prior checkpoint recorded")
    expect(msg).not.toContain("last checkpoint")
    expect(msg).not.toContain("no prior checkpoint recorded")
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
    const ongoingDir = path.join(agentRoot, "tasks", "ongoing")
    fs.mkdirSync(ongoingDir, { recursive: true })
    fs.writeFileSync(path.join(ongoingDir, "2026-0311-0900-daily-standup.md"), "---\ntype: ongoing\n---\nDo standup.", "utf8")

    // Scheduler sends bare stem, not collection-prefixed path
    const content = readTaskFile(agentRoot, "2026-0311-0900-daily-standup")
    expect(content).toContain("Do standup.")
  })

  it("does not search tasks/habits/ collection (habits moved to bundle root)", () => {
    const habitsDir = path.join(agentRoot, "tasks", "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(path.join(habitsDir, "2026-0311-0900-heartbeat.md"), "---\ntype: habit\n---\nHeartbeat.", "utf8")

    // Bare stem should NOT find the file in tasks/habits/ anymore
    const content = readTaskFile(agentRoot, "2026-0311-0900-heartbeat")
    expect(content).toBe("")
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

    expect(mockPostTurnTrim).not.toHaveBeenCalled()
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

  it("passes toolChoiceRequired: true in runAgentOptions", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions).toEqual(expect.objectContaining({
      toolChoiceRequired: true,
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

  it.skip("routes delegated inner completions to the freshest attached bridge session before plain recency", async () => {
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

  it.skip("falls back to queued session delivery when proactive BlueBubbles delivery does not succeed", async () => {
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

  it.skip("persists delegated completions when no live outward session is available", async () => {
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

  it.skip("falls back to queued bridge-session delivery when proactive BlueBubbles send fails for the bridge target", async () => {
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

  it.skip("routes delegated completions to the freshest active friend-facing session when bridge preference is unavailable", async () => {
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

  it.skip("delivers delegated completions directly to the freshest active BlueBubbles session when no bridge applies", async () => {
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

  it.skip("falls back to friend recency when an active bridge does not include a matching attached outward session", async () => {
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

  it.skip("emits senses.obligation_fulfilled nerves event when routeDelegatedCompletion routes a delegated completion", async () => {
    const deferredDir = path.join(agentRoot, "state", "pending-returns", "friend-1")
    mockGetDeferredReturnDir.mockReturnValue(deferredDir)
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "obligation result" }],
      completion: { answer: "obligation result", intent: "complete" },
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
          obligationStatus: "pending",
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    const fulfillmentEvent = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0]?.event === "senses.obligation_fulfilled",
    )
    expect(fulfillmentEvent).toBeDefined()
    expect(fulfillmentEvent![0].component).toBe("senses")
    expect(fulfillmentEvent![0].meta).toEqual(expect.objectContaining({
      friendId: "friend-1",
      channel: "bluebubbles",
      key: "chat",
    }))
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

  it("passes instinct user message as pipeline input.messages on resumed session with reason instinct", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "I will rest until heartbeat." },
      ],
    })

    await runInnerDialogTurn({
      reason: "instinct",
      instincts: [{ id: "backlog", prompt: "Instinct: review pending tasks.", enabled: true }],
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.messages).toHaveLength(1)
    expect(input.messages[0].role).toBe("user")
    const content = String(input.messages[0].content)
    expect(content).toContain("Instinct: review pending tasks.")
    expect(content).not.toContain("no prior checkpoint recorded")
    expect(content).toContain("last checkpoint: I will rest until heartbeat.")
  })

  it("includes checkpoint context in instinct message on resumed session with reason instinct", async () => {
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
      reason: "instinct",
      instincts: [{ id: "resume", prompt: "what was i working on?", enabled: true }],
      now: () => new Date("2026-03-06T12:06:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("what was i working on?")
    expect(content).toContain("last checkpoint:")
    expect(content).toContain("Unit 2b editing src/repertoire/tools.ts")
  })

  it("uses buildHabitTurnMessage for heartbeat habit on resumed session", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "heartbeat.md"),
      "---\ntitle: Heartbeat\ncadence: 30m\nstatus: active\nlastRun: 2026-03-06T11:30:00.000Z\ncreated: 2026-03-01\n---\n\nCheck in on responsibilities.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready for next cycle" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("unified habit turn message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toBe("unified habit turn message")
  })

  // ── Habit turn tests ──────────────────────────────────────────────

  it("passes habitBody and habitTitle to buildHabitTurnMessage for heartbeat", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "heartbeat.md"),
      "---\ntitle: Heartbeat\ncadence: 30m\nstatus: active\nlastRun: 2026-03-06T11:30:00.000Z\ncreated: 2026-03-01\n---\n\nCheck in on my responsibilities and reflect on what needs attention.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready for next cycle" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("habit turn with body")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.habitBody).toContain("Check in on my responsibilities")
    expect(call.habitTitle).toBe("Heartbeat")
    expect(call.habitName).toBe("heartbeat")
    expect(call.lastRun).toBe("2026-03-06T11:30:00.000Z")
  })

  it("uses buildHabitTurnMessage for non-heartbeat habits (same path as heartbeat)", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day's accomplishments and plan for tomorrow.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed tasks" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("daily reflection habit turn")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.habitName).toBe("daily-reflection")
    expect(call.habitTitle).toBe("Daily Reflection")
    expect(call.habitBody).toContain("Reflect on the day's accomplishments")
    expect(call.lastRun).toBe("2026-03-05T22:00:00.000Z")
    expect(call.checkpoint).toBe("reviewed tasks")
  })

  it("passes checkpoint from session state to buildHabitTurnMessage", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "heartbeat.md"),
      "---\ntitle: Heartbeat\ncadence: 30m\nstatus: active\nlastRun: 2026-03-06T11:30:00.000Z\ncreated: 2026-03-01\n---\n\nCheck in.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: refactoring tool registry" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn with checkpoint")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.checkpoint).toBe("refactoring tool registry")
  })

  it("passes stale obligations to buildHabitTurnMessage for all habits", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect.",
      "utf8",
    )

    const nowDate = new Date("2026-03-06T22:00:00.000Z")
    const nowMs = nowDate.getTime()
    mockListActiveObligations.mockReturnValueOnce([
      {
        id: "obl-1",
        delegatedContent: "review the architecture doc",
        origin: { friendId: "ari" },
        createdAt: nowMs - 45 * 60 * 1000,
      },
    ])

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn with obligations")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => nowDate,
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.staleObligations).toHaveLength(1)
    expect(call.staleObligations[0].friendName).toBe("ari")
    expect(call.staleObligations[0].stalenessMs).toBe(45 * 60 * 1000)
  })

  it("passes also-due to buildHabitTurnMessage", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )
    // Another overdue habit
    fs.writeFileSync(
      path.join(habitsDir, "weekly-review.md"),
      "---\ntitle: Weekly Review\ncadence: 7d\nstatus: active\nlastRun: 2026-02-20T10:00:00.000Z\ncreated: 2026-02-01\n---\n\nReview the week.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn with also-due")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.alsoDue).toContain("also due")
    expect(call.alsoDue).toContain("weekly-review")
  })

  it("handles missing habit file gracefully in habit turn", async () => {
    // Do NOT create the habit file
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "nonexistent",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("nonexistent")
    // Should indicate the file was not found but still produce a turn
    expect(content).toMatch(/not found|missing|could not read/i)
  })

  it("heartbeat habit without file still calls buildHabitTurnMessage (missing file path)", async () => {
    // No habit file created -- should fall through to "could not be read" message
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    // Missing file falls through to error message, not buildHabitTurnMessage
    expect(content).toMatch(/could not be read/i)
  })

  // ── Parse error nudge tests ──────────────────────────────────────

  it("passes parseErrors to buildHabitTurnMessage when provided", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn with parse errors")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
      parseErrors: [{ file: "broken-habit.md", error: "invalid frontmatter" }],
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.parseErrors).toHaveLength(1)
    expect(call.parseErrors[0].file).toBe("broken-habit.md")
    expect(call.parseErrors[0].error).toBe("invalid frontmatter")
  })

  it("passes empty parseErrors to buildHabitTurnMessage when none provided", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn without parse errors")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.parseErrors).toEqual([])
  })

  // ── Degraded state nudge tests ────────────────────────────────────

  it("passes degradedComponents to buildHabitTurnMessage when health file reports degraded", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockReadHealth.mockReturnValue({
      status: "running",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-06T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [{ component: "heartbeat", reason: "cron registration failed", since: "2026-03-06T09:00:00.000Z" }],
      agents: {},
      habits: { heartbeat: { cronStatus: "failed", lastFired: null, fallback: true } },
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn with degraded")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.degradedComponents).toHaveLength(1)
    expect(call.degradedComponents[0].component).toBe("heartbeat")
    expect(call.degradedComponents[0].reason).toBe("cron registration failed")
  })

  it("passes empty degradedComponents when health file has no degraded", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockReadHealth.mockReturnValue({
      status: "running",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-06T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [],
      agents: {},
      habits: {},
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn without degraded")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.degradedComponents).toEqual([])
  })

  it("passes empty degradedComponents when health file is missing", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockReadHealth.mockReturnValue(null)
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn without health")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.degradedComponents).toEqual([])
  })

  it("does not crash when readHealth throws", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "daily-reflection.md"),
      "---\ntitle: Daily Reflection\ncadence: 1d\nstatus: active\nlastRun: 2026-03-05T22:00:00.000Z\ncreated: 2026-03-01\n---\n\nReflect on the day.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockReadHealth.mockImplementation(() => { throw new Error("disk error") })
    mockBuildHabitTurnMessage.mockReturnValueOnce("turn despite health error")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "daily-reflection",
      now: () => new Date("2026-03-06T22:00:00.000Z"),
    })

    // Should still call buildHabitTurnMessage with empty degradedComponents
    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.degradedComponents).toEqual([])
  })

  it("passes degradedComponents for heartbeat habit turns too (same path)", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "heartbeat.md"),
      "---\ntitle: Heartbeat\ncadence: 30m\nstatus: active\nlastRun: 2026-03-06T11:30:00.000Z\ncreated: 2026-03-01\n---\n\nCheck in.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockBuildHabitTurnMessage.mockReturnValueOnce("heartbeat with degraded")

    mockReadHealth.mockReturnValue({
      status: "running",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-06T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [{ component: "heartbeat", reason: "timer fallback active", since: "2026-03-06T09:00:00.000Z" }],
      agents: {},
      habits: {},
    })

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.degradedComponents).toHaveLength(1)
    expect(call.degradedComponents[0].reason).toBe("timer fallback active")
  })

  it("does not include degraded state nudge for non-habit turns", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: reviewed" },
      ],
    })

    mockReadHealth.mockReturnValue({
      status: "running",
      mode: "prod",
      pid: 12345,
      startedAt: "2026-03-06T10:00:00.000Z",
      uptimeSeconds: 3600,
      safeMode: null,
      degraded: [{ component: "cron", reason: "broken", since: "2026-03-06T09:00:00.000Z" }],
      agents: {},
      habits: {},
    })

    await runInnerDialogTurn({
      reason: "instinct",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    // Non-habit turns should NOT get the degraded nudge
    expect(content).not.toContain("scheduling is degraded")
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
    expect(content).toContain("last checkpoint: standup sent")
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
    expect(bootstrap).toContain("distill anything valuable into my diary and remove these files")
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

    // Default reason is now "instinct", so on resumed session uses instinct message
    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("stirring")
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
            { id: "tc_1", type: "function", function: { name: "search_notes", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "search_notes", arguments: "{}" } },
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
    expect(nervesCall![0].meta.toolCalls).toEqual(["search_notes"])
  })

  // ── Exact-origin routing tests ──────────────────────────────────

  it.skip("routes delegated completion to exact origin session before bridge or freshest", async () => {
    // Exact origin is bluebubbles/chat; bridge-attached is teams/conv; freshest is cli/session.
    // Should route to bluebubbles/chat (exact origin).
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    const cliPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "cli", "session")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) => {
      if (channel === "bluebubbles" && key === "chat") return bluebubblesPendingDir
      if (channel === "cli" && key === "session") return cliPendingDir
      return "/tmp/unused"
    })
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
    // Bridge points to teams/conv, not bluebubbles/chat.
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "alignment",
      summary: "relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        { friendId: "friend-1", channel: "teams", key: "conv", sessionPath: "/tmp/teams.json" },
      ],
      task: null,
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "exact origin wins" }],
      completion: { answer: "exact origin wins", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "delegate to inner",
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

    // Should route to exact origin (bluebubbles/chat) not cli/session (freshest) or teams/conv (bridge)
    const routedFiles = fs.readdirSync(bluebubblesPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(bluebubblesPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("exact origin wins")
    expect(fs.existsSync(cliPendingDir)).toBe(false)
  })

  it.skip("falls back to bridge when exact origin session is not active", async () => {
    // Exact origin (bluebubbles/chat) NOT in session activity.
    // Bridge-attached session (teams/conv) IS active.
    const teamsPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "teams", "conv")
    mockGetPendingDir.mockImplementation((_agent: string, _friendId: string, channel: string, key: string) => {
      if (channel === "teams" && key === "conv") return teamsPendingDir
      return "/tmp/unused"
    })
    mockListSessionActivity.mockReturnValue([
      {
        friendId: "friend-1",
        friendName: "Ari",
        channel: "teams",
        key: "conv",
        sessionPath: "/tmp/state/sessions/friend-1/teams/conv.json",
        lastActivityAt: "2026-03-13T20:05:00.000Z",
        lastActivityMs: Date.parse("2026-03-13T20:05:00.000Z"),
        activitySource: "friend-facing",
      },
    ])
    mockGetBridge.mockReturnValue({
      id: "bridge-1",
      objective: "alignment",
      summary: "relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        { friendId: "friend-1", channel: "teams", key: "conv", sessionPath: "/tmp/teams.json" },
      ],
      task: null,
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "bridge fallback" }],
      completion: { answer: "bridge fallback", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "delegate",
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

    const routedFiles = fs.readdirSync(teamsPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(teamsPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.content).toBe("bridge fallback")
  })

  // ── Obligation lifecycle tests ──────────────────────────────────

  it.skip("advances obligation from queued to running then to returned on successful delivery", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockReturnValue(bluebubblesPendingDir)
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
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "done" }],
      completion: { answer: "done", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "inner task",
          timestamp: 1709900001,
          obligationId: "1709900001-obl123",
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

    // Should advance to running first
    expect(mockAdvanceObligation).toHaveBeenCalledWith(
      "test-agent",
      "1709900001-obl123",
      expect.objectContaining({ status: "running" }),
    )
    // Then advance to returned with exact-origin target
    expect(mockAdvanceObligation).toHaveBeenCalledWith(
      "test-agent",
      "1709900001-obl123",
      expect.objectContaining({
        status: "returned",
        returnTarget: "exact-origin",
      }),
    )
  })

  it.skip("advances obligation to deferred when no session is available", async () => {
    const deferredDir = path.join(agentRoot, "state", "pending-returns", "friend-1")
    mockGetDeferredReturnDir.mockReturnValue(deferredDir)
    mockListSessionActivity.mockReturnValue([])
    mockFindFreshestFriendSession.mockReturnValue(null)
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "deferred result" }],
      completion: { answer: "deferred result", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "think deeply",
          timestamp: 1709900001,
          obligationId: "1709900001-obldefer",
          delegatedFrom: {
            friendId: "friend-1",
            channel: "cli",
            key: "session",
          },
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    expect(mockAdvanceObligation).toHaveBeenCalledWith(
      "test-agent",
      "1709900001-obldefer",
      expect.objectContaining({
        status: "deferred",
        returnTarget: "deferred",
      }),
    )
  })

  it.skip("delivers proactively via bridge-attached BlueBubbles session when exact origin is not active", async () => {
    // Origin: cli/session (NOT in session activity).
    // Bridge-attached: bluebubbles/chat (IS active, proactive delivery succeeds).
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
      objective: "bridge",
      summary: "relay",
      lifecycle: "active",
      runtime: "idle",
      createdAt: "2026-03-13T20:00:00.000Z",
      updatedAt: "2026-03-13T20:00:00.000Z",
      attachedSessions: [
        { friendId: "friend-1", channel: "bluebubbles", key: "chat", sessionPath: "/tmp/bb.json" },
      ],
      task: null,
    })
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "bridge proactive" }],
      completion: { answer: "bridge proactive", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "delegate",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "cli",
            key: "session",
            bridgeId: "bridge-1",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: true })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith({
      friendId: "friend-1",
      sessionKey: "chat",
      text: "bridge proactive",
    })
  })

  it.skip("delivers proactively via freshest BlueBubbles session when exact origin and bridge are unavailable", async () => {
    // Origin: cli/session (NOT in session activity).
    // No bridge. Freshest: bluebubbles/chat (proactive delivery succeeds).
    mockListSessionActivity.mockReturnValue([])
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
      messages: [{ role: "assistant", content: "freshest proactive" }],
      completion: { answer: "freshest proactive", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "delegate",
          timestamp: 1709900001,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "cli",
            key: "session",
          },
        },
      ],
    })
    mockSendProactiveBlueBubblesMessageToSession.mockResolvedValue({ delivered: true })

    await runInnerDialogTurn({
      reason: "heartbeat",
      now: () => new Date("2026-03-13T20:10:00.000Z"),
    })

    expect(mockSendProactiveBlueBubblesMessageToSession).toHaveBeenCalledWith({
      friendId: "friend-1",
      sessionKey: "chat",
      text: "freshest proactive",
    })
  })

  it.skip("preserves obligationId in outbound return envelope", async () => {
    const bluebubblesPendingDir = path.join(agentRoot, "state", "pending", "friend-1", "bluebubbles", "chat")
    mockGetPendingDir.mockReturnValue(bluebubblesPendingDir)
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
    mockHandleInboundTurn.mockResolvedValue({
      resolvedContext: { friend: { id: "self", name: "test-agent" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      messages: [{ role: "assistant", content: "with obligation" }],
      completion: { answer: "with obligation", intent: "complete" },
      drainedPending: [
        {
          from: "test-agent",
          content: "delegated content",
          timestamp: 1709900001,
          obligationId: "1709900001-oblpreserve",
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

    const routedFiles = fs.readdirSync(bluebubblesPendingDir)
    expect(routedFiles.length).toBe(1)
    const routedPayload = JSON.parse(fs.readFileSync(path.join(bluebubblesPendingDir, routedFiles[0]), "utf8"))
    expect(routedPayload.obligationId).toBe("1709900001-oblpreserve")
  })

  // ── Habit tool enforcement tests ──────────────────────────────────

  it("restricts tools to only those declared in habit tools field", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "focused-habit.md"),
      "---\ntitle: Focused Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\ntools:\n  - read\n  - shell\n---\n\nDo focused work.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("focused habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "focused-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const tools = input.runAgentOptions.tools
    expect(tools).toBeDefined()
    expect(tools).toHaveLength(2)
    expect(tools.map((t: any) => t.function.name).sort()).toEqual(["read", "shell"])
  })

  it("silently excludes unknown tool names from habit tools field (fail closed)", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "partial-habit.md"),
      "---\ntitle: Partial Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\ntools:\n  - read\n  - nonexistent_tool\n---\n\nDo partial work.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("partial habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "partial-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const tools = input.runAgentOptions.tools
    expect(tools).toBeDefined()
    expect(tools).toHaveLength(1)
    expect(tools[0].function.name).toBe("read")
  })

  it("does not set runAgentOptions.tools when habit has no tools field (full repertoire)", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "open-habit.md"),
      "---\ntitle: Open Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\n---\n\nDo anything needed.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("open habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "open-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions.tools).toBeUndefined()
  })

  it("passes empty tools array when habit declares tools: [] (no tools)", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "silent-habit.md"),
      "---\ntitle: Silent Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\ntools: []\n---\n\nThink quietly.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("silent habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "silent-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const tools = input.runAgentOptions.tools
    expect(tools).toBeDefined()
    expect(tools).toHaveLength(0)
  })

  it("emits habit.tools_restricted nerves event when habit has tools field", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "restricted-habit.md"),
      "---\ntitle: Restricted Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\ntools:\n  - read\n  - shell\n---\n\nRestricted work.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("restricted habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "restricted-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const restrictedEvent = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "habit.tools_restricted",
    )
    expect(restrictedEvent).toBeDefined()
    expect(restrictedEvent![0].component).toBe("senses")
    expect(restrictedEvent![0].meta.habitName).toBe("restricted-habit")
    expect(restrictedEvent![0].meta.declared).toEqual(["read", "shell"])
    expect(restrictedEvent![0].meta.resolved).toEqual(["read", "shell"])
  })

  it("emits habit.tools_unrestricted nerves event when habit has no tools field", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "unrestricted-habit.md"),
      "---\ntitle: Unrestricted Habit\ncadence: 1h\nstatus: active\nlastRun: 2026-03-06T11:00:00.000Z\ncreated: 2026-03-01\n---\n\nUnrestricted work.",
      "utf8",
    )

    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("unrestricted habit message")

    await runInnerDialogTurn({
      reason: "habit",
      habitName: "unrestricted-habit",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    const unrestrictedEvent = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "habit.tools_unrestricted",
    )
    expect(unrestrictedEvent).toBeDefined()
    expect(unrestrictedEvent![0].component).toBe("senses")
    expect(unrestrictedEvent![0].meta.habitName).toBe("unrestricted-habit")
  })
})
