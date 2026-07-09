import * as fs from "fs"
import * as path from "path"

import { afterEach, describe, expect, it, vi } from "vitest"

const mockProviderCredentials = vi.hoisted(() => ({
  pools: new Map<string, any>(),
  refreshProviderCredentialPool: vi.fn(async (agentName: string) => {
    const result = mockProviderCredentials.pools.get(agentName) ?? {
      ok: true,
      poolPath: `vault:${agentName}:providers/*`,
      pool: {
        schemaVersion: 1,
        updatedAt: "2026-06-09T20:00:00.000Z",
        providers: {},
      },
    }
    mockProviderCredentials.pools.set(agentName, result)
    return result
  }),
  readProviderCredentialPool: vi.fn((agentName: string) => {
    return mockProviderCredentials.pools.get(agentName) ?? {
      ok: false,
      reason: "missing",
      poolPath: `vault:${agentName}:providers/*`,
      error: "provider credentials have not been loaded from vault",
    }
  }),
}))

vi.mock("../../../heart/provider-credentials", async () => {
  const actual = await vi.importActual<typeof import("../../../heart/provider-credentials")>("../../../heart/provider-credentials")
  return {
    ...actual,
    refreshProviderCredentialPool: mockProviderCredentials.refreshProviderCredentialPool,
    readProviderCredentialPool: mockProviderCredentials.readProviderCredentialPool,
  }
})

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliCommand,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import {
  writeFlightRecorderResume,
  type FlightRecorderResume,
} from "../../../arc/flight-recorder"
import {
  contextLossSentinelPaths,
  readContextLossSentinelView,
  refreshContextLossSentinel,
} from "../../../heart/context-loss-sentinel"
import type { AgentProvider } from "../../../heart/identity"
import type { AgentProviderVisibility } from "../../../heart/provider-visibility"
import { createTmpBundle } from "../../test-helpers/tmpdir-bundle"

function createMockDeps(overrides: Partial<OuroCliDeps> = {}): OuroCliDeps {
  return {
    socketPath: "/tmp/ouro-test.sock",
    sendCommand: vi.fn().mockRejectedValue(new Error("daemon should not be called")),
    startDaemonProcess: vi.fn().mockResolvedValue({ pid: 12345 }),
    writeStdout: vi.fn(),
    checkSocketAlive: vi.fn().mockResolvedValue(true),
    cleanupStaleSocket: vi.fn(),
    fallbackPendingMessage: vi.fn().mockReturnValue("pending"),
    ...overrides,
  }
}

function scaffoldDeskRecord(agentRoot: string): void {
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "diary", "daily"), { recursive: true })
  fs.mkdirSync(path.join(agentRoot, "desk", "_record", "notes"), { recursive: true })
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "facts.jsonl"), "", "utf-8")
  fs.writeFileSync(path.join(agentRoot, "desk", "_record", "diary", "entities.json"), "{}\n", "utf-8")
}

function readyResume(): FlightRecorderResume {
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
      recordedAt: "2026-06-09T20:00:00.000Z",
      sourceEventIds: ["fr-ready"],
    },
    recorderHealth: { status: "ok", issues: [] },
  }
}

function readyProviderVisibility(agentName: string): AgentProviderVisibility {
  return {
    agentName,
    lanes: [
      {
        lane: "outward",
        status: "configured",
        provider: "minimax",
        model: "minimax-text-01",
        source: "agent.json",
        readiness: { status: "ready", checkedAt: "2026-06-09T20:00:00.000Z" },
        credential: { status: "present", source: "vault", revision: "rev-outward" },
        warnings: [],
      },
      {
        lane: "inner",
        status: "configured",
        provider: "anthropic",
        model: "claude-opus-4-1",
        source: "agent.json",
        readiness: { status: "ready", checkedAt: "2026-06-09T20:00:00.000Z" },
        credential: { status: "present", source: "vault", revision: "rev-inner" },
        warnings: [],
      },
    ],
  }
}

function sentinelFileStats(rootDir: string): Record<string, { mtimeMs: number; size: number }> {
  const stats: Record<string, { mtimeMs: number; size: number }> = {}
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(absolute)
        continue
      }
      const fileStat = fs.statSync(absolute)
      stats[path.relative(rootDir, absolute)] = {
        mtimeMs: fileStat.mtimeMs,
        size: fileStat.size,
      }
    }
  }
  visit(rootDir)
  return stats
}

function providerRecord(provider: AgentProvider): Record<string, unknown> {
  return {
    provider,
    revision: `vault_${provider}`,
    updatedAt: "2026-06-09T20:00:00.000Z",
    credentials: provider === "openai-codex" ? { oauthAccessToken: "token" } : { apiKey: "token" },
    config: {},
    provenance: { source: "manual", updatedAt: "2026-06-09T20:00:00.000Z" },
  }
}

afterEach(() => {
  mockProviderCredentials.pools.clear()
  mockProviderCredentials.refreshProviderCredentialPool.mockClear()
  mockProviderCredentials.readProviderCredentialPool.mockClear()
})

describe("ouro work card CLI", () => {
  it("parses work card and gauntlet text and JSON formats", () => {
    expect(parseOuroCommand(["work", "card", "--agent", "slugger"])).toEqual({
      kind: "work.card",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "card", "--agent", "slugger", "--format", "json"])).toEqual({
      kind: "work.card",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "card", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.card",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "card"])).toEqual({ kind: "work.card" })
    expect(parseOuroCommand(["work", "gauntlet", "--agent", "slugger"])).toEqual({
      kind: "work.gauntlet",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "gauntlet", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.gauntlet",
      agent: "slugger",
      format: "json",
    })
    expect(() => parseOuroCommand(["work"])).toThrow(/Usage: ouro work/)
    expect(() => parseOuroCommand(["work", "card", "--format"])).toThrow(/Usage: ouro work card/)
    expect(() => parseOuroCommand(["work", "gauntlet", "--format"])).toThrow(/Usage: ouro work gauntlet/)
    expect(() => parseOuroCommand(["work", "card", "--format", "yaml"])).toThrow(/format/)
  })

  it("parses work sentinel read and refresh text and JSON formats", () => {
    const readType = { kind: "work.sentinel", agent: "slugger" } satisfies OuroCliCommand
    const refreshType = { kind: "work.sentinel.refresh", agent: "slugger" } satisfies OuroCliCommand

    expect(readType.kind).toBe("work.sentinel")
    expect(refreshType.kind).toBe("work.sentinel.refresh")
    expect(parseOuroCommand(["work", "sentinel", "--agent", "slugger"])).toEqual({
      kind: "work.sentinel",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "sentinel"])).toEqual({
      kind: "work.sentinel",
    })
    expect(parseOuroCommand(["work", "sentinel", "--agent", "slugger", "--format", "json"])).toEqual({
      kind: "work.sentinel",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "sentinel", "--agent", "slugger", "--format", "text"])).toEqual({
      kind: "work.sentinel",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "sentinel", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.sentinel",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "sentinel", "refresh", "--agent", "slugger"])).toEqual({
      kind: "work.sentinel.refresh",
      agent: "slugger",
    })
    expect(parseOuroCommand(["work", "sentinel", "refresh"])).toEqual({
      kind: "work.sentinel.refresh",
    })
    expect(parseOuroCommand(["work", "sentinel", "refresh", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.sentinel.refresh",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "sentinel", "refresh", "--agent", "slugger", "--format", "json"])).toEqual({
      kind: "work.sentinel.refresh",
      agent: "slugger",
      format: "json",
    })
    expect(parseOuroCommand(["work", "sentinel", "refresh", "--agent", "slugger", "--format", "text"])).toEqual({
      kind: "work.sentinel.refresh",
      agent: "slugger",
    })
    expect(() => parseOuroCommand(["work", "sentinel", "--format"])).toThrow(/Usage: ouro work sentinel/)
    expect(() => parseOuroCommand(["work", "sentinel", "refresh", "--format", "yaml"])).toThrow(/format/)
  })

  it("renders JSON from the bundle without routing through the daemon socket", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "card", "--agent", "slugger", "--format", "json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed.agent).toBe("slugger")
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.projection.owner).toBe("arc/work-card")
      expect(parsed.claims.available).toBe(false)
      expect(parsed.counts.unverifiedClaims).toBeNull()
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })

  it("renders the context-loss gauntlet without routing through the daemon socket", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "gauntlet", "--agent", "slugger", "--format", "json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed.agent).toBe("slugger")
      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.checks.map((check: { id: string }) => check.id)).toContain("stale_guard")
      expect(parsed.workCard.projection.owner).toBe("arc/work-card")
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })

  it("reads Sentinel JSON without routing through the daemon socket or mutating receipts", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      scaffoldDeskRecord(tmp.agentRoot)
      writeFlightRecorderResume(tmp.agentRoot, readyResume())
      await refreshContextLossSentinel("slugger", tmp.agentRoot, {
        trigger: "daemon_health",
        now: () => new Date("2026-06-09T20:10:00.000Z"),
        createReceiptId: () => "sentinel-cli-read",
        providerVisibility: readyProviderVisibility("slugger"),
        daemonHealthResults: [],
        gitStatus: () => ({ ok: true, porcelain: "" }),
      })
      const paths = contextLossSentinelPaths(tmp.agentRoot)
      const pinnedMtime = new Date("2026-06-09T20:11:00.000Z")
      for (const filePath of [
        paths.latest,
        paths.latestReady,
        path.join(paths.receiptsDir, "sentinel-cli-read.json"),
        path.join(paths.historyDir, "2026-06-09.jsonl"),
      ]) {
        fs.utimesSync(filePath, pinnedMtime, pinnedMtime)
      }
      const beforeStats = sentinelFileStats(paths.rootDir)
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "sentinel", "--agent", "slugger", "--format", "json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.latest.id).toBe("sentinel-cli-read")
      expect(parsed.latest.trigger).toBe("daemon_health")
      expect(parsed.history.map((receipt: { id: string }) => receipt.id)).toEqual(["sentinel-cli-read"])
      expect(sentinelFileStats(paths.rootDir)).toEqual(beforeStats)
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })

  it("renders Sentinel text in read mode and keeps missing state non-mutating", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      const paths = contextLossSentinelPaths(tmp.agentRoot)
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "sentinel", "--agent", "slugger"], deps)

      expect(result).toBe("Recovery Sentinel - unavailable")
      expect(fs.existsSync(paths.rootDir)).toBe(false)
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })

  it("refreshes Sentinel explicitly with the manual_cli trigger", async () => {
    const tmp = createTmpBundle({ agentName: "slugger" })
    try {
      mockProviderCredentials.pools.set("slugger", {
        ok: true,
        poolPath: "vault:slugger:providers/*",
        pool: {
          schemaVersion: 1,
          updatedAt: "2026-06-09T20:00:00.000Z",
          providers: {
            minimax: providerRecord("minimax"),
          },
        },
      })
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "sentinel", "refresh", "--agent", "slugger", "--json"], deps)
      const parsed = JSON.parse(result)
      const view = readContextLossSentinelView(tmp.agentRoot, { limit: 5 })

      expect(parsed.agent).toBe("slugger")
      expect(parsed.trigger).toBe("manual_cli")
      expect(JSON.stringify(parsed.signals)).not.toContain("credentials not loaded")
      expect(mockProviderCredentials.refreshProviderCredentialPool).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(view.latest?.trigger).toBe("manual_cli")
      expect(view.history.map((receipt) => receipt.id)).toContain(parsed.id)
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })
})
