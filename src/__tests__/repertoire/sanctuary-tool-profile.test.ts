import { afterEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"

import { getChannelCapabilities } from "@ouro.bot/friends"
import { resetIdentity, setAgentName } from "../../heart/identity"
import { approvalPolicyForToolName, execTool, getSanctuaryRelationshipTools, getToolsForChannel, resolveToolDefinition } from "../../repertoire/tools"
import { baseToolDefinitions } from "../../repertoire/tools-base"

describe("Sanctuary active tool profile", () => {
  afterEach(() => resetIdentity())

  it("advertises exactly the locked Telegram surface", () => {
    setAgentName("sanctuary")
    const names = getToolsForChannel(getChannelCapabilities("telegram")).map((tool) => tool.function.name)
    expect(names).toEqual([
      "save_friend_note",
      "query_active_work",
      "query_cares",
      "care_manage",
      "list_recent_attachments",
      "materialize_attachment",
      "describe_image",
      "await_condition",
      "resolve_await",
      "cancel_await",
      "telegram_contact_manage",
      "unraid_list_containers",
      "unraid_get_container_logs",
      "unraid_get_storage",
      "sanctuary_get_media_optimization",
      "unraid_get_disks",
      "unraid_get_notifications",
      "unraid_get_system",
      "unraid_check_services",
      "sanctuary_get_download_queue",
      "sanctuary_resume_download_queue",
      "unraid_restart_container",
      "steward_policy_manage",
      "ponder",
      "settle",
      "speak",
    ])
    const packaged = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8"))
    expect(packaged.version).toBe(2)
    expect(packaged.profiles["sanctuary-owner"].version).toBe(6)
    expect(packaged.profiles["sanctuary-household"].version).toBe(5)
    expect(packaged.profiles["sanctuary-event"].version).toBe(4)
    expect(packaged.profiles["sanctuary-owner"].toolNames).toEqual(expect.arrayContaining(names))
    expect(packaged.profiles["sanctuary-owner"].toolNames).toEqual(expect.arrayContaining(["external_event_disposition", "query_active_work", "query_cares", "care_manage", "await_condition", "resolve_await", "cancel_await"]))
    expect(packaged.profiles["sanctuary-owner"].toolNames).toContain("save_friend_note")
    expect(packaged.profiles["sanctuary-household"].toolNames).toContain("save_friend_note")
    for (const profile of ["sanctuary-owner", "sanctuary-household"]) {
      expect(packaged.profiles[profile].toolNames).toEqual(expect.arrayContaining(["list_recent_attachments", "materialize_attachment", "describe_image"]))
    }
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("telegram_contact_manage")
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("sanctuary_get_download_queue")
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("sanctuary_resume_download_queue")
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("sanctuary_get_media_optimization")
    expect(packaged.profiles["sanctuary-event"].toolNames).toContain("sanctuary_get_media_optimization")
    expect(packaged.profiles["sanctuary-event"].toolNames).toContain("sanctuary_get_download_queue")
    expect(packaged.profiles["sanctuary-event"].toolNames).not.toContain("sanctuary_resume_download_queue")
    expect(packaged.profiles["sanctuary-event"].toolNames).toEqual(expect.arrayContaining(["external_event_disposition", "query_cares", "care_manage", "await_condition", "resolve_await", "steward_policy_manage", "rest"]))
    expect(packaged.profiles["sanctuary-event"].toolNames).not.toContain("send_message")
    expect(packaged.profiles["sanctuary-household"].toolNames).not.toContain("ponder")
    expect(packaged.profiles["sanctuary-household"].toolNames).toContain("unraid_restart_container")
    expect(names).not.toEqual(expect.arrayContaining(["shell", "read_file", "write_file", "jellyseerr_request", "sonarr_add", "radarr_add"]))
    expect(Object.keys(packaged.profiles)).toEqual(["sanctuary-owner", "sanctuary-household", "sanctuary-event"])
  })

  it("resolves every relationship profile from the same canonical Sanctuary definition pool", () => {
    setAgentName("sanctuary")
    const packaged = JSON.parse(fs.readFileSync("deploy/unraid/sanctuary.ouro/tool-profiles.json", "utf8")) as {
      profiles: Record<string, { toolNames: string[] }>
    }
    const resolve = (profile: string) => getSanctuaryRelationshipTools(packaged.profiles[profile]!.toolNames)
      .map((tool) => tool.function.name)

    for (const profile of ["sanctuary-owner", "sanctuary-household", "sanctuary-event"]) {
      expect(resolve(profile).toSorted()).toEqual(packaged.profiles[profile]!.toolNames.toSorted())
    }
    expect(resolve("sanctuary-event")).toEqual(expect.arrayContaining([
      "external_event_disposition",
      "steward_policy_manage",
      "unraid_list_containers",
      "unraid_get_container_logs",
      "unraid_restart_container",
      "rest",
    ]))
    expect(getSanctuaryRelationshipTools(["shell", "read_file", "unraid_get_system"]).map((tool) => tool.function.name))
      .toEqual(["unraid_get_system"])
  })

  it("keeps Telegram contact management owner-only and delegates exact mutations to the live manager", async () => {
    const manager = {
      list: vi.fn(async () => ({ contacts: [], blocked: [] })),
      revoke: vi.fn(async ({ friendId }: { friendId: string }) => ({ revoked: true as const, friendId })),
      unblock: vi.fn(async ({ admissionId }: { admissionId: string }) => ({ unblocked: true as const, admissionId })),
    }
    const base = { signin: async () => undefined, telegramContactManager: manager,
      relationshipAuthorization: { authorizedContextScopes: [], advertisedToolNames: ["telegram_contact_manage"], authorizeTool: async () => ({ allowed: true as const, receiptId: "owner" }) } } as any
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "list" }, base))).toMatchObject({ ok: false })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "list" }, { ...base, relationshipAuthorization: { ...base.relationshipAuthorization, actor: { friendId: "guest", trustLevel: "friend" } } }))).toMatchObject({ ok: false })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "list" }, { ...base, telegramContactManager: undefined, relationshipAuthorization: { ...base.relationshipAuthorization, actor: { friendId: "ari", trustLevel: "family" } } }))).toMatchObject({ ok: false })
    const owner = { ...base, relationshipAuthorization: { ...base.relationshipAuthorization, actor: { friendId: "ari", trustLevel: "family", sessionEventId: "evt-owner" } } }
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "list" }, owner))).toMatchObject({ ok: true, contacts: [] })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "revoke", friendId: "sibling" }, owner))).toMatchObject({ ok: true, revoked: true })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "unblock", admissionId: "admission" }, owner))).toMatchObject({ ok: true, unblocked: true })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "revoke" }, owner))).toMatchObject({ ok: false })
    expect(JSON.parse(await execTool("telegram_contact_manage", { action: "unblock", admissionId: "   " }, owner))).toMatchObject({ ok: false })
    expect(JSON.parse(await execTool("telegram_contact_manage", {}, owner))).toMatchObject({ ok: false })
    expect(resolveToolDefinition("telegram_contact_manage")!.riskProfile!({ action: "list" })).toEqual({ mutates: "none", risk: "low" })
    expect(resolveToolDefinition("telegram_contact_manage")!.riskProfile!({ action: "revoke" })).toMatchObject({ mutates: "durable_state_write", risk: "high" })
    expect(approvalPolicyForToolName("telegram_contact_manage", { action: "revoke" })).toEqual({ kind: "not_required" })
  })

  it("deduplicates relationship schemas by canonical tool name", () => {
    const original = baseToolDefinitions.find((definition) => definition.tool.function.name === "query_active_work")!
    baseToolDefinitions.push({ ...original, tool: { ...original.tool, function: { ...original.tool.function } } })
    try {
      expect(getSanctuaryRelationshipTools(["query_active_work"]).filter((tool) => tool.function.name === "query_active_work")).toHaveLength(1)
    } finally {
      baseToolDefinitions.pop()
    }
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
    expect(approvalPolicyForToolName("sanctuary_resume_download_queue", {})).toEqual({ kind: "required", policyId: "sanctuary.downloads.resume.v1", actionClass: "sanctuary.downloads.resume", requiresSoleCall: true })
    expect(resolveToolDefinition("sanctuary_get_download_queue")?.riskProfile).toMatchObject({ risk: "low", mutates: "none" })
    expect(resolveToolDefinition("sanctuary_resume_download_queue")?.riskProfile).toMatchObject({ risk: "high", mutates: "external_side_effect" })
  })
})
