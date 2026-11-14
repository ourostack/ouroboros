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
    expect(names("bluebubbles", { habitSession: { toolPolicy: { outwardMessagingAllowed: true, grantedTools: [] } } })).not.toContain("react")
  })
})
