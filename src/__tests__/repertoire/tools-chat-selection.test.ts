import { describe, expect, it } from "vitest"
import { getChannelCapabilities } from "@ouro.bot/friends"

import { selectToolsForChannel } from "../../repertoire/tools"

describe("chat action tools on the menu", () => {
  const names = (channel: string, context: Record<string, unknown> = {}) => selectToolsForChannel(
    { ...getChannelCapabilities(channel), availableIntegrations: [] },
    undefined, undefined, undefined, undefined, undefined, context as never,
  ).ordinary.map(({ tool }) => tool.function.name)

  it("are offered in iMessage and Telegram chats", () => {
    for (const channel of ["bluebubbles", "telegram"]) expect(names(channel)).toEqual(expect.arrayContaining(["react", "set_reply_target"]))
  })

  it("are not offered where there is no chat to act in, or the turn may not send", () => {
    for (const channel of ["cli", "teams", "inner"]) expect(names(channel)).not.toContain("react")
    expect(names("telegram", { noSend: true })).not.toContain("react")
    expect(names("telegram", { autonomousTurnKind: "proactive" })).not.toContain("set_reply_target")
    expect(names("bluebubbles", { habitSession: { permissionEnvelope: { schemaVersion: 1, canMessageOutward: true, returnRoutes: [], deniedTools: [], warnings: [] } } })).not.toContain("react")
  })

  it("offer send_file on every sense that takes files: iMessage, Telegram and Teams", () => {
    for (const channel of ["bluebubbles", "telegram", "teams"]) expect(names(channel)).toContain("send_file")
    for (const channel of ["cli", "inner"]) expect(names(channel)).not.toContain("send_file")
    expect(names("telegram", { noSend: true })).not.toContain("send_file")
  })

  it("give a habit's private-runtime turn send_message and surface only when it may message outward", () => {
    const habitSession = (canMessageOutward: boolean) => ({
      habitSession: { permissionEnvelope: { schemaVersion: 1, canMessageOutward, returnRoutes: [], deniedTools: [], warnings: [] } },
    })
    expect(names("inner", habitSession(true))).toEqual(expect.arrayContaining(["send_message", "surface", "shell"]))
    const quiet = names("inner", habitSession(false))
    expect(quiet).not.toContain("send_message")
    expect(quiet).not.toContain("surface")
    expect(quiet).toContain("shell")
    expect(names("inner")).toContain("surface")
  })
})
