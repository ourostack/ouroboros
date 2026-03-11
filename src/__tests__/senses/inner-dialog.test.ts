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
const mockHandleInboundTurn = vi.fn()
const mockGetChannelCapabilities = vi.fn()
const mockEnforceTrustGate = vi.fn()
const mockAccumulateFriendTokens = vi.fn()

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
  INNER_DIALOG_PENDING: { friendId: "self", channel: "inner", key: "dialog" },
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
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

import {
  buildInnerDialogBootstrapMessage,
  buildNonCanonicalCleanupNudge,
  buildInstinctUserMessage,
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
    mockGetChannelCapabilities.mockReset().mockReturnValue(innerCapabilities)
    mockEnforceTrustGate.mockReset().mockReturnValue({ allowed: true })
    mockAccumulateFriendTokens.mockReset().mockResolvedValue(undefined)

    // Default handleInboundTurn: simulate pipeline running agent and returning result.
    // Mirrors the real pipeline: resolves friend, calls sessionLoader, appends input.messages,
    // calls injected runAgent, postTurn, and accumulateFriendTokens.
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

  it("builds bootstrap message with first-person awareness framing", () => {
    const message = buildInnerDialogBootstrapMessage("Learn and help Ari.", "No prior session found.")
    expect(message).toBe("waking up. settling in.\n\nwhat needs my attention?")
  })

  it("returns same bootstrap message regardless of aspirations content", () => {
    const message = buildInnerDialogBootstrapMessage("", "No prior session found.")
    expect(message).toBe("waking up. settling in.\n\nwhat needs my attention?")
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

  it("bootstrap message is exactly 'waking up. settling in.\\n\\nwhat needs my attention?'", () => {
    const message = buildInnerDialogBootstrapMessage("any aspirations", "any state")
    expect(message).toBe("waking up. settling in.\n\nwhat needs my attention?")
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
    // Use a non-call-through pipeline mock so mockRunAgent is only called if inner-dialog
    // invokes it directly (not through the pipeline's input.runAgent pass-through)
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
    // Use a non-call-through pipeline mock
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

  it("passes bootstrap user message as pipeline input.messages on fresh session", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(input.messages).toHaveLength(1)
    expect(input.messages[0].role).toBe("user")
    expect(String(input.messages[0].content)).toContain("waking up. settling in.")
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

  it("session loader returns system prompt on fresh session", async () => {
    // Use non-call-through mock to prevent session mutation before inspection
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

    // Use non-call-through mock to prevent session mutation before inspection
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

  it("uses same bootstrap message when aspirations file is missing", async () => {
    fs.unlinkSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"))

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:01:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(String(input.messages[0].content)).toContain("waking up. settling in.")
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

  // ── Inbox drain (adapter concern, not pipeline) ──────────────────

  it("drains inbox messages into user message when drainInbox returns messages", async () => {
    const drainInbox = vi.fn(() => [
      { from: "ouroboros", content: "review PR #42" },
      { from: "ari", content: "check task board" },
    ])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-07T12:00:00.000Z"),
      drainInbox,
    })

    expect(drainInbox).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("## incoming messages")
    expect(content).toContain("**ouroboros**: review PR #42")
    expect(content).toContain("**ari**: check task board")
  })

  it("does not inject incoming messages section when drainInbox returns empty array", async () => {
    const drainInbox = vi.fn(() => [])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-07T12:01:00.000Z"),
      drainInbox,
    })

    expect(drainInbox).toHaveBeenCalledTimes(1)
    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(String(input.messages[0].content)).not.toContain("## incoming messages")
  })

  it("works without drainInbox option (default no-op)", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-07T12:02:00.000Z"),
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    expect(String(input.messages[0].content)).not.toContain("## incoming messages")
  })

  it("drains inbox on resumed sessions (heartbeat) and appends to instinct message", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: working on task board" },
      ],
    })

    const drainInbox = vi.fn(() => [
      { from: "ouro-poke", content: "poke habit-heartbeat" },
    ])

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-07T12:03:00.000Z"),
      drainInbox,
    })

    const input = mockHandleInboundTurn.mock.calls[0][0]
    const content = String(input.messages[0].content)
    expect(content).toContain("Instinct: check in.")
    expect(content).toContain("## incoming messages")
    expect(content).toContain("**ouro-poke**: poke habit-heartbeat")
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

  it("emits nerves event after pipeline completes", async () => {
    const { emitNervesEvent } = await import("../../nerves/runtime")

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.inner_dialog_turn",
    }))
  })
})
