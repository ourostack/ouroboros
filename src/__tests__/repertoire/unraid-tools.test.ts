import { describe, expect, it, vi } from "vitest"

import { createUnraidReadTools, normalizeDockerStatus } from "../../repertoire/tools-unraid"

describe("Unraid typed read tools", () => {
  it("normalizes only canonical Docker state/status pairs", () => {
    expect(normalizeDockerStatus("RUNNING", "Up 2 months")).toEqual({ state: "running", exitCode: null, degraded: false })
    expect(normalizeDockerStatus("RUNNING", "Up 2 seconds (healthy)")).toEqual({ state: "running", exitCode: null, degraded: false })
    expect(normalizeDockerStatus("running", "Up About a day (health: starting)")).toEqual({ state: "running", exitCode: null, degraded: false })
    expect(normalizeDockerStatus("Exited", "Exited (0) About a year ago")).toEqual({ state: "exited", exitCode: 0, degraded: false })
    expect(normalizeDockerStatus("exited", "Restarting (7) About a week ago")).toEqual({ state: "restarting", exitCode: 7, degraded: false })
    expect(normalizeDockerStatus("EXITED", "Exited (255) 2 months ago")).toEqual({ state: "exited", exitCode: 255, degraded: false })
    expect(normalizeDockerStatus("RUNNING", "Restarting (1) 3 days ago")).toEqual({ state: "restarting", exitCode: 1, degraded: false })
    expect(normalizeDockerStatus("RUNNING", "up 2 hours")).toEqual({ state: "unknown", exitCode: null, degraded: true })
    expect(normalizeDockerStatus("EXITED", "Exited (01) 1 hour ago")).toEqual({ state: "unknown", exitCode: null, degraded: true })
  })

  it("maps, bounds, and sorts the fixed container query", async () => {
    const read = vi.fn(async () => ({ docker: { containers: [
      { id: "sanctuary:b", names: ["/zeta"], state: "EXITED", status: "Exited (1) 2 months ago", autoStart: false },
      { id: "sanctuary:a", names: ["alpha"], state: "RUNNING", status: "Up 2 hours (healthy)", autoStart: true },
    ] } }))
    const tools = createUnraidReadTools({ read } as any)
    await expect(tools.listContainers()).resolves.toEqual({ ok: true, data: {
      containers: [
        { id: "sanctuary:a", name: "alpha", autostart: true, state: "running", exitCode: null, degraded: false, status: "Up 2 hours (healthy)" },
        { id: "sanctuary:b", name: "zeta", autostart: false, state: "exited", exitCode: 1, degraded: false, status: "Exited (1) 2 months ago" },
      ],
      truncated: false,
    } })
    expect(read.mock.calls[0]?.[0]).toContain("query SanctuaryContainers")
  })

  it("accepts the live 129-byte Docker PrefixedID without relaxing container-name bounds", async () => {
    const id = `${"a".repeat(64)}:${"b".repeat(64)}`
    const read = vi.fn(async () => ({ docker: { containers: [
      { id, names: ["/calibre-web"], state: "EXITED", status: "Exited (255) 2 months ago", autoStart: true },
    ] } }))

    await expect(createUnraidReadTools({ read } as any).listContainers()).resolves.toMatchObject({
      ok: true,
      data: { containers: [{ id, name: "calibre-web", state: "exited", exitCode: 255 }] },
    })
  })

  it("resolves logs by exact case-sensitive name and returns the 65,536-byte recent suffix", async () => {
    const huge = "x".repeat(70_000)
    const read = vi.fn()
      .mockResolvedValueOnce({ docker: { containers: [{ id: "sanctuary:a", names: ["calibre-web"], state: "EXITED", status: "Exited (255) 2 months ago", autoStart: false }] } })
      .mockResolvedValueOnce({ docker: { logs: { containerId: "sanctuary:a", lines: [{ timestamp: "2026-08-18T00:00:00Z", message: huge }], cursor: null } } })
      .mockResolvedValueOnce({ docker: { containers: [{ id: "sanctuary:a", names: ["calibre-web"], state: "EXITED", status: "Exited (255) 2 months ago", autoStart: false }] } })
    const tools = createUnraidReadTools({ read } as any)
    const result = await tools.getContainerLogs({ container: "calibre-web", tailLines: 200 })
    expect(result).toMatchObject({ ok: true, data: { container: { id: "sanctuary:a", name: "calibre-web" }, originalBytes: 70_000, returnedBytes: 65_536, truncated: true } })
    expect((result as any).data.text).toBe("x".repeat(65_536))
    await expect(tools.getContainerLogs({ container: "Calibre-web", tailLines: 1 })).resolves.toMatchObject({ ok: false, error: { code: "not_found" } })
  })

  it("maps storage, disks, notifications, and system through fixed documents", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({ array: { state: "STARTED", capacity: { kilobytes: { used: 2, free: 3, total: 5 } } }, shares: [{ id: "s1", name: "media", used: 1024, free: 1024, size: 2048 }] })
      .mockResolvedValueOnce({ disks: [{ id: "sanctuary:d1", name: "disk1", smartStatus: "PASSED", temperature: 38 }], array: { parityCheckStatus: { status: "COMPLETED", date: "2026-08-18T00:00:00Z", errors: 0, running: false } } })
      .mockResolvedValueOnce({ notifications: { list: [{ id: "n1", timestamp: "2026-08-18T00:00:00Z", importance: "WARNING", title: "Disk warm", subject: "disk1", description: "38C", type: "UNREAD" }] } })
      .mockResolvedValueOnce({ vars: { name: "Sanctuary", version: "7.2.3" }, info: { os: { uptime: 1234 }, versions: { core: { unraid: "7.2.3", api: "4.37.1" } } }, array: { state: "STARTED" } })
    const tools = createUnraidReadTools({ read } as any)
    await expect(tools.getStorage()).resolves.toMatchObject({ ok: true, data: { array: { usedBytes: 2048, freeBytes: 3072, usedPercent: 40 }, shares: [{ name: "media", usedBytes: 1024, freeBytes: 1024, usedPercent: 50 }] } })
    await expect(tools.getDisks()).resolves.toMatchObject({ ok: true, data: { disks: [{ id: "sanctuary:d1", name: "disk1", smart: "passed", temperatureC: 38, degraded: false }], parity: { result: "success" } } })
    await expect(tools.getNotifications()).resolves.toMatchObject({ ok: true, data: { unacknowledged: [{ id: "n1", createdAt: "2026-08-18T00:00:00.000Z", severity: "warning", title: "Disk warm", summary: "disk1\n38C", degraded: false }] } })
    await expect(tools.getSystem()).resolves.toEqual({ ok: true, data: { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 1234, degraded: false } })
  })

  it("fails closed when the parity completion timestamp is in the future", async () => {
    const read = vi.fn(async () => ({
      disks: [],
      array: { parityCheckStatus: { status: "COMPLETED", date: "2099-01-01T00:00:00Z", errors: 0, running: false } },
    }))

    await expect(createUnraidReadTools({ read } as any).getDisks()).resolves.toMatchObject({
      ok: true,
      data: { parity: { result: "success", completedAt: "2099-01-01T00:00:00.000Z", ageHours: null, degraded: true } },
    })
  })
})
