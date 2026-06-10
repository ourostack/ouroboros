import * as fs from "fs"

import { describe, expect, it, vi } from "vitest"

import {
  parseOuroCommand,
  runOuroCli,
  type OuroCliCommand,
  type OuroCliDeps,
} from "../../../heart/daemon/daemon-cli"
import {
  contextLossSentinelPaths,
  readContextLossSentinelView,
  refreshContextLossSentinel,
} from "../../../heart/context-loss-sentinel"
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
    expect(parseOuroCommand(["work", "sentinel", "--agent", "slugger", "--format", "json"])).toEqual({
      kind: "work.sentinel",
      agent: "slugger",
      format: "json",
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
    expect(parseOuroCommand(["work", "sentinel", "refresh", "--agent", "slugger", "--json"])).toEqual({
      kind: "work.sentinel.refresh",
      agent: "slugger",
      format: "json",
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
      fs.utimesSync(paths.latest, pinnedMtime, pinnedMtime)
      const beforeLatestMtime = fs.statSync(paths.latest).mtimeMs
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "sentinel", "--agent", "slugger", "--format", "json"], deps)
      const parsed = JSON.parse(result)

      expect(parsed.schemaVersion).toBe(1)
      expect(parsed.latest.id).toBe("sentinel-cli-read")
      expect(parsed.latest.trigger).toBe("daemon_health")
      expect(parsed.history.map((receipt: { id: string }) => receipt.id)).toEqual(["sentinel-cli-read"])
      expect(fs.statSync(paths.latest).mtimeMs).toBe(beforeLatestMtime)
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
      const writeStdout = vi.fn()
      const deps = createMockDeps({ bundlesRoot: tmp.bundlesRoot, writeStdout })

      const result = await runOuroCli(["work", "sentinel", "refresh", "--agent", "slugger", "--json"], deps)
      const parsed = JSON.parse(result)
      const view = readContextLossSentinelView(tmp.agentRoot, { limit: 5 })

      expect(parsed.agent).toBe("slugger")
      expect(parsed.trigger).toBe("manual_cli")
      expect(view.latest?.trigger).toBe("manual_cli")
      expect(view.history.map((receipt) => receipt.id)).toContain(parsed.id)
      expect(deps.sendCommand).not.toHaveBeenCalled()
      expect(writeStdout).toHaveBeenCalledWith(result)
    } finally {
      tmp.cleanup()
    }
  })
})
