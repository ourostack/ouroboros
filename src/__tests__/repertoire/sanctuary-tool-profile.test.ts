import { describe, expect, it } from "vitest"

import { getChannelCapabilities } from "@ouro.bot/friends"
import { approvalPolicyForToolName, getToolsForChannel, resolveToolDefinition } from "../../repertoire/tools"

describe("Sanctuary active tool profile", () => {
  it("advertises exactly the locked Telegram surface", () => {
    const names = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)
    expect(names).toEqual([
      "unraid_list_containers",
      "unraid_get_container_logs",
      "unraid_get_storage",
      "unraid_get_disks",
      "unraid_get_notifications",
      "unraid_get_system",
      "unraid_restart_container",
      "ponder",
      "settle",
      "speak",
    ])
  })

  it("marks restart as sole-call approval-required and all reads as non-mutating", () => {
    expect(approvalPolicyForToolName("unraid_restart_container", { container: "calibre-web" })).toEqual({
      kind: "required",
      policyId: "sanctuary.unraid.restart.v1",
      actionClass: "unraid.container.restart",
      requiresSoleCall: true,
    })
    expect(resolveToolDefinition("unraid_restart_container")?.riskProfile).toMatchObject({ risk: "high", mutates: "external_side_effect" })
    expect(resolveToolDefinition("unraid_list_containers")?.riskProfile).toMatchObject({ risk: "low", mutates: "none" })
  })
})
