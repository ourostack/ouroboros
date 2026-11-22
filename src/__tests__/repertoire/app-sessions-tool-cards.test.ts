import { describe, expect, it } from "vitest"

import { appSessionsToolDefinitions } from "../../repertoire/tools-app-sessions"

describe("app-sessions tool cards", () => {
  it("gives every app-sessions tool a card under its own id in the turn-app-sessions group", () => {
    expect(appSessionsToolDefinitions).toHaveLength(16)
    for (const definition of appSessionsToolDefinitions) {
      expect(definition.ax, definition.tool.function.name).toMatchObject({ id: `tool:${definition.tool.function.name}`, group: "turn-app-sessions" })
    }
  })

  it("calls a tool read exactly when its risk profile says it changes nothing", () => {
    for (const definition of appSessionsToolDefinitions) {
      expect(definition.ax!.effect, definition.tool.function.name).toBe(definition.riskProfile!.mutates === "none" ? "read" : "write")
    }
  })

  it("marks archiving destructive, since a project session's worktree goes with it", () => {
    const archive = appSessionsToolDefinitions.find((definition) => definition.tool.function.name === "archive_session")!
    expect(archive.ax).toMatchObject({ destructive: true })
  })
})
