import { describe, expect, it } from "vitest"

import { houseCareToolDefinitions, houseDigestToolDefinition, houseSweepToolDefinition } from "../../repertoire/tools-house-care"
import { authorizeRootHostToolInvocation, rootHostToolDefinition } from "../../repertoire/tools-sanctuary-host"
import { unraidToolDefinitions, withCardCode } from "../../repertoire/tools-unraid"
import { formatTelegramApprovalPrompt } from "../../senses/telegram-approval-runtime"

const definitions = [...unraidToolDefinitions, rootHostToolDefinition, ...houseCareToolDefinitions]
const named = (name: string) => definitions.find((definition) => definition.tool.function.name === name)!

describe("Sanctuary tool cards", () => {
  it("gives every Sanctuary tool a card under its own id in the turn-sanctuary group", () => {
    for (const definition of definitions) {
      expect(definition.ax, definition.tool.function.name).toMatchObject({ id: `tool:${definition.tool.function.name}`, group: "turn-sanctuary" })
    }
    expect(definitions).toHaveLength(16)
  })

  it("says consequential exactly for the tools that ask for approval", () => {
    for (const definition of definitions) {
      expect(definition.ax!.effect === "consequential", definition.tool.function.name).toBe(definition.approvalPolicy !== undefined)
    }
  })

  it("quotes the Telegram approval question word for word in each confirm line", () => {
    expect(named("sanctuary_resume_download_queue").ax!.confirm).toBe(formatTelegramApprovalPrompt("sanctuary_resume_download_queue", {}))
    expect(named("unraid_restart_container").ax!.confirm).toBe(formatTelegramApprovalPrompt("unraid_restart_container", { container: "<container>" }))
  })

  it("tags a missing runtime with the tool-context-missing code", async () => {
    for (const definition of unraidToolDefinitions) {
      const result = JSON.parse(await definition.handler({ container: "alpha", tailLines: "1" }, undefined))
      expect(result.error.code).toBe("tool_context_missing")
      expect(result.error.message).toMatch(/report it\. \(code: tool-context-missing\)$/)
    }
  })

  it("ends a failed Sanctuary result's message with its card code", () => {
    expect(withCardCode({ ok: false, error: { code: "not_found", message: "container 'x' was not found", degraded: true } }))
      .toEqual({ ok: false, error: { code: "not_found", message: "container 'x' was not found (code: not-found)", degraded: true } })
    expect(withCardCode({ ok: false, error: { code: "invalid_response", message: "bad" } })).toEqual({ ok: false, error: { code: "invalid_response", message: "bad (code: invalid-response)" } })
    expect(withCardCode({ ok: false, error: { code: "unavailable", message: "Media service is unavailable" } })).toEqual({ ok: false, error: { code: "unavailable", message: "Media service is unavailable (code: unavailable)" } })
  })

  it("leaves every other result as it is", () => {
    const ok = { ok: true, data: {} }
    expect(withCardCode(ok)).toBe(ok)
    expect(withCardCode(null)).toBeNull()
    const unknownCode = { ok: false, error: { code: "credential_unavailable" } }
    expect(withCardCode(unknownCode)).toBe(unknownCode)
    const inherited = { ok: false, error: { code: "toString", message: "x" } }
    expect(withCardCode(inherited)).toBe(inherited)
    const noMessage = { ok: false, error: { code: "timeout" } }
    expect(withCardCode(noMessage)).toBe(noMessage)
    const noError = { ok: false }
    expect(withCardCode(noError)).toBe(noError)
  })

  it("tags a failed media catalog search with its code", async () => {
    const search = named("sanctuary_search_media_catalog")
    const sanctuary = { searchMediaCatalog: async () => ({ ok: false, error: { code: "invalid_response", message: "Media catalog query is too long", degraded: true } }) }
    expect(JSON.parse(await search.handler({ query: "x" }, { sanctuary } as never)).error.message).toBe("Media catalog query is too long (code: invalid-response)")
  })

  it("tags a restart refused for want of a grant with routine-action-denied", async () => {
    const restart = named("unraid_restart_container")
    const result = JSON.parse(await restart.handler({ container: "alpha" }, { routineActionSelection: { kind: "denied", reason: "no grant" } } as never))
    expect(result.error).toMatchObject({ code: "routine_action_denied", message: "no grant (code: routine-action-denied)" })
  })

  it("ends the host command's refusals with their codes", async () => {
    expect(() => rootHostToolDefinition.handler({}, undefined)).toThrow("resident execution is forbidden (code: resident-execution-forbidden)")
    await expect(authorizeRootHostToolInvocation(undefined, undefined, {})).rejects.toThrow("Sanctuary root host authorization denied (code: root-host-denied)")
  })

  it("adds a code beside each house-care error a card names", async () => {
    expect(JSON.parse(await houseSweepToolDefinition.handler({}, undefined) as string)).toMatchObject({ code: "sweep-runtime-missing" })
    expect(JSON.parse(await houseDigestToolDefinition.handler({ finding_ids: ["a"] } as never, undefined) as string)).toMatchObject({ code: "sweep-runtime-missing" })
  })
})
