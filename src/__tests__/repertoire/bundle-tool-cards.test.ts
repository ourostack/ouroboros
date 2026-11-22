import { describe, expect, it } from "vitest"

import { bundleToolDefinitions } from "../../repertoire/tools-bundle"

describe("bundle tool cards", () => {
  it("gives every bundle tool a card under its own id in the turn-bundle group", () => {
    expect(bundleToolDefinitions).toHaveLength(8)
    for (const definition of bundleToolDefinitions) {
      expect(definition.ax, definition.tool.function.name).toMatchObject({ id: `tool:${definition.tool.function.name}`, group: "turn-bundle" })
    }
  })

  it("marks the two read-only bundle tools as changing nothing", () => {
    for (const name of ["bundle_check_sync_status", "bundle_list_first_commit"]) {
      const definition = bundleToolDefinitions.find((entry) => entry.tool.function.name === name)!
      expect(definition.ax!.effect).toBe("read")
      expect(definition.riskProfile).toEqual({ mutates: "none", risk: "low" })
    }
  })

  it("names the same sync failures on both sync tools", () => {
    const codes = (name: string) => bundleToolDefinitions.find((entry) => entry.tool.function.name === name)!.ax!.errors!.map((error) => error.code)
    expect(codes("bundle_push")).toEqual(codes("bundle_pull_rebase"))
    expect(codes("bundle_push")).toEqual(expect.arrayContaining(["not-a-repo", "no-remote", "no-commits", "confirmation-required", "remote-unreachable", "sync-busy", "sync-paused", "sync-failed"]))
  })
})
