import { describe, expect, it } from "vitest"

import { renderSanctuaryGroundedResponse, sanctuaryGroundedResponseAccurate } from "../../senses/sanctuary-grounding"

const system = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
const degradedSystem = { ...system, degraded: true }
const storage = { array: { state: "STARTED", usedBytes: 8_000_000_000_000, freeBytes: 2_000_000_000_000, usedPercent: 80, degraded: false }, shares: [], truncated: false }

describe("Sanctuary grounded response accuracy", () => {
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
