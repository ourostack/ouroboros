import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createSanctuaryHealthSweep } from "../../senses/sanctuary-health"

function context(state: "running" | "exited") {
  return { sanctuary: {
    listContainers: vi.fn().mockResolvedValue({ ok: true, data: { containers: [{ id: "Docker:a", name: "calibre-web", autostart: true, state, exitCode: state === "exited" ? 1 : null, degraded: false, status: state === "running" ? "Up 2 hours" : "Exited (1) 2 minutes ago" }], truncated: false } }),
    getStorage: vi.fn().mockResolvedValue({ ok: true, data: { array: { state: "STARTED", usedPercent: 76, degraded: false }, shares: [], truncated: false } }),
    getDisks: vi.fn().mockResolvedValue({ ok: true, data: { disks: [{ id: "Disk:1", name: "disk1", smart: "passed", temperatureC: 35, degraded: false }], parity: { result: "success", ageHours: 10, degraded: false }, truncated: false } }),
    getNotifications: vi.fn().mockResolvedValue({ ok: true, data: { unacknowledged: [], truncated: false } }),
    getSystem: vi.fn().mockResolvedValue({ ok: true, data: { serverName: "sanctuary", degraded: false } }),
  } } as any
}

describe("Sanctuary deterministic health sweep", () => {
  it("alerts once on transition, suppresses unchanged, and emits one recovery", async () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-")), "state.json")
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
    const now = () => new Date("2026-08-18T18:00:00.000Z")
    const broken = createSanctuaryHealthSweep({ toolContext: context("exited"), statePath, fetch, now })
    expect((await broken()).message).toContain("calibre-web")
    expect((await broken()).message).toBeNull()

    const healthy = createSanctuaryHealthSweep({ toolContext: context("running"), statePath, fetch, now })
    expect((await healthy()).message).toContain("recovered")
    expect((await healthy()).message).toBeNull()
  })
})
