import { describe, expect, it } from "vitest"
import { unraidToolDefinitions } from "../../../repertoire/tools-unraid"
import { createSyntheticSanctuary } from "../../../eval/transport/synthetic-sanctuary"
import { STOPPED_ON_PURPOSE_NOTE } from "../../../repertoire/sanctuary-container-policy"

async function call(name: string, args: Record<string, unknown> = {}) {
  const definition = unraidToolDefinitions.find((tool) => tool.tool.function.name === name)!
  return JSON.parse(await definition.handler(args, { sanctuary: createSyntheticSanctuary() } as never)) as { ok?: boolean; data?: Record<string, any>; error?: { code: string } }
}

describe("synthetic Sanctuary for the eval turn", () => {
  it.each([
    "unraid_list_containers", "unraid_get_storage", "unraid_get_disks", "unraid_get_notifications", "unraid_get_system",
    "sanctuary_get_install_state", "unraid_check_services", "sanctuary_get_media_optimization",
  ])("%s answers instead of tool_context_missing", async (name) => {
    const result = await call(name)
    expect(result.error?.code).not.toBe("tool_context_missing")
    expect(result.ok).toBe(true)
  })

  it("lists the containers through the production mapping and the production annotation", async () => {
    const result = await call("unraid_list_containers")
    expect(result.data!.containers.map((container: { name: string; state: string }) => `${container.name}:${container.state}`)).toEqual([
      "calibre:exited", "calibre-web:running", "jellyfin:running", "sabnzbd:running", "unmanic:running",
    ])
    const byName = Object.fromEntries(result.data!.containers.map((container: { name: string }) => [container.name, container]))
    // As on the household: the calibre desktop app is kept stopped on purpose, and Books is calibre-web.
    expect(byName.calibre).toMatchObject({ desired: "stopped", note: STOPPED_ON_PURPOSE_NOTE })
    expect(byName["calibre-web"]).toMatchObject({ serves: "Books" })
  })

  it("checks the services the way production names them: by house endpoint, with Books on calibre-web", async () => {
    const result = await call("unraid_check_services")
    expect(result.data!.services).toEqual([
      { name: "books", container: "calibre-web", url: expect.stringMatching(/^https:\/\//), ok: true, status: 200 },
      { name: "jellyfin", url: expect.stringMatching(/^https:\/\//), ok: true, status: 200 },
    ])
  })

  it("reads a container's logs and refuses an unknown container", async () => {
    expect((await call("unraid_get_container_logs", { container: "jellyfin", tailLines: 5 })).data!.text).toContain("listening")
    expect((await call("unraid_get_container_logs", { container: "nope", tailLines: 5 })).error?.code).toBe("not_found")
  })

  it("reports the download queue", async () => {
    const definition = unraidToolDefinitions.find((tool) => tool.tool.function.name === "sanctuary_get_download_queue")!
    expect(JSON.parse(await definition.handler({}, { sanctuary: createSyntheticSanctuary() } as never))).toMatchObject({ paused: false, queuedJobs: 0 })
  })

  it("searches the media catalog by title and samples it without one", async () => {
    expect((await call("sanctuary_search_media_catalog", { query: "harbor" })).data!.items).toHaveLength(1)
    expect((await call("sanctuary_search_media_catalog", { limit: 2 })).data).toMatchObject({ matchedItems: 3, truncated: true })
    expect((await call("sanctuary_search_media_catalog", { query: "zzz" })).data!.items).toEqual([])
  })

  it("never simulates a mutation", async () => {
    const sanctuary = createSyntheticSanctuary()
    expect(await sanctuary.restartContainer({ container: "jellyfin" })).toMatchObject({ ok: false, error: { code: "unavailable" } })
    expect(await sanctuary.resumeDownloadQueue()).toMatchObject({ ok: false, error: { code: "unavailable" } })
  })
})
