import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  recordFlightRecorderEvent,
  writeFlightRecorderResume,
  type FlightRecorderResume,
} from "../../arc/flight-recorder"
import {
  contextLossSentinelPaths,
  deriveContextLossSentinelProviderSignals,
  formatContextLossSentinelText,
  readContextLossSentinelView,
  refreshContextLossSentinel,
  type ContextLossSentinelSignal,
} from "../../heart/context-loss-sentinel"
import type { DaemonHealthResult } from "../../heart/daemon/daemon"
import type {
  AgentProviderVisibility,
  ProviderVisibilityLane,
} from "../../heart/provider-visibility"

const tempDirs: string[] = []

function makeAgentRoot(prefix = "context-loss-sentinel-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  fs.writeFileSync(
    path.join(dir, "agent.json"),
    `${JSON.stringify({
      version: 2,
      enabled: true,
      humanFacing: { provider: "minimax", model: "minimax-text-01" },
      agentFacing: { provider: "anthropic", model: "claude-opus-4" },
      phrases: {
        thinking: ["working"],
        tool: ["running tool"],
        followup: ["processing"],
      },
    }, null, 2)}\n`,
    "utf-8",
  )
  scaffoldDeskRecord(dir)
  writeReadyResume(dir)
  return dir
}

function scaffoldDeskRecord(agentRoot: string): void {
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "diary", "daily"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "notes"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "facts.jsonl"), "", "utf-8")
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "entities.json"), "{}\n", "utf-8")
}

function readyResume(overrides: Partial<FlightRecorderResume> = {}): FlightRecorderResume {
  return {
    schemaVersion: 1,
    hasCompleteState: true,
    canContinue: true,
    missing: [],
    gaps: [],
    currentAsk: {
      value: "keep the Arc updated even if the transcript disappears",
      confidence: "current",
      sourceEventIds: ["fr-ready"],
    },
    nextSafeAction: {
      value: "refresh Sentinel and continue from the latest-ready anchor",
      stopBefore: ["merge"],
      sourceEventIds: ["fr-ready"],
    },
    blockedBecause: [],
    activeObligationIds: [],
    activeReturnObligationIds: [],
    activePacketIds: [],
    openEvolutionCaseIds: [],
    recentClaimIds: [],
    unverifiedClaimIds: [],
    lastSafeCheckpoint: {
      turnId: "turn-ready",
      sessionRef: "codex/session",
      recordedAt: "2026-06-08T20:00:00.000Z",
      sourceEventIds: ["fr-ready"],
    },
    recorderHealth: { status: "ok", issues: [] },
    ...overrides,
  }
}

function writeReadyResume(agentRoot: string, overrides: Partial<FlightRecorderResume> = {}): void {
  writeFlightRecorderResume(agentRoot, readyResume(overrides))
}

function configuredLane(
  lane: "outward" | "inner",
  overrides: Partial<Extract<ProviderVisibilityLane, { status: "configured" }>> = {},
): ProviderVisibilityLane {
  return {
    lane,
    status: "configured",
    provider: lane === "outward" ? "minimax" : "anthropic",
    model: lane === "outward" ? "minimax-text-01" : "claude-opus-4",
    source: "agent.json",
    readiness: { status: "ready", checkedAt: "2026-06-08T20:00:00.000Z" },
    credential: {
      status: "present",
      source: `vault:slugger:providers/${lane}`,
      revision: `rev-${lane}`,
    },
    warnings: [],
    ...overrides,
  }
}

function unconfiguredLane(lane: "outward" | "inner"): ProviderVisibilityLane {
  return {
    lane,
    status: "unconfigured",
    provider: "unconfigured",
    model: "-",
    source: "missing",
    readiness: { status: "unknown", reason: `${lane} lane is not configured` },
    credential: {
      status: "missing",
      repairCommand: `ouro use --agent slugger --lane ${lane} --provider <provider> --model <model>`,
    },
    repairCommand: `ouro use --agent slugger --lane ${lane} --provider <provider> --model <model>`,
    reason: `${lane} lane is not configured`,
    warnings: [],
  }
}

function providerVisibility(lanes: ProviderVisibilityLane[] = [
  configuredLane("outward"),
  configuredLane("inner"),
]): AgentProviderVisibility {
  return { agentName: "slugger", lanes }
}

function okHealth(): DaemonHealthResult[] {
  return [
    { name: "agent-processes", status: "ok", message: "all managed agents running" },
    { name: "cron-health", status: "ok", message: "cron jobs are healthy" },
    { name: "disk-space", status: "ok", message: "disk usage healthy (10%)" },
  ]
}

function signal(receiptSignals: ContextLossSentinelSignal[], id: string): ContextLossSentinelSignal {
  const found = receiptSignals.find((entry) => entry.id === id)
  expect(found, `expected Sentinel signal ${id}`).toBeTruthy()
  return found!
}

afterEach(() => {
  vi.useRealTimers()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("context-loss Sentinel core", () => {
  it("persists latest, history, receipt files, and latest-ready for a ready deterministic refresh", async () => {
    const agentRoot = makeAgentRoot()
    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:10:00.000Z"),
      createReceiptId: () => "sentinel-ready",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(receipt).toMatchObject({
      schemaVersion: 1,
      id: "sentinel-ready",
      agent: "slugger",
      trigger: "post_turn",
      generatedAt: "2026-06-08T20:10:00.000Z",
      verdict: "ready",
      recoveryAnchor: {
        kind: "flight-recorder",
        currentAsk: "keep the Arc updated even if the transcript disappears",
        nextSafeAction: "refresh Sentinel and continue from the latest-ready anchor",
        flightRecorderLatestLocator: "arc/flight-recorder/latest.json",
      },
      gauntlet: {
        verdict: "ready",
        scorePercentage: 100,
        failedChecks: [],
        warnedChecks: [],
      },
      receiptLocator: "arc/flight-recorder/context-loss-sentinel/receipts/sentinel-ready.json",
      latestReadyLocator: "arc/flight-recorder/context-loss-sentinel/latest-ready.json",
    })
    expect(receipt.sourceLocators).toEqual(expect.arrayContaining([
      "arc/flight-recorder/latest.json",
      "arc/flight-recorder/context-loss-sentinel/latest.json",
      "arc/flight-recorder/context-loss-sentinel/latest-ready.json",
      "arc/flight-recorder/context-loss-sentinel/history/2026-06-08.jsonl",
      "arc/flight-recorder/context-loss-sentinel/receipts/sentinel-ready.json",
    ]))
    expect(receipt.signals.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "gauntlet:context-loss",
      "provider:outward",
      "provider:inner",
      "bundle:git",
    ]))

    const paths = contextLossSentinelPaths(agentRoot)
    expect(JSON.parse(fs.readFileSync(paths.latest, "utf-8")).id).toBe("sentinel-ready")
    expect(JSON.parse(fs.readFileSync(paths.latestReady, "utf-8")).id).toBe("sentinel-ready")
    expect(JSON.parse(fs.readFileSync(path.join(paths.receiptsDir, "sentinel-ready.json"), "utf-8")).id).toBe("sentinel-ready")
    expect(fs.readFileSync(path.join(paths.historyDir, "2026-06-08.jsonl"), "utf-8")).toContain("sentinel-ready")

    const view = readContextLossSentinelView(agentRoot, { limit: 5 })
    expect(view.latest?.id).toBe("sentinel-ready")
    expect(view.latestReady?.id).toBe("sentinel-ready")
    expect(view.history.map((entry) => entry.id)).toEqual(["sentinel-ready"])
    expect(view.degraded.issues).toEqual([])

    const rendered = formatContextLossSentinelText(view)
    expect(rendered).toContain("Recovery Sentinel - slugger")
    expect(rendered).toContain("verdict: ready")
    expect(rendered).toContain("latest-ready: arc/flight-recorder/context-loss-sentinel/latest-ready.json")
    expect(rendered).toContain("provider:outward")
  })

  it("preserves latest-ready when a later blocked receipt becomes latest", async () => {
    const agentRoot = makeAgentRoot()
    await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:10:00.000Z"),
      createReceiptId: () => "sentinel-ready",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    const blocked = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "provider_failover",
      now: () => new Date("2026-06-08T20:11:00.000Z"),
      createReceiptId: () => "sentinel-blocked",
      providerVisibility: providerVisibility([
        configuredLane("outward", {
          readiness: { status: "failed", checkedAt: "2026-06-08T20:11:00.000Z", error: "MiniMax 503" },
        }),
        configuredLane("inner"),
      ]),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(blocked.verdict).toBe("blocked")
    expect(blocked.latestReadyLocator).toBe("arc/flight-recorder/context-loss-sentinel/latest-ready.json")
    expect(signal(blocked.signals, "provider:outward")).toMatchObject({
      kind: "provider_lane",
      status: "fail",
      severity: "critical",
      verdictImpact: "blocked",
      repair: {
        actor: "agent-runnable",
        kind: "provider-live-check",
        command: "ouro provider check --agent slugger --lane outward",
      },
    })

    const view = readContextLossSentinelView(agentRoot, { limit: 10 })
    expect(view.latest?.id).toBe("sentinel-blocked")
    expect(view.latestReady?.id).toBe("sentinel-ready")
    expect(view.history.map((entry) => entry.id)).toEqual(["sentinel-ready", "sentinel-blocked"])
  })

  it("classifies provider lanes with repair actors, sources, severity, and verdict impact", () => {
    const cases: Array<{
      label: string
      lane: ProviderVisibilityLane
      expected: Partial<ContextLossSentinelSignal>
      expectedRepair?: Partial<NonNullable<ContextLossSentinelSignal["repair"]>>
      expectedSummary: string
    }> = [
      {
        label: "outward configured and ready",
        lane: configuredLane("outward"),
        expected: { id: "provider:outward", status: "pass", severity: "info", verdictImpact: "none" },
        expectedSummary: "outward provider ready",
      },
      {
        label: "inner unconfigured",
        lane: unconfiguredLane("inner"),
        expected: { id: "provider:inner", status: "fail", severity: "critical", verdictImpact: "blocked" },
        expectedRepair: {
          actor: "human-choice",
          kind: "provider-selection",
          command: "ouro use --agent slugger --lane inner --provider <provider> --model <model>",
        },
        expectedSummary: "inner provider unconfigured",
      },
      {
        label: "outward missing credentials",
        lane: configuredLane("outward", {
          credential: {
            status: "missing",
            repairCommand: "ouro auth --agent slugger --provider minimax",
          },
        }),
        expected: { id: "provider:outward", status: "fail", severity: "critical", verdictImpact: "blocked" },
        expectedRepair: {
          actor: "human-required",
          kind: "provider-credential",
          command: "ouro auth --agent slugger --provider minimax",
        },
        expectedSummary: "outward credentials missing",
      },
      {
        label: "inner vault unavailable",
        lane: configuredLane("inner", {
          credential: {
            status: "invalid-pool",
            repairCommand: "ouro vault unlock --agent slugger",
          },
        }),
        expected: { id: "provider:inner", status: "fail", severity: "critical", verdictImpact: "blocked" },
        expectedRepair: {
          actor: "human-required",
          kind: "vault-unavailable",
          command: "ouro vault unlock --agent slugger",
        },
        expectedSummary: "inner credential vault unavailable",
      },
      {
        label: "outward credential cache not loaded",
        lane: configuredLane("outward", {
          credential: {
            status: "not-loaded",
            repairCommand: "ouro provider refresh --agent slugger",
          },
        }),
        expected: { id: "provider:outward", status: "warn", severity: "warn", verdictImpact: "watch" },
        expectedRepair: {
          actor: "agent-runnable",
          kind: "provider-credential-cache",
          command: "ouro provider refresh --agent slugger",
        },
        expectedSummary: "outward credentials not loaded",
      },
      {
        label: "inner unknown readiness",
        lane: configuredLane("inner", {
          readiness: { status: "unknown", reason: "no live check has run after daemon start" },
        }),
        expected: { id: "provider:inner", status: "warn", severity: "warn", verdictImpact: "watch" },
        expectedRepair: {
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: "ouro provider check --agent slugger --lane inner",
        },
        expectedSummary: "inner readiness unknown",
      },
      {
        label: "outward failed live check",
        lane: configuredLane("outward", {
          readiness: {
            status: "failed",
            checkedAt: "2026-06-08T20:12:00.000Z",
            error: "provider returned 503",
            attempts: 2,
          },
        }),
        expected: { id: "provider:outward", status: "fail", severity: "critical", verdictImpact: "blocked" },
        expectedRepair: {
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: "ouro provider check --agent slugger --lane outward",
        },
        expectedSummary: "outward live check failed",
      },
      {
        label: "inner stale readiness with persisted source",
        lane: configuredLane("inner", {
          readiness: {
            status: "stale",
            checkedAt: "2026-06-08T17:00:00.000Z",
            reason: "persisted readiness older than policy",
          },
        }),
        expected: { id: "provider:inner", status: "warn", severity: "warn", verdictImpact: "watch" },
        expectedRepair: {
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: "ouro provider check --agent slugger --lane inner",
        },
        expectedSummary: "inner readiness stale",
      },
      {
        label: "outward stale readiness without evidence degrades to unknown",
        lane: configuredLane("outward", {
          readiness: { status: "stale" },
        }),
        expected: { id: "provider:outward", status: "warn", severity: "warn", verdictImpact: "watch" },
        expectedRepair: {
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: "ouro provider check --agent slugger --lane outward",
        },
        expectedSummary: "outward readiness unknown",
      },
    ]

    for (const testCase of cases) {
      const signals = deriveContextLossSentinelProviderSignals(providerVisibility([testCase.lane]))
      const providerSignal = signal(signals, `provider:${testCase.lane.lane}`)
      expect(providerSignal, testCase.label).toMatchObject({
        kind: "provider_lane",
        source: {
          kind: "provider-visibility",
          locator: `agent.json#providers.${testCase.lane.lane}`,
        },
        ...testCase.expected,
      })
      expect(providerSignal.summary).toContain(testCase.expectedSummary)
      if (testCase.expectedRepair) {
        expect(providerSignal.repair).toMatchObject(testCase.expectedRepair)
      }
    }
  })

  it("turns unhealthy sense and bundle state into deterministic Sentinel signals", async () => {
    const agentRoot = makeAgentRoot()
    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:15:00.000Z"),
      createReceiptId: () => "sentinel-health-watch",
      providerVisibility: providerVisibility(),
      daemonHealthResults: [
        ...okHealth(),
        {
          name: "sense-probe:bluebubbles",
          status: "critical",
          message: "bluebubbles failed: local attachment disconnected",
        },
      ],
      gitStatus: () => ({
        ok: true,
        porcelain: " M src/heart/context-loss-sentinel.ts\n?? scratch.log\n",
      }),
    })

    expect(receipt.verdict).toBe("blocked")
    expect(signal(receipt.signals, "sense:sense-probe:bluebubbles")).toMatchObject({
      kind: "sense",
      status: "fail",
      severity: "critical",
      verdictImpact: "blocked",
      summary: "bluebubbles failed: local attachment disconnected",
      source: {
        kind: "daemon-health",
        locator: "daemon.health:sense-probe:bluebubbles",
      },
    })
    expect(signal(receipt.signals, "bundle:git")).toMatchObject({
      kind: "bundle",
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      repair: {
        actor: "agent-runnable",
        kind: "bundle-cleanup",
        command: "git status --porcelain",
      },
    })
  })

  it("degrades when git status is unavailable without hiding the refresh result", async () => {
    const agentRoot = makeAgentRoot()
    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_startup",
      now: () => new Date("2026-06-08T20:16:00.000Z"),
      createReceiptId: () => "sentinel-git-unavailable",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: false, error: "spawn git ENOENT" }),
    })

    expect(receipt.verdict).toBe("watch")
    expect(signal(receipt.signals, "bundle:git")).toMatchObject({
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
      summary: "bundle git status unavailable: spawn git ENOENT",
    })
  })

  it("protects latest and latest-ready from out-of-order concurrent refresh writes", async () => {
    const agentRoot = makeAgentRoot()

    const older = refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:20:00.000Z"),
      createReceiptId: () => "sentinel-older-slow",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
      delayBeforeWriteMs: 40,
    })
    const newer = refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:21:00.000Z"),
      createReceiptId: () => "sentinel-newer-fast",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    await Promise.all([older, newer])

    const view = readContextLossSentinelView(agentRoot, { limit: 10 })
    expect(view.latest?.id).toBe("sentinel-newer-fast")
    expect(view.latestReady?.id).toBe("sentinel-newer-fast")
    expect(view.history.map((entry) => entry.id)).toEqual([
      "sentinel-newer-fast",
      "sentinel-older-slow",
    ])
  })

  it("keeps independent module refreshes monotonic through file-backed sequence protection", async () => {
    const agentRoot = makeAgentRoot()

    vi.resetModules()
    const firstModule = await import("../../heart/context-loss-sentinel")
    vi.resetModules()
    const secondModule = await import("../../heart/context-loss-sentinel")

    await Promise.all([
      firstModule.refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "post_turn",
        now: () => new Date("2026-06-08T20:30:00.000Z"),
        createReceiptId: () => "sentinel-process-a",
        providerVisibility: providerVisibility(),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
        delayBeforeWriteMs: 30,
      }),
      secondModule.refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "daemon_health",
        now: () => new Date("2026-06-08T20:31:00.000Z"),
        createReceiptId: () => "sentinel-process-b",
        providerVisibility: providerVisibility(),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
      }),
    ])

    const view = readContextLossSentinelView(agentRoot, { limit: 10 })
    expect(view.latest?.id).toBe("sentinel-process-b")
    expect(view.latestReady?.id).toBe("sentinel-process-b")
  })

  it("does not self-poison future refreshes on Sentinel-authored blocker events", async () => {
    const agentRoot = makeAgentRoot()
    await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:40:00.000Z"),
      createReceiptId: () => "sentinel-ready-anchor",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })
    recordFlightRecorderEvent(agentRoot, {
      id: "fr-sentinel-blocker",
      kind: "blocker_detected",
      recordedAt: "2026-06-08T20:41:00.000Z",
      summary: "Context-loss Sentinel blocked recovery",
      blockedBecause: ["context-loss Sentinel blocked: provider:outward failed"],
      producedRefs: [{
        kind: "arc",
        locator: "arc/flight-recorder/context-loss-sentinel/receipts/sentinel-blocked.json",
      }],
      meta: {
        source: "context-loss-sentinel",
        receiptId: "sentinel-blocked",
      },
    })

    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:42:00.000Z"),
      createReceiptId: () => "sentinel-after-self-blocker",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(receipt.verdict).toBe("ready")
    expect(receipt.gauntlet.failedChecks).not.toContain("stale_guard")
    expect(receipt.recoveryAnchor).toMatchObject({
      kind: "latest-ready",
      currentAsk: "keep the Arc updated even if the transcript disappears",
      nextSafeAction: "refresh Sentinel and continue from the latest-ready anchor",
    })
  })

  it("reports malformed receipts as degraded read state instead of mutating them", () => {
    const agentRoot = makeAgentRoot()
    const paths = contextLossSentinelPaths(agentRoot)
    fs.mkdirSync(paths.historyDir, { recursive: true })
    fs.writeFileSync(paths.latest, "{", "utf-8")
    fs.writeFileSync(paths.latestReady, `${JSON.stringify({ schemaVersion: 1, id: 12 })}\n`, "utf-8")
    fs.writeFileSync(path.join(paths.historyDir, "2026-06-08.jsonl"), "{\"id\":\"ok-but-malformed\"}\nnot-json\n", "utf-8")
    const latestMtime = fs.statSync(paths.latest).mtimeMs

    const view = readContextLossSentinelView(agentRoot, { limit: 5 })

    expect(view.latest).toBeNull()
    expect(view.latestReady).toBeNull()
    expect(view.history).toEqual([])
    expect(view.degraded.issues.join("\n")).toContain("latest.json unreadable")
    expect(view.degraded.issues.join("\n")).toContain("latest-ready.json malformed")
    expect(view.degraded.issues.join("\n")).toContain("history/2026-06-08.jsonl line 2 unreadable")
    expect(fs.statSync(paths.latest).mtimeMs).toBe(latestMtime)
  })
})
