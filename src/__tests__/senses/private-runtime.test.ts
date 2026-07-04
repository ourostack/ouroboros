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
const mockGetPrivateRuntimePendingDir = vi.fn()
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
const mockReadHealth = vi.fn(() => null)
const mockGetDefaultHealthPath = vi.fn(() => "/tmp/fake-health-path/daemon-health.json")
const mockGetToolsForChannel = vi.fn()

vi.mock("../../mind/prompt", () => ({
  buildSystem: (...args: any[]) => mockBuildSystem(...args),
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
  getPrivateRuntimePendingDir: (...args: any[]) => mockGetPrivateRuntimePendingDir(...args),
  getDeferredReturnDir: (...args: any[]) => mockGetDeferredReturnDir(...args),
  PRIVATE_RUNTIME_PENDING: { friendId: "self", channel: "inner", key: "dialog" },
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

vi.mock("../../senses/pipeline", () => ({
  handleInboundTurn: (...args: any[]) => mockHandleInboundTurn(...args),
}))

// Friends now lives in the @ouro.bot/friends package (a single barrel module).
// The previously separate channel/tokens mocks merge into one package mock that
// spreads the real barrel and overrides getChannelCapabilities + accumulateFriendTokens.
vi.mock("@ouro.bot/friends", async () => {
  const actual = await vi.importActual<typeof import("@ouro.bot/friends")>("@ouro.bot/friends")
  return {
    ...actual,
    getChannelCapabilities: (...args: any[]) => mockGetChannelCapabilities(...args),
    accumulateFriendTokens: (...args: any[]) => mockAccumulateFriendTokens(...args),
  }
})

vi.mock("../../senses/trust-gate", () => ({
  enforceTrustGate: (...args: any[]) => mockEnforceTrustGate(...args),
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

vi.mock("../../heart/daemon/daemon-health", () => ({
  readHealth: (...args: any[]) => mockReadHealth(...args),
  getDefaultHealthPath: (...args: any[]) => mockGetDefaultHealthPath(...args),
}))

vi.mock("../../repertoire/tools", () => ({
  getToolsForChannel: (...args: any[]) => mockGetToolsForChannel(...args),
}))

import {
  createPrivateTurnRequestFingerprint,
  requestPrivateTurnDecision,
  type PrivateTurnDecision,
  type PrivateTurnRequest,
} from "../../heart/private-runtime"
import {
  buildPrivateRuntimeBootstrapMessage,
  buildNonCanonicalCleanupNudge,
  buildHeldReturnWakeMessage,
  buildInstinctUserMessage,
  buildTaskTriggeredMessage,
  readTaskFile,
  deriveResumeCheckpoint,
  loadPrivateRuntimeInstincts,
  runPrivateRuntimeTurn,
} from "../../senses/private-runtime"

describe("private runtime", () => {
  let sessionFile: string
  let agentRoot: string
  let privateDecisionCounter = 0

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
    privateDecisionCounter = 0
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "private-runtime-test-"))
    sessionFile = path.join(tmp, "private-runtime-session.json")
    agentRoot = path.join(tmp, "agent-root")
    fs.mkdirSync(path.join(agentRoot, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "Keep improving the harness.", "utf8")

    mockBuildSystem.mockReset().mockResolvedValue({ stable: "system prompt", volatile: "" })
    mockRunAgent.mockReset().mockImplementation(async (_messages: any, callbacks: any) => {
      callbacks?.onModelStart?.()
      callbacks?.onModelStreamStart?.()
      callbacks?.onTextChunk?.("private-runtime text chunk")
      callbacks?.onReasoningChunk?.("private-runtime reasoning chunk")
      callbacks?.onToolStart?.("search_facts")
      callbacks?.onToolEnd?.("search_facts", true)
      callbacks?.onError?.(new Error("private-runtime synthetic callback error"))
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
    mockGetPrivateRuntimePendingDir.mockReset().mockReturnValue("/tmp/fake-pending-dir")
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

  function makePrivateTurnRequest(overrides: Partial<PrivateTurnRequest> = {}): PrivateTurnRequest {
    privateDecisionCounter += 1
    return {
      agent: "test-agent",
      origin: "daemon.private.wake",
      reason: "unit test private-runtime turn",
      providerLane: "inner",
      triggerSource: "unit-test",
      idempotencyKey: `unit-test-private-turn-${privateDecisionCounter}`,
      budgetClass: "interactive",
      originRefs: [{ kind: "unit-test", id: String(privateDecisionCounter) }],
      ...overrides,
    }
  }

  function writeLedgeredPrivateTurnDecision(input: {
    request?: Partial<PrivateTurnRequest>
    decision?: Partial<PrivateTurnDecision>
    decidedAt?: string
  } = {}): PrivateTurnDecision {
    const request = makePrivateTurnRequest(input.request)
    const ledgerPath = path.join(agentRoot, "state", "private-runtime", "decisions.jsonl")
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    const line = fs.existsSync(ledgerPath)
      ? fs.readFileSync(ledgerPath, "utf-8").split("\n").filter(Boolean).length + 1
      : 1
    const decision: PrivateTurnDecision = {
      schemaVersion: 1,
      receiptId: `ptrr-unit-test-${privateDecisionCounter}`,
      agent: request.agent,
      origin: request.origin,
      requestReason: request.reason,
      reason: request.reason,
      providerLane: {
        lane: request.providerLane,
        provider: "minimax",
        model: "minimax-test",
        source: "agent.json",
        credentialRevision: "test-rev",
      },
      triggerSource: request.triggerSource,
      idempotencyKey: request.idempotencyKey!,
      budgetClass: request.budgetClass,
      originRefs: request.originRefs,
      requestFingerprint: createPrivateTurnRequestFingerprint(request),
      result: "allow",
      executable: true,
      decidedAt: input.decidedAt ?? "2026-03-06T11:59:00.000Z",
      ledgerLocator: { path: ledgerPath, line },
      ...input.decision,
    }
    fs.appendFileSync(ledgerPath, `${JSON.stringify(decision)}\n`, "utf-8")
    return decision
  }

  function withApprovedPrivateTurnDecision(
    options: Parameters<typeof runPrivateRuntimeTurn>[0] = {},
  ): Parameters<typeof runPrivateRuntimeTurn>[0] {
    if (options.privateTurnDecision) return options
    const originRefs: PrivateTurnRequest["originRefs"] = []
    if (typeof options.taskId === "string") originRefs.push({ kind: "task", id: options.taskId })
    if (typeof options.habitName === "string") originRefs.push({ kind: "habit", id: options.habitName })
    if (typeof options.awaitName === "string") originRefs.push({ kind: "await", id: options.awaitName })
    originRefs.push({ kind: "unit-test", id: `approved-${privateDecisionCounter + 1}` })
    return {
      ...options,
      privateTurnDecision: writeLedgeredPrivateTurnDecision({
        request: { originRefs },
        decidedAt: (options.now?.() ?? new Date()).toISOString(),
      }),
    }
  }

  function runApprovedPrivateRuntimeTurn(options?: Parameters<typeof runPrivateRuntimeTurn>[0]) {
    return runPrivateRuntimeTurn(withApprovedPrivateTurnDecision(options))
  }

  // ── Pure function tests (adapter concerns, no pipeline) ──────────

  it("builds bootstrap message with aspirations and state summary", () => {
    const message = buildPrivateRuntimeBootstrapMessage("Learn and help Ari.", "No prior session found.")
    expect(message).toContain("waking up.")
    expect(message).toContain("## what matters to me")
    expect(message).toContain("Learn and help Ari.")
    expect(message).toContain("## what i know so far")
    expect(message).toContain("No prior session found.")
    expect(message).toContain("what needs my attention?")
  })

  it("omits aspirations section when aspirations are empty", () => {
    const message = buildPrivateRuntimeBootstrapMessage("", "No prior session found.")
    expect(message).not.toContain("## what matters to me")
    expect(message).toContain("## what i know so far")
    expect(message).toContain("what needs my attention?")
  })

  it("omits state summary section when state summary is empty", () => {
    const message = buildPrivateRuntimeBootstrapMessage("Learn things.", "")
    expect(message).toContain("## what matters to me")
    expect(message).not.toContain("## what i know so far")
    expect(message).toContain("what needs my attention?")
  })

  it("builds a narrow held-return wake message that does not repeat stale checkpoints", () => {
    const message = buildHeldReturnWakeMessage()
    expect(message).toContain("current held-work frame")
    expect(message).toContain("surface(delegationId=...)")
    expect(message).toContain("Older checkpoints")
    expect(message).toContain("completed returns")
    expect(message).toContain("repeated probes")
    expect(message).toContain("Return only the requested result")
    expect(message).not.toContain("last checkpoint")
    expect(message).not.toContain("none currently waiting")
  })

  it("returns minimal bootstrap when both aspirations and state are empty", () => {
    const message = buildPrivateRuntimeBootstrapMessage("", "")
    expect(message).toBe("waking up.\n\nwhat needs my attention?")
  })

  it("returns default instincts with first-person awareness framing", () => {
    const instincts = loadPrivateRuntimeInstincts()
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
    const instincts = loadPrivateRuntimeInstincts()
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

  it("strips think tags when deriving the fallback checkpoint line", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: "<think>Rest with HEARTBEAT_OK.</think>",
      },
    ])
    expect(checkpoint).toBe("Rest with HEARTBEAT_OK.")
  })

  it("falls back when think tags strip the assistant checkpoint down to nothing", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: "<think>   </think>",
      },
    ])
    expect(checkpoint).toBe("no prior checkpoint recorded")
  })

  it("uses the latest meaningful tool-only assistant action when empty rest follows it", () => {
    const checkpoint = deriveResumeCheckpoint([
      {
        role: "assistant",
        content: "older visible checkpoint",
      },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_surface",
            type: "function",
            function: {
              name: "surface",
              arguments: JSON.stringify({
                message: "HEY — something is WRONG. I just called rest hundreds of times.",
              }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_surface", content: "delivered — via iMessage" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_rest",
            type: "function",
            function: { name: "rest", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_rest", content: "(resting)" },
    ] as OpenAI.ChatCompletionMessageParam[])

    expect(checkpoint).toBe("surfaced: HEY — something is WRONG. I just called rest hundreds of times.")
  })

  it("derives checkpoints from other meaningful tool-only assistant actions", () => {
    expect(deriveResumeCheckpoint([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_ponder",
            type: "function",
            function: { name: "ponder", arguments: JSON.stringify({ question: "what just happened?" }) },
          },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[])).toBe("pondered: what just happened?")

    expect(deriveResumeCheckpoint([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_diary",
            type: "function",
            function: { name: "diary_write", arguments: JSON.stringify({ text: "logged the incident" }) },
          },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[])).toBe("diary: logged the incident")

    expect(deriveResumeCheckpoint([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_let_go",
            type: "function",
            function: { name: "let_go", arguments: JSON.stringify({ reason: "no longer relevant" }) },
          },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[])).toBe("let go: no longer relevant")

    expect(deriveResumeCheckpoint([
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_rest_note",
            type: "function",
            function: { name: "rest", arguments: JSON.stringify({ note: "waiting on the next tick" }) },
          },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[])).toBe("rested: waiting on the next tick")
  })

  it("skips unrecognized or malformed tool-only assistant actions when deriving checkpoints", () => {
    const checkpoint = deriveResumeCheckpoint([
      { role: "assistant", content: "previous meaningful checkpoint" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_shell",
            type: "function",
            function: { name: "shell", arguments: JSON.stringify({ cmd: "pwd" }) },
          },
          {
            id: "call_diary_empty",
            type: "function",
            function: { name: "diary_write", arguments: "{}" },
          },
          {
            id: "call_let_go_empty",
            type: "function",
            function: { name: "let_go", arguments: "{}" },
          },
          {
            id: "call_ponder_empty",
            type: "function",
            function: { name: "ponder", arguments: "{}" },
          },
          {
            id: "call_surface_array",
            type: "function",
            function: { name: "surface", arguments: "[]" },
          },
          {
            id: "call_malformed",
            type: "function",
            function: { name: "surface", arguments: "{" },
          },
          { id: "call_bad_function", type: "function", function: "not an object" } as any,
          {
            id: "call_missing_function_fields",
            type: "function",
            function: { name: 7, arguments: 12 },
          } as any,
          {
            id: "call_rest_without_arguments",
            type: "function",
            function: { name: "rest" },
          } as any,
          { id: "call_custom", type: "custom" },
        ],
      },
    ] as OpenAI.ChatCompletionMessageParam[])

    expect(checkpoint).toBe("previous meaningful checkpoint")
  })

  // ── Pipeline integration tests ──────────────────────────────────

  describe("private-runtime provider boundary", () => {
    it("fails closed before the pipeline when no approved private-turn decision is supplied", async () => {
      await expect(runPrivateRuntimeTurn({
        reason: "instinct",
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/private-runtime.*decision/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed for denied decisions before provider-bound pipeline work", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: {
          result: "deny",
          executable: false,
          deniedReason: "default policy deny",
        },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/default policy deny|decision/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed for denied decisions even when no denial reason is recorded", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: {
          result: "deny",
          executable: false,
          deniedReason: undefined,
        },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/denied: deny/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed when the decision belongs to another agent", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: { agent: "other-agent" },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/agent mismatch|other-agent/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed for stale approved decisions before provider-bound pipeline work", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decidedAt: "2026-03-06T11:00:00.000Z",
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/stale|decision/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed for ledgered decisions with invalid timestamps", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decidedAt: "not-a-date",
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/invalid decidedAt/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed when the decision has no ledger locator", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: { ledgerLocator: { path: "" } },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/no ledger locator/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("accepts a ledgered decision found by receipt when the locator line is absent", async () => {
      const decision = writeLedgeredPrivateTurnDecision()
      const decisionWithoutLine = {
        ...decision,
        ledgerLocator: { path: decision.ledgerLocator.path },
      }

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decisionWithoutLine,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).resolves.toEqual(expect.objectContaining({ sessionPath: sessionFile }))

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
    })

    it("fails closed when the decision is absent from the referenced ledger", async () => {
      const decision = writeLedgeredPrivateTurnDecision()
      const missingLedgerDecision = {
        ...decision,
        ledgerLocator: { path: path.join(path.dirname(decision.ledgerLocator.path), "missing-decisions.jsonl") },
      }

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: missingLedgerDecision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/not present in the ledger/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed when the referenced ledger row has been tampered", async () => {
      const decision = writeLedgeredPrivateTurnDecision()
      const [line] = fs.readFileSync(decision.ledgerLocator.path, "utf-8").split("\n")
      const tampered = {
        ...JSON.parse(line!) as PrivateTurnDecision,
        executable: false,
      }
      fs.writeFileSync(decision.ledgerLocator.path, `${JSON.stringify(tampered)}\n`, "utf-8")

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/does not match its ledger row/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed when the decision fingerprint no longer matches the canonical request fields", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: { requestFingerprint: "ptr_mismatched" },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/fingerprint|decision/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("accepts producer decisions whose policy reason differs from the fingerprinted request reason", async () => {
      const request = makePrivateTurnRequest({
        reason: "task poke task-a",
        triggerSource: "task-poke",
        idempotencyKey: "task-poke:test-agent:task-a:receipt-policy-reason",
        originRefs: [
          { kind: "task", id: "task-a" },
          { kind: "queue-receipt", id: "receipt-policy-reason" },
        ],
      })
      const ledgerPath = path.join(agentRoot, "state", "private-runtime", "policy-decisions.jsonl")
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
      const decision = await requestPrivateTurnDecision(request, {
        ledgerPath,
        resolveProviderLane: () => ({
          lane: "inner",
          provider: "minimax",
          model: "minimax-test",
          source: "agent.json",
        }),
        evaluatePolicy: () => ({ result: "allow", reason: "operator-approved spend" }),
        now: () => "2026-03-06T11:59:00.000Z",
      })

      expect(decision.reason).toBe("operator-approved spend")
      expect(decision.requestReason).toBe("task poke task-a")

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        taskId: "task-a",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).resolves.toEqual(expect.objectContaining({ sessionPath: sessionFile }))

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
    })

    it("accepts legacy ledgered decisions that predate requestReason", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: { requestReason: undefined },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).resolves.toEqual(expect.objectContaining({ sessionPath: sessionFile }))

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
    })

    it("fails closed when a task decision is replayed for a different task payload", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        request: {
          reason: "task poke task-a",
          triggerSource: "task-poke",
          idempotencyKey: "task-poke:test-agent:task-a:receipt-1",
          originRefs: [
            { kind: "task", id: "task-a" },
            { kind: "queue-receipt", id: "receipt-1" },
          ],
        },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        taskId: "task-b",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/task-b|decision|payload/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("fails closed when a task decision is replayed without any task payload", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        request: {
          reason: "task poke task-a",
          triggerSource: "task-poke",
          idempotencyKey: "task-poke:test-agent:task-a:receipt-2",
          originRefs: [
            { kind: "task", id: "task-a" },
            { kind: "queue-receipt", id: "receipt-2" },
          ],
        },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/missing task payload|task-a/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("lets an approved ledgered decision reach the provider-bound pipeline once", async () => {
      const decision = writeLedgeredPrivateTurnDecision()

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).resolves.toEqual(expect.objectContaining({ sessionPath: sessionFile }))

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
    })

    it("collapses sequential duplicate execution claims for the same approved decision", async () => {
      const decision = writeLedgeredPrivateTurnDecision()
      const options = {
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      }

      await (runPrivateRuntimeTurn as any)(options)
      const duplicate = await (runPrivateRuntimeTurn as any)(options)

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
      expect(duplicate).toEqual(expect.objectContaining({
        turnOutcome: "rested",
        restStatus: "DUPLICATE_PRIVATE_TURN",
      }))
    })

    it("collapses concurrent duplicate execution claims for the same approved decision", async () => {
      const decision = writeLedgeredPrivateTurnDecision()
      const options = {
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      }

      const results = await Promise.all([
        (runPrivateRuntimeTurn as any)(options),
        (runPrivateRuntimeTurn as any)(options),
      ])

      expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
      expect(mockRunAgent).toHaveBeenCalledTimes(1)
      expect(results).toContainEqual(expect.objectContaining({
        turnOutcome: "rested",
        restStatus: "DUPLICATE_PRIVATE_TURN",
      }))
    })

    it("surfaces unexpected execution-claim write failures before provider-bound pipeline work", async () => {
      const decision = writeLedgeredPrivateTurnDecision({
        decision: { receiptId: `ptrr-${"a".repeat(300)}` },
      })

      await expect((runPrivateRuntimeTurn as any)({
        reason: "instinct",
        privateTurnDecision: decision,
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow()

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })

    it("applies the same fail-closed guard through the canonical private-runtime boundary", async () => {
      await expect(runPrivateRuntimeTurn({
        reason: "instinct",
        instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
        now: () => new Date("2026-03-06T12:00:00.000Z"),
      })).rejects.toThrow(/private-runtime.*decision/i)

      expect(mockHandleInboundTurn).not.toHaveBeenCalled()
      expect(mockRunAgent).not.toHaveBeenCalled()
    })
  })

  it("calls handleInboundTurn instead of inline lifecycle", async () => {
    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockHandleInboundTurn).toHaveBeenCalledTimes(1)
  })

  it("passes channel 'inner' and senseType 'internal' capabilities to pipeline", async () => {
    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockPostTurnTrim).not.toHaveBeenCalled()
  })

  it("passes pending dir for self/inner/dialog to pipeline", async () => {
    mockGetPrivateRuntimePendingDir.mockReturnValue("/tmp/pending/test-agent/self/inner/dialog")

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })

    expect(mockGetPrivateRuntimePendingDir).toHaveBeenCalledWith("test-agent")
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.pendingDir).toBe("/tmp/pending/test-agent/self/inner/dialog")
  })

  it("uses held-return wake copy instead of stale checkpoint copy when return work is active", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "assistant", content: "checkpoint: none currently waiting; matching May pattern exactly" },
      ],
    })
    mockListActiveObligations.mockReturnValue([
      {
        id: "obl-1",
        origin: { friendId: "friend-1", channel: "mcp", key: "session-1" },
        delegatedContent: "private marker analysis",
        createdAt: 1000,
        status: "queued",
      },
    ] as any)

    await runApprovedPrivateRuntimeTurn({
      reason: "instinct",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const userContent = input.messages[0].content
    expect(userContent).toContain("current held-work frame")
    expect(userContent).toContain("surface(delegationId=...)")
    expect(userContent).not.toContain("May pattern")
    expect(userContent).not.toContain("last checkpoint")
    expect(userContent).not.toContain("none currently waiting")
  })

  it("does not prepend an empty held-work status frame", async () => {
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      expect(input.onPendingDrained([])).toEqual([])
      return {
        resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
        gateResult: { allowed: true },
        usage: undefined,
        sessionPath: sessionFile,
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
      }
    })

    await runApprovedPrivateRuntimeTurn({
      reason: "instinct",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })
  })

  it("keeps delegatedOrigins visible to tools after pending drain", async () => {
    mockHandleInboundTurn.mockImplementationOnce(async (input: any) => {
      input.onPendingDrained([
        {
          from: "test-agent",
          content: "call evolution_status",
          timestamp: 1000,
          delegatedFrom: {
            friendId: "friend-1",
            channel: "mcp",
            key: "session-1",
          },
          obligationId: "obl-1",
        },
      ])

      const result = await input.runAgent(
        [],
        input.callbacks,
        input.channel,
        input.signal,
        input.runAgentOptions,
      )

      return {
        resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
        gateResult: { allowed: true },
        usage: result?.usage,
        sessionPath: sessionFile,
        messages: [{ role: "assistant", content: null, tool_calls: [] }],
      }
    })

    mockRunAgent.mockImplementationOnce(async (_messages: any, _callbacks: any, _channel: any, _signal: any, options: any) => {
      expect(options.toolContext.delegatedOrigins).toHaveLength(1)
      expect(options.toolContext.delegatedOrigins[0]).toEqual(expect.objectContaining({
        id: "obl-1",
        friendId: "friend-1",
        channel: "mcp",
        key: "session-1",
      }))
      return { usage: undefined }
    })

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })

    expect(mockRunAgent).toHaveBeenCalled()
  })

  it("injects drainPending, runAgent, postTurn, accumulateFriendTokens, enforceTrustGate into pipeline", async () => {
    await runApprovedPrivateRuntimeTurn({
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
    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.runAgentOptions).toEqual(expect.objectContaining({
      toolChoiceRequired: true,
    }))
  })

  it("passes empty continuity ingress text to the shared pipeline for private runtime", async () => {
    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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
    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-03-06T12:05:00.000Z"),
    })

    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toBe("unified habit turn message")
  })

  it("uses a fresh per-run habit session path and habit prompt instead of bootstrapping", async () => {
    const habitsDir = path.join(agentRoot, "habits")
    fs.mkdirSync(habitsDir, { recursive: true })
    fs.writeFileSync(
      path.join(habitsDir, "heartbeat.md"),
      "---\ntitle: Heartbeat\ncadence: 30m\nstatus: active\ncreated: 2026-03-01\n---\n\nCheck in on responsibilities.",
      "utf8",
    )
    const runId = "2026-06-11T17-00-00-000Z-heartbeat-abc123ef"
    const sessionPath = path.join(agentRoot, "state", "habit-sessions", runId, "session.json")
    const pendingDir = path.join(agentRoot, "state", "habit-sessions", runId, "pending")
    mockLoadSession.mockReturnValueOnce(null)
    mockBuildHabitTurnMessage.mockReturnValueOnce("fresh habit turn message")

    await (runApprovedPrivateRuntimeTurn as any)({
      reason: "habit",
      habitName: "heartbeat",
      now: () => new Date("2026-06-11T17:00:00.000Z"),
      habitSession: {
        runId,
        sessionPath,
        pendingDir,
        permissionEnvelope: {
          schemaVersion: 1,
          canMessageOutward: false,
          returnRoutes: [],
          deniedTools: ["send_message", "surface"],
          warnings: [],
        },
        toolPolicy: {
          requestedTools: null,
          grantedTools: ["read"],
          deniedTools: ["shell", "send_message", "surface"],
          outwardMessagingAllowed: false,
        },
      },
    })

    expect(mockLoadSession).toHaveBeenCalledWith(sessionPath)
    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.pendingDir).toBe(pendingDir)
    expect(input.runAgentOptions.toolContext.habitSession.runId).toBe(runId)
    await expect(input.sessionLoader.loadOrCreate()).resolves.toMatchObject({ sessionPath })
    expect(String(input.messages[0].content)).toBe("fresh habit turn message")
  })

  it("uses prepared habit context without reparsing the habit file", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: waiting on habit" },
      ],
    })
    mockBuildHabitTurnMessage.mockReturnValueOnce("prepared habit turn message")
    const runId = "run-prepared"
    const sessionPath = path.join(agentRoot, "state", "habit-sessions", runId, "session.json")
    const pendingDir = path.join(agentRoot, "state", "habit-sessions", runId, "pending")

    await (runApprovedPrivateRuntimeTurn as any)({
      reason: "habit",
      habitName: "stateful-check",
      now: () => new Date("2026-06-11T17:00:00.000Z"),
      preparedHabit: {
        runId,
        trigger: "poke",
        operationId: "op-prepared",
        habit: {
          name: "stateful-check",
          title: "Stateful Check",
          cadence: "1h",
          status: "active",
          lastRun: "2026-06-11T16:00:00.000Z",
          created: "2026-06-01T00:00:00.000Z",
          tools: ["send_message"],
          origin: { friendId: "ari", channel: "bluebubbles", key: "chat" },
          surface: { family: false, originator: true, extra: [] },
          continuity: { mode: "stateful" },
          body: "Use the prepared habit body.",
        },
      },
      habitSession: {
        runId,
        sessionPath,
        pendingDir,
        permissionEnvelope: {
          schemaVersion: 1,
          canMessageOutward: true,
          returnRoutes: [],
          deniedTools: [],
          warnings: [],
        },
        toolPolicy: {
          requestedTools: ["send_message"],
          grantedTools: ["send_message"],
          deniedTools: [],
          outwardMessagingAllowed: true,
        },
      },
    })

    expect(mockBuildHabitTurnMessage).toHaveBeenCalledTimes(1)
    const call = mockBuildHabitTurnMessage.mock.calls[0][0]
    expect(call.habitName).toBe("stateful-check")
    expect(call.habitTitle).toBe("Stateful Check")
    expect(call.habitBody).toBe("Use the prepared habit body.")
    expect(call.lastRun).toBe("2026-06-11T16:00:00.000Z")
    expect(call.surfacePolicy).toContain("ari via bluebubbles/chat")
    expect(String(mockHandleInboundTurn.mock.calls[0][0].messages[0].content)).toBe("prepared habit turn message")
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
      reason: "instinct",
      taskId: "habits/nonexistent",
      now: () => new Date("2026-03-06T09:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("(task file not found)")
  })

  it("ignores taskId on fresh session (uses bootstrap instead)", async () => {
    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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
    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-10T01:00:00.000Z"),
    })

    expect(mockBuildSystem).toHaveBeenCalledTimes(1)
    expect(mockBuildSystem.mock.calls[0][0]).toBe("inner")
  })

  it("uses bootstrap with empty aspirations when aspirations file is missing", async () => {
    fs.unlinkSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"))

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn()

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

    const result = await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.sessionPath).toBe(sessionFile)
    expect(result.usage).toEqual(expect.objectContaining({ total_tokens: 160 }))
    expect(result.messages).toBeDefined()
  })

  it("returns rested HEARTBEAT_OK metadata from pipeline result", async () => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      turnOutcome: "rested",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "...time passing. anything stirring?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_rest",
            type: "function",
            function: { name: "rest", arguments: JSON.stringify({ status: "HEARTBEAT_OK" }) },
          }],
        },
        { role: "tool", tool_call_id: "call_rest", content: "(resting)" },
      ],
    })

    const result = await runApprovedPrivateRuntimeTurn({
      reason: "habit",
      habitName: "heartbeat",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.turnOutcome).toBe("rested")
    expect(result.restStatus).toBe("HEARTBEAT_OK")
  })

  it.each([
    ["blank", JSON.stringify({ status: "   " })],
    ["missing", JSON.stringify({})],
  ])("omits %s rest status metadata from pipeline result", async (_caseName, restArguments) => {
    mockHandleInboundTurn.mockResolvedValueOnce({
      resolvedContext: { friend: { id: "self" }, channel: innerCapabilities },
      gateResult: { allowed: true },
      usage: undefined,
      sessionPath: sessionFile,
      turnOutcome: "rested",
      messages: [
        { role: "system", content: "system prompt" },
        { role: "user", content: "...time passing. anything stirring?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_rest",
            type: "function",
            function: { name: "rest", arguments: restArguments },
          }],
        },
        { role: "tool", tool_call_id: "call_rest", content: "(resting)" },
      ],
    })

    const result = await runApprovedPrivateRuntimeTurn({
      reason: "habit",
      habitName: "heartbeat",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.turnOutcome).toBe("rested")
    expect(result.restStatus).toBeUndefined()
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

    await runApprovedPrivateRuntimeTurn({
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

    await expect(runApprovedPrivateRuntimeTurn({
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

    mockSessionPath.mockReturnValue(path.join(blockedParent, "private-runtime-session.json"))

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const warnings = mockEmitNervesEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event?.event === "senses.private_runtime_state_error")

    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.private_runtime_state_error",
      message: "failed to write private-runtime state",
      meta: expect.objectContaining({
        path: path.join(blockedParent, "runtime.json"),
        error: expect.any(String),
      }),
    })]))
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.private_runtime_state_error",
      meta: expect.objectContaining({
        status: "running",
        reason: "boot",
      }),
    })]))
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({
      level: "warn",
      component: "senses",
      event: "senses.private_runtime_state_error",
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

    const result = await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(result.messages).toEqual([])
    expect(result.sessionPath).toBe(sessionFile)
    expect(result.usage).toBeUndefined()
  })

  it("provides a friendResolver that resolves to a self-referencing context", async () => {
    await runApprovedPrivateRuntimeTurn({
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
    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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

    await runApprovedPrivateRuntimeTurn({
      reason: "instinct",
      taskId: "habits/daily-standup",
      now: () => new Date("2026-03-06T09:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
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
            { id: "tc_1", type: "function", function: { name: "search_facts", arguments: "{}" } },
            { id: "tc_2", type: "function", function: { name: "search_facts", arguments: "{}" } },
          ],
        },
      ],
    })

    await runApprovedPrivateRuntimeTurn({
      reason: "boot",
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const nervesCall = mockEmitNervesEvent.mock.calls.find(
      (call: any[]) => call[0].event === "senses.private_runtime_turn",
    )
    expect(nervesCall![0].meta.toolCalls).toEqual(["search_facts"])
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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

    await runApprovedPrivateRuntimeTurn({
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
