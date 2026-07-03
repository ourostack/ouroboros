import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"
import { emitNervesEvent } from "../../../nerves/runtime"
import { parseOuroCommand, runOuroCli, type OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { OuroDaemon } from "../../../heart/daemon/daemon"

const require = createRequire(import.meta.url)
const cjsFs = require("node:fs") as typeof import("fs")

function emitTestEvent(testName: string): void {
  emitNervesEvent({
    component: "private-runtime",
    event: "private_runtime.decision_read_surface_test",
    message: `decision read surface test: ${testName}`,
    meta: { testName },
  })
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

function makeDaemon(bundlesRoot: string): OuroDaemon {
  const processManager = {
    listAgentSnapshots: vi.fn(() => []),
    startAutoStartAgents: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    startAgent: vi.fn(async () => undefined),
    resetAgentFailureState: vi.fn(),
    sendToAgent: vi.fn(),
  }
  const scheduler = {
    listJobs: vi.fn(() => []),
    triggerJob: vi.fn(async (jobId: string) => ({ ok: true, message: `triggered ${jobId}` })),
    reconcile: vi.fn(async () => undefined),
    recordTaskRun: vi.fn(async () => undefined),
  }
  const healthMonitor = {
    runChecks: vi.fn(async () => []),
    getLastResults: vi.fn(() => []),
    stopPeriodicChecks: vi.fn(),
  }
  const router = {
    send: vi.fn(),
    pollInbox: vi.fn(() => []),
  }
  const senseManager = {
    startAutoStartSenses: vi.fn(async () => undefined),
    stopAll: vi.fn(async () => undefined),
    listSenseRows: vi.fn(() => []),
    reviveSense: vi.fn(),
  }

  return new OuroDaemon({
    socketPath: path.join(os.tmpdir(), `private-decisions-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`),
    processManager,
    scheduler,
    healthMonitor,
    router,
    senseManager,
    bundlesRoot,
    mailboxServerFactory: vi.fn(async () => ({
      url: "http://127.0.0.1:6876",
      stop: async () => undefined,
    })),
  } as any)
}

function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    receiptId: "ptrr_allow",
    agent: "slugger",
    origin: "habit.poke",
    reason: "manual habit poke",
    providerLane: {
      lane: "inner",
      provider: "openai-codex",
      model: "gpt-5.5",
      source: "agent.json",
    },
    triggerSource: "manual",
    idempotencyKey: "ptk_habit",
    budgetClass: "interactive",
    originRefs: [{ kind: "habit", id: "heartbeat" }],
    requestFingerprint: "ptr_habit",
    result: "allow",
    executable: true,
    decidedAt: "2026-07-03T20:00:00.000Z",
    ledgerLocator: {
      path: "decisions.jsonl",
      line: 1,
    },
    ...overrides,
  }
}

function writeDecisionLedger(bundlesRoot: string, agent: string, rows: Array<Record<string, unknown>>): string {
  const ledgerPath = path.join(bundlesRoot, `${agent}.ouro`, "state", "private-runtime", "decisions.jsonl")
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
  fs.writeFileSync(ledgerPath, `${rows.map((row) => JSON.stringify({
    ...row,
    ledgerLocator: {
      path: ledgerPath,
      line: row.ledgerLocator && typeof row.ledgerLocator === "object"
        ? (row.ledgerLocator as Record<string, unknown>).line
        : undefined,
    },
  })).join("\n")}\n`, "utf-8")
  return ledgerPath
}

describe("private-runtime decision read surface", () => {
  it("parses canonical CLI decision reader arguments", () => {
    emitTestEvent("parse private decisions cli")

    expect(parseOuroCommand(["private", "decisions", "--agent", "slugger", "--limit", "2", "--json"])).toEqual({
      kind: "private.decisions",
      agent: "slugger",
      limit: 2,
      json: true,
    })
    expect(parseOuroCommand(["private", "decisions"])).toEqual({
      kind: "private.decisions",
      limit: 20,
      json: false,
    })
  })

  it("rejects malformed CLI private decision reader arguments", () => {
    emitTestEvent("parse private decisions cli errors")

    expect(() => parseOuroCommand(["private"])).toThrow(
      "Usage: ouro private decisions [--agent <name>] [--limit <n>] [--json]",
    )
    expect(() => parseOuroCommand(["private", "decisions", "--limit", "0"])).toThrow(
      "private decisions --limit must be an integer between 1 and 1000",
    )
    expect(() => parseOuroCommand(["private", "decisions", "--unknown"])).toThrow(
      "Usage: ouro private decisions [--agent <name>] [--limit <n>] [--json]",
    )
  })

  it("routes CLI private decision reads through the daemon command and renders bounded text", async () => {
    emitTestEvent("cli private decisions text")
    const rows = [
      decision({
        receiptId: "ptrr_deny",
        result: "deny",
        executable: false,
        reason: "private runtime policy denies by default",
        deniedReason: "default policy deny",
        idempotencyKey: "ptk_deny",
        decidedAt: "2026-07-03T20:01:00.000Z",
        turn: { prompt: "private transcript content must not render" },
      }),
      decision({
        receiptId: "ptrr_allow",
        origin: "await.expiry",
        triggerSource: "scheduled",
        idempotencyKey: "ptk_allow",
        budgetClass: "background",
      }),
    ]
    const sendCommand = vi.fn(async () => ({
      ok: true,
      summary: "2 private-runtime decisions",
      data: { agent: "slugger", decisions: rows },
    }))
    const deps = makeDeps({ sendCommand })

    const result = await runOuroCli(["private", "decisions", "--agent", "slugger", "--limit", "2"], deps)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "private.decisions",
      agent: "slugger",
      limit: 2,
    })
    expect(result).toContain("private decisions: slugger")
    expect(result).toContain("habit.poke")
    expect(result).toContain("await.expiry")
    expect(result).toContain("default policy deny")
    expect(result).toContain("ptk_deny")
    expect(result).toContain("inner")
    expect(result).toContain("ptrr_allow")
    expect(result).not.toContain("private transcript content")
    expect(deps.writeStdout).toHaveBeenCalledWith(result)
  })

  it("renders CLI private decision reads as JSON without transcript payloads", async () => {
    emitTestEvent("cli private decisions json")
    const sendCommand = vi.fn(async () => ({
      ok: true,
      summary: "1 private-runtime decision",
      data: {
        agent: "slugger",
        decisions: [
          decision({
            turn: { prompt: "private transcript content must not render" },
            privateTranscriptPath: "state/sessions/self/private/session.json",
          }),
        ],
      },
    }))
    const deps = makeDeps({ sendCommand })

    const result = await runOuroCli(["private", "decisions", "--agent", "slugger", "--json"], deps)
    const parsed = JSON.parse(result)

    expect(sendCommand).toHaveBeenCalledWith("/tmp/ouro-test.sock", {
      kind: "private.decisions",
      agent: "slugger",
      limit: 20,
    })
    expect(parsed).toMatchObject({
      agent: "slugger",
      decisions: [
        {
          receiptId: "ptrr_allow",
          origin: "habit.poke",
          result: "allow",
          idempotencyKey: "ptk_habit",
          providerLane: { lane: "inner" },
        },
      ],
    })
    expect(JSON.stringify(parsed)).not.toContain("private transcript content")
    expect(JSON.stringify(parsed)).not.toContain("privateTranscriptPath")
  })

  it("renders empty daemon decision payloads with explicit guidance", async () => {
    emitTestEvent("cli private decisions empty")
    const sendCommand = vi.fn(async () => ({
      ok: true,
      summary: "0 private-runtime decisions",
      data: {
        guidance: "No private-runtime decision ledger exists for slugger",
        ledgerPath: "/tmp/slugger.ouro/state/private-runtime/decisions.jsonl",
        decisions: "not-an-array",
      },
    }))
    const deps = makeDeps({ sendCommand })

    const result = await runOuroCli(["private", "decisions", "--agent", "slugger"], deps)

    expect(result).toContain("private decisions: slugger")
    expect(result).toContain("ledger: /tmp/slugger.ouro/state/private-runtime/decisions.jsonl")
    expect(result).toContain("guidance: No private-runtime decision ledger exists for slugger")
    expect(result).toContain("no private-runtime decisions found")
  })

  it("sanitizes daemon decision rows before JSON rendering", async () => {
    emitTestEvent("cli private decisions sanitize")
    const sendCommand = vi.fn(async () => ({
      ok: true,
      summary: "1 private-runtime decision",
      data: {
        agent: "slugger",
        decisions: [
          decision({
            providerLane: {
              lane: 42,
              provider: null,
              model: [],
              source: "vault",
              credentialRevision: "rev-1",
              secret: "provider secret must not render",
            },
            originRefs: [
              { kind: "habit", id: "heartbeat", turn: { prompt: "nested private transcript" } },
              { kind: "broken" },
              null,
              ["bad"],
            ],
            ledgerLocator: {
              path: 42,
              line: "two",
            },
            result: "banana",
            executable: "yes",
            turn: { prompt: "private transcript content must not render" },
            privateTranscriptPath: "state/sessions/self/private/session.json",
          }),
        ],
      },
    }))
    const deps = makeDeps({ sendCommand })

    const result = await runOuroCli(["private", "decisions", "--agent", "slugger", "--json"], deps)
    const parsed = JSON.parse(result)

    expect(parsed.decisions[0]).toMatchObject({
      providerLane: {
        lane: "inner",
        provider: "unknown",
        model: "unknown",
        source: "agent.json",
        credentialRevision: "rev-1",
      },
      originRefs: [{ kind: "habit", id: "heartbeat" }],
      ledgerLocator: { path: "" },
      result: "deny",
      executable: false,
    })
    expect(JSON.stringify(parsed)).not.toContain("provider secret must not render")
    expect(JSON.stringify(parsed)).not.toContain("nested private transcript")
    expect(JSON.stringify(parsed)).not.toContain("private transcript content")
    expect(JSON.stringify(parsed)).not.toContain("privateTranscriptPath")
  })

  it("renders sparse sanitized decision rows with safe text fallbacks", async () => {
    emitTestEvent("cli private decisions sparse text")
    const sendCommand = vi.fn(async () => ({
      ok: true,
      summary: "1 private-runtime decision",
      data: {
        agent: "slugger",
        decisions: [
          {
            schemaVersion: 1,
            receiptId: "ptrr_sparse",
            agent: "slugger",
            originRefs: ["broken", { kind: "habit" }, ["bad"]],
            providerLane: {},
            result: "deny",
            executable: false,
            ledgerLocator: {
              path: "/tmp/slugger.ouro/state/private-runtime/decisions.jsonl",
            },
          },
        ],
      },
    }))
    const deps = makeDeps({ sendCommand })

    const result = await runOuroCli(["private", "decisions", "--agent", "slugger"], deps)

    expect(result).toContain("- undated deny")
    expect(result).toContain("lane=inner")
    expect(result).toContain("receipt=ptrr_sparse")
    expect(result).toContain("reason=(no reason recorded)")
    expect(result).toContain("locator=/tmp/slugger.ouro/state/private-runtime/decisions.jsonl")
  })

  it("normalizes non-object daemon payloads and duplicate metadata", async () => {
    emitTestEvent("cli private decisions defensive payload")
    const emptySendCommand = vi.fn(async () => ({
      ok: true,
      summary: "0 private-runtime decisions",
      data: "not-an-object",
    }))
    const emptyDeps = makeDeps({ sendCommand: emptySendCommand })

    const emptyResult = await runOuroCli(["private", "decisions", "--agent", "slugger", "--json"], emptyDeps)

    expect(JSON.parse(emptyResult)).toEqual({
      agent: "slugger",
      decisions: [],
    })

    const duplicateSendCommand = vi.fn(async () => ({
      ok: true,
      summary: "2 private-runtime decisions",
      data: {
        agent: "slugger",
        ledgerPath: "/tmp/slugger.ouro/state/private-runtime/decisions.jsonl",
        decisions: [
          "not-a-decision-row",
          {
            schemaVersion: 1,
            receiptId: "ptrr_duplicate",
            agent: "slugger",
            origin: "habit.poke",
            providerLane: {
              lane: "inner",
              provider: "openai-codex",
              model: "gpt-5.5",
            },
            idempotencyKey: "ptk_duplicate",
            result: "deny",
            executable: false,
            ledgerLocator: {
              path: "/tmp/slugger.ouro/state/private-runtime/decisions.jsonl",
              line: 7,
            },
            duplicateOf: "ptrr_original",
            error: "duplicate collapse note",
          },
        ],
      },
    }))
    const duplicateDeps = makeDeps({ sendCommand: duplicateSendCommand })

    const duplicateResult = await runOuroCli(["private", "decisions", "--agent", "slugger", "--json"], duplicateDeps)
    const duplicatePayload = JSON.parse(duplicateResult)

    expect(duplicatePayload.decisions[0]).toMatchObject({
      receiptId: "ptrr_duplicate",
      duplicateOf: "ptrr_original",
      error: "duplicate collapse note",
      ledgerLocator: {
        line: 7,
      },
    })
    expect(duplicatePayload.decisions[1]).toMatchObject({
      receiptId: "",
      agent: "",
      ledgerLocator: {
        path: "/tmp/slugger.ouro/state/private-runtime/decisions.jsonl",
      },
    })
  })

  it("daemon private.decisions reads recent ledger rows without provider secrets or transcript files", async () => {
    emitTestEvent("daemon private decisions")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "private-decisions-bundles-"))
    const ledgerPath = writeDecisionLedger(bundlesRoot, "slugger", [
      decision({
        receiptId: "ptrr_old",
        idempotencyKey: "ptk_old",
        decidedAt: "2026-07-03T19:59:00.000Z",
        ledgerLocator: { line: 1 },
      }),
      decision({
        receiptId: "ptrr_new",
        origin: "mail.discovery",
        result: "deny",
        executable: false,
        deniedReason: "default policy deny",
        idempotencyKey: "ptk_new",
        decidedAt: "2026-07-03T20:02:00.000Z",
        ledgerLocator: { line: 2 },
        turn: { prompt: "private transcript content must not leave daemon" },
        privateTranscriptPath: "state/sessions/self/private/session.json",
      }),
    ])
    const transcriptPath = path.join(bundlesRoot, "slugger.ouro", "state", "sessions", "self", "private", "session.json")
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    fs.writeFileSync(transcriptPath, "private transcript content must not be read", "utf-8")
    const realReadFileSync = cjsFs.readFileSync.bind(cjsFs)
    const readFileSync = vi.spyOn(cjsFs, "readFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, options?: unknown) => {
      if (typeof file === "string" && path.resolve(file) === transcriptPath) {
        throw new Error("private transcript file must not be read")
      }
      return realReadFileSync(file, options as never)
    }) as typeof cjsFs.readFileSync)
    const daemon = makeDaemon(bundlesRoot)

    const response = await daemon.handleCommand({ kind: "private.decisions", agent: "slugger", limit: 1 } as any)

    expect(response).toMatchObject({
      ok: true,
      summary: "1 private-runtime decision",
      data: {
        agent: "slugger",
        ledgerPath,
        decisions: [
          {
            receiptId: "ptrr_new",
            origin: "mail.discovery",
            result: "deny",
            idempotencyKey: "ptk_new",
            deniedReason: "default policy deny",
            ledgerLocator: { path: ledgerPath, line: 2 },
          },
        ],
      },
    })
    expect(JSON.stringify(response.data)).not.toContain("private transcript content")
    expect(JSON.stringify(response.data)).not.toContain("privateTranscriptPath")
    expect(readFileSync).not.toHaveBeenCalledWith(transcriptPath, expect.anything())
    readFileSync.mockRestore()
  })

  it("daemon private.decisions reports missing ledgers with repair guidance", async () => {
    emitTestEvent("daemon private decisions missing ledger")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "private-decisions-missing-"))
    const ledgerPath = path.join(bundlesRoot, "slugger.ouro", "state", "private-runtime", "decisions.jsonl")
    const daemon = makeDaemon(bundlesRoot)

    const response = await daemon.handleCommand({ kind: "private.decisions", agent: "slugger" } as any)

    expect(response).toMatchObject({
      ok: true,
      summary: "0 private-runtime decisions",
      message: `No private-runtime decision ledger exists for slugger; run an explicit private-runtime trigger or check ${path.dirname(ledgerPath)}.`,
      data: {
        agent: "slugger",
        ledgerPath,
        guidance: `No private-runtime decision ledger exists for slugger; run an explicit private-runtime trigger or check ${path.dirname(ledgerPath)}.`,
        decisions: [],
      },
    })
  })

  it("daemon private.decisions caps direct daemon callers at 1000 recent rows", async () => {
    emitTestEvent("daemon private decisions limit cap")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "private-decisions-cap-"))
    const rows = Array.from({ length: 1001 }, (_value, index) => decision({
      receiptId: `ptrr_${String(index).padStart(4, "0")}`,
      idempotencyKey: `ptk_${String(index).padStart(4, "0")}`,
      decidedAt: new Date(Date.UTC(2026, 6, 3, 20, 0, index)).toISOString(),
      ledgerLocator: { line: index + 1 },
    }))
    writeDecisionLedger(bundlesRoot, "slugger", rows)
    const daemon = makeDaemon(bundlesRoot)

    const response = await daemon.handleCommand({ kind: "private.decisions", agent: "slugger", limit: 2000 } as any)

    expect(response.ok).toBe(true)
    expect(response.summary).toBe("1000 private-runtime decisions")
    expect((response.data as { decisions: Array<{ receiptId: string }> }).decisions).toHaveLength(1000)
    expect((response.data as { decisions: Array<{ receiptId: string }> }).decisions[0]?.receiptId).toBe("ptrr_1000")
    expect(JSON.stringify(response.data)).not.toContain("ptrr_0000")
  })

  it("daemon private.decisions fails explicitly on malformed ledger rows", async () => {
    emitTestEvent("daemon private decisions malformed ledger")
    const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "private-decisions-malformed-"))
    const ledgerPath = path.join(bundlesRoot, "slugger.ouro", "state", "private-runtime", "decisions.jsonl")
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.writeFileSync(ledgerPath, "sk_live_private_transcript_content providerSecret\n", "utf-8")
    const daemon = makeDaemon(bundlesRoot)

    const response = await daemon.handleCommand({ kind: "private.decisions", agent: "slugger" } as any)

    expect(response.ok).toBe(false)
    expect(response.error).toContain("private-runtime decision ledger is malformed")
    expect(response.error).toContain(ledgerPath)
    expect(response.error).not.toContain("sk_live")
    expect(response.error).not.toContain("private_transcript_content")
    expect(response.error).not.toContain("providerSecret")
  })
})
