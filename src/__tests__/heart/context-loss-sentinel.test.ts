import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { spawn } from "child_process"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  recordFlightRecorderEvent,
  writeFlightRecorderResume,
  type FlightRecorderResume,
} from "../../arc/flight-recorder"
import {
  contextLossSentinelPaths,
  deriveContextLossSentinelProviderSignals,
  formatContextLossSentinelJson,
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
  writeAgentJson(dir)
  scaffoldDeskRecord(dir)
  writeReadyResume(dir)
  return dir
}

function makeNamedBundleRoot(agentName = "slugger"): string {
  const bundlesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-loss-sentinel-bundles-"))
  tempDirs.push(bundlesRoot)
  const agentRoot = path.join(bundlesRoot, `${agentName}.ouro`)
  fs.mkdirSync(agentRoot, { recursive: true })
  writeAgentJson(agentRoot)
  scaffoldDeskRecord(agentRoot)
  writeReadyResume(agentRoot)
  return agentRoot
}

function writeAgentJson(dir: string): void {
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

function runChildVitest(testPath: string, env: Record<string, string>): Promise<void> {
  const repoRoot = process.cwd()
  const vitestBin = path.join(repoRoot, "node_modules", "vitest", "vitest.mjs")
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      vitestBin,
      "run",
      testPath,
      "--config",
      path.join(repoRoot, "vitest.config.ts"),
      "--pool",
      "forks",
    ], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`child Vitest exited ${code}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`))
    })
  })
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
    expect(formatContextLossSentinelText({ ...view, degraded: { issues: ["latest-ready.json stale"] } }))
      .toContain("degraded: latest-ready.json stale")

    const json = formatContextLossSentinelJson(view)
    expect(JSON.parse(json)).toMatchObject({
      schemaVersion: 1,
      latest: { id: "sentinel-ready", verdict: "ready" },
      latestReady: { id: "sentinel-ready", verdict: "ready" },
      history: [{ id: "sentinel-ready" }],
      degraded: { issues: [] },
    })

    const mtimes = [paths.latest, paths.latestReady, path.join(paths.receiptsDir, "sentinel-ready.json")]
      .map((filePath) => [filePath, fs.statSync(filePath).mtimeMs] as const)
    readContextLossSentinelView(agentRoot, { limit: 5 })
    formatContextLossSentinelText(view)
    formatContextLossSentinelJson(view)
    expect(mtimes.map(([filePath, mtime]) => [filePath, fs.statSync(filePath).mtimeMs])).toEqual(mtimes)
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
    expect(formatContextLossSentinelText(blocked)).toContain("repair: ouro provider check --agent slugger --lane outward")
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

  it("classifies every provider state for both outward and inner lanes with repair actors, sources, severity, and verdict impact", () => {
    const lanes = ["outward", "inner"] as const
    const cases: Array<{
      label: string
      makeLane: (lane: "outward" | "inner") => ProviderVisibilityLane
      expected: (lane: "outward" | "inner") => Partial<ContextLossSentinelSignal>
      expectedRepair?: (lane: "outward" | "inner") => Partial<NonNullable<ContextLossSentinelSignal["repair"]>>
      expectedSummary: (lane: "outward" | "inner") => string
    }> = [
      {
        label: "configured and ready",
        makeLane: (lane) => configuredLane(lane),
        expected: (lane) => ({ id: `provider:${lane}`, status: "pass", severity: "info", verdictImpact: "none" }),
        expectedSummary: (lane) => `${lane} provider ready`,
      },
      {
        label: "unconfigured",
        makeLane: (lane) => unconfiguredLane(lane),
        expected: (lane) => ({ id: `provider:${lane}`, status: "fail", severity: "critical", verdictImpact: "blocked" }),
        expectedRepair: (lane) => ({
          actor: "human-choice",
          kind: "provider-selection",
          command: `ouro use --agent slugger --lane ${lane} --provider <provider> --model <model>`,
        }),
        expectedSummary: (lane) => `${lane} provider unconfigured`,
      },
      {
        label: "missing credentials",
        makeLane: (lane) => configuredLane(lane, {
          credential: {
            status: "missing",
            repairCommand: `ouro auth --agent slugger --provider ${lane === "outward" ? "minimax" : "anthropic"}`,
          },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "fail", severity: "critical", verdictImpact: "blocked" }),
        expectedRepair: (lane) => ({
          actor: "human-required",
          kind: "provider-credential",
          command: `ouro auth --agent slugger --provider ${lane === "outward" ? "minimax" : "anthropic"}`,
        }),
        expectedSummary: (lane) => `${lane} credentials missing`,
      },
      {
        label: "vault unavailable",
        makeLane: (lane) => configuredLane(lane, {
          credential: {
            status: "invalid-pool",
            repairCommand: "ouro vault unlock --agent slugger",
          },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "fail", severity: "critical", verdictImpact: "blocked" }),
        expectedRepair: () => ({
          actor: "human-required",
          kind: "vault-unavailable",
          command: "ouro vault unlock --agent slugger",
        }),
        expectedSummary: (lane) => `${lane} credential vault unavailable`,
      },
      {
        label: "credential cache not loaded",
        makeLane: (lane) => configuredLane(lane, {
          credential: {
            status: "not-loaded",
            repairCommand: "ouro provider refresh --agent slugger",
          },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "warn", severity: "warn", verdictImpact: "watch" }),
        expectedRepair: () => ({
          actor: "agent-runnable",
          kind: "provider-credential-cache",
          command: "ouro provider refresh --agent slugger",
        }),
        expectedSummary: (lane) => `${lane} credentials not loaded`,
      },
      {
        label: "unknown readiness",
        makeLane: (lane) => configuredLane(lane, {
          readiness: { status: "unknown", reason: "no live check has run after daemon start" },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "warn", severity: "warn", verdictImpact: "watch" }),
        expectedRepair: (lane) => ({
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: `ouro provider check --agent slugger --lane ${lane}`,
        }),
        expectedSummary: (lane) => `${lane} readiness unknown`,
      },
      {
        label: "failed live check",
        makeLane: (lane) => configuredLane(lane, {
          readiness: {
            status: "failed",
            checkedAt: "2026-06-08T20:12:00.000Z",
            error: "provider returned 503",
            attempts: 2,
          },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "fail", severity: "critical", verdictImpact: "blocked" }),
        expectedRepair: (lane) => ({
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: `ouro provider check --agent slugger --lane ${lane}`,
        }),
        expectedSummary: (lane) => `${lane} live check failed`,
      },
      {
        label: "stale readiness with persisted source",
        makeLane: (lane) => configuredLane(lane, {
          readiness: {
            status: "stale",
            checkedAt: "2026-06-08T17:00:00.000Z",
            reason: "persisted readiness older than policy",
          },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "warn", severity: "warn", verdictImpact: "watch" }),
        expectedRepair: (lane) => ({
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: `ouro provider check --agent slugger --lane ${lane}`,
        }),
        expectedSummary: (lane) => `${lane} readiness stale`,
      },
      {
        label: "stale readiness without evidence degrades to unknown",
        makeLane: (lane) => configuredLane(lane, {
          readiness: { status: "stale" },
        }),
        expected: (lane) => ({ id: `provider:${lane}`, status: "warn", severity: "warn", verdictImpact: "watch" }),
        expectedRepair: (lane) => ({
          actor: "agent-runnable",
          kind: "provider-live-check",
          command: `ouro provider check --agent slugger --lane ${lane}`,
        }),
        expectedSummary: (lane) => `${lane} readiness unknown`,
      },
    ]

    for (const testCase of cases) {
      for (const lane of lanes) {
        const otherLane = lane === "outward" ? "inner" : "outward"
        const signals = deriveContextLossSentinelProviderSignals(providerVisibility([
          testCase.makeLane(lane),
          configuredLane(otherLane),
        ]))
        const providerSignal = signal(signals, `provider:${lane}`)
        expect(providerSignal, `${testCase.label} ${lane}`).toMatchObject({
          kind: "provider_lane",
          source: {
            kind: "provider-visibility",
            locator: `agent.json#providers.${lane}`,
          },
          ...testCase.expected(lane),
        })
        expect(providerSignal.summary).toContain(testCase.expectedSummary(lane))
        if (testCase.expectedRepair) {
          expect(providerSignal.repair).toMatchObject(testCase.expectedRepair(lane))
        }
      }
    }

    const partialSignals = deriveContextLossSentinelProviderSignals(providerVisibility([configuredLane("outward")]))
    expect(signal(partialSignals, "provider:inner")).toMatchObject({
      kind: "provider_lane",
      status: "fail",
      severity: "critical",
      verdictImpact: "blocked",
      summary: "inner provider visibility missing from deterministic provider report",
      repair: {
        actor: "agent-runnable",
        kind: "provider-visibility",
        command: "ouro work sentinel refresh --agent slugger",
      },
    })

    const missingSignals = deriveContextLossSentinelProviderSignals(providerVisibility([]))
    expect(signal(missingSignals, "provider:outward").summary).toBe("outward provider visibility missing from deterministic provider report")
    expect(signal(missingSignals, "provider:inner").summary).toBe("inner provider visibility missing from deterministic provider report")
  })

  it("does not invent optional provider readiness metadata", () => {
    const failed = signal(deriveContextLossSentinelProviderSignals(providerVisibility([
      configuredLane("outward", { readiness: { status: "failed" } }),
      configuredLane("inner"),
    ])), "provider:outward")
    expect(failed.summary).toBe("outward live check failed for minimax")
    expect(failed.meta).toMatchObject({
      checkedAt: null,
      attempts: null,
    })

    const stale = signal(deriveContextLossSentinelProviderSignals(providerVisibility([
      configuredLane("outward", { readiness: { status: "stale", checkedAt: "2026-06-08T19:00:00.000Z" } }),
      configuredLane("inner"),
    ])), "provider:outward")
    expect(stale.summary).toBe("outward readiness stale for minimax")
    expect(stale.meta).toMatchObject({
      checkedAt: "2026-06-08T19:00:00.000Z",
    })

    const staleReasonOnly = signal(deriveContextLossSentinelProviderSignals(providerVisibility([
      configuredLane("outward", { readiness: { status: "stale", reason: "persisted readiness expired" } }),
      configuredLane("inner"),
    ])), "provider:outward")
    expect(staleReasonOnly.summary).toBe("outward readiness stale for minimax: persisted readiness expired")
    expect(staleReasonOnly.meta).toMatchObject({
      checkedAt: null,
    })

    const ready = signal(deriveContextLossSentinelProviderSignals(providerVisibility([
      configuredLane("outward", { readiness: { status: "ready" } }),
      configuredLane("inner"),
    ])), "provider:outward")
    expect(ready.summary).toBe("outward provider ready: minimax / minimax-text-01")
    expect(ready.meta).toMatchObject({
      checkedAt: null,
    })
  })

  it("constructs provider visibility during refresh when no injected provider report is supplied", async () => {
    const agentRoot = makeNamedBundleRoot()
    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_startup",
      now: () => new Date("2026-06-08T20:13:00.000Z"),
      createReceiptId: () => "sentinel-provider-built",
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
      homeDir: agentRoot,
    })

    expect(receipt.signals.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "provider:outward",
      "provider:inner",
    ]))
    expect(signal(receipt.signals, "provider:outward")).toMatchObject({
      summary: "outward credentials not loaded for minimax",
      kind: "provider_lane",
      repair: {
        actor: "agent-runnable",
        kind: "provider-credential-cache",
        command: "ouro provider refresh --agent slugger",
      },
      source: {
        kind: "provider-visibility",
        locator: "agent.json#providers.outward",
      },
    })
    expect(signal(receipt.signals, "provider:inner")).toMatchObject({
      summary: "inner credentials not loaded for anthropic",
      kind: "provider_lane",
      repair: {
        actor: "agent-runnable",
        kind: "provider-credential-cache",
        command: "ouro provider refresh --agent slugger",
      },
      source: {
        kind: "provider-visibility",
        locator: "agent.json#providers.inner",
      },
    })
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

  it("reads empty Sentinel state and formats null/unavailable views without creating files", () => {
    const agentRoot = makeAgentRoot()
    const paths = contextLossSentinelPaths(agentRoot)

    const view = readContextLossSentinelView(agentRoot, { limit: 5 })

    expect(view).toEqual({
      schemaVersion: 1,
      latest: null,
      latestReady: null,
      history: [],
      degraded: { issues: [] },
    })
    expect(formatContextLossSentinelText(null)).toBe("Recovery Sentinel - unavailable")
    expect(formatContextLossSentinelText(view)).toBe("Recovery Sentinel - unavailable")
    expect(formatContextLossSentinelText({ ...view, degraded: { issues: ["latest.json unreadable"] } }))
      .toContain("degraded: latest.json unreadable")
    expect(JSON.parse(formatContextLossSentinelJson(null))).toBeNull()
    expect(fs.existsSync(paths.rootDir)).toBe(false)
  })

  it("covers default refresh dependencies, generated ids, session/manual triggers, and unavailable latest-ready formatting", async () => {
    const agentRoot = makeNamedBundleRoot()

    const sessionReceipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "session_start",
      lockTimeoutMs: 1_000,
      homeDir: agentRoot,
    })

    expect(sessionReceipt.id).toMatch(/^sentinel-/)
    expect(new Date(sessionReceipt.generatedAt).toString()).not.toBe("Invalid Date")
    expect(sessionReceipt.verdict).toBe("watch")
    expect(signal(sessionReceipt.signals, "provider:outward").summary).toBe("outward credentials not loaded for minimax")
    expect(signal(sessionReceipt.signals, "provider:inner").summary).toBe("inner credentials not loaded for anthropic")
    expect(signal(sessionReceipt.signals, "bundle:git").summary).toContain("bundle git status unavailable")
    expect(readContextLossSentinelView(agentRoot, { limit: 1 }).latest?.trigger).toBe("session_start")

    const manualReceipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "manual_cli",
      now: () => new Date("2026-06-09T20:17:00.000Z"),
      createReceiptId: () => "sentinel-manual-ready",
      providerVisibility: providerVisibility(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(manualReceipt.verdict).toBe("ready")
    expect(readContextLossSentinelView(agentRoot, { limit: 2 }).latest?.trigger).toBe("manual_cli")
    expect(formatContextLossSentinelText(manualReceipt)).toContain("trigger: manual_cli")
  })

  it("tracks gauntlet watch and first blocked receipts without a latest-ready fallback", async () => {
    const watchRoot = makeAgentRoot()
    writeReadyResume(watchRoot, {
      currentAsk: {
        value: "recover stale work",
        confidence: "stale_risky",
        sourceEventIds: ["fr-stale"],
      },
    })

    const watchReceipt = await refreshContextLossSentinel("slugger", watchRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:18:00.000Z"),
      createReceiptId: () => "sentinel-gauntlet-watch",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(watchReceipt.verdict).toBe("watch")
    expect(signal(watchReceipt.signals, "gauntlet:context-loss")).toMatchObject({
      status: "warn",
      verdictImpact: "watch",
    })

    const blockedRoot = makeAgentRoot()
    writeFlightRecorderResume(blockedRoot, {
      ...readyResume(),
      hasCompleteState: false,
      canContinue: false,
      missing: ["currentAsk"],
      currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
    })

    const blockedReceipt = await refreshContextLossSentinel("slugger", blockedRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:19:00.000Z"),
      createReceiptId: () => "sentinel-first-blocked",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(blockedReceipt.verdict).toBe("blocked")
    expect(blockedReceipt.latestReadyLocator).toBeNull()
    expect(signal(blockedReceipt.signals, "gauntlet:context-loss")).toMatchObject({
      status: "fail",
      verdictImpact: "blocked",
    })
    expect(formatContextLossSentinelText(blockedReceipt)).toContain("latest-ready: unavailable")
  })

  it("reports warn-level sense probes and singular dirty git entries", async () => {
    const agentRoot = makeAgentRoot()
    const receipt = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:19:30.000Z"),
      createReceiptId: () => "sentinel-warn-sense",
      providerVisibility: providerVisibility(),
      daemonHealthResults: [
        ...okHealth(),
        {
          name: "sense-probe:mail",
          status: "warn",
          message: "mail backlog is stale",
        },
        {
          name: "sense-probe:voice",
          status: "ok",
          message: "voice healthy",
        },
      ],
      gitStatus: () => ({ ok: true, porcelain: " M agent.json\n" }),
    })

    expect(receipt.verdict).toBe("watch")
    expect(signal(receipt.signals, "sense:sense-probe:mail")).toMatchObject({
      status: "warn",
      severity: "warn",
      verdictImpact: "watch",
    })
    expect(signal(receipt.signals, "sense:sense-probe:voice")).toMatchObject({
      status: "pass",
      severity: "info",
      verdictImpact: "none",
    })
    expect(signal(receipt.signals, "bundle:git").summary).toContain("1 uncommitted git status entry")
  })

  it("uses deterministic id tie-breaking and fails active locks without deleting someone else's lock", async () => {
    const agentRoot = makeAgentRoot()
    await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:20:30.000Z"),
      createReceiptId: () => "sentinel-z",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })
    await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:20:30.000Z"),
      createReceiptId: () => "sentinel-a",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })
    expect(readContextLossSentinelView(agentRoot).latest?.id).toBe("sentinel-z")

    const lockedRoot = makeAgentRoot()
    const paths = contextLossSentinelPaths(lockedRoot)
    fs.mkdirSync(paths.rootDir, { recursive: true })
    fs.writeFileSync(paths.lock, "stale-owner\n", "utf-8")

    await expect(refreshContextLossSentinel("slugger", lockedRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:20:45.000Z"),
      createReceiptId: () => "sentinel-lock-timeout",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
      lockTimeoutMs: 1,
    })).rejects.toThrow("context-loss Sentinel lock timed out")
    expect(fs.existsSync(paths.lock)).toBe(true)

    const errorRoot = makeAgentRoot()
    const errorPaths = contextLossSentinelPaths(errorRoot)
    fs.mkdirSync(errorPaths.rootDir, { recursive: true })
    fs.chmodSync(errorPaths.rootDir, 0o500)
    try {
      await expect(refreshContextLossSentinel("slugger", errorRoot, {
        trigger: "daemon_health",
        now: () => new Date("2026-06-08T20:20:55.000Z"),
        createReceiptId: () => "sentinel-lock-error",
        providerVisibility: providerVisibility(),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
      })).rejects.toThrow()
    } finally {
      fs.chmodSync(errorPaths.rootDir, 0o700)
    }
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

  it("keeps latest and latest-ready correct when ready and blocked refreshes interleave", async () => {
    const agentRoot = makeAgentRoot()

    await Promise.all([
      refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "post_turn",
        now: () => new Date("2026-06-08T20:22:00.000Z"),
        createReceiptId: () => "sentinel-ready-slow",
        providerVisibility: providerVisibility(),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
        delayBeforeWriteMs: 40,
      }),
      refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "daemon_health",
        now: () => new Date("2026-06-08T20:23:00.000Z"),
        createReceiptId: () => "sentinel-blocked-fast",
        providerVisibility: providerVisibility([
          configuredLane("outward", {
            readiness: { status: "failed", checkedAt: "2026-06-08T20:23:00.000Z", error: "MiniMax 503" },
          }),
          configuredLane("inner"),
        ]),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
      }),
    ])

    const view = readContextLossSentinelView(agentRoot, { limit: 10 })
    expect(view.latest?.id).toBe("sentinel-blocked-fast")
    expect(view.latestReady?.id).toBe("sentinel-ready-slow")
    expect(view.latest?.latestReadyLocator).toBe("arc/flight-recorder/context-loss-sentinel/latest-ready.json")
    expect(formatContextLossSentinelText(view)).toContain("history: 2 receipts")

    await Promise.all([
      refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "provider_failover",
        now: () => new Date("2026-06-08T20:24:00.000Z"),
        createReceiptId: () => "sentinel-blocked-slow",
        providerVisibility: providerVisibility([
          configuredLane("outward"),
          configuredLane("inner", {
            credential: { status: "missing", repairCommand: "ouro auth --agent slugger --provider anthropic" },
          }),
        ]),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
        delayBeforeWriteMs: 40,
      }),
      refreshContextLossSentinel("slugger", agentRoot, {
        trigger: "post_turn",
        now: () => new Date("2026-06-08T20:25:00.000Z"),
        createReceiptId: () => "sentinel-ready-fast",
        providerVisibility: providerVisibility(),
        daemonHealthResults: okHealth(),
        gitStatus: () => ({ ok: true, porcelain: "" }),
      }),
    ])

    const nextView = readContextLossSentinelView(agentRoot, { limit: 10 })
    expect(nextView.latest?.id).toBe("sentinel-ready-fast")
    expect(nextView.latestReady?.id).toBe("sentinel-ready-fast")
    expect(nextView.history.map((entry) => entry.id)).toEqual([
      "sentinel-blocked-fast",
      "sentinel-ready-slow",
      "sentinel-ready-fast",
      "sentinel-blocked-slow",
    ])
  })

  it("keeps independent child-process refreshes monotonic through file-backed sequence protection", async () => {
    const agentRoot = makeAgentRoot()
    const helperPath = path.join(process.cwd(), "src", "__tests__", "heart", "context-loss-sentinel-child-process.test.ts")

    await Promise.all([
      runChildVitest(helperPath, {
        SENTINEL_AGENT_ROOT: agentRoot,
        SENTINEL_RECEIPT_ID: "sentinel-process-a",
        SENTINEL_GENERATED_AT: "2026-06-08T20:30:00.000Z",
        SENTINEL_DELAY_MS: "70",
        SENTINEL_TRIGGER: "post_turn",
      }),
      runChildVitest(helperPath, {
        SENTINEL_AGENT_ROOT: agentRoot,
        SENTINEL_RECEIPT_ID: "sentinel-process-b",
        SENTINEL_GENERATED_AT: "2026-06-08T20:31:00.000Z",
        SENTINEL_DELAY_MS: "0",
        SENTINEL_TRIGGER: "daemon_health",
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
    fs.appendFileSync(
      path.join(agentRoot, "arc", "flight-recorder", "events", "2026-06-08.jsonl"),
      "not-json\n",
      "utf-8",
    )

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
    writeFlightRecorderResume(agentRoot, {
      ...readyResume(),
      hasCompleteState: false,
      canContinue: false,
      missing: ["currentAsk"],
      currentAsk: { value: null, confidence: "unknown", sourceEventIds: [] },
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
      blockedBecause: ["context-loss Sentinel blocked without source event ids"],
      lastSafeCheckpoint: {
        ...readyResume().lastSafeCheckpoint,
        sourceEventIds: [],
      },
    })

    const noEventIds = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:42:30.000Z"),
      createReceiptId: () => "sentinel-after-empty-event-ids",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(noEventIds.verdict).toBe("blocked")
    expect(noEventIds.recoveryAnchor.kind).toBe("flight-recorder")

    recordFlightRecorderEvent(agentRoot, {
      id: "fr-human-blocker-mentioning-sentinel",
      kind: "blocker_detected",
      recordedAt: "2026-06-08T20:43:00.000Z",
      summary: "Human blocker mentioning context-loss Sentinel",
      blockedBecause: ["human asked to stop until context-loss Sentinel plan is reviewed"],
      producedRefs: [{
        kind: "arc",
        locator: "arc/notes/human-blocker.json",
      }],
      meta: {
        source: "human",
      },
    })

    const humanBlocked = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:44:00.000Z"),
      createReceiptId: () => "sentinel-after-human-blocker",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(humanBlocked.verdict).toBe("blocked")
    expect(humanBlocked.gauntlet.failedChecks).toContain("stale_guard")
    expect(humanBlocked.recoveryAnchor.kind).toBe("flight-recorder")

    const missingEventsRoot = makeAgentRoot()
    fs.rmSync(path.join(missingEventsRoot, "arc", "flight-recorder", "events"), { recursive: true, force: true })
    writeFlightRecorderResume(missingEventsRoot, {
      ...readyResume(),
      hasCompleteState: false,
      canContinue: false,
      missing: ["nextSafeAction"],
      nextSafeAction: { value: null, stopBefore: [], sourceEventIds: [] },
      blockedBecause: ["context-loss Sentinel text appears in a human-authored stale checkpoint"],
      lastSafeCheckpoint: {
        ...readyResume().lastSafeCheckpoint,
        sourceEventIds: ["fr-missing-event-file"],
      },
    })

    const missingEvents = await refreshContextLossSentinel("slugger", missingEventsRoot, {
      trigger: "daemon_health",
      now: () => new Date("2026-06-08T20:45:00.000Z"),
      createReceiptId: () => "sentinel-after-missing-events-root",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    expect(missingEvents.verdict).toBe("blocked")
    expect(missingEvents.recoveryAnchor.kind).toBe("flight-recorder")
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
    expect(view.degraded.issues.join("\n")).toContain("history/2026-06-08.jsonl line 1 malformed")
    expect(view.degraded.issues.join("\n")).toContain("history/2026-06-08.jsonl line 2 unreadable")
    expect(fs.statSync(paths.latest).mtimeMs).toBe(latestMtime)
  })

  it("degrades malformed nested receipt shapes instead of accepting partial disk state", async () => {
    const agentRoot = makeAgentRoot()
    const paths = contextLossSentinelPaths(agentRoot)
    const base = await refreshContextLossSentinel("slugger", agentRoot, {
      trigger: "post_turn",
      now: () => new Date("2026-06-08T20:50:00.000Z"),
      createReceiptId: () => "sentinel-schema-base",
      providerVisibility: providerVisibility(),
      daemonHealthResults: okHealth(),
      gitStatus: () => ({ ok: true, porcelain: "" }),
    })

    const cases: Array<[string, unknown]> = [
      ["not an object", null],
      ["bad signal", { ...base, signals: [null] }],
      ["bad signal source", { ...base, signals: [{ ...base.signals[0], source: null }] }],
      ["bad signal repair", { ...base, signals: [{ ...base.signals[0], repair: null }] }],
      ["bad signal repair actor", {
        ...base,
        signals: [{
          ...base.signals[0],
          repair: {
            actor: "somebody-else",
            kind: "provider-live-check",
            detail: "bad actor",
          },
        }],
      }],
      ["bad recovery anchor", { ...base, recoveryAnchor: null }],
      ["bad gauntlet", { ...base, gauntlet: null }],
      ["bad resume", { ...base, resumeSnapshot: null }],
    ]

    for (const [label, candidate] of cases) {
      fs.writeFileSync(paths.latest, `${JSON.stringify(candidate)}\n`, "utf-8")
      const view = readContextLossSentinelView(agentRoot)

      expect(view.latest, label).toBeNull()
      expect(view.degraded.issues.join("\n"), label).toContain("latest.json malformed")
    }
  })
})
