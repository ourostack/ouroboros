import { describe, expect, it, vi } from "vitest"

const mockEmitNervesEvent = vi.hoisted(() => vi.fn())
vi.mock("../../../nerves/runtime", async () => {
  const actual = await vi.importActual<typeof import("../../../nerves/runtime")>("../../../nerves/runtime")
  return {
    ...actual,
    emitNervesEvent: (event: Parameters<typeof actual.emitNervesEvent>[0]) => {
      mockEmitNervesEvent(event)
      return actual.emitNervesEvent(event)
    },
  }
})

import type { StatusPayload } from "../../../heart/daemon/cli-render"
import { finalHandoffBlockers, handoffSnapshot, judgeRestartAfterUpFailure, unsettledReason, type HandoffBlocker, type HandoffSnapshot } from "../../../heart/daemon/handoff-blockers"
import { emitNervesEvent } from "../../../nerves/runtime"

function payload(overrides: Partial<StatusPayload>): StatusPayload {
  return { overview: {} as StatusPayload["overview"], senses: [], workers: [], healthChecks: [], sync: [], agents: [], providers: [], ...overrides }
}

const blueBubblesDown = { key: "slugger/bluebubbles:error", text: "slugger/bluebubbles: error - Cannot reach BlueBubbles" }
const canaryCritical = { key: "mcp-canary:critical", text: "mcp-canary: critical - canary failed" }

/** A settled daemon: health checks reported and the usual workers listed. */
function snap(blockers: HandoffBlocker[], overrides: Partial<HandoffSnapshot> = {}): HandoffSnapshot {
  return { blockers, workers: ["slugger/inner", "slugger/bluebubbles"], healthCheckCount: 4, ...overrides }
}

describe("finalHandoffBlockers", () => {
  it("lists stopped workers, enabled senses that are not running, and blocking health checks, in that order", () => {
    emitNervesEvent({ component: "daemon", event: "daemon.handoff_blockers_test", message: "handoff blockers listing test", meta: {} })
    const blockers = finalHandoffBlockers(payload({
      workers: [
        { agent: "slugger", worker: "inner", status: "crashed", errorReason: "exit 1", fixHint: "ouro up" },
        { agent: "slugger", worker: "plain", status: "crashed", errorReason: null, fixHint: null },
        { agent: "slugger", worker: "idle", status: "stopped", autoStart: false },
        { agent: "slugger", worker: "chat", status: "running" },
      ] as unknown as StatusPayload["workers"],
      senses: [
        { agent: "slugger", sense: "bluebubbles", enabled: true, status: "error", detail: "Cannot reach BlueBubbles" },
        { agent: "slugger", sense: "teams", enabled: true, status: "running", detail: "ok" },
        { agent: "slugger", sense: "mail", enabled: false, status: "error", detail: "off" },
      ] as unknown as StatusPayload["senses"],
      healthChecks: [
        { name: "mcp-canary", status: "critical", message: "canary failed" },
        { name: "sense-probe:bluebubbles", status: "warn", message: "probe failing" },
        { name: "cron-health", status: "warn", message: "late" },
        { name: "disk", status: "warn", message: "low" },
        { name: "agent-processes", status: "ok", message: "fine" },
      ],
    }))

    expect(blockers.map((blocker) => blocker.text)).toEqual([
      "slugger/inner: crashed - exit 1; fix: ouro up",
      "slugger/plain: crashed",
      "slugger/bluebubbles: error - Cannot reach BlueBubbles",
      "mcp-canary: critical - canary failed",
      "sense-probe:bluebubbles: warn - probe failing",
      "cron-health: warn - late",
    ])
    expect(blockers.map((blocker) => blocker.key)).toEqual([
      "slugger/inner:crashed", "slugger/plain:crashed", "slugger/bluebubbles:error", "mcp-canary:critical",
      "sense-probe:bluebubbles:warn", "cron-health:warn:late",
    ])
  })

  it("keys a summary check by its message and every check by severity, so a new failure cannot hide behind an old row", () => {
    const keys = (healthChecks: StatusPayload["healthChecks"]) => finalHandoffBlockers(payload({ healthChecks })).map((blocker) => blocker.key)
    expect(keys([{ name: "sense-probes", status: "warn", message: "bluebubbles failing" }]))
      .not.toEqual(keys([{ name: "sense-probes", status: "warn", message: "bluebubbles failing; mail failing" }]))
    expect(keys([{ name: "sense-probes", status: "warn", message: "bluebubbles failing" }]))
      .not.toEqual(keys([{ name: "sense-probes", status: "critical", message: "bluebubbles failing" }]))
    expect(keys([{ name: "sense-probe:mail", status: "warn", message: "slow" }]))
      .not.toEqual(keys([{ name: "sense-probe:mail", status: "critical", message: "slow" }]))
  })
})

describe("handoffSnapshot and unsettledReason", () => {
  it("records every listed worker and how many health checks reported", () => {
    const snapshot = handoffSnapshot(payload({
      workers: [{ agent: "slugger", worker: "inner", status: "running" }] as unknown as StatusPayload["workers"],
      healthChecks: [{ name: "disk", status: "ok", message: "fine" }],
    }))
    expect(snapshot).toEqual({ blockers: [], workers: ["slugger/inner"], healthCheckCount: 1 })
  })

  it("calls a new daemon unsettled until its health checks report and its old workers are listed", () => {
    const before = snap([])
    expect(unsettledReason(before, snap([], { healthCheckCount: 0 }))).toBe("the new daemon has not reported any health checks yet")
    expect(unsettledReason(before, snap([], { workers: ["slugger/inner"] })))
      .toBe("the new daemon does not list workers it had before: slugger/bluebubbles")
    expect(unsettledReason(before, snap([], { workers: ["slugger/inner", "slugger/bluebubbles", "slugger/mail"] }))).toBeNull()
  })
})

describe("judgeRestartAfterUpFailure", () => {
  const upFailure = "ouro-launcher.js up exited 3: runtime health is warn"
  const base = { upFailure, upRefusedOnHandoffHealth: true, expectedVersion: "v2", seenVersion: "v2" }

  it("accepts a release that answers when every blocker predates the update (one sense down, 2026-11-25)", () => {
    const result = judgeRestartAfterUpFailure({
      ...base,
      expectedVersion: "0.1.0-alpha.1586",
      seenVersion: "0.1.0-alpha.1586",
      before: snap([blueBubblesDown, canaryCritical]),
      after: snap([{ ...blueBubblesDown, text: "slugger/bluebubbles: error - still down" }]),
    })
    expect(result).toEqual({
      ok: true,
      detail: "came up on 0.1.0-alpha.1586; still blocked by what was already wrong before the update: slugger/bluebubbles: error - still down",
    })
    expect(mockEmitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "warn",
      event: "daemon.self_update_preexisting_blockers_accepted",
    }))
  })

  it("accepts a release whose blockers cleared by the time it answered", () => {
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([blueBubblesDown]), after: snap([]) }))
      .toEqual({ ok: true, detail: "came up on v2" })
  })

  it("accepts a newer release that came up in place of the expected one", () => {
    expect(judgeRestartAfterUpFailure({
      ...base,
      expectedVersion: "0.1.0-alpha.1710",
      seenVersion: "0.1.0-alpha.1711",
      before: snap([blueBubblesDown]),
      after: snap([]),
    })).toEqual({ ok: true, detail: "came up on 0.1.0-alpha.1711" })
  })

  it("rejects any up failure other than the final health refusal: a migration, provider step or timeout", () => {
    const failure = "ouro-launcher.js up exited 1: provider checks failed"
    expect(judgeRestartAfterUpFailure({ ...base, upFailure: failure, upRefusedOnHandoffHealth: false, before: snap([]), after: snap([]) }))
      .toEqual({ ok: false, detail: failure })
  })

  it("rejects a release that introduced a blocker, or made an old one worse", () => {
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([]), after: snap([blueBubblesDown]) }))
      .toEqual({ ok: false, detail: `${upFailure}; new since the update: ${blueBubblesDown.text}` })
    const probeWarn = { key: "sense-probe:mail:warn", text: "sense-probe:mail: warn - slow" }
    const probeCritical = { key: "sense-probe:mail:critical", text: "sense-probe:mail: critical - down" }
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([probeWarn]), after: snap([probeCritical]) }))
      .toEqual({ ok: false, detail: `${upFailure}; new since the update: ${probeCritical.text}` })
  })

  it("rejects a status read before the new daemon settled", () => {
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([blueBubblesDown]), after: snap([blueBubblesDown], { healthCheckCount: 0 }) }))
      .toEqual({ ok: false, detail: `${upFailure}; the new daemon has not reported any health checks yet` })
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([blueBubblesDown]), after: snap([blueBubblesDown], { workers: ["slugger/inner"] }) }))
      .toEqual({ ok: false, detail: `${upFailure}; the new daemon does not list workers it had before: slugger/bluebubbles` })
  })

  it("rejects when the daemon did not answer on the release, or answered on another", () => {
    expect(judgeRestartAfterUpFailure({ ...base, seenVersion: null, before: snap([]), after: null }))
      .toEqual({ ok: false, detail: `${upFailure}; the daemon did not answer` })
    expect(judgeRestartAfterUpFailure({ ...base, seenVersion: "v1", before: snap([]), after: null }))
      .toEqual({ ok: false, detail: `${upFailure}; the daemon answered with v1` })
  })

  it("rejects when status before or after could not be read", () => {
    const detail = `${upFailure}; could not compare daemon status before and after the update`
    expect(judgeRestartAfterUpFailure({ ...base, before: null, after: snap([]) })).toEqual({ ok: false, detail })
    expect(judgeRestartAfterUpFailure({ ...base, before: snap([]), after: null })).toEqual({ ok: false, detail })
  })
})
