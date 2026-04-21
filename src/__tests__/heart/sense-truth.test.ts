import { describe, expect, it } from "vitest"

import { getSenseInventory, type SenseStatus } from "../../heart/sense-truth"

describe("sense truth model", () => {
  it("uses default sense config when an agent does not define senses explicitly", () => {
    const inventory = getSenseInventory({})

    expect(inventory).toEqual([
      expect.objectContaining({ sense: "cli", enabled: true, status: "interactive" satisfies SenseStatus }),
      expect.objectContaining({ sense: "teams", enabled: false, status: "disabled" satisfies SenseStatus }),
      expect.objectContaining({ sense: "bluebubbles", enabled: false, status: "disabled" satisfies SenseStatus }),
      expect.objectContaining({ sense: "mail", enabled: false, status: "disabled" satisfies SenseStatus }),
    ])
  })

  it("returns all available senses with defaults when only cli is enabled", () => {
    const inventory = getSenseInventory({
      senses: {
        cli: { enabled: true },
        teams: { enabled: false },
        bluebubbles: { enabled: false },
      },
    })

    expect(inventory).toEqual([
      expect.objectContaining({ sense: "cli", enabled: true, status: "interactive" satisfies SenseStatus }),
      expect.objectContaining({ sense: "teams", enabled: false, status: "disabled" satisfies SenseStatus }),
      expect.objectContaining({ sense: "bluebubbles", enabled: false, status: "disabled" satisfies SenseStatus }),
      expect.objectContaining({ sense: "mail", enabled: false, status: "disabled" satisfies SenseStatus }),
    ])
  })

  it("reports needs_config for enabled daemon-managed senses missing required config", () => {
    const inventory = getSenseInventory(
      {
        senses: {
          cli: { enabled: true },
          teams: { enabled: true },
          bluebubbles: { enabled: true },
        },
      },
      {
        teams: { configured: false },
        bluebubbles: { configured: false },
      },
    )

    expect(inventory.find((item) => item.sense === "teams")).toEqual(
      expect.objectContaining({ enabled: true, daemonManaged: true, status: "needs_config" satisfies SenseStatus }),
    )
    expect(inventory.find((item) => item.sense === "bluebubbles")).toEqual(
      expect.objectContaining({ enabled: true, daemonManaged: true, status: "needs_config" satisfies SenseStatus }),
    )
  })

  it("prefers running and error runtime states over ready for daemon-managed senses", () => {
    const runningInventory = getSenseInventory(
      {
        senses: {
          cli: { enabled: true },
          teams: { enabled: false },
          bluebubbles: { enabled: true },
        },
      },
      {
        bluebubbles: { configured: true, runtime: "running" },
      },
    )
    const erroredInventory = getSenseInventory(
      {
        senses: {
          cli: { enabled: true },
          teams: { enabled: false },
          bluebubbles: { enabled: true },
        },
      },
      {
        bluebubbles: { configured: true, runtime: "error" },
      },
    )

    expect(runningInventory.find((item) => item.sense === "bluebubbles")).toEqual(
      expect.objectContaining({ status: "running" satisfies SenseStatus }),
    )
    expect(erroredInventory.find((item) => item.sense === "bluebubbles")).toEqual(
      expect.objectContaining({ status: "error" satisfies SenseStatus }),
    )
  })

  it("reports ready for enabled daemon-managed senses when config exists but runtime is idle", () => {
    const inventory = getSenseInventory(
      {
        senses: {
          cli: { enabled: true },
          teams: { enabled: true },
          bluebubbles: { enabled: false },
        },
      },
      {
        teams: { configured: true },
      },
    )

    expect(inventory.find((item) => item.sense === "teams")).toEqual(
      expect.objectContaining({ enabled: true, daemonManaged: true, status: "ready" satisfies SenseStatus }),
    )
  })
})
