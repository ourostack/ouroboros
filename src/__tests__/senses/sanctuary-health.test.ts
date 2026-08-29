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

function statePath(prefix = "sanctuary-health-"): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), prefix)), "state.json")
}

function validState(overrides: Record<string, unknown> = {}) {
  return {
    incidents: {},
    lastDigestDay: null,
    updatedAt: "2026-08-18T18:00:00.000Z",
    outbox: null,
    indeterminateDeliveries: [],
    deliveredReceipts: [],
    sweepReceipts: [],
    ...overrides,
  }
}

const validDelivery = (overrides: Record<string, unknown> = {}) => ({
  id: "delivery-1",
  message: "health",
  status: "pending",
  createdAt: "2026-08-18T18:00:00.000Z",
  kind: "transition",
  ...overrides,
})

const validDeliveredReceipt = (overrides: Record<string, unknown> = {}) => ({
  deliveryId: "delivery-1",
  kind: "transition",
  messageIds: [1],
  deliveredAt: "2026-08-18T18:00:00.000Z",
  ...overrides,
})

const validSweepReceipt = (overrides: Record<string, unknown> = {}) => ({
  sweepId: "12345678-1234-4567-8123-123456789abc",
  startedAt: "2026-08-18T18:00:00.000Z",
  completedAt: "2026-08-18T18:00:00.000Z",
  incidentDigest: "a".repeat(64),
  opened: 1,
  recovered: 0,
  digestDue: false,
  deliveryId: "delivery-1",
  scenarioHandleDigest: "b".repeat(64),
  ...overrides,
})

function writeState(filePath: string, state: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, `${JSON.stringify(state)}\n`, "utf8")
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

  it.each([
    "http://books.mendelow.cloud/",
    "https://user@books.mendelow.cloud/",
    "https://user:password@books.mendelow.cloud/",
  ])("rejects an unsafe configured endpoint without fetching it: %s", async (url) => {
    const fetch = vi.fn()

    await expect(probeSanctuaryEndpoint(url, fetch)).resolves.toEqual({ url, ok: false, status: 0 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [299, true],
    [400, false],
    [503, false],
  ])("returns terminal HTTP %i health", async (status, ok) => {
    const fetch = vi.fn().mockResolvedValue({ status, headers: new Headers(), body: null })

    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", fetch as typeof globalThis.fetch))
      .resolves.toEqual({ url: "https://books.mendelow.cloud/", ok, status })
  })

  it("contains transport and response-body cancellation failures", async () => {
    const transportFailure = vi.fn().mockRejectedValue(new Error("offline"))
    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", transportFailure)).resolves.toEqual({
      url: "https://books.mendelow.cloud/", ok: false, status: 0,
    })

    const cancelFailure = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { cancel: vi.fn().mockRejectedValue(new Error("already closed")) },
    })
    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", cancelFailure as typeof globalThis.fetch))
      .resolves.toMatchObject({ ok: true, status: 200 })

    const redirectCancelFailure = vi.fn()
      .mockResolvedValueOnce({
        status: 302,
        headers: new Headers({ location: "/ready" }),
        body: { cancel: vi.fn().mockRejectedValue(new Error("already closed")) },
      })
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", redirectCancelFailure as typeof globalThis.fetch))
      .resolves.toMatchObject({ ok: true, status: 204 })
  })

  it.each([
    ["a missing location", "", 1],
    ["an insecure target", "http://books.mendelow.cloud/ready", 1],
    ["a credentialed target", "https://user@books.mendelow.cloud/ready", 1],
    ["a password-bearing target", "https://user:password@books.mendelow.cloud/ready", 1],
  ])("rejects %s during redirects", async (_label, location, calls) => {
    const fetch = vi.fn().mockResolvedValue({
      status: 302,
      headers: new Headers(location ? { location } : {}),
      body: { cancel: vi.fn().mockResolvedValue(undefined) },
    })

    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", fetch as typeof globalThis.fetch))
      .resolves.toMatchObject({ ok: false, status: 0 })
    expect(fetch).toHaveBeenCalledTimes(calls)
  })

  it("bounds same-origin redirect chains at six requests", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 399, headers: { location: "/again" } }))

    await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/", fetch)).resolves.toMatchObject({ ok: false, status: 0 })
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it("uses ambient fetch when no endpoint dependency is supplied", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal("fetch", fetch)
    try {
      await expect(probeSanctuaryEndpoint("https://books.mendelow.cloud/")).resolves.toMatchObject({ ok: true, status: 204 })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([
    ["invalid JSON", "{"],
    ["missing incidents", JSON.stringify(validState({ incidents: undefined }))],
    ["primitive incidents", JSON.stringify(validState({ incidents: 1 }))],
    ["array incidents", JSON.stringify(validState({ incidents: [] }))],
    ["invalid digest day", JSON.stringify(validState({ lastDigestDay: 1 }))],
    ["invalid update time", JSON.stringify(validState({ updatedAt: 1 }))],
    ["invalid outbox primitive", JSON.stringify(validState({ outbox: 1 }))],
    ["outbox missing id", JSON.stringify(validState({ outbox: { message: "m", status: "pending", createdAt: "t" } }))],
    ["outbox missing message", JSON.stringify(validState({ outbox: { id: "d", status: "pending", createdAt: "t" } }))],
    ["outbox invalid status", JSON.stringify(validState({ outbox: { id: "d", message: "m", status: "sent", createdAt: "t" } }))],
    ["outbox missing created time", JSON.stringify(validState({ outbox: { id: "d", message: "m", status: "pending" } }))],
    ["outbox invalid cached message", JSON.stringify(validState({ outbox: { id: "d", message: "m", status: "pending", createdAt: "t", summarizedMessage: 1 } }))],
    ["non-array indeterminate deliveries", JSON.stringify(validState({ indeterminateDeliveries: {} }))],
    ["invalid indeterminate delivery", JSON.stringify(validState({ indeterminateDeliveries: [null] }))],
    ["non-array delivered receipts", JSON.stringify(validState({ deliveredReceipts: {} }))],
    ["null delivered receipt", JSON.stringify(validState({ deliveredReceipts: [null] }))],
    ["receipt missing delivery id", JSON.stringify(validState({ deliveredReceipts: [{ deliveredAt: "t", messageIds: [1] }] }))],
    ["receipt missing delivery time", JSON.stringify(validState({ deliveredReceipts: [{ deliveryId: "d", messageIds: [1] }] }))],
    ["receipt message ids not an array", JSON.stringify(validState({ deliveredReceipts: [{ deliveryId: "d", deliveredAt: "t", messageIds: 1 }] }))],
    ["receipt message ids empty", JSON.stringify(validState({ deliveredReceipts: [{ deliveryId: "d", deliveredAt: "t", messageIds: [] }] }))],
    ["receipt message id fractional", JSON.stringify(validState({ deliveredReceipts: [{ deliveryId: "d", deliveredAt: "t", messageIds: [1.5] }] }))],
    ["receipt message id nonpositive", JSON.stringify(validState({ deliveredReceipts: [{ deliveryId: "d", deliveredAt: "t", messageIds: [0] }] }))],
  ])("fails closed for corrupt durable state: %s", async (_label, contents) => {
    const filePath = statePath("sanctuary-health-corrupt-")
    fs.writeFileSync(filePath, contents, "utf8")
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(sweep()).rejects.toThrow("Sanctuary health state is corrupt")
  })

  it.each([
    ["outbox id length", validState({ outbox: validDelivery({ id: "x".repeat(129) }) })],
    ["outbox UTF-8 message bytes", validState({ outbox: validDelivery({ message: "é".repeat(25_001) }) })],
    ["outbox canonical timestamp", validState({ outbox: validDelivery({ createdAt: "yesterday" }) })],
    ["outbox delivery kind", validState({ outbox: validDelivery({ kind: "other" }) })],
    ["outbox cached UTF-8 bytes", validState({ outbox: validDelivery({ summarizedMessage: "é".repeat(25_001) }) })],
    ["delivered receipt count", validState({ deliveredReceipts: Array.from({ length: 101 }, () => validDeliveredReceipt()) })],
    ["delivered receipt id length", validState({ deliveredReceipts: [validDeliveredReceipt({ deliveryId: "x".repeat(129) })] })],
    ["delivered receipt canonical timestamp", validState({ deliveredReceipts: [validDeliveredReceipt({ deliveredAt: "yesterday" })] })],
    ["delivered receipt kind", validState({ deliveredReceipts: [validDeliveredReceipt({ kind: "other" })] })],
    ["delivered receipt message-id count", validState({ deliveredReceipts: [validDeliveredReceipt({ messageIds: Array.from({ length: 101 }, (_, index) => index + 1) })] })],
    ["sweep receipt collection type", validState({ sweepReceipts: {} })],
    ["sweep receipt count", validState({ sweepReceipts: Array.from({ length: 501 }, () => validSweepReceipt()) })],
    ["sweep UUID", validState({ sweepReceipts: [validSweepReceipt({ sweepId: "not-a-v4-uuid" })] })],
    ["sweep start timestamp", validState({ sweepReceipts: [validSweepReceipt({ startedAt: "yesterday" })] })],
    ["sweep completion timestamp", validState({ sweepReceipts: [validSweepReceipt({ completedAt: "yesterday" })] })],
    ["sweep incident digest", validState({ sweepReceipts: [validSweepReceipt({ incidentDigest: "bad" })] })],
    ["sweep opened count", validState({ sweepReceipts: [validSweepReceipt({ opened: -1 })] })],
    ["sweep recovered count", validState({ sweepReceipts: [validSweepReceipt({ recovered: 0.5 })] })],
    ["sweep digest flag", validState({ sweepReceipts: [validSweepReceipt({ digestDue: "false" })] })],
    ["sweep delivery id", validState({ sweepReceipts: [validSweepReceipt({ deliveryId: "x".repeat(129) })] })],
    ["sweep scenario digest", validState({ sweepReceipts: [validSweepReceipt({ scenarioHandleDigest: "bad" })] })],
  ])("fails closed for bounded receipt schema violation: %s", async (_label, state) => {
    const filePath = statePath("sanctuary-health-schema-bound-")
    writeState(filePath, state)
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(sweep()).rejects.toThrow("Sanctuary health state is corrupt")
  })

  it("rejects a durable health file above four MiB before parsing", async () => {
    const filePath = statePath("sanctuary-health-file-bound-")
    fs.writeFileSync(filePath, " ".repeat(4 * 1024 * 1024 + 1), "utf8")
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(sweep()).rejects.toThrow("Sanctuary health state is corrupt")
  })

  it("keeps multi-byte incident evidence bounded without authoring a message", async () => {
    const toolContext = context("running")
    toolContext.sanctuary.getNotifications.mockResolvedValue({ ok: true, data: { unacknowledged: [
      { id: "large", title: "é".repeat(30_000) },
    ] } })
    const filePath = statePath("sanctuary-health-utf8-bound-")
    const sweep = createSanctuaryHealthSweep({
      toolContext,
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      now: () => new Date("2026-08-18T15:00:00.000Z"),
    })

    const opened = await sweep()
    expect(opened.message).toBeNull()
    expect(Buffer.byteLength(opened.incidents[0].summary)).toBeLessThanOrEqual(4_096)
    expect(opened.incidents[0].summary).toMatch(/…$/u)
  })

  it("records transition evidence without detector-authored messages or daily digests", async () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-")), "state.json")
    const fetch = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }))
    let clock = new Date("2026-08-18T18:00:00.000Z")
    const now = () => clock
    const broken = createSanctuaryHealthSweep({ toolContext: context("exited"), statePath, fetch, now, acceptanceEventMeta: () => ({ scenarioHandleDigest: "a".repeat(64) }) })
    const opened = await broken()
    expect(opened).toMatchObject({ message: null, transition: "opened", incidents: [expect.objectContaining({ id: "container:Docker:a:availability", summary: "calibre-web is exited" })] })
    expect(JSON.parse(fs.readFileSync(statePath, "utf8")).sweepReceipts[0]).toMatchObject({ opened: 1, recovered: 0, digestDue: false, scenarioHandleDigest: "a".repeat(64) })
    expect((await broken())).toMatchObject({ message: null, transition: "unchanged", recovered: [] })
    const restarted = createSanctuaryHealthSweep({ toolContext: context("exited"), statePath, fetch, now })
    expect(await restarted()).toMatchObject({ message: null, transition: "unchanged" })

    clock = new Date("2026-08-19T18:00:00.000Z")
    expect(await restarted()).toMatchObject({ message: null, transition: "unchanged" })

    const healthy = createSanctuaryHealthSweep({ toolContext: context("running"), statePath, fetch, now })
    const recovered = await healthy()
    expect(recovered).toMatchObject({ message: null, transition: "recovered", incidents: [], recovered: [expect.objectContaining({ id: "container:Docker:a:availability" })] })
    expect((await healthy())).toMatchObject({ message: null, transition: "unchanged", recovered: [] })
  })

  it("serializes overlapping sweeps while sampling each requested observation", async () => {
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
    expect(left.transition).toBe("opened")
    expect(right.transition).toBe("unchanged")
    expect(toolContext.sanctuary.listContainers).toHaveBeenCalledTimes(2)
  })

  it("creates the health state directory before acquiring the first lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-first-"))
    const statePath = path.join(root, "missing", "health", "state.json")
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath,
      fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    })

    await expect(sweep()).resolves.toMatchObject({ message: null })
    expect(fs.existsSync(path.dirname(statePath))).toBe(true)
  })

  it("reports a named mandate container down even when Unraid autostart is disabled", async () => {
    const statePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-")), "state.json")
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("exited", false),
      statePath,
      fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    })

    expect((await sweep()).incidents).toContainEqual(expect.objectContaining({ id: "container:Docker:a:availability", summary: "calibre-web is exited" }))
  })

  it("surfaces every degraded health dimension with stable incident identities", async () => {
    const toolContext = context("running")
    toolContext.sanctuary.listContainers.mockResolvedValue({ ok: true, data: { containers: [
      { id: "Docker:optional", name: "optional", autostart: false, state: "exited", exitCode: null, degraded: false },
      { id: "Docker:auto", name: "auto", autostart: true, state: "exited", exitCode: null, degraded: false },
      { id: "Docker:unknown", name: "unknown", autostart: false, state: "unknown", exitCode: null, degraded: false },
      { id: "Docker:degraded", name: "degraded", autostart: false, state: "running", exitCode: null, degraded: true },
    ], truncated: false } })
    toolContext.sanctuary.getStorage.mockResolvedValue({ ok: true, data: {
      array: { state: "STARTED", usedPercent: 95, degraded: false },
      shares: [
        { name: "unknown", usedPercent: null, degraded: false },
        { name: "degraded", usedPercent: 10, degraded: true },
        { name: "full", usedPercent: 91, degraded: false },
        { name: "healthy", usedPercent: 30, degraded: false },
      ],
    } })
    toolContext.sanctuary.getDisks.mockResolvedValue({ ok: true, data: {
      disks: [
        { id: "Disk:bad", name: "bad", smart: "failed", temperatureC: null },
        { id: "Disk:hot", name: "hot", smart: "passed", temperatureC: 50 },
        { id: "Disk:good", name: "good", smart: "passed", temperatureC: 49 },
      ],
      parity: { result: "failed", ageHours: 1 },
    } })
    toolContext.sanctuary.getNotifications.mockResolvedValue({ ok: true, data: { unacknowledged: [
      { id: "n1", title: "Disk warning" },
      { id: "n2", title: "" },
    ] } })
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(new Response(null, { status: 204 }))
    const sweep = createSanctuaryHealthSweep({
      toolContext,
      statePath: statePath("sanctuary-health-degraded-"),
      fetch,
      now: () => new Date("2026-08-18T15:00:00.000Z"),
    })

    const result = await sweep()
    const ids = result.incidents.map((incident) => incident.id)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toEqual(expect.arrayContaining([
      "container:Docker:auto:availability",
      "container:Docker:unknown:health",
      "container:Docker:degraded:health",
      "storage:array:capacity",
      "storage:share:unknown:capacity",
      "storage:share:degraded:capacity",
      "storage:share:full:capacity",
      "disk:Disk:bad:smart",
      "disk:Disk:bad:temperature",
      "disk:Disk:hot:temperature",
      "parity:stale-or-failed",
      "notification:n1",
      "notification:n2",
      "endpoint:https://media.mendelow.cloud/",
      "endpoint:https://books.mendelow.cloud/",
    ]))
    expect(ids).not.toContain("container:Docker:optional:availability")
    expect(result.message).toBeNull()
    expect(result.incidents.map((incident) => incident.summary)).toEqual(expect.arrayContaining(["unacknowledged notification: n2", "https://books.mendelow.cloud/ returned no response"]))
  })

  it.each([
    ["containers", { listContainers: { ok: false, error: { code: "offline" } } }, "containers:unavailable"],
    ["storage", { getStorage: { ok: false, error: { code: "offline" } } }, "storage:array:capacity"],
    ["disks", { getDisks: { ok: false, error: { code: "offline" } } }, "disks:unavailable"],
    ["notifications", { getNotifications: { ok: false, error: { code: "offline" } } }, "notifications:unavailable"],
  ])("reports unavailable %s results", async (_label, replacement, expectedId) => {
    const toolContext = context("running")
    for (const [method, result] of Object.entries(replacement)) {
      toolContext.sanctuary[method].mockResolvedValue(result)
    }
    const sweep = createSanctuaryHealthSweep({
      toolContext,
      statePath: statePath("sanctuary-health-unavailable-"),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      now: () => new Date("2026-08-18T15:00:00.000Z"),
    })

    expect((await sweep()).incidents.map((incident) => incident.id)).toContain(expectedId)
  })

  it("handles absent collections, malformed capacity, and each parity invalidity", async () => {
    const toolContext = context("running")
    toolContext.sanctuary.listContainers.mockResolvedValue({ ok: true, data: { containers: null } })
    toolContext.sanctuary.getStorage.mockResolvedValue({ ok: true, data: { array: [], shares: null } })
    toolContext.sanctuary.getDisks.mockResolvedValue({ ok: true, data: { disks: null, parity: [] } })
    toolContext.sanctuary.getNotifications.mockResolvedValue({ ok: true, data: { unacknowledged: null } })
    const sweep = createSanctuaryHealthSweep({
      toolContext,
      statePath: statePath("sanctuary-health-malformed-tools-"),
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      now: () => new Date("2026-08-18T15:00:00.000Z"),
    })

    expect((await sweep()).incidents.map((incident) => incident.id)).toEqual(expect.arrayContaining([
      "containers:unavailable", "storage:array:capacity", "parity:stale-or-failed", "notifications:unavailable",
    ]))

    const parityCases = [
      { result: "failed", ageHours: 1 },
      { result: "success", ageHours: null },
      { result: "success", ageHours: 45 * 24 },
    ]
    for (const parity of parityCases) {
      const nextContext = context("running")
      nextContext.sanctuary.getDisks.mockResolvedValue({ ok: true, data: { disks: [], parity } })
      const next = createSanctuaryHealthSweep({
        toolContext: nextContext,
        statePath: statePath("sanctuary-health-parity-"),
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        now: () => new Date("2026-08-18T15:00:00.000Z"),
      })
      expect((await next()).incidents.map((incident) => incident.id)).toContain("parity:stale-or-failed")
    }
  })

  it("rejects unavailable runtime and keeps legacy delivery mutations closed when no outbox exists", async () => {
    const filePath = statePath("sanctuary-health-transitions-")
    const absent = createSanctuaryHealthSweep({
      toolContext: {} as any,
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })
    await expect(absent()).rejects.toThrow("Sanctuary health runtime is unavailable")

    const sweep = createSanctuaryHealthSweep({
      toolContext: context("exited"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    })
    await sweep()
    await expect(sweep.markDeliveryAttempting("wrong")).rejects.toThrow("is not pending")
    await expect(sweep.cacheDeliveryPayload("retired", 1 as any)).rejects.toThrow("must be nonempty")
    await expect(sweep.cacheDeliveryPayload("retired", "   ")).rejects.toThrow("must be nonempty")
    await expect(sweep.cacheDeliveryPayload("retired", "x".repeat(50_001))).rejects.toThrow("bounded")
    await expect(sweep.cacheDeliveryPayload("wrong", "summary")).rejects.toThrow("is not pending")
    await expect(sweep.markDelivered("retired", null as any)).rejects.toThrow("canonical Telegram message ids")
    await expect(sweep.markDelivered("retired", [])).rejects.toThrow("canonical Telegram message ids")
    await expect(sweep.markDelivered("retired", [1.5])).rejects.toThrow("canonical Telegram message ids")
    await expect(sweep.markDelivered("retired", [0])).rejects.toThrow("canonical Telegram message ids")
    await expect(sweep.markDelivered("retired", Array.from({ length: 101 }, (_, index) => index + 1))).rejects.toThrow("canonical Telegram message ids")
    await expect(sweep.markDelivered("retired", [1])).rejects.toThrow("is not attempting")
    await expect(sweep.markDelivered("wrong", [1])).rejects.toThrow("is not attempting")
  })

  it("caps delivered receipts at the newest one hundred and preserves canonical message ids", async () => {
    const filePath = statePath("sanctuary-health-receipts-")
    const oldReceipts = Array.from({ length: 100 }, (_, index) => ({
      deliveryId: `old-${index}`,
      messageIds: [index + 1],
      deliveredAt: "2026-08-17T00:00:00.000Z",
    }))
    writeState(filePath, validState({
      outbox: { id: "new", message: "health", status: "attempting", createdAt: "2026-08-18T18:00:00.000Z" },
      deliveredReceipts: oldReceipts,
    }))
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"), statePath: filePath, now: () => new Date("2026-08-18T19:00:00.000Z"),
    })

    await sweep.markDelivered("new", [9001, 9002])

    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"))
    expect(saved.deliveredReceipts).toHaveLength(100)
    expect(saved.deliveredReceipts[0].deliveryId).toBe("old-1")
    expect(saved.deliveredReceipts.at(-1)).toMatchObject({ deliveryId: "new", kind: "legacy_unknown", messageIds: [9001, 9002] })
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["state.json"])
  })

  it("retires an attempting legacy delivery without surfacing detector prose", async () => {
    const filePath = statePath("sanctuary-health-indeterminate-retry-")
    writeState(filePath, validState({
      incidents: { previous: { id: "previous", summary: "prior health alert" } },
      outbox: {
        id: "uncached-attempt",
        message: "prior uncached delivery",
        status: "attempting",
        createdAt: "2026-08-18T18:00:00.000Z",
        kind: "transition",
      },
      lastDigestDay: null,
    }))
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response("ok", { status: 200 })),
      now: () => new Date("2026-08-18T19:00:00.000Z"),
    })

    const result = await sweep()

    expect(result.message).toBeNull()
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"))
    expect(saved.outbox).toBeNull()
    expect(saved.indeterminateDeliveries).toHaveLength(0)
  })

  it("retires legacy indeterminate delivery prose without a digest", async () => {
    const filePath = statePath("sanctuary-health-legacy-indeterminate-")
    writeState(filePath, validState({
      indeterminateDeliveries: [{
        id: "legacy-delivery",
        message: "prior health warning",
        status: "attempting",
        createdAt: "2026-08-17T18:00:00.000Z",
      }],
    }))
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
      now: () => new Date("2026-08-18T18:00:00.000Z"),
    })

    const result = await sweep()
    expect(result.message).toBeNull()
    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toMatchObject({ outbox: null, indeterminateDeliveries: [] })
  })

  it("defaults omitted durable collections and the runtime clock", async () => {
    const filePath = statePath("sanctuary-health-defaults-")
    writeState(filePath, {
      incidents: {},
      lastDigestDay: null,
      updatedAt: "1970-01-01T00:00:00.000Z",
    })
    const sweep = createSanctuaryHealthSweep({
      toolContext: context("running"),
      statePath: filePath,
      fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
    })

    await expect(sweep()).resolves.toMatchObject({ message: null, incidents: [] })
    const saved = JSON.parse(fs.readFileSync(filePath, "utf8"))
    expect(saved.indeterminateDeliveries).toEqual([])
    expect(saved.deliveredReceipts).toEqual([])
    expect(saved.sweepReceipts).toEqual([expect.objectContaining({
      sweepId: expect.any(String),
      incidentDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      opened: 0,
      recovered: 0,
      digestDue: false,
    })])
    expect(Date.parse(saved.updatedAt)).toBeGreaterThan(0)
  })

  it("fails quiet when a locale formatter omits expected date parts", async () => {
    const formatter = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function () {
      return { formatToParts: () => [] } as any
    })
    try {
      const sweep = createSanctuaryHealthSweep({
        toolContext: context("running"),
        statePath: statePath("sanctuary-health-locale-fallback-"),
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        now: () => new Date("2026-08-18T18:00:00.000Z"),
      })

      await expect(sweep()).resolves.toMatchObject({ message: null, incidents: [] })
    } finally {
      formatter.mockRestore()
    }
  })
})
