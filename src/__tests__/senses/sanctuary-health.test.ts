import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createSanctuaryHealthSweep, probeSanctuaryEndpoint } from "../../senses/sanctuary-health"

function context(state: "running" | "exited", autostart = true) {
  return { sanctuary: {
    listContainers: vi.fn().mockResolvedValue({ ok: true, data: { containers: [{ id: "Docker:a", name: "calibre-web", autostart, state, exitCode: state === "exited" ? 1 : null, degraded: false, status: state === "running" ? "Up 2 hours" : "Exited (1) 2 minutes ago" }], truncated: false } }),
    getStorage: vi.fn().mockResolvedValue({ ok: true, data: { array: { state: "STARTED", usedPercent: 76, degraded: false }, shares: [], truncated: false } }),
    getDisks: vi.fn().mockResolvedValue({ ok: true, data: { disks: [{ id: "Disk:1", name: "disk1", smart: "passed", temperatureC: 35, degraded: false }], parity: { result: "success", ageHours: 10, degraded: false }, truncated: false } }),
    getNotifications: vi.fn().mockResolvedValue({ ok: true, data: { unacknowledged: [], truncated: false } }),
    getSystem: vi.fn().mockResolvedValue({ ok: true, data: { serverName: "sanctuary", degraded: false } }),
  } } as any
}

describe("Sanctuary deterministic health sweep", () => {
  it("follows only bounded same-origin HTTPS redirects with manual redirect control", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: "/ready" } }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }))

    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", fetch)).resolves.toEqual({
      url: "https://books.mendelow.cloud/",
      ok: true,
      status: 200,
    })
    expect(fetch).toHaveBeenNthCalledWith(1, "https://books.mendelow.cloud/", expect.objectContaining({ redirect: "manual" }))
    expect(fetch).toHaveBeenNthCalledWith(2, "https://books.mendelow.cloud/ready", expect.objectContaining({ redirect: "manual" }))
  })

  it("rejects redirects that change origin without contacting the target", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://attacker.example/" } }))

    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", fetch)).resolves.toEqual({
      url: "https://books.mendelow.cloud/",
      ok: false,
      status: 0,
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

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

  it("reports a named mandate container down even when Unraid autostart is disabled", async () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-")), "state.json")
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("exited", false),
      statePath,
      fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    })

    expect((await sweep()).message).toContain("calibre-web is exited")
  })
})
