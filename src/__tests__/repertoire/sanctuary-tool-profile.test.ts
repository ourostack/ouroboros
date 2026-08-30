import { afterEach, describe, expect, it } from "vitest"
import * as fs from "node:fs"

import { getChannelCapabilities } from "@ouro.bot/friends"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { approvalPolicyForToolName, getToolsForChannel, resolveToolDefinition } from "../../repertoire/tools"

describe("Sanctuary active tool profile", () => {
  afterEach(() => resetIdentity())

  it("advertises exactly the locked Telegram surface", () => {
    setAgentName("sanctuary")
    const names = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)
    expect(names).toEqual([
      "query_active_work",
      "query_cares",
      "care_manage",
      "await_condition",
      "cancel_await",
      "unraid_list_containers",
      "unraid_get_container_logs",
      "unraid_get_storage",
      "unraid_get_disks",
      "unraid_get_notifications",
      "unraid_get_system",
      "unraid_restart_container",
      "steward_policy_manage",
      "ponder",
      "settle",
      "speak",
    ])
    const packaged = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8"))
    expect(packaged.version).toBe(2)
    expect(packaged.profiles["sanctuary-owner"].toolNames).toEqual(expect.arrayContaining(names))
    expect(packaged.profiles["sanctuary-owner"].toolNames).toEqual(expect.arrayContaining(["external_event_disposition", "query_active_work", "query_cares", "care_manage", "await_condition", "cancel_await"]))
    expect(packaged.profiles["sanctuary-event"].toolNames).toEqual(expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition", "steward_policy_manage", "rest"]))
    expect(packaged.profiles["sanctuary-event"].toolNames).not.toContain("send_message")
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("ponder")
    expect(names).not.toEqual(expect.arrayContaining(["shell", "read_file", "write_file", "jellyseerr_request", "sonarr_add", "radarr_add"]))
    expect(Object.keys(packaged.profiles)).toEqual(["sanctuary-owner", "sanctuary-household", "sanctuary-event"])
  })

  it("keeps non-Sanctuary Telegram agents on the generic tool profile", () => {
    setAgentName("slugger")
    const names = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)

    expect(names).toContain("shell")
    expect(names).toContain("read_file")
    expect(names).not.toContain("unraid_list_containers")
    expect(names).not.toContain("unraid_restart_container")
  })

  it("fails closed to the generic Telegram profile when agent identity is unavailable", () => {
    const names = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)

    expect(names).toContain("shell")
    expect(names).not.toContain("unraid_list_containers")
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
