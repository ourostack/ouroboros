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
  })
})
