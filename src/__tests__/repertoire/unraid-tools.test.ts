import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"

import { createUnraidReadTools, normalizeDockerStatus, unraidToolDefinitions } from "../../repertoire/tools-unraid"
import { updateStewardPolicy } from "../../heart/steward-policy"
import { approvalPolicyForInvocation, execTool, routineActionSelectionForInvocation } from "../../repertoire/tools"

const LIVE_SERVER_ID = `${"a".repeat(64)}:${"b".repeat(64)}`

function root(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "unraid-tools-routine-"))
}

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
    const serverPrefixedId = LIVE_SERVER_ID
    const sourceIdentityDigest = createHash("sha256").update(serverPrefixedId).digest("hex")
    const read = vi.fn()
      .mockResolvedValueOnce({ vars: { id: serverPrefixedId }, array: { state: "STARTED", capacity: { kilobytes: { used: 2, free: 3, total: 5 } } }, shares: [{ id: "s1", name: "media", used: 1024, free: 1024, size: 2048 }] })
      .mockResolvedValueOnce({ disks: [{ id: "sanctuary:d1", name: "disk1", smartStatus: "PASSED", temperature: 38 }], array: { parityCheckStatus: { status: "COMPLETED", date: "2026-08-18T00:00:00Z", errors: 0, running: false } } })
      .mockResolvedValueOnce({ notifications: { list: [{ id: "n1", timestamp: "2026-08-18T00:00:00Z", importance: "WARNING", title: "Disk warm", subject: "disk1", description: "38C", type: "UNREAD" }] } })
      .mockResolvedValueOnce({ vars: { id: serverPrefixedId, name: "Sanctuary", version: "7.2.3" }, info: { os: { uptime: 1234 }, versions: { core: { unraid: "7.2.3", api: "4.37.1" } } }, array: { state: "STARTED" } })
    const tools = createUnraidReadTools({ read } as any)
    await expect(tools.getStorage()).resolves.toMatchObject({ ok: true, data: { sourceIdentityDigest, array: { usedBytes: 2048, freeBytes: 3072, usedPercent: 40 }, shares: [{ name: "media", usedBytes: 1024, freeBytes: 1024, usedPercent: 50 }] } })
    await expect(tools.getDisks()).resolves.toMatchObject({ ok: true, data: { disks: [{ id: "sanctuary:d1", name: "disk1", smart: "passed", temperatureC: 38, degraded: false }], parity: { result: "success" } } })
    await expect(tools.getNotifications()).resolves.toMatchObject({ ok: true, data: { unacknowledged: [{ id: "n1", createdAt: "2026-08-18T00:00:00.000Z", severity: "warning", title: "Disk warm", summary: "disk1\n38C", degraded: false }] } })
    await expect(tools.getSystem()).resolves.toEqual({ ok: true, data: { sourceIdentityDigest, serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 1234, degraded: false } })
    expect(String(read.mock.calls[0]?.[0])).toContain("vars { id }")
    expect(String(read.mock.calls[3]?.[0])).toContain("vars { id name version }")
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

  it("degrades malformed and non-canonical container fields without guessing", async () => {
    expect(normalizeDockerStatus(null, null)).toEqual({ state: "unknown", exitCode: null, degraded: true })
    expect(normalizeDockerStatus(12, "Up 2 hours")).toEqual({ state: "unknown", exitCode: null, degraded: true })
    expect(normalizeDockerStatus("EXITED", "Exited (4294967296) 1 hour ago")).toEqual({ state: "unknown", exitCode: null, degraded: true })
    expect(normalizeDockerStatus("RUNNING", "Restarting (4294967296) 1 hour ago")).toEqual({ state: "unknown", exitCode: null, degraded: true })
    expect(normalizeDockerStatus("EXITED", `Exited (${"9".repeat(400)}) 1 hour ago`)).toEqual({ state: "unknown", exitCode: null, degraded: true })

    const longStatus = `${"x".repeat(252)}é${"x".repeat(20)}`
    const read = vi.fn(async () => ({ docker: { containers: [
      { id: "Docker:b", names: ["beta"], state: "RUNNING", status: longStatus },
      { id: "Docker:a", names: ["alpha"], state: "RUNNING", status: 42, autoStart: "yes" },
    ] } }))
    await expect(createUnraidReadTools({ read } as any).listContainers()).resolves.toMatchObject({
      ok: true,
      data: { containers: [
        { id: "Docker:a", name: "alpha", autostart: false, state: "unknown", degraded: true, status: "" },
        { id: "Docker:b", name: "beta", autostart: false, state: "unknown", degraded: true, status: expect.stringMatching(/\.\.\.$/) },
      ] },
    })
  })

  it.each([
    [{ docker: null }, "docker response is invalid"],
    [{ docker: { containers: {} } }, "container list is invalid"],
    [{ docker: { containers: [null] } }, "container is invalid"],
    [{ docker: { containers: [{ id: "raw", names: ["a"], state: "RUNNING", status: "Up 1 hour", autoStart: true }] } }, "prefixed ID"],
    [{ docker: { containers: [{ id: "Docker:a", names: [], state: "RUNNING", status: "Up 1 hour", autoStart: true }] } }, "names are ambiguous"],
    [{ docker: { containers: [{ id: "Docker:a", names: ["a", "b"], state: "RUNNING", status: "Up 1 hour", autoStart: true }] } }, "names are ambiguous"],
    [{ docker: { containers: [{ id: "Docker:a", names: ["bad\uFFFD"], state: "RUNNING", status: "Up 1 hour", autoStart: true }] } }, "container name is invalid"],
  ])("returns a typed failure for malformed container responses", async (payload, message) => {
    const read = vi.fn(async () => payload)
    await expect(createUnraidReadTools({ read } as any).listContainers()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: expect.stringContaining(message) } })
  })

  it("bounds the container list and exact outbound log requests", async () => {
    const containers = Array.from({ length: 201 }, (_, index) => ({ id: `Docker:${index}`, names: [`name-${String(index).padStart(3, "0")}`], state: "RUNNING", status: "Up 1 hour", autoStart: true }))
    const read = vi.fn()
      .mockResolvedValueOnce({ docker: { containers } })
      .mockResolvedValueOnce({ docker: { containers: [containers[0], { ...containers[0] }] } })
      .mockResolvedValueOnce({ docker: { containers: [containers[0]] } })
      .mockResolvedValueOnce({ docker: { logs: { containerId: "Docker:0", lines: [{ message: "hello" }] } } })
    const tools = createUnraidReadTools({ read } as any)
    await expect(tools.listContainers()).resolves.toMatchObject({ ok: true, data: { truncated: true, containers: { length: 200 } } })
    await expect(tools.getContainerLogs({ container: "name-000", tailLines: 1 })).resolves.toMatchObject({ ok: false, error: { code: "ambiguous" } })
    await expect(tools.getContainerLogs({ container: "name-000", tailLines: 7 })).resolves.toMatchObject({ ok: true, data: { text: "hello", truncated: false } })
    expect(read.mock.calls.at(-1)).toEqual([expect.stringContaining("query SanctuaryContainerLogs"), { id: "Docker:0", tail: 7 }])
  })

  it.each([0, 201, 1.5])("rejects invalid tail line count %s before a read", async (tailLines) => {
    const read = vi.fn()
    await expect(createUnraidReadTools({ read } as any).getContainerLogs({ container: "name", tailLines })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    expect(read).not.toHaveBeenCalled()
  })

  it("fails closed on log identity drift and malformed log lines", async () => {
    const listed = { docker: { containers: [{ id: "Docker:a", names: ["alpha"], state: "RUNNING", status: "Up 1 hour", autoStart: true }] } }
    const drift = createUnraidReadTools({ read: vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce({ docker: { logs: { containerId: "Docker:b", lines: [] } } }) } as any)
    await expect(drift.getContainerLogs({ container: "alpha", tailLines: 1 })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    const malformed = createUnraidReadTools({ read: vi.fn().mockResolvedValueOnce(listed).mockResolvedValueOnce({ docker: { logs: { containerId: "Docker:a", lines: [null] } } }) } as any)
    await expect(malformed.getContainerLogs({ container: "alpha", tailLines: 1 })).resolves.toMatchObject({ ok: false, error: { code: "invalid_response" } })
    const failedList = createUnraidReadTools({ read: vi.fn(async () => { throw new Error("offline") }) } as any)
    await expect(failedList.getContainerLogs({ container: "alpha", tailLines: 1 })).resolves.toMatchObject({ ok: false, error: { message: "offline" } })
  })

  it("maps degraded, bounded storage data and exact storage request", async () => {
    const shares = Array.from({ length: 257 }, (_, index) => ({ name: `share-${index}`, used: index === 0 ? "10" : "bad", free: index === 0 ? 0n : null }))
    const read = vi.fn(async () => ({ vars: { id: LIVE_SERVER_ID }, array: { state: 42, capacity: { kilobytes: { used: "2", free: 0n } } }, shares }))
    const result = await createUnraidReadTools({ read } as any).getStorage()
    expect(result).toMatchObject({ ok: true, data: { array: { state: "", usedBytes: 2048, freeBytes: 0, usedPercent: 100, degraded: true }, shares: { length: 256 }, truncated: true } })
    expect((result as any).data.shares.find((share: any) => share.name === "share-0")).toMatchObject({ usedBytes: 10, freeBytes: 0, usedPercent: 100, degraded: false })
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("query SanctuaryStorage"), {})
  })

  it("rejects a live source identity that is bounded but not the canonical digest pair", async () => {
    const read = vi.fn(async () => ({
      vars: { id: "a".repeat(64) },
      array: { state: "STARTED", capacity: { kilobytes: { used: 1, free: 1 } } },
      shares: [],
    }))

    await expect(createUnraidReadTools({ read } as any).getStorage()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_response", message: "server identity is invalid" },
    })
  })

  it("returns null percentages for missing or zero capacity", async () => {
    const read = vi.fn(async () => ({ vars: { id: LIVE_SERVER_ID }, array: { state: "STARTED", capacity: { kilobytes: { used: -1, free: "bad" } } }, shares: [{ name: "empty", used: 0, free: 0 }] }))
    await expect(createUnraidReadTools({ read } as any).getStorage()).resolves.toMatchObject({ ok: true, data: { array: { usedBytes: null, freeBytes: null, usedPercent: null, degraded: true }, shares: [{ usedPercent: null, degraded: false }] } })
  })

  it("maps disk failure and unknown health branches with bounded output", async () => {
    const disks = Array.from({ length: 65 }, (_, index) => ({ id: `Disk:${index}`, name: `disk-${index}`, smartStatus: index === 0 ? "FAILED" : null, temperature: index === 0 ? 41 : Number.NaN }))
    const read = vi.fn(async () => ({ disks, array: { parityCheckStatus: { status: "completed", date: "invalid", errors: 3 } } }))
    await expect(createUnraidReadTools({ read } as any).getDisks()).resolves.toMatchObject({ ok: true, data: { disks: { length: 64 }, parity: { result: "failed", completedAt: null, ageHours: null, degraded: true }, truncated: true } })
    const result = await createUnraidReadTools({ read: vi.fn(async () => ({ disks: [{ id: "Disk:x", name: "x", smartStatus: "mystery", temperature: "hot" }], array: { parityCheckStatus: { status: "running", date: null, errors: null } } })) } as any).getDisks()
    expect(result).toMatchObject({ ok: true, data: { disks: [{ smart: "unknown", temperatureC: null, degraded: true }], parity: { result: "unknown" } } })
  })

  it("maps and sorts degraded notifications while bounding fields", async () => {
    const long = "x".repeat(600)
    const list = Array.from({ length: 101 }, (_, index) => index === 0
      ? { id: "n-a", timestamp: null, importance: "mystery", title: 42, subject: long, description: long }
      : { id: `n-${index}`, timestamp: "2026-08-18T00:00:00+00:00", importance: "ERROR", title: "title", subject: "", description: "desc" })
    const read = vi.fn(async () => ({ notifications: { list } }))
    await expect(createUnraidReadTools({ read } as any).getNotifications()).resolves.toMatchObject({ ok: true, data: { unacknowledged: { length: 100 }, truncated: true } })
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("query SanctuaryNotifications"), {})
  })

  it("falls back to vars version and degrades malformed system fields", async () => {
    const read = vi.fn(async () => ({ vars: { id: LIVE_SERVER_ID, name: 42, version: "7.2.3" }, info: { os: { uptime: "123" }, versions: { core: { api: null } } }, array: { state: "x".repeat(200) } }))
    await expect(createUnraidReadTools({ read } as any).getSystem()).resolves.toMatchObject({ ok: true, data: { serverName: "", unraidVersion: "7.2.3", apiVersion: "", uptimeSeconds: 123, degraded: true } })
    expect(read).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("query SanctuarySystem"), {})
  })

  it("returns typed failures from every read tool", async () => {
    const failure = new Error("offline")
    for (const method of ["getStorage", "getDisks", "getNotifications", "getSystem"] as const) {
      const tools = createUnraidReadTools({ read: vi.fn(async () => { throw failure }) } as any)
      await expect(tools[method]()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: "offline" } })
    }
  })

  it("covers invalid timestamps, disk tie-breaking, and every notification sort predicate", async () => {
    const read = vi.fn()
      .mockResolvedValueOnce({
        disks: [
          { id: "Disk:b", name: "same", smartStatus: "PASSED", temperature: 1 },
          { id: "Disk:a", name: "same", smartStatus: "PASSED", temperature: 1 },
        ],
        array: { parityCheckStatus: { status: "running", date: "not-a-dateZ", errors: 0 } },
      })
      .mockResolvedValueOnce({ notifications: { list: [
        { id: "z", timestamp: null, importance: null, title: "z", subject: "", description: "" },
        { id: "b", timestamp: null, importance: "INFO", title: "b", subject: "", description: "" },
        { id: "a", timestamp: null, importance: "INFO", title: "a", subject: "", description: "" },
        { id: "old", timestamp: "2026-08-17T00:00:00Z", importance: "INFO", title: "old", subject: "", description: "" },
        { id: "new", timestamp: "2026-08-18T00:00:00Z", importance: "INFO", title: "new", subject: "", description: "" },
      ] } })
    const tools = createUnraidReadTools({ read } as any)
    await expect(tools.getDisks()).resolves.toMatchObject({ ok: true, data: { disks: [{ id: "Disk:a" }, { id: "Disk:b" }], parity: { completedAt: null, result: "unknown" } } })
    await expect(tools.getNotifications()).resolves.toMatchObject({ ok: true, data: { unacknowledged: [
      { id: "new" }, { id: "old" }, { id: "a" }, { id: "b" }, { id: "z", severity: "unknown" },
    ] } })

    const datedBeforeUndated = createUnraidReadTools({ read: vi.fn(async () => ({ notifications: { list: [
      { id: "dated", timestamp: "2026-08-18T00:00:00Z", importance: "INFO", title: "dated", subject: "", description: "" },
      { id: "undated", timestamp: null, importance: "INFO", title: "undated", subject: "", description: "" },
    ] } })) } as any)
    await expect(datedBeforeUndated.getNotifications()).resolves.toMatchObject({ ok: true, data: { unacknowledged: [{ id: "dated" }, { id: "undated" }] } })
  })

  it("normalizes thrown non-client errors and primitive errors", async () => {
    await expect(createUnraidReadTools({ read: vi.fn(async () => { throw new Error("boom") }) } as any).listContainers()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: "boom" } })
    await expect(createUnraidReadTools({ read: vi.fn(async () => { throw 42 }) } as any).listContainers()).resolves.toMatchObject({ ok: false, error: { code: "invalid_response", message: "42" } })
  })

  it("wires every tool definition to the exact runtime method and fails closed without runtime", async () => {
    const sanctuary = {
      listContainers: vi.fn(async () => ({ ok: true, data: "containers" })),
      getContainerLogs: vi.fn(async (args) => ({ ok: true, data: args })),
      getStorage: vi.fn(async () => ({ ok: true, data: "storage" })),
      getDisks: vi.fn(async () => ({ ok: true, data: "disks" })),
      getNotifications: vi.fn(async () => ({ ok: true, data: "notifications" })),
      getSystem: vi.fn(async () => ({ ok: true, data: "system" })),
      restartContainer: vi.fn(async (args) => ({ ok: true, data: args })),
    }
    for (const definition of unraidToolDefinitions) {
      const missing = JSON.parse(await definition.handler({}, undefined as any))
      expect(missing).toMatchObject({ ok: false, error: { code: "invalid_response" } })
      const args = definition.tool.function.name === "unraid_get_container_logs" ? { container: "alpha", tailLines: 7 }
        : definition.tool.function.name === "unraid_restart_container" ? { container: "alpha" } : {}
      expect(JSON.parse(await definition.handler(args, { sanctuary } as any)).ok).toBe(true)
    }
    expect(sanctuary.getContainerLogs).toHaveBeenCalledExactlyOnceWith({ container: "alpha", tailLines: 7 })
    expect(sanctuary.restartContainer).toHaveBeenCalledExactlyOnceWith({ container: "alpha" }, undefined)
    const restartDefinition = unraidToolDefinitions.find((definition) => definition.tool.function.name === "unraid_restart_container")!
    expect(restartDefinition.approvalPolicy?.({}, {} as any)).toEqual({ kind: "required", policyId: "sanctuary.unraid.restart.v1", actionClass: "unraid.container.restart", requiresSoleCall: true })
  })

  it("uses standing policy only for an exact family-authorized routine restart and otherwise preserves approval", async () => {
    const agentRoot = root()
    updateStewardPolicy(agentRoot, {
      expectedVersion: 0,
      actor: { friendId: "ari", trustLevel: "family", sessionEventId: "evt-1" },
      mutation: { kind: "grant_routine_action", key: "unraid.restart:alpha", action: "unraid.container.restart", targets: ["alpha"], maxCount: 2, windowMs: 3_600_000, verificationRequired: true, exclusions: [], provenance: "stated" },
    })
    const restart = unraidToolDefinitions.find((definition) => definition.tool.function.name === "unraid_restart_container")!
    const context = { signin: async () => undefined, agentRoot, relationshipAuthorization: { authorizedContextScopes: [], advertisedToolNames: ["unraid_restart_container"], actor: { friendId: "ari", trustLevel: "family" as const, sessionEventId: "evt-2" }, authorizeTool: () => ({ allowed: true as const, receiptId: "relationship-1", profileVersion: 7 }) }, sanctuary: { restartContainer: vi.fn(async () => ({ ok: true })) } } as any
    expect(await approvalPolicyForInvocation("unraid_restart_container", { container: "alpha" }, context)).toEqual({ kind: "not_required" })
    await execTool("unraid_restart_container", { container: "alpha" }, { ...context, routineActionSelection: routineActionSelectionForInvocation("unraid_restart_container", { container: "alpha" }, context) })
    expect(context.sanctuary.restartContainer).toHaveBeenCalledWith({ container: "alpha" }, { routine: expect.objectContaining({ key: "unraid.restart:alpha", expectedPolicyVersion: 1, authorizationReceiptId: "relationship-1", authorizationVersion: 7 }) })
    expect(await approvalPolicyForInvocation("unraid_restart_container", { container: "other" }, context)).toMatchObject({ kind: "required" })
    const beforePolicyId = (await approvalPolicyForInvocation("unraid_restart_container", { container: "other" }, context) as { policyId: string }).policyId
    updateStewardPolicy(agentRoot, { expectedVersion: 1, actor: { friendId: "ari", trustLevel: "family", sessionEventId: "evt-4" }, mutation: { kind: "set_desired_state", key: "container:other", value: "on", provenance: "stated", source: "request" } })
    const afterPolicyId = (await approvalPolicyForInvocation("unraid_restart_container", { container: "other" }, context) as { policyId: string }).policyId
    expect(afterPolicyId).not.toBe(beforePolicyId)
    const nonFamily = { ...context, relationshipAuthorization: { ...context.relationshipAuthorization, actor: { friendId: "brother", trustLevel: "friend", sessionEventId: "evt-3" } } }
    expect(await approvalPolicyForInvocation("unraid_restart_container", { container: "alpha" }, nonFamily)).toMatchObject({ kind: "required" })
    const missingVersion = { ...context, relationshipAuthorization: { ...context.relationshipAuthorization, authorizeTool: () => ({ allowed: true as const, receiptId: "relationship-unversioned" }) } }
    const missingVersionSelection = routineActionSelectionForInvocation("unraid_restart_container", { container: "alpha" }, missingVersion)
    expect(JSON.parse(await execTool("unraid_restart_container", { container: "alpha" }, { ...missingVersion, routineActionSelection: missingVersionSelection }))).toMatchObject({ ok: false, error: { code: "approval_required" } })
    expect(JSON.parse(await restart.handler({ container: "other" }, { ...context, routineActionSelection: { key: "unraid.restart:alpha", target: "alpha", expectedPolicyVersion: 2 }, routineActionAuthorization: { receiptId: "relationship-1", profileVersion: 7 } }))).toMatchObject({ ok: false, error: { message: expect.stringContaining("arguments changed") } })
    expect(JSON.parse(await restart.handler({ container: "alpha" }, { ...context, routineActionSelection: { key: "unraid.restart:alpha", target: "alpha", expectedPolicyVersion: 1 }, routineActionAuthorization: { receiptId: "relationship-1", profileVersion: 7 } }))).toMatchObject({ ok: false, error: { message: expect.stringContaining("version changed") } })
  })
})
