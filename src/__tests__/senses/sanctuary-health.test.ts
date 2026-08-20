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
    let clock = new Date("2026-08-18T18:00:00.000Z")
    const now = () => clock
    const broken = createSanctuaryHealthSweep({ toolContext: context("exited"), statePath, fetch, now })
    const opened = await broken()
    expect(opened.message).toContain("calibre-web")
    expect(opened.deliveryId).toBeTypeOf("string")
    expect((await broken())).toMatchObject({ message: opened.message, deliveryId: opened.deliveryId })
    await broken.cacheDeliveryPayload(opened.deliveryId!, "cached private summary")
    expect(await broken()).toMatchObject({ deliveryId: opened.deliveryId, cachedMessage: "cached private summary" })
    await broken.markDeliveryAttempting(opened.deliveryId!)
    const restarted = createSanctuaryHealthSweep({ toolContext: context("exited"), statePath, fetch, now })
    expect((await restarted()).message).toBeNull()
    clock = new Date("2026-08-19T18:00:00.000Z")
    const nextDigest = await restarted()
    expect(nextDigest.deliveryId).not.toBe(opened.deliveryId)
    expect(nextDigest.message).toContain("prior Telegram delivery was indeterminate")
    await restarted.markDeliveryAttempting(nextDigest.deliveryId!)
    await restarted.markDelivered(nextDigest.deliveryId!, [7001])
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).deliveredReceipts).toEqual([
      expect.objectContaining({ deliveryId: nextDigest.deliveryId, messageIds: [7001] }),
    ])
    expect((await broken()).message).toBeNull()

    const healthy = createSanctuaryHealthSweep({ toolContext: context("running"), statePath, fetch, now })
    const recovered = await healthy()
    expect(recovered.message).toContain("recovered")
    await healthy.markDeliveryAttempting(recovered.deliveryId!)
    await healthy.markDelivered(recovered.deliveryId!, [7002])
    expect((await healthy()).message).toBeNull()
  })

  it("serializes overlapping sweeps so they share one durable delivery", async () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-overlap-")), "state.json")
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const toolContext = context("exited")
    toolContext.sanctuary.listContainers.mockImplementationOnce(async () => {
      await gate
      return { ok: true, data: { containers: [{ id: "Docker:a", name: "calibre-web", autostart: true, state: "exited", exitCode: 1, degraded: false, status: "Exited" }], truncated: false } }
    })
    const sweep = createSanctuaryHealthSweep({ toolContext, statePath, fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })), now: () => new Date("2026-08-18T18:00:00.000Z") })
    const first = sweep()
    const second = sweep()
    release()
    const [left, right] = await Promise.all([first, second])
    expect(right.deliveryId).toBe(left.deliveryId)
    expect(toolContext.sanctuary.listContainers).toHaveBeenCalledTimes(1)
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
