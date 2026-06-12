import * as fs from "fs"
import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  mockGetAgentRoot,
  mockReadHabitSessionSummary,
  mockWriteFileSync,
  mockMkdirSync,
} = vi.hoisted(() => ({
  mockGetAgentRoot: vi.fn(() => "/mock/agent-root"),
  mockReadHabitSessionSummary: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}))

vi.mock("fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("fs")>()),
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}))

vi.mock("../../heart/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../heart/identity")>()),
  getAgentRoot: (...args: any[]) => mockGetAgentRoot(...args),
}))

vi.mock("../../heart/habits/habit-session-summary", () => ({
  readHabitSessionSummary: (...args: any[]) => mockReadHabitSessionSummary(...args),
}))

function sampleSummary(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    habitName: "stateful-check",
    operationId: "habit:stateful-check",
    status: "surfaced",
    triggeredAt: "2026-06-11T20:00:00.000Z",
    completedAt: "2026-06-11T20:01:00.000Z",
    summary: "Asked Ari for the missing deployment decision.",
    decisions: ["wait for Ari before deploying"],
    pending: { count: 1, files: ["reply.json"] },
    messagesSent: [{ recipient: "ari", channel: "bluebubbles", result: "queued" }],
    toolsUsed: ["send_message"],
    producedRefs: [{ kind: "surface", locator: "surface/ari/bluebubbles" }],
    errors: [],
    nextLikelyStep: "check whether Ari answered",
    sources: {
      receipt: "arc/flight-recorder/habit-receipts/run-1.json",
      session: "state/habit-sessions/run-1/session.json",
      pending: "state/habit-sessions/run-1/pending",
      runtimeState: "state/habits/stateful-check.json",
    },
    warnings: ["session file missing"],
    ...overrides,
  }
}

async function getSessionSummaryTool() {
  vi.resetModules()
  const { baseToolDefinitions } = await import("../../repertoire/tools-base")
  const tool = baseToolDefinitions.find((entry) => entry.tool.function.name === "session_summary")
  if (!tool) throw new Error("session_summary tool not registered")
  return tool
}

function parseToolResult(value: string) {
  return JSON.parse(value) as Record<string, any>
}

describe("session_summary tool", () => {
  beforeEach(() => {
    mockGetAgentRoot.mockReset().mockReturnValue("/mock/agent-root")
    mockReadHabitSessionSummary.mockReset().mockReturnValue(sampleSummary())
    mockWriteFileSync.mockReset()
    mockMkdirSync.mockReset()
  })

  it("is registered in baseToolDefinitions as a read-only orientation tool", async () => {
    const tool = await getSessionSummaryTool()

    expect(tool.tool.function.description).toContain("read-only")
    expect(tool.tool.function.parameters).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        runId: expect.objectContaining({ type: "string" }),
        habitName: expect.objectContaining({ type: "string" }),
        operationId: expect.objectContaining({ type: "string" }),
        which: expect.objectContaining({ enum: ["latest", "previous", "latest-success", "latest-failure"] }),
      }),
    })
    expect(tool.riskProfile).toEqual({
      mutates: "none",
      risk: "low",
      reason: "reads habit run summaries from local receipts and session artifacts",
    })
  })

  it("returns structured JSON with readable text and source locators", async () => {
    const tool = await getSessionSummaryTool()

    const result = parseToolResult(await tool.handler({ runId: "run-1" }) as string)

    expect(mockReadHabitSessionSummary).toHaveBeenCalledWith("/mock/agent-root", { runId: "run-1" })
    expect(result).toMatchObject({
      kind: "habit_session_summary",
      text: expect.stringContaining("Asked Ari for the missing deployment decision."),
      summary: expect.objectContaining({
        runId: "run-1",
        habitName: "stateful-check",
        operationId: "habit:stateful-check",
        status: "surfaced",
        sources: {
          receipt: "arc/flight-recorder/habit-receipts/run-1.json",
          session: "state/habit-sessions/run-1/session.json",
          pending: "state/habit-sessions/run-1/pending",
          runtimeState: "state/habits/stateful-check.json",
        },
      }),
    })
    expect(result.text).toContain("next: check whether Ari answered")
    expect(fs.writeFileSync).not.toHaveBeenCalled()
    expect(fs.mkdirSync).not.toHaveBeenCalled()
  })

  it("validates exclusive runId selectors before reading summaries", async () => {
    const tool = await getSessionSummaryTool()

    const result = parseToolResult(await tool.handler({ runId: "run-1", habitName: "stateful-check" }) as string)

    expect(result).toMatchObject({
      kind: "invalid_selector",
      code: "run_id_exclusive",
    })
    expect(mockReadHabitSessionSummary).not.toHaveBeenCalled()
  })

  it("validates which values before reading summaries", async () => {
    const tool = await getSessionSummaryTool()

    const result = parseToolResult(await tool.handler({ habitName: "stateful-check", which: "oldest" }) as string)

    expect(result).toMatchObject({
      kind: "invalid_selector",
      code: "invalid_which",
    })
    expect(mockReadHabitSessionSummary).not.toHaveBeenCalled()
  })

  it("returns not_found when no habit run matches", async () => {
    mockReadHabitSessionSummary.mockReturnValue(null)
    const tool = await getSessionSummaryTool()

    const result = parseToolResult(await tool.handler({ operationId: "habit:missing", which: "latest" }) as string)

    expect(mockReadHabitSessionSummary).toHaveBeenCalledWith("/mock/agent-root", {
      operationId: "habit:missing",
      which: "latest",
    })
    expect(result).toMatchObject({
      kind: "not_found",
      message: "no habit run matched selector",
    })
  })
})
