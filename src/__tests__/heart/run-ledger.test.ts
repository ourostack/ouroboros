import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())

vi.mock("../../nerves/runtime", () => ({
  emitNervesEvent: (...args: any[]) => mockEmitNervesEvent(...args),
}))

import {
  appendRunLedgerRecord,
  appendRunLedgerRecordNonFatal,
  createRunLedgerRecord,
  deriveRunLedgerIds,
  readRunLedger,
  runLedgerPath,
  usageMetadataFromUsageData,
} from "../../heart/run-ledger"

function tempAgentRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ouro-run-ledger-"))
}

describe("run ledger", () => {
  beforeEach(() => {
    mockEmitNervesEvent.mockReset()
  })

  it("derives deterministic ids and content-free records from causal inputs", () => {
    const idsA = deriveRunLedgerIds({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      target: {
        chatGuid: "iMessage;-;+15551234567",
        anchorMessageGuid: "bb-guid-1",
        userText: "who is pending?",
      },
      idempotencyScope: {
        transport: "bluebubbles",
        messageGuid: "bb-guid-1",
        transcriptExcerpt: "who is pending?",
      },
    })
    const idsB = deriveRunLedgerIds({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      target: {
        chatGuid: "iMessage;-;+15551234567",
        anchorMessageGuid: "bb-guid-1",
        userText: "who is pending?",
      },
      idempotencyScope: {
        transport: "bluebubbles",
        messageGuid: "bb-guid-1",
        transcriptExcerpt: "who is pending?",
      },
    })

    expect(idsA).toEqual(idsB)
    expect(idsA.runId).toMatch(/^run_[a-f0-9]{24}$/)
    expect(idsA.rootRunId).toBe(idsA.runId)
    expect(idsA.parentRunId).toBeUndefined()
    expect(idsA.idempotencyKey).toMatch(/^idem_[a-f0-9]{32}$/)
    expect(idsA.targetHash).toMatch(/^sha256:[a-f0-9]{64}$/)

    const record = createRunLedgerRecord({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "completed",
      startedAt: "2026-07-09T19:23:00.000Z",
      endedAt: "2026-07-09T19:23:02.000Z",
      target: {
        chatGuid: "iMessage;-;+15551234567",
        anchorMessageGuid: "bb-guid-1",
        userText: "who is pending?",
      },
      idempotencyScope: {
        transport: "bluebubbles",
        messageGuid: "bb-guid-1",
        transcriptExcerpt: "who is pending?",
      },
      usage: usageMetadataFromUsageData({
        input_tokens: 44,
        output_tokens: 9,
        reasoning_tokens: 3,
        total_tokens: 56,
      }, "provider"),
      provider: "minimax",
      model: "MiniMax-M2.7",
      sessionRef: { channel: "imessage", keyHash: "sha256:chat" },
      contextPacketIds: ["scp_same_thread"],
    })

    const serialized = JSON.stringify(record)
    expect(record).toMatchObject({
      schemaVersion: 1,
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "completed",
      contentStored: false,
      usage: {
        source: "provider",
        inputTokens: 44,
        outputTokens: 9,
        reasoningTokens: 3,
        totalTokens: 56,
      },
      provider: "minimax",
      model: "MiniMax-M2.7",
      contextPacketIds: ["scp_same_thread"],
      sessionRef: { channel: "imessage", keyHash: "sha256:chat" },
    })
    expect(serialized).not.toContain("who is pending")
    expect(serialized).not.toContain("+15551234567")
    expect(serialized).not.toContain("transcriptExcerpt")
  })

  it("appends, reads, and skips malformed rows without losing valid spend records", () => {
    const agentRoot = tempAgentRoot()
    const first = createRunLedgerRecord({
      agent: "slugger",
      triggerType: "habit",
      sourceKind: "private-runtime",
      senseOrHabit: "rsvp",
      lifecycle: "started",
      startedAt: "2026-07-09T17:00:00.000Z",
      target: { habitName: "rsvp", civilDate: "2026-07-09", prompt: "never store this" },
      idempotencyScope: { habitName: "rsvp", civilDate: "2026-07-09" },
    })
    const second = createRunLedgerRecord({
      agent: "slugger",
      triggerType: "habit",
      sourceKind: "private-runtime",
      senseOrHabit: "rsvp",
      lifecycle: "completed",
      startedAt: "2026-07-09T17:00:00.000Z",
      endedAt: "2026-07-09T17:00:05.000Z",
      target: { habitName: "rsvp", civilDate: "2026-07-09", prompt: "never store this" },
      idempotencyScope: { habitName: "rsvp", civilDate: "2026-07-09" },
      usage: usageMetadataFromUsageData(undefined, "none"),
    })

    appendRunLedgerRecord(agentRoot, first)
    fs.appendFileSync(runLedgerPath(agentRoot), "not-json\n{\"schemaVersion\":99}\n", "utf-8")
    appendRunLedgerRecord(agentRoot, second)

    const rows = readRunLedger(agentRoot)
    expect(rows).toEqual([first, second])
    expect(fs.readFileSync(runLedgerPath(agentRoot), "utf-8")).not.toContain("never store this")
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.run_ledger_malformed",
      level: "warn",
      meta: expect.objectContaining({ lineNumber: 2 }),
    }))
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.run_ledger_malformed",
      level: "warn",
      meta: expect.objectContaining({ lineNumber: 3, reason: "invalid shape" }),
    }))
  })

  it("normalizes missing and partial usage metadata without inventing provider spend", () => {
    expect(usageMetadataFromUsageData(undefined, "none")).toEqual({
      source: "none",
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    })
    expect(usageMetadataFromUsageData({
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    }, "provider")).toEqual({
      source: "provider",
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 12,
    })
  })

  it("reports append failures without exposing content inputs", () => {
    const record = createRunLedgerRecord({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "started",
      startedAt: "2026-07-09T19:23:00.000Z",
      target: { secret: "do not print me" },
    })

    expect(appendRunLedgerRecordNonFatal("\0bad-root", record)).toBe(false)
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "heart.run_ledger_record_error",
      level: "error",
      meta: expect.objectContaining({
        agent: "slugger",
        runId: record.runId,
      }),
    }))
    expect(JSON.stringify(mockEmitNervesEvent.mock.calls)).not.toContain("do not print me")
  })

  it("handles missing ledgers", () => {
    expect(readRunLedger(tempAgentRoot())).toEqual([])
  })

  it("rejects malformed record permutations while preserving canonical array hashing", () => {
    const agentRoot = tempAgentRoot()
    const valid = createRunLedgerRecord({
      agent: "slugger",
      triggerType: "inbound",
      sourceKind: "sense",
      senseOrHabit: "bluebubbles",
      lifecycle: "error",
      startedAt: "2026-07-09T19:23:00.000Z",
      endedAt: "2026-07-09T19:23:03.000Z",
      target: ["array-target", { nested: ["value"], secret: "raw array text" }],
      idempotencyScope: ["array-target", { nested: ["value"] }],
      parentRunId: "run_parent",
      rootRunId: "run_root",
      usage: usageMetadataFromUsageData({
        input_tokens: 1,
        output_tokens: 2,
        reasoning_tokens: 3,
        total_tokens: 6,
      }, "reported-unavailable"),
      sessionRef: { channel: "bluebubbles", keyHash: "sha256:chat" },
      contextPacketIds: ["scp_one", "", "scp_one", "scp_two"],
      errorName: "ProviderError",
      errorCode: "rate-limit",
    })
    expect(valid.contextPacketIds).toEqual(["scp_one", "scp_two"])
    expect(JSON.stringify(valid)).not.toContain("raw array text")

    const invalidRows: Array<Record<string, unknown>> = [
      { ...valid, schemaVersion: 2 },
      { ...valid, recordedAt: 0 },
      { ...valid, runId: 0 },
      { ...valid, rootRunId: 0 },
      { ...valid, parentRunId: 0 },
      { ...valid, idempotencyKey: 0 },
      { ...valid, agent: 0 },
      { ...valid, triggerType: "bogus" },
      { ...valid, sourceKind: "bogus" },
      { ...valid, senseOrHabit: 0 },
      { ...valid, targetHash: 0 },
      { ...valid, lifecycle: "bogus" },
      { ...valid, startedAt: 0 },
      { ...valid, endedAt: 0 },
      { ...valid, usage: { ...valid.usage, source: "bogus" } },
      { ...valid, usage: { ...valid.usage, inputTokens: "1" } },
      { ...valid, usage: { ...valid.usage, outputTokens: "2" } },
      { ...valid, usage: { ...valid.usage, reasoningTokens: "3" } },
      { ...valid, usage: { ...valid.usage, totalTokens: "6" } },
      { ...valid, provider: 0 },
      { ...valid, model: 0 },
      { ...valid, sessionRef: { channel: 0, keyHash: "sha256:chat" } },
      { ...valid, sessionRef: { channel: "bluebubbles", keyHash: 0 } },
      { ...valid, contextPacketIds: ["scp", 1] },
      { ...valid, contentStored: true },
      { ...valid, errorName: 0 },
      { ...valid, errorCode: 0 },
    ]

    fs.mkdirSync(path.dirname(runLedgerPath(agentRoot)), { recursive: true })
    fs.writeFileSync(runLedgerPath(agentRoot), `${invalidRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf-8")

    expect(readRunLedger(agentRoot)).toEqual([])
    expect(mockEmitNervesEvent).toHaveBeenCalledTimes(invalidRows.length)
  })
})
