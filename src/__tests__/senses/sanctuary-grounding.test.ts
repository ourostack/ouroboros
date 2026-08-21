import { describe, expect, it } from "vitest"

import { projectSanctuaryGrounding, renderSanctuaryGroundedResponse, sanctuaryGroundedResponseAccurate, sanctuaryGroundingDigest } from "../../senses/sanctuary-grounding"

const system = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
const degradedSystem = { ...system, degraded: true }
const storage = { array: { state: "STARTED", usedBytes: 8_000_000_000_000, freeBytes: 2_000_000_000_000, usedPercent: 80, degraded: false }, shares: [], truncated: false }

describe("Sanctuary grounded response accuracy", () => {
  it("projects only exact successful system and storage envelopes", () => {
    const systemEnvelope = { ok: true, data: { ...system, sourceIdentityDigest: "a".repeat(64), uptimeSeconds: null } }
    const storageEnvelope = { ok: true, data: { ...storage, sourceIdentityDigest: "b".repeat(64) } }
    expect(projectSanctuaryGrounding("other", systemEnvelope)).toBeNull()
    expect(projectSanctuaryGrounding("unraid_get_system", systemEnvelope)).toEqual(system)
    expect(projectSanctuaryGrounding("unraid_get_storage", storageEnvelope)).toEqual(storage)
    expect(sanctuaryGroundingDigest(system)).toMatch(/^[0-9a-f]{64}$/u)

    for (const [tool, value] of [
      ["unraid_get_system", null],
      ["unraid_get_system", { ok: false }],
      ["unraid_get_system", { ok: true, data: [] }],
      ["unraid_get_system", { ok: true, data: { ...systemEnvelope.data, extra: true } }],
      ["unraid_get_system", { ok: true, data: { ...systemEnvelope.data, serverName: "" } }],
      ["unraid_get_system", { ok: true, data: { ...systemEnvelope.data, uptimeSeconds: -1 } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, shares: null } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, extra: true } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, array: [] } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, array: { ...storage.array, extra: true } } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, array: { ...storage.array, state: "" } } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, array: { ...storage.array, usedBytes: -1 } } }],
      ["unraid_get_storage", { ok: true, data: { ...storageEnvelope.data, array: { ...storage.array, usedPercent: Number.NaN } } }],
    ] as const) expect(() => projectSanctuaryGrounding(tool, value)).toThrow()
  })

  it("renders canonical delivered clauses directly from the validated live facts", () => {
    const systemText = renderSanctuaryGroundedResponse("unraid_get_system", system)
    const storageText = renderSanctuaryGroundedResponse("unraid_get_storage", storage)
    expect(systemText).toBe("Sanctuary is running Unraid 7.2.3 with the array STARTED and not degraded.")
    expect(storageText).toBe("There is 2 TB free and the array is 80% used.")
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", system, systemText)).toBe(true)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, storageText)).toBe(true)
  })

  it("accepts bounded, rounded, factually consistent system and storage answers", () => {
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", system, "Sanctuary is running Unraid 7.2.3; the array is STARTED and not degraded.")).toBe(true)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, "There is 2 TB free; the array is 80% used. The array is STARTED and healthy.")).toBe(true)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, "About 1.82 TiB is available and usage is 80.0%.")).toBe(true)
  })

  it.each([
    "Sanctuary is NOT running Unraid 7.2.3; the array is NOT STARTED and is healthy.",
    "Sanctuary runs Unraid 7.2.3, but the array is STOPPED and healthy (STARTED is stale).",
    "Sanctuary runs Unraid 7.2.3; the array is STARTED but degraded.",
    "Sanctuary is not actually currently running Unraid 7.2.3; array STARTED and healthy.",
    "Sanctuary is running Unraid 7.2.3; the array is STARTED and healthy yesterday but is down now.",
  ])("rejects a negated or contradictory system answer: %s", (response) => {
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", system, response)).toBe(false)
  })

  it("requires the response to report a degraded system as degraded", () => {
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", degradedSystem, "Sanctuary is running Unraid 7.2.3; the array is STARTED and healthy.")).toBe(false)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", degradedSystem, "Sanctuary is running Unraid 7.2.3; the array is STARTED and degraded.")).toBe(true)
  })

  it("rejects incomplete facts and accepts every canonical health synonym", () => {
    expect(sanctuaryGroundedResponseAccurate("unraid_get_system", {}, "anything")).toBe(false)
    for (const word of ["not degraded", "healthy", "nominal"]) {
      expect(sanctuaryGroundedResponseAccurate("unraid_get_system", system, `Sanctuary is running Unraid 7.2.3 with the array STARTED and ${word}.`)).toBe(true)
    }
    for (const word of ["degraded", "unhealthy"]) {
      expect(sanctuaryGroundedResponseAccurate("unraid_get_system", degradedSystem, `Sanctuary is running Unraid 7.2.3 with the array STARTED and ${word}.`)).toBe(true)
    }
  })

  it("covers exact storage units, health clauses, invalid facts, and renderer bounds", () => {
    const bytes = { ...storage, array: { ...storage.array, freeBytes: 512 } }
    const zeroBytes = { ...storage, array: { ...storage.array, freeBytes: 0 } }
    const gb = { ...storage, array: { ...storage.array, freeBytes: 2_000_000_000 } }
    expect(renderSanctuaryGroundedResponse("unraid_get_storage", bytes)).toContain("512 bytes")
    expect(renderSanctuaryGroundedResponse("unraid_get_storage", zeroBytes)).toContain("0 bytes")
    expect(renderSanctuaryGroundedResponse("unraid_get_storage", gb)).toContain("2 GB")
    expect(renderSanctuaryGroundedResponse("unraid_get_system", degradedSystem)).toContain("and degraded")
    expect(() => renderSanctuaryGroundedResponse("unraid_get_system", {})).toThrow()
    expect(() => renderSanctuaryGroundedResponse("unraid_get_storage", { array: [] })).toThrow()
    expect(() => renderSanctuaryGroundedResponse("unraid_get_storage", { array: { freeBytes: null, usedPercent: 1 } })).toThrow()
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", { array: {} }, "anything")).toBe(false)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, "There is 2 TB free; usage is 80%. The array is STARTED and nominal.")).toBe(true)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, "There is 2 TB free; usage is 81%.")).toBe(false)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", { ...storage, array: { ...storage.array, degraded: true } }, "There is 2 TB free; usage is 80%. The array is STARTED and unhealthy.")).toBe(true)
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, "There is 2 TB free; usage is 80%. The array is STOPPED and healthy.")).toBe(false)
  })

  it.each([
    "There is 12 TB, not 2 TB, free; usage is 180%, not 80%.",
    "There is 2 TB free, although actually 12 TB is free; usage is 80%.",
    "There is 2 TB free; usage is 180% (the old reading was 80%).",
    "There is 2 TB free; usage is 80%, but the array is STOPPED.",
    "There is 2 TB free; usage is 80%, but the array is degraded.",
    "There is 2 TB free; usage is 80%. The array is down.",
    "There is 2 TB free; usage is 180 percent, not 80 percent.",
  ])("rejects embedded, negated, or contradictory storage claims: %s", (response) => {
    expect(sanctuaryGroundedResponseAccurate("unraid_get_storage", storage, response)).toBe(false)
  })
})
