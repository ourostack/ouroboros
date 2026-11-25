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
import { finalHandoffBlockers, judgeRestartAfterUpFailure } from "../../../heart/daemon/handoff-blockers"
import { emitNervesEvent } from "../../../nerves/runtime"

function payload(overrides: Partial<StatusPayload>): StatusPayload {
  return { overview: {} as StatusPayload["overview"], senses: [], workers: [], healthChecks: [], sync: [], agents: [], providers: [], ...overrides }
}

const blueBubblesDown = { key: "slugger/bluebubbles", text: "slugger/bluebubbles: error - Cannot reach BlueBubbles" }
const canaryCritical = { key: "mcp-canary", text: "mcp-canary: critical - canary failed" }

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
      "slugger/inner", "slugger/plain", "slugger/bluebubbles", "mcp-canary", "sense-probe:bluebubbles", "cron-health",
    ])
  })
})

describe("judgeRestartAfterUpFailure", () => {
  const upFailure = "ouro-launcher.js up exited 1: runtime health is warn"

  it("accepts a release that answers when every blocker predates the update (one sense down, 2026-11-25)", () => {
    const result = judgeRestartAfterUpFailure({
      upFailure,
      expectedVersion: "0.1.0-alpha.1586",
      seenVersion: "0.1.0-alpha.1586",
      before: [blueBubblesDown, canaryCritical],
      after: [{ ...blueBubblesDown, text: "slugger/bluebubbles: error - still down" }],
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
    expect(judgeRestartAfterUpFailure({
      upFailure, expectedVersion: "v2", seenVersion: "v2", before: [blueBubblesDown], after: [],
    })).toEqual({ ok: true, detail: "came up on v2" })
  })

  it("rejects a release that introduced a blocker", () => {
    expect(judgeRestartAfterUpFailure({
      upFailure, expectedVersion: "v2", seenVersion: "v2", before: [], after: [blueBubblesDown],
    })).toEqual({ ok: false, detail: `${upFailure}; new since the update: ${blueBubblesDown.text}` })
  })

  it("rejects when the daemon did not answer on the release, or answered on another", () => {
    expect(judgeRestartAfterUpFailure({ upFailure, expectedVersion: "v2", seenVersion: null, before: [], after: null }))
      .toEqual({ ok: false, detail: `${upFailure}; the daemon did not answer` })
    expect(judgeRestartAfterUpFailure({ upFailure, expectedVersion: "v2", seenVersion: "v1", before: [], after: null }))
      .toEqual({ ok: false, detail: `${upFailure}; the daemon answered with v1` })
  })

  it("rejects when status before or after could not be read", () => {
    const detail = `${upFailure}; could not compare daemon status before and after the update`
    expect(judgeRestartAfterUpFailure({ upFailure, expectedVersion: "v2", seenVersion: "v2", before: null, after: [] }))
      .toEqual({ ok: false, detail })
    expect(judgeRestartAfterUpFailure({ upFailure, expectedVersion: "v2", seenVersion: "v2", before: [], after: null }))
      .toEqual({ ok: false, detail })
  })
})
