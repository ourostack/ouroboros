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
}))

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
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

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inner-dialog-test-"))
    sessionFile = path.join(tmp, "inner-dialog-session.json")
    agentRoot = path.join(tmp, "agent-root")
    fs.mkdirSync(path.join(agentRoot, "psyche"), { recursive: true })
    fs.writeFileSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"), "Keep improving the harness.", "utf8")

    mockBuildSystem.mockReset().mockResolvedValue("system prompt")
    mockRunAgent.mockReset().mockImplementation(async (messages: OpenAI.ChatCompletionMessageParam[], callbacks: any) => {
      callbacks?.onModelStart?.()
      callbacks?.onModelStreamStart?.()
      callbacks?.onTextChunk?.("inner-dialog text chunk")
      callbacks?.onReasoningChunk?.("inner-dialog reasoning chunk")
      callbacks?.onToolStart?.("memory_search")
      callbacks?.onToolEnd?.("memory_search", true)
      callbacks?.onError?.(new Error("inner-dialog synthetic callback error"))
      messages.push({ role: "assistant", content: "Noted. I will continue autonomous work." })
      return { usage: undefined }
    })
    mockSessionPath.mockReset().mockReturnValue(sessionFile)
    mockLoadSession.mockReset().mockReturnValue(null)
    mockPostTurn.mockReset().mockImplementation(() => {})
    mockGetAgentRoot.mockReset().mockReturnValue(agentRoot)
    mockGetAgentName.mockReset().mockReturnValue("test-agent")
    mockDrainPending.mockReset().mockReturnValue([])
    mockGetPendingDir.mockReset().mockReturnValue("/tmp/fake-pending-dir")
  })

  it("builds bootstrap message with aspirations and current state", () => {
    const message = buildInnerDialogBootstrapMessage("Learn and help Ari.", "No prior session found.")
    expect(message).toContain("Learn and help Ari.")
    expect(message).toContain("No prior session found.")
    expect(message).toContain("decide what to do next")
  })

  it("uses fallback aspirations text when aspirations are blank", () => {
    const message = buildInnerDialogBootstrapMessage("", "No prior session found.")
    expect(message).toContain("No explicit aspirations file found")
  })

  it("returns default instincts", () => {
    const instincts = loadInnerDialogInstincts()
    expect(instincts.length).toBeGreaterThan(0)
    expect(instincts[0].prompt.toLowerCase()).toContain("heartbeat")
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
    expect(text.toLowerCase()).toContain("heartbeat instinct")
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

  it("starts autonomous turn with bootstrap context and runs agent on cli channel", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:00:00.000Z"),
    })

    expect(mockRunAgent).toHaveBeenCalledTimes(1)
    const [messages, _callbacks, channel] = mockRunAgent.mock.calls[0]
    expect(channel).toBe("cli")
    expect(messages[0]).toMatchObject({ role: "system" })
    expect(messages[1]).toMatchObject({ role: "user" })
    expect(String(messages[1].content)).toContain("Keep improving the harness")
    expect(mockPostTurn).toHaveBeenCalledTimes(1)
  })

  it("uses bootstrap fallback text when aspirations file is missing", async () => {
    fs.unlinkSync(path.join(agentRoot, "psyche", "ASPIRATIONS.md"))

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-06T12:01:00.000Z"),
    })

    const [messages] = mockRunAgent.mock.calls[0]
    expect(String(messages[1].content)).toContain("No explicit aspirations file found")
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

    const [messages] = mockRunAgent.mock.calls[0]
    const bootstrap = String(messages[1].content)
    expect(bootstrap).toContain("distill anything valuable into your memory system and remove these files")
    expect(bootstrap).toContain("teams-app/manifest.json")
  })

  it("appends instinct-driven user messages on resumed sessions", async () => {
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

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((message: OpenAI.ChatCompletionMessageParam) => message.role === "user")
    expect(lastUser).toBeDefined()
    expect(String(lastUser!.content)).toContain("Instinct: review pending tasks.")
    expect(String(lastUser!.content).toLowerCase()).not.toBe("continue")
  })

  it("adds checkpoint-oriented context when resuming after interruption", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        {
          role: "assistant",
          content:
            "checkpoint: Unit 2b editing src/repertoire/tools.ts and src/__tests__/repertoire/tools.test.ts",
        },
      ],
    })

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "resume", prompt: "Instinct: resume interrupted work.", enabled: true }],
      now: () => new Date("2026-03-06T12:06:00.000Z"),
    })

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((message: OpenAI.ChatCompletionMessageParam) => message.role === "user")
    expect(lastUser).toBeDefined()
    const content = String(lastUser!.content)
    expect(content).toContain("Instinct: resume interrupted work.")
    expect(content).toContain("checkpoint:")
    expect(content).toContain("Unit 2b editing src/repertoire/tools.ts")
  })

  it("uses default reason/clock/instinct loading when options are omitted", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "ready for next cycle" },
      ],
    })

    await runInnerDialogTurn()

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((message: OpenAI.ChatCompletionMessageParam) => message.role === "user")
    expect(lastUser).toBeDefined()
    expect(String(lastUser!.content).toLowerCase()).toContain("heartbeat")
    expect(String(lastUser!.content)).toContain("reason: heartbeat")
  })

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
    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
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
    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    expect(String(lastUser!.content)).not.toContain("## incoming messages")
  })

  it("works without drainInbox option (default no-op)", async () => {
    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-07T12:02:00.000Z"),
    })

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    expect(String(lastUser!.content)).not.toContain("## incoming messages")
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

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
    expect(content).toContain("Instinct: check in.")
    expect(content).toContain("## incoming messages")
    expect(content).toContain("**ouro-poke**: poke habit-heartbeat")
  })

  // --- C1: Inner dialog drains pending dir ---

  it("calls drainPending with getPendingDir(agentName, 'self', 'inner', 'dialog') on boot", async () => {
    mockGetPendingDir.mockReturnValue("/tmp/pending/test-agent/self/inner/dialog")
    mockDrainPending.mockReturnValue([])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:00:00.000Z"),
    })

    expect(mockGetPendingDir).toHaveBeenCalledWith("test-agent", "self", "inner", "dialog")
    expect(mockDrainPending).toHaveBeenCalledWith("/tmp/pending/test-agent/self/inner/dialog")
  })

  it("proceeds normally when drainPending returns no messages (boot)", async () => {
    mockDrainPending.mockReturnValue([])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:01:00.000Z"),
    })

    expect(mockDrainPending).toHaveBeenCalledTimes(1)
    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
    expect(content).not.toContain("## pending messages")
    expect(content).toContain("Keep improving the harness")
  })

  it("appends pending messages to user message when drainPending returns messages (boot)", async () => {
    mockDrainPending.mockReturnValue([
      { from: "cli-session", content: "Think about what I said about refactoring.", timestamp: 1000 },
      { from: "ouroboros", content: "Hey, can you review my PR?", timestamp: 2000 },
    ])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:02:00.000Z"),
    })

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
    expect(content).toContain("## pending messages")
    expect(content).toContain("**cli-session**: Think about what I said about refactoring.")
    expect(content).toContain("**ouroboros**: Hey, can you review my PR?")
  })

  it("appends pending messages to instinct message on resumed session", async () => {
    mockLoadSession.mockReturnValue({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "assistant", content: "checkpoint: working on task board" },
      ],
    })

    mockDrainPending.mockReturnValue([
      { from: "ari-cli", content: "Don't forget about the tests.", timestamp: 3000 },
    ])

    await runInnerDialogTurn({
      reason: "heartbeat",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:03:00.000Z"),
    })

    expect(mockGetPendingDir).toHaveBeenCalledWith("test-agent", "self", "inner", "dialog")
    expect(mockDrainPending).toHaveBeenCalledTimes(1)
    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
    expect(content).toContain("Instinct: check in.")
    expect(content).toContain("## pending messages")
    expect(content).toContain("**ari-cli**: Don't forget about the tests.")
  })

  it("pending messages appear before inbox messages in the user message", async () => {
    mockDrainPending.mockReturnValue([
      { from: "self-note", content: "Review my aspirations.", timestamp: 1000 },
    ])

    const drainInbox = vi.fn(() => [
      { from: "ouroboros", content: "inbox message" },
    ])

    await runInnerDialogTurn({
      reason: "boot",
      instincts: [{ id: "heartbeat", prompt: "Instinct: check in.", enabled: true }],
      now: () => new Date("2026-03-09T10:04:00.000Z"),
      drainInbox,
    })

    const [messages] = mockRunAgent.mock.calls[0]
    const lastUser = [...messages].reverse().find((m: OpenAI.ChatCompletionMessageParam) => m.role === "user")
    const content = String(lastUser!.content)
    const pendingIdx = content.indexOf("## pending messages")
    const inboxIdx = content.indexOf("## incoming messages")
    expect(pendingIdx).toBeGreaterThan(-1)
    expect(inboxIdx).toBeGreaterThan(-1)
    expect(pendingIdx).toBeLessThan(inboxIdx)
  })
})
