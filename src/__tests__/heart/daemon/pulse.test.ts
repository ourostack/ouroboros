import { describe, expect, it, vi } from "vitest"
import {
  buildAlertId,
  buildPulseState,
  buildRecoveryAlertId,
  findNovelBrokenAgents,
  findRecoveredAgents,
  flushPulse,
  pickWakeRecipient,
  readAgentActivity,
  writePulse,
  readPulse,
  readDeliveredState,
  writeDeliveredState,
  pruneDeliveredState,
  getPulsePath,
  getPulseDeliveredPath,
  type PulseAgentEntry,
  type PulseState,
} from "../../../heart/daemon/pulse"
import type { DaemonAgentSnapshot } from "../../../heart/daemon/process-manager"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

function makeSnapshot(overrides: Partial<DaemonAgentSnapshot>): DaemonAgentSnapshot {
  return {
    name: "slugger",
    channel: "inner-dialog",
    status: "running",
    pid: 1234,
    restartCount: 0,
    startedAt: "2026-04-08T22:00:00.000Z",
    lastCrashAt: null,
    backoffMs: 1000,
    lastExitCode: null,
    lastSignal: null,
    errorReason: null,
    fixHint: null,
    ...overrides,
  }
}

describe("buildAlertId", () => {
  it("produces a stable id for the same (agent, error) pair", () => {
    const a = buildAlertId("ouroboros", "missing github-copilot creds")
    const b = buildAlertId("ouroboros", "missing github-copilot creds")
    expect(a).toBe(b)
  })

  it("produces different ids for different errors on the same agent", () => {
    const a = buildAlertId("ouroboros", "missing github-copilot creds")
    const b = buildAlertId("ouroboros", "agent.json not found")
    expect(a).not.toBe(b)
  })

  it("produces different ids for the same error on different agents", () => {
    const a = buildAlertId("ouroboros", "missing creds")
    const b = buildAlertId("slugger", "missing creds")
    expect(a).not.toBe(b)
  })

  it("ids are short hex (compact for storage)", () => {
    const id = buildAlertId("ouroboros", "some long error message that goes on and on and on")
    // Format: <agent>:<hex>
    expect(id).toMatch(/^ouroboros:[a-f0-9]+$/)
  })
})

describe("buildPulseState", () => {
  it("builds a pulse from an empty snapshot list", () => {
    const result = buildPulseState([], "/tmp/bundles", "0.1.0-alpha.273", new Date("2026-04-08T22:00:00Z"))
    expect(result).toEqual({
      generatedAt: "2026-04-08T22:00:00.000Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [],
    })
  })

  it("maps healthy snapshots to PulseAgentEntry with no alertId", () => {
    const snap = makeSnapshot({ name: "slugger", status: "running" })
    // Inject a stub readActivity that returns null so the test doesn't
    // touch fs (the production default would try to read from
    // /Users/test/AgentBundles/slugger.ouro/state/sessions/.../runtime.json).
    const result = buildPulseState(
      [snap],
      "/Users/test/AgentBundles",
      "0.1.0-alpha.273",
      new Date("2026-04-08T22:00:00Z"),
      () => null,
    )
    expect(result.agents).toHaveLength(1)
    expect(result.agents[0]).toEqual({
      name: "slugger",
      bundlePath: "/Users/test/AgentBundles/slugger.ouro",
      status: "running",
      lastSeenAt: "2026-04-08T22:00:00.000Z",
      errorReason: null,
      fixHint: null,
      alertId: null,
      currentActivity: null,
    })
  })

  it("maps broken snapshots to PulseAgentEntry with errorReason, fixHint, and alertId", () => {
    const snap = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "secrets.json for 'ouroboros' is missing providers.github-copilot section",
      fixHint: "Run 'ouro auth ouroboros' to configure github-copilot credentials.",
    })
    const result = buildPulseState([snap], "/tmp/bundles", "0.1.0-alpha.273", new Date("2026-04-08T22:00:00Z"))
    expect(result.agents[0]!.errorReason).toContain("github-copilot section")
    expect(result.agents[0]!.fixHint).toContain("ouro auth ouroboros")
    expect(result.agents[0]!.alertId).not.toBeNull()
    expect(result.agents[0]!.alertId).toMatch(/^ouroboros:[a-f0-9]+$/)
  })

  it("preserves the snapshot order in the agents list", () => {
    const result = buildPulseState(
      [
        makeSnapshot({ name: "slugger" }),
        makeSnapshot({ name: "ouroboros" }),
      ],
      "/tmp/bundles",
      "v",
      new Date("2026-04-08T22:00:00Z"),
    )
    expect(result.agents.map((a) => a.name)).toEqual(["slugger", "ouroboros"])
  })
})

describe("findNovelBrokenAgents", () => {
  function entry(overrides: Partial<PulseAgentEntry>): PulseAgentEntry {
    return {
      name: "x",
      bundlePath: "/tmp/x.ouro",
      status: "running",
      lastSeenAt: null,
      errorReason: null,
      fixHint: null,
      alertId: null,
      currentActivity: null,
      ...overrides,
    }
  }

  function state(agents: PulseAgentEntry[]): PulseState {
    return { generatedAt: "2026-04-08T22:00:00Z", daemonVersion: "v", agents }
  }

  it("returns empty when nothing is broken", () => {
    const next = state([entry({ name: "slugger" }), entry({ name: "ouroboros" })])
    expect(findNovelBrokenAgents(null, next)).toEqual([])
  })

  it("returns newly-broken agents when prev is null (first pulse)", () => {
    const next = state([
      entry({ name: "slugger" }),
      entry({ name: "ouroboros", status: "crashed", errorReason: "boom", alertId: "ouroboros:abc" }),
    ])
    const novel = findNovelBrokenAgents(null, next)
    expect(novel).toHaveLength(1)
    expect(novel[0]!.name).toBe("ouroboros")
  })

  it("excludes agents that were broken in prev with the same alertId (no re-page)", () => {
    const broken = entry({ name: "ouroboros", status: "crashed", errorReason: "boom", alertId: "ouroboros:abc" })
    const prev = state([entry({ name: "slugger" }), broken])
    const next = state([entry({ name: "slugger" }), broken])
    expect(findNovelBrokenAgents(prev, next)).toEqual([])
  })

  it("includes agents that transitioned from one error to a different error (re-page)", () => {
    const prev = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "missing provider", alertId: "ouroboros:111" }),
    ])
    const next = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "agent.json not found", alertId: "ouroboros:222" }),
    ])
    const novel = findNovelBrokenAgents(prev, next)
    expect(novel).toHaveLength(1)
    expect(novel[0]!.alertId).toBe("ouroboros:222")
  })

  it("includes agents that transitioned from healthy to broken", () => {
    const prev = state([entry({ name: "ouroboros" })])
    const next = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "boom", alertId: "ouroboros:abc" }),
    ])
    expect(findNovelBrokenAgents(prev, next)).toHaveLength(1)
  })

  it("excludes agents in the prev state that were healthy and are still healthy", () => {
    const prev = state([entry({ name: "slugger" })])
    const next = state([entry({ name: "slugger" })])
    expect(findNovelBrokenAgents(prev, next)).toEqual([])
  })
})

describe("pickWakeRecipient", () => {
  function entry(overrides: Partial<PulseAgentEntry>): PulseAgentEntry {
    return {
      name: "x",
      bundlePath: "/tmp/x.ouro",
      status: "running",
      lastSeenAt: null,
      errorReason: null,
      fixHint: null,
      alertId: null,
      currentActivity: null,
      ...overrides,
    }
  }

  function state(agents: PulseAgentEntry[]): PulseState {
    return { generatedAt: "2026-04-08T22:00:00Z", daemonVersion: "v", agents }
  }

  it("returns null when no other agents are running", () => {
    const s = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "boom", alertId: "ouroboros:abc" }),
    ])
    expect(pickWakeRecipient(s, "ouroboros")).toBeNull()
  })

  it("returns the only other running agent when there is exactly one", () => {
    const s = state([
      entry({ name: "slugger", lastSeenAt: "2026-04-08T22:00:00Z" }),
      entry({ name: "ouroboros", status: "crashed", errorReason: "boom", alertId: "ouroboros:abc" }),
    ])
    expect(pickWakeRecipient(s, "ouroboros")).toBe("slugger")
  })

  it("picks the most-recently-active running agent when multiple eligible", () => {
    const s = state([
      entry({ name: "alpha", lastSeenAt: "2026-04-08T20:00:00Z" }),
      entry({ name: "bravo", lastSeenAt: "2026-04-08T22:00:00Z" }),
      entry({ name: "charlie", lastSeenAt: "2026-04-08T21:00:00Z" }),
      entry({ name: "broken", status: "crashed", errorReason: "boom", alertId: "broken:abc" }),
    ])
    expect(pickWakeRecipient(s, "broken")).toBe("bravo")
  })

  it("excludes the broken agent itself", () => {
    const s = state([
      entry({ name: "broken", status: "running", lastSeenAt: "2026-04-08T22:00:00Z" }),
    ])
    expect(pickWakeRecipient(s, "broken")).toBeNull()
  })

  it("excludes non-running agents (stopped, starting, crashed)", () => {
    const s = state([
      entry({ name: "stopped", status: "stopped", lastSeenAt: "2026-04-08T22:00:00Z" }),
      entry({ name: "starting", status: "starting", lastSeenAt: "2026-04-08T22:00:00Z" }),
      entry({ name: "broken", status: "crashed", errorReason: "boom", alertId: "broken:abc" }),
    ])
    expect(pickWakeRecipient(s, "broken")).toBeNull()
  })

  it("excludes running agents that have never been seen alive (lastSeenAt null)", () => {
    const s = state([
      entry({ name: "neverseen", status: "running", lastSeenAt: null }),
      entry({ name: "broken", status: "crashed", errorReason: "boom", alertId: "broken:abc" }),
    ])
    expect(pickWakeRecipient(s, "broken")).toBeNull()
  })
})

describe("writePulse / readPulse roundtrip", () => {
  it("writes a pulse state and reads it back identically", () => {
    let written = ""
    const state: PulseState = {
      generatedAt: "2026-04-08T22:00:00.000Z",
      daemonVersion: "0.1.0-alpha.273",
      agents: [
        {
          name: "slugger",
          bundlePath: "/tmp/bundles/slugger.ouro",
          status: "running",
          lastSeenAt: "2026-04-08T22:00:00.000Z",
          errorReason: null,
          fixHint: null,
          alertId: null,
        },
      ],
    }

    writePulse(state, {
      writeFile: (_p, c) => { written = c },
      mkdirp: vi.fn(),
      pulsePath: "/tmp/pulse.json",
    })

    const result = readPulse({
      readFile: () => written,
      pulsePath: "/tmp/pulse.json",
    })
    expect(result).toEqual(state)
  })

  it("readPulse returns null when the file is missing", () => {
    const result = readPulse({
      readFile: () => { throw new Error("ENOENT") },
      pulsePath: "/tmp/missing.json",
    })
    expect(result).toBeNull()
  })

  it("readPulse returns null when the file is malformed JSON", () => {
    const result = readPulse({
      readFile: () => "not json {{",
      pulsePath: "/tmp/bad.json",
    })
    expect(result).toBeNull()
  })

  it("readPulse returns null when generatedAt is wrong type", () => {
    const result = readPulse({
      readFile: () => JSON.stringify({ generatedAt: 42 }),
      pulsePath: "/tmp/wrong.json",
    })
    expect(result).toBeNull()
  })

  it("readPulse returns null when daemonVersion is missing", () => {
    const result = readPulse({
      readFile: () => JSON.stringify({ generatedAt: "2026-04-08T22:00:00Z" }),
      pulsePath: "/tmp/wrong.json",
    })
    expect(result).toBeNull()
  })

  it("readPulse returns null when agents is not an array", () => {
    const result = readPulse({
      readFile: () => JSON.stringify({
        generatedAt: "2026-04-08T22:00:00Z",
        daemonVersion: "v",
        agents: "not an array",
      }),
      pulsePath: "/tmp/wrong.json",
    })
    expect(result).toBeNull()
  })

  it("readPulse filters out invalid agent entries but keeps valid ones", () => {
    const result = readPulse({
      readFile: () => JSON.stringify({
        generatedAt: "2026-04-08T22:00:00Z",
        daemonVersion: "v",
        agents: [
          { name: "slugger", bundlePath: "/x", status: "running", lastSeenAt: null, errorReason: null, fixHint: null, alertId: null, currentActivity: null },
          { malformed: true },
          "not even an object",
          { name: "ouroboros", bundlePath: "/y", status: "crashed", lastSeenAt: null, errorReason: "x", fixHint: "y", alertId: "ouroboros:abc", currentActivity: null },
        ],
      }),
      pulsePath: "/tmp/mixed.json",
    })
    expect(result?.agents.map((a) => a.name)).toEqual(["slugger", "ouroboros"])
  })

  it("writePulse swallows write errors (best-effort)", () => {
    expect(() => writePulse({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "v",
      agents: [],
    }, {
      writeFile: () => { throw new Error("EACCES") },
      mkdirp: vi.fn(),
      pulsePath: "/tmp/x.json",
    })).not.toThrow()
  })

  it("writePulse creates the parent directory before writing", () => {
    const mkdirp = vi.fn()
    writePulse({
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "v",
      agents: [],
    }, {
      writeFile: vi.fn(),
      mkdirp,
      pulsePath: "/tmp/nested/dir/pulse.json",
    })
    expect(mkdirp).toHaveBeenCalledWith("/tmp/nested/dir")
  })
})

describe("delivered state roundtrip and pruning", () => {
  it("readDeliveredState returns empty set when file is missing", () => {
    const result = readDeliveredState({
      readFile: () => { throw new Error("ENOENT") },
      deliveredPath: "/tmp/missing.json",
    })
    expect(result.size).toBe(0)
  })

  it("readDeliveredState returns empty set when file is malformed", () => {
    const result = readDeliveredState({
      readFile: () => "not json",
      deliveredPath: "/tmp/bad.json",
    })
    expect(result.size).toBe(0)
  })

  it("readDeliveredState filters out non-string entries", () => {
    const result = readDeliveredState({
      readFile: () => JSON.stringify({ delivered: ["a", 42, "b", null, "c"] }),
      deliveredPath: "/tmp/mixed.json",
    })
    expect([...result].sort()).toEqual(["a", "b", "c"])
  })

  it("readDeliveredState returns empty set when delivered field is not an array", () => {
    const result = readDeliveredState({
      readFile: () => JSON.stringify({ delivered: "not an array" }),
      deliveredPath: "/tmp/x.json",
    })
    expect(result.size).toBe(0)
  })

  it("writeDeliveredState writes a sorted JSON array of ids", () => {
    let written = ""
    writeDeliveredState(new Set(["c", "a", "b"]), {
      writeFile: (_p, c) => { written = c },
      mkdirp: vi.fn(),
      deliveredPath: "/tmp/delivered.json",
    })
    const parsed = JSON.parse(written) as { delivered: string[] }
    expect(parsed.delivered).toEqual(["a", "b", "c"])
  })

  it("writeDeliveredState swallows write errors (best-effort)", () => {
    expect(() => writeDeliveredState(new Set(["a"]), {
      writeFile: () => { throw new Error("EACCES") },
      mkdirp: vi.fn(),
      deliveredPath: "/tmp/x.json",
    })).not.toThrow()
  })

  it("pruneDeliveredState drops ids that no longer correspond to a live alert", () => {
    const state: PulseState = {
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "v",
      agents: [
        { name: "slugger", bundlePath: "/x", status: "running", lastSeenAt: null, errorReason: null, fixHint: null, alertId: null, currentActivity: null },
        { name: "ouroboros", bundlePath: "/y", status: "crashed", lastSeenAt: null, errorReason: "still broken", fixHint: null, alertId: "ouroboros:abc", currentActivity: null },
      ],
    }
    const before = new Set(["ouroboros:abc", "slugger:old", "ouroboros:previous"])
    const after = pruneDeliveredState(before, state)
    expect([...after]).toEqual(["ouroboros:abc"])
  })

  it("pruneDeliveredState returns an empty set when no agents are broken", () => {
    const state: PulseState = {
      generatedAt: "2026-04-08T22:00:00Z",
      daemonVersion: "v",
      agents: [
        { name: "slugger", bundlePath: "/x", status: "running", lastSeenAt: null, errorReason: null, fixHint: null, alertId: null, currentActivity: null },
      ],
    }
    const before = new Set(["ouroboros:abc", "slugger:xyz"])
    expect(pruneDeliveredState(before, state).size).toBe(0)
  })
})

describe("path defaults", () => {
  it("getPulsePath returns ~/.ouro-cli/pulse.json", () => {
    const p = getPulsePath()
    expect(p).toContain(".ouro-cli")
    expect(p).toContain("pulse.json")
  })

  it("getPulseDeliveredPath returns ~/.ouro-cli/pulse-delivered.json", () => {
    const p = getPulseDeliveredPath()
    expect(p).toContain(".ouro-cli")
    expect(p).toContain("pulse-delivered.json")
  })
})

describe("readAgentActivity", () => {
  it("returns null when runtime.json is missing", () => {
    const result = readAgentActivity("/tmp/missing.ouro", () => { throw new Error("ENOENT") })
    expect(result).toBeNull()
  })

  it("returns null when runtime.json is malformed JSON", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => "not json")
    expect(result).toBeNull()
  })

  it("returns null when status is missing", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => JSON.stringify({ reason: "x", startedAt: "y" }))
    expect(result).toBeNull()
  })

  it("formats running + reason + startedAt as 'running (reason since HH:MM)'", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => JSON.stringify({
      status: "running",
      reason: "instinct",
      startedAt: "2026-04-08T23:44:29.548Z",
    }))
    expect(result).toBe("running (instinct since 23:44)")
  })

  it("formats running + reason without startedAt as 'running (reason)'", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => JSON.stringify({
      status: "running",
      reason: "instinct",
    }))
    expect(result).toBe("running (instinct)")
  })

  it("formats non-running status as '<status> since HH:MM'", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => JSON.stringify({
      status: "idle",
      startedAt: "2026-04-08T21:30:00Z",
    }))
    expect(result).toBe("idle since 21:30")
  })

  it("formats running without reason as just 'running' (no parens)", () => {
    const result = readAgentActivity("/tmp/x.ouro", () => JSON.stringify({
      status: "running",
    }))
    expect(result).toBe("running")
  })
})

describe("findRecoveredAgents", () => {
  function entry(overrides: Partial<PulseAgentEntry>): PulseAgentEntry {
    return {
      name: "x",
      bundlePath: "/tmp/x.ouro",
      status: "running",
      lastSeenAt: null,
      errorReason: null,
      fixHint: null,
      alertId: null,
      currentActivity: null,
      ...overrides,
    }
  }

  function state(agents: PulseAgentEntry[]): PulseState {
    return { generatedAt: "2026-04-08T22:00:00Z", daemonVersion: "v", agents }
  }

  it("returns empty when prev is null (no recovery is possible without history)", () => {
    const next = state([entry({ name: "slugger" })])
    expect(findRecoveredAgents(null, next)).toEqual([])
  })

  it("returns empty when nothing has changed (still healthy)", () => {
    const prev = state([entry({ name: "slugger" })])
    const next = state([entry({ name: "slugger" })])
    expect(findRecoveredAgents(prev, next)).toEqual([])
  })

  it("returns the agent that recovered from broken to healthy", () => {
    const prev = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "missing creds", alertId: "ouroboros:abc" }),
    ])
    const next = state([entry({ name: "ouroboros", status: "running" })])
    const recovered = findRecoveredAgents(prev, next)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.name).toBe("ouroboros")
  })

  it("excludes agents that are still broken", () => {
    const prev = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "missing creds", alertId: "ouroboros:abc" }),
    ])
    const next = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "missing creds", alertId: "ouroboros:abc" }),
    ])
    expect(findRecoveredAgents(prev, next)).toEqual([])
  })

  it("excludes agents that healed but are not currently running (e.g., stopped)", () => {
    const prev = state([
      entry({ name: "ouroboros", status: "crashed", errorReason: "x", alertId: "ouroboros:abc" }),
    ])
    const next = state([entry({ name: "ouroboros", status: "stopped" })])
    expect(findRecoveredAgents(prev, next)).toEqual([])
  })
})

describe("buildRecoveryAlertId", () => {
  it("produces a stable id for the same (agent, recoveredAt) pair", () => {
    const a = buildRecoveryAlertId("ouroboros", "2026-04-08T22:00:00Z")
    const b = buildRecoveryAlertId("ouroboros", "2026-04-08T22:00:00Z")
    expect(a).toBe(b)
    expect(a).toContain("recovery:")
    expect(a).toContain("ouroboros")
  })

  it("produces different ids for different recovery times (so successive recoveries re-page)", () => {
    const a = buildRecoveryAlertId("ouroboros", "2026-04-08T22:00:00Z")
    const b = buildRecoveryAlertId("ouroboros", "2026-04-08T23:00:00Z")
    expect(a).not.toBe(b)
  })
})

describe("flushPulse", () => {
  function makeFlushDeps(overrides: {
    snapshots: DaemonAgentSnapshot[]
    prev?: PulseState | null
    delivered?: Set<string>
    fireInnerWake?: ReturnType<typeof vi.fn>
    writtenStateRef?: { state: PulseState | null }
    writtenDeliveredRef?: { delivered: Set<string> | null }
  }) {
    return {
      snapshots: overrides.snapshots,
      bundlesRoot: "/Users/test/AgentBundles",
      daemonVersion: "0.1.0-alpha.273",
      now: new Date("2026-04-08T22:00:00Z"),
      readPrev: () => overrides.prev ?? null,
      writeNext: (s: PulseState) => {
        if (overrides.writtenStateRef) overrides.writtenStateRef.state = s
      },
      readDelivered: () => overrides.delivered ?? new Set<string>(),
      writeDelivered: (d: Set<string>) => {
        if (overrides.writtenDeliveredRef) overrides.writtenDeliveredRef.delivered = d
      },
      fireInnerWake: overrides.fireInnerWake ?? vi.fn(),
    }
  }

  it("writes the new pulse state to disk on every flush", () => {
    const writtenRef: { state: PulseState | null } = { state: null }
    const result = flushPulse(makeFlushDeps({
      snapshots: [makeSnapshot({ name: "slugger" })],
      writtenStateRef: writtenRef,
    }))

    expect(writtenRef.state).not.toBeNull()
    expect(writtenRef.state!.agents).toHaveLength(1)
    expect(writtenRef.state!.agents[0]!.name).toBe("slugger")
    expect(result.state.agents[0]!.name).toBe("slugger")
  })

  it("fires no wakes when no agents are broken", () => {
    const wake = vi.fn()
    const result = flushPulse(makeFlushDeps({
      snapshots: [makeSnapshot({ name: "slugger" }), makeSnapshot({ name: "ouroboros" })],
      fireInnerWake: wake,
    }))

    expect(wake).not.toHaveBeenCalled()
    expect(result.wakeFiredFor).toEqual([])
    expect(result.newlyDelivered).toEqual([])
  })

  it("fires inner.wake on the most-recently-active sibling when an agent newly breaks", () => {
    const wake = vi.fn()
    const writtenStateRef: { state: PulseState | null } = { state: null }
    const writtenDeliveredRef: { delivered: Set<string> | null } = { delivered: null }

    const result = flushPulse(makeFlushDeps({
      snapshots: [
        makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" }),
        makeSnapshot({
          name: "ouroboros",
          status: "crashed",
          errorReason: "missing github-copilot creds",
          fixHint: "run `ouro auth ouroboros`",
        }),
      ],
      prev: null,
      fireInnerWake: wake,
      writtenStateRef,
      writtenDeliveredRef,
    }))

    expect(wake).toHaveBeenCalledWith("slugger")
    expect(result.wakeFiredFor).toEqual(["slugger"])
    expect(result.newlyDelivered).toHaveLength(1)
    expect(writtenDeliveredRef.delivered?.size).toBe(1)
  })

  it("does not re-fire inner.wake on the same alert across daemon restarts (persistent at-most-once)", () => {
    const broken = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing creds",
      fixHint: "run `ouro auth`",
    })
    const slugger = makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" })

    // First flush: brand-new break, wake fires, alert is delivered.
    const wake1 = vi.fn()
    flushPulse(makeFlushDeps({
      snapshots: [slugger, broken],
      prev: null,
      delivered: new Set(),
      fireInnerWake: wake1,
    }))
    expect(wake1).toHaveBeenCalledTimes(1)

    // Compute the alertId that should now be in the delivered set.
    const expectedAlertId = buildAlertId("ouroboros", "missing creds")

    // Second flush — simulating a daemon restart that picks up the same
    // broken state from disk. The delivered set has the alert ID; no
    // wake should fire.
    const wake2 = vi.fn()
    flushPulse(makeFlushDeps({
      snapshots: [slugger, broken],
      prev: null,
      delivered: new Set([expectedAlertId]),
      fireInnerWake: wake2,
    }))
    expect(wake2).not.toHaveBeenCalled()
  })

  it("fires a fresh wake when the same agent transitions from one error to a different error", () => {
    const slugger = makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" })
    const oldBroken = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing github-copilot creds",
    })
    const newBroken = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "agent.json not found",
    })

    const oldAlertId = buildAlertId("ouroboros", "missing github-copilot creds")
    const prev = buildPulseState([slugger, oldBroken], "/x", "v", new Date("2026-04-08T21:00:00Z"))

    const wake = vi.fn()
    flushPulse(makeFlushDeps({
      snapshots: [slugger, newBroken],
      prev,
      delivered: new Set([oldAlertId]),
      fireInnerWake: wake,
    }))

    expect(wake).toHaveBeenCalledWith("slugger")
  })

  it("prunes delivered alerts for agents that have healed", () => {
    const slugger = makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" })
    // ouroboros: previously broken, now healthy
    const ouroborosHealed = makeSnapshot({ name: "ouroboros", startedAt: "2026-04-08T22:00:00.000Z" })

    const oldAlertId = buildAlertId("ouroboros", "missing creds")
    const writtenDeliveredRef: { delivered: Set<string> | null } = { delivered: null }

    flushPulse(makeFlushDeps({
      snapshots: [slugger, ouroborosHealed],
      delivered: new Set([oldAlertId]),
      writtenDeliveredRef,
    }))

    expect(writtenDeliveredRef.delivered?.has(oldAlertId)).toBe(false)
  })

  it("marks an alert delivered even when no recipient is available (avoids spam)", () => {
    // Only one agent on the machine, and they're broken — no one to wake.
    // The alert should still be marked delivered so the daemon doesn't
    // try again on every snapshot change.
    const onlyAgent = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing creds",
    })

    const wake = vi.fn()
    const writtenDeliveredRef: { delivered: Set<string> | null } = { delivered: null }
    const result = flushPulse(makeFlushDeps({
      snapshots: [onlyAgent],
      fireInnerWake: wake,
      writtenDeliveredRef,
    }))

    expect(wake).not.toHaveBeenCalled()
    expect(result.newlyDelivered).toHaveLength(1)
    expect(writtenDeliveredRef.delivered?.size).toBe(1)
  })

  it("fires inner.wake on a recovery transition (broken → healthy)", () => {
    // Prev: ouroboros was crashed. Next: ouroboros is running. We should
    // wake the most-recently-active sibling so the user gets a positive
    // notification that their fix took effect.
    const slugger = makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" })
    const ouroborosBefore = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing creds",
      fixHint: "fix it",
    })
    const ouroborosAfter = makeSnapshot({
      name: "ouroboros",
      status: "running",
      startedAt: "2026-04-08T22:00:00.000Z",
    })

    // Previous pulse state has ouroboros broken; the alert was already delivered.
    const prevAlertId = buildAlertId("ouroboros", "missing creds")
    const prev = buildPulseState([slugger, ouroborosBefore], "/x", "v", new Date("2026-04-08T21:00:00Z"), () => null)

    const wake = vi.fn()
    const result = flushPulse({
      snapshots: [slugger, ouroborosAfter],
      bundlesRoot: "/Users/test/AgentBundles",
      daemonVersion: "0.1.0-alpha.273",
      now: new Date("2026-04-08T22:00:00Z"),
      readPrev: () => prev,
      writeNext: () => {},
      readDelivered: () => new Set([prevAlertId]),
      writeDelivered: () => {},
      fireInnerWake: wake,
    })

    // Should have fired a wake on slugger for the recovery
    expect(wake).toHaveBeenCalledWith("slugger")
    expect(result.wakeFiredFor).toContain("slugger")
    // The recovery alert ID should be marked delivered
    expect(result.newlyDelivered.some((id) => id.startsWith("recovery:ouroboros:"))).toBe(true)
  })

  it("marks recovery alert delivered even when no wake recipient is available", () => {
    // Single-agent recovery: ouroboros recovered, but it's the only agent
    // on the machine — no one to wake. The alert still gets marked
    // delivered so subsequent flushes don't reattempt.
    const ouroborosAfter = makeSnapshot({
      name: "ouroboros",
      status: "running",
      startedAt: "2026-04-08T22:00:00.000Z",
    })
    const ouroborosBefore = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing creds",
    })

    const prev = buildPulseState([ouroborosBefore], "/x", "v", new Date("2026-04-08T21:00:00Z"), () => null)

    const wake = vi.fn()
    const writtenDeliveredRef: { delivered: Set<string> | null } = { delivered: null }
    const result = flushPulse({
      snapshots: [ouroborosAfter],
      bundlesRoot: "/Users/test/AgentBundles",
      daemonVersion: "0.1.0-alpha.273",
      now: new Date("2026-04-08T22:00:00Z"),
      readPrev: () => prev,
      writeNext: () => {},
      readDelivered: () => new Set(),
      writeDelivered: (d) => { writtenDeliveredRef.delivered = d },
      fireInnerWake: wake,
    })

    expect(wake).not.toHaveBeenCalled()
    expect(result.newlyDelivered.some((id) => id.startsWith("recovery:"))).toBe(true)
  })

  it("does not re-fire recovery wakes once delivered", () => {
    // Same scenario but the recovery alert has already been delivered.
    const slugger = makeSnapshot({ name: "slugger", startedAt: "2026-04-08T22:00:00.000Z" })
    const ouroborosAfter = makeSnapshot({
      name: "ouroboros",
      status: "running",
      startedAt: "2026-04-08T22:00:00.000Z",
    })
    const ouroborosBefore = makeSnapshot({
      name: "ouroboros",
      status: "crashed",
      errorReason: "missing creds",
    })

    const prev = buildPulseState([slugger, ouroborosBefore], "/x", "v", new Date("2026-04-08T21:00:00Z"), () => null)
    const recoveryAlertId = buildRecoveryAlertId("ouroboros", "2026-04-08T22:00:00.000Z")

    const wake = vi.fn()
    flushPulse({
      snapshots: [slugger, ouroborosAfter],
      bundlesRoot: "/Users/test/AgentBundles",
      daemonVersion: "0.1.0-alpha.273",
      now: new Date("2026-04-08T22:00:00Z"),
      readPrev: () => prev,
      writeNext: () => {},
      readDelivered: () => new Set([recoveryAlertId]),
      writeDelivered: () => {},
      fireInnerWake: wake,
    })

    expect(wake).not.toHaveBeenCalled()
  })
})
