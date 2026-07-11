import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

import { createRunLedgerRecord, usageMetadataFromUsageData } from "../../heart/run-ledger"
import {
  ensureRsvpSpendLedger,
  readRsvpSpendLedger,
  recordRsvpSpendLedgerRun,
} from "../../rsvp/spend-ledger"

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-spend-ledger-"))
}

function runRecord(lifecycle: "started" | "completed" = "started") {
  return createRunLedgerRecord({
    agent: "slugger",
    triggerType: "habit",
    sourceKind: "private-runtime",
    senseOrHabit: "rsvp-ari-rachel",
    lifecycle,
    startedAt: "2026-07-09T17:00:00.000Z",
    ...(lifecycle === "completed" ? {
      endedAt: "2026-07-09T17:00:10.000Z",
      usage: usageMetadataFromUsageData({
        input_tokens: 10,
        output_tokens: 5,
        reasoning_tokens: 2,
        total_tokens: 17,
      }, "provider"),
    } : {}),
    target: {
      habitName: "rsvp-ari-rachel",
      runId: "habit-run-rsvp",
      trigger: "scheduled",
      operationId: "op_rsvp",
    },
    idempotencyScope: {
      habitName: "rsvp-ari-rachel",
      runId: "habit-run-rsvp",
      trigger: "scheduled",
      operationId: "op_rsvp",
    },
  })
}

function spendLedgerPath(agentRoot: string): string {
  return path.join(agentRoot, "state", "rsvp", "spend-ledger.json")
}

describe("RSVP spend ledger", () => {
  it("initializes a content-free cold-start ledger", () => {
    const agentRoot = tempRoot()

    const ledger = ensureRsvpSpendLedger(agentRoot, "2026-07-09T20:00:00.000Z")

    expect(ledger).toMatchObject({
      policyVersion: "rsvp-spend-ledger/v1",
      createdAt: "2026-07-09T20:00:00.000Z",
      updatedAt: "2026-07-09T20:00:00.000Z",
      runs: [],
    })
    expect(readRsvpSpendLedger(agentRoot)).toEqual(ledger)
  })

  it("does not overwrite an existing spend ledger during cold-start initialization", () => {
    const agentRoot = tempRoot()
    const first = ensureRsvpSpendLedger(agentRoot, "2026-07-09T20:00:00.000Z")

    const second = ensureRsvpSpendLedger(agentRoot, "2026-07-10T20:00:00.000Z")

    expect(second).toEqual(first)
  })

  it("records RSVP habit run lifecycle rows without storing message content", () => {
    const agentRoot = tempRoot()
    const started = runRecord("started")
    const completed = runRecord("completed")

    recordRsvpSpendLedgerRun(agentRoot, started)
    const ledger = recordRsvpSpendLedgerRun(agentRoot, completed)

    expect(ledger.runs).toHaveLength(2)
    expect(ledger.runs[0]).toMatchObject({
      runId: started.runId,
      habitName: "rsvp-ari-rachel",
      lifecycle: "started",
      contentStored: false,
    })
    expect(ledger.runs[1]).toMatchObject({
      runId: completed.runId,
      habitName: "rsvp-ari-rachel",
      lifecycle: "completed",
      endedAt: "2026-07-09T17:00:10.000Z",
      usage: {
        source: "provider",
        inputTokens: 10,
        outputTokens: 5,
        reasoningTokens: 2,
        totalTokens: 17,
      },
      contentStored: false,
    })
    expect(JSON.stringify(ledger)).not.toContain("RSVP Update")
    expect(JSON.stringify(ledger)).not.toContain("AislePlanner")
  })

  it("upserts duplicate lifecycle rows for the same run id", () => {
    const agentRoot = tempRoot()
    const first = runRecord("started")
    const duplicate = { ...first, recordedAt: "2026-07-09T17:00:05.000Z" }

    recordRsvpSpendLedgerRun(agentRoot, first)
    const ledger = recordRsvpSpendLedgerRun(agentRoot, duplicate)

    expect(ledger.runs).toHaveLength(1)
    expect(ledger.runs[0]?.recordedAt).toBe("2026-07-09T17:00:05.000Z")
  })

  it("preserves loose legacy run rows while appending v1 rows", () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.dirname(spendLedgerPath(agentRoot)), { recursive: true })
    fs.writeFileSync(spendLedgerPath(agentRoot), `${JSON.stringify({
      createdAt: "2026-07-08T10:00:00.000Z",
      updatedAt: "2026-07-08T10:00:00.000Z",
      runs: [
        {
          runId: "legacy-run",
          lifecycle: "completed",
          totalTokens: 42,
          contentStored: false,
        },
      ],
    }, null, 2)}\n`, "utf-8")

    const ledger = recordRsvpSpendLedgerRun(agentRoot, runRecord("started"))

    expect(ledger.runs).toHaveLength(2)
    expect(ledger.runs[0]).toMatchObject({
      runId: "legacy-run",
      lifecycle: "completed",
      totalTokens: 42,
      contentStored: false,
    })
    expect(ledger.runs[1]).toMatchObject({
      habitName: "rsvp-ari-rachel",
      lifecycle: "started",
      contentStored: false,
    })
  })

  it("migrates loose legacy ledgers without timestamps and drops non-object runs", () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.dirname(spendLedgerPath(agentRoot)), { recursive: true })
    fs.writeFileSync(spendLedgerPath(agentRoot), `${JSON.stringify({
      runs: [
        null,
        "bad",
        {
          runId: "legacy-run",
          lifecycle: "completed",
          contentStored: false,
        },
      ],
    }, null, 2)}\n`, "utf-8")

    const ledger = readRsvpSpendLedger(agentRoot)

    expect(ledger.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(ledger.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(ledger.runs).toEqual([
      expect.objectContaining({
        runId: "legacy-run",
        lifecycle: "completed",
        contentStored: false,
      }),
    ])
  })

  it("treats shape-invalid spend ledgers as empty", () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.dirname(spendLedgerPath(agentRoot)), { recursive: true })
    fs.writeFileSync(spendLedgerPath(agentRoot), "[]", "utf-8")

    expect(readRsvpSpendLedger(agentRoot).runs).toEqual([])

    fs.writeFileSync(spendLedgerPath(agentRoot), JSON.stringify({ createdAt: "2026-07-09T20:00:00.000Z" }), "utf-8")
    expect(readRsvpSpendLedger(agentRoot).runs).toEqual([])
  })

  it("treats malformed spend ledgers as empty instead of throwing", () => {
    const agentRoot = tempRoot()
    fs.mkdirSync(path.dirname(spendLedgerPath(agentRoot)), { recursive: true })
    fs.writeFileSync(spendLedgerPath(agentRoot), "{not-json", "utf-8")

    expect(readRsvpSpendLedger(agentRoot)).toMatchObject({
      policyVersion: "rsvp-spend-ledger/v1",
      runs: [],
    })
  })
})
