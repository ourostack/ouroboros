import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterAll, describe, expect, it, vi } from "vitest"
import { writeHabitRunReceipt, type HabitRunReceipt } from "../../../arc/flight-recorder"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { getCommandHelp } from "../../../heart/daemon/cli-help"

function makeHabitReceipt(overrides: Partial<HabitRunReceipt> = {}): HabitRunReceipt {
  const runId = overrides.runId ?? "run-base"
  return {
    schemaVersion: 2,
    runId,
    sessionId: runId,
    habitName: overrides.habitName ?? "heartbeat",
    operationId: "operationId" in overrides ? overrides.operationId : "habit:heartbeat",
    trigger: overrides.trigger ?? "poke",
    startedAt: overrides.startedAt ?? "2026-06-11T10:00:00.000Z",
    endedAt: overrides.endedAt ?? "2026-06-11T10:01:00.000Z",
    outcome: overrides.outcome ?? "surfaced",
    definitionLocator: overrides.definitionLocator ?? "habits/heartbeat.md",
    sessionLocator: overrides.sessionLocator ?? `state/habit-sessions/${runId}/session.json`,
    pendingLocator: overrides.pendingLocator ?? `state/habit-sessions/${runId}/pending`,
    runtimeStateLocator: overrides.runtimeStateLocator ?? "state/habits/heartbeat.json",
    receiptLocator: overrides.receiptLocator ?? `arc/flight-recorder/habit-receipts/${runId}.json`,
    nextRunAt: overrides.nextRunAt ?? "2026-06-12T10:01:00.000Z",
    summarySnapshot: overrides.summarySnapshot ?? {
      summary: "Asked Ari for the missing deployment decision.",
      decisions: ["wait for Ari"],
      nextLikelyStep: "check the iMessage reply",
    },
    permissionEnvelope: overrides.permissionEnvelope ?? {
      schemaVersion: 1,
      canMessageOutward: true,
      returnRoutes: [{ kind: "family", recipient: "ari", status: "allowed", friendId: "ari", channel: "bluebubbles", key: "chat" }],
      deniedTools: [],
      warnings: [],
    },
    toolPolicy: overrides.toolPolicy ?? {
      requestedTools: ["send_message", "session_summary"],
      grantedTools: ["send_message", "session_summary"],
      deniedTools: [],
      outwardMessagingAllowed: true,
    },
    producedRefs: overrides.producedRefs ?? [{ kind: "surface", locator: "surface/ari/bluebubbles" }],
    surfaceAttempts: overrides.surfaceAttempts ?? [{
      recipient: "ari",
      channel: "bluebubbles",
      reason: "status",
      result: "queued",
      rawStatus: "queued",
      routeKind: "family",
    }],
    errors: overrides.errors ?? [],
  }
}

function makeDeps(overrides?: Partial<OuroCliDeps>): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn(),
    startDaemonProcess: vi.fn(async () => ({ pid: 1 })),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn(async () => true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn(() => "/tmp/pending.jsonl"),
    listDiscoveredAgents: vi.fn(async () => ["slugger"]),
    ...overrides,
  }
}

function writeSummaryArtifacts(bundleRoot: string, receipt: HabitRunReceipt): void {
  writeHabitRunReceipt(bundleRoot, receipt)
  const sessionPath = path.join(bundleRoot, receipt.sessionLocator)
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
  fs.writeFileSync(sessionPath, JSON.stringify({
    version: 1,
    messages: [
      { role: "assistant", name: "send_message", content: "queued iMessage" },
    ],
    summary: {
      decisions: ["session decision"],
      nextLikelyStep: "inspect delivery status",
    },
  }, null, 2), "utf-8")
  const pendingDir = path.join(bundleRoot, receipt.pendingLocator)
  fs.mkdirSync(pendingDir, { recursive: true })
  fs.writeFileSync(path.join(pendingDir, "reply.json"), JSON.stringify({ content: "waiting" }), "utf-8")
}

describe("ouro habit summary CLI", () => {
  const cleanup: string[] = []

  afterAll(() => {
    while (cleanup.length > 0) {
      const entry = cleanup.pop()
      if (entry) fs.rmSync(entry, { recursive: true, force: true })
    }
  })

  it("parses run, habit, operation, which, and json selectors", () => {
    expect(parseOuroCommand(["habit", "summary", "--agent", "slugger", "--run-id", "run-1", "--json"])).toEqual({
      kind: "habit.summary",
      agent: "slugger",
      runId: "run-1",
      json: true,
    })
    expect(parseOuroCommand(["habit", "summary", "--habit", "heartbeat", "--operation-id", "habit:heartbeat", "--which", "latest-success"])).toEqual({
      kind: "habit.summary",
      habitName: "heartbeat",
      operationId: "habit:heartbeat",
      which: "latest-success",
      json: false,
    })
  })

  it("rejects invalid selector combinations and invalid which values", () => {
    expect(() => parseOuroCommand(["habit", "summary"])).toThrow("provide --run-id, --habit, or --operation-id")
    expect(() => parseOuroCommand(["habit", "summary", "--run-id", "run-1", "--habit", "heartbeat"])).toThrow("run-id")
    expect(() => parseOuroCommand(["habit", "summary", "--habit", "heartbeat", "--which", "oldest"])).toThrow("which")
    expect(() => parseOuroCommand(["habit", "summary", "--run-id"])).toThrow("Usage")
    expect(() => parseOuroCommand(["habit", "summary", "--operation-id"])).toThrow("Usage")
    expect(() => parseOuroCommand(["habit", "summary", "--surprise", "x"])).toThrow("Usage")
  })

  it("includes habit summary usage in help text", () => {
    expect(() => parseOuroCommand(["habit", "unknown"])).toThrow("ouro habit summary")
    expect(getCommandHelp("habit")).toContain("summary")
  })

  it("prints focused habit summary help for nested help invocations", async () => {
    const deps = makeDeps()

    expect(parseOuroCommand(["habit", "summary", "--help"])).toEqual({ kind: "help", command: "habit summary" })
    const result = await runOuroCli(["habit", "summary", "--help"], deps)

    expect(result).toContain("ouro habit summary")
    expect(result).toContain("--run-id <id>")
    expect(result).toContain("--operation-id <id>")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("prints habit summary JSON from local bundle artifacts without daemon access", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-json-"))
    cleanup.push(tempBundle)
    writeSummaryArtifacts(tempBundle, makeHabitReceipt({ runId: "run-summary-json" }))
    const deps = makeDeps({ agentBundleRoot: tempBundle })

    const result = await runOuroCli(["habit", "summary", "--agent", "test", "--run-id", "run-summary-json", "--json"], deps)
    const parsed = JSON.parse(result)

    expect(parsed).toMatchObject({
      runId: "run-summary-json",
      habitName: "heartbeat",
      operationId: "habit:heartbeat",
      summary: "Asked Ari for the missing deployment decision.",
      decisions: ["wait for Ari", "session decision"],
      pending: { count: 1, files: ["reply.json"] },
      toolsUsed: ["send_message"],
      sources: {
        receipt: "arc/flight-recorder/habit-receipts/run-summary-json.json",
        session: "state/habit-sessions/run-summary-json/session.json",
      },
    })
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("resolves a sole discovered agent before reading local bundle artifacts", async () => {
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-bundles-"))
    cleanup.push(bundlesRoot)
    const discoveredBundle = path.join(bundlesRoot, "test.ouro")
    fs.mkdirSync(discoveredBundle, { recursive: true })
    writeSummaryArtifacts(discoveredBundle, makeHabitReceipt({ runId: "run-sole-agent" }))
    const deps = makeDeps({
      bundlesRoot,
      listDiscoveredAgents: vi.fn(async () => ["test"]),
    })

    const result = await runOuroCli(["habit", "summary", "--run-id", "run-sole-agent", "--json"], deps)
    const parsed = JSON.parse(result)

    expect(parsed).toMatchObject({
      runId: "run-sole-agent",
      habitName: "heartbeat",
    })
    expect(deps.listDiscoveredAgents).toHaveBeenCalled()
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("prints readable habit summary text by selector", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-text-"))
    cleanup.push(tempBundle)
    writeSummaryArtifacts(tempBundle, makeHabitReceipt({ runId: "run-summary-text" }))
    const deps = makeDeps({ agentBundleRoot: tempBundle })

    const result = await runOuroCli(["habit", "summary", "--agent", "test", "--habit", "heartbeat", "--which", "latest"], deps)

    expect(result).toContain("run-summary-text")
    expect(result).toContain("Asked Ari for the missing deployment decision.")
    expect(result).toContain("next=check the iMessage reply")
    expect(result).toContain("receipt=arc/flight-recorder/habit-receipts/run-summary-text.json")
    expect(result).toContain("pending=1")
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("sets exit code for missing habit summaries", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-missing-"))
    cleanup.push(tempBundle)
    const setExitCode = vi.fn()
    const deps = makeDeps({ agentBundleRoot: tempBundle, setExitCode })

    const result = await runOuroCli(["habit", "summary", "--agent", "test", "--operation-id", "habit:missing", "--json"], deps)

    expect(result).toBe("error: habit summary not found")
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(deps.sendCommand).not.toHaveBeenCalled()
  })

  it("renders sparse text summaries with errors and without optional fields", async () => {
    const tempBundle = fs.mkdtempSync(path.join(os.tmpdir(), "habit-summary-sparse-"))
    cleanup.push(tempBundle)
    const receipt = makeHabitReceipt({
      runId: "run-summary-sparse",
      operationId: null,
      outcome: "error",
      summarySnapshot: { summary: "Habit heartbeat finished with error.", decisions: [], nextLikelyStep: null },
      producedRefs: [],
      surfaceAttempts: [],
      errors: ["provider went away"],
    })
    writeHabitRunReceipt(tempBundle, receipt)
    fs.mkdirSync(path.join(tempBundle, "state", "habit-sessions", "run-summary-sparse"), { recursive: true })
    fs.writeFileSync(path.join(tempBundle, "state", "habit-sessions", "run-summary-sparse", "session.json"), JSON.stringify({
      version: 1,
      messages: [],
      summary: { decisions: [], nextLikelyStep: null },
    }, null, 2), "utf-8")
    const deps = makeDeps({ agentBundleRoot: tempBundle })

    const result = await runOuroCli(["habit", "summary", "--agent", "test", "--habit", "heartbeat", "--which", "latest-failure"], deps)

    expect(result).toContain("run-summary-sparse")
    expect(result).toContain("summary=Habit heartbeat finished with error.")
    expect(result).toContain("pending=0")
    expect(result).toContain("messages=0")
    expect(result).toContain("tools=none")
    expect(result).toContain("errors=provider went away")
    expect(result).toContain("warnings=session file had no usable messages")
    expect(result).not.toContain("operation=")
    expect(result).not.toContain("next=")
    expect(result).not.toContain("decisions=")
    expect(result).not.toContain("refs=")
  })
})
