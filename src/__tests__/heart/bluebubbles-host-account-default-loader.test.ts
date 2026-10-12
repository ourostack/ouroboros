import { describe, expect, it, vi } from "vitest"

const loadAgentConfig = vi.hoisted(() => vi.fn())
vi.mock("../../heart/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../heart/identity")>()),
  loadAgentConfig,
}))

import { checkBlueBubblesSenseHostAccount } from "../../heart/bluebubbles-host-account"

describe("checkBlueBubblesSenseHostAccount default loader", () => {
  it("reads the running agent's config when no loader is given", () => {
    loadAgentConfig.mockReturnValue({ senses: { bluebubbles: { enabled: true, hostUsername: "clawdbot" } } })
    const result = checkBlueBubblesSenseHostAccount("slugger", undefined, { username: "arimendelow", uid: 501 })
    expect(loadAgentConfig).toHaveBeenCalledOnce()
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "mismatch" }))
  })

  it("treats a config without senses as having no declared host", () => {
    loadAgentConfig.mockReturnValue({})
    const result = checkBlueBubblesSenseHostAccount("slugger", undefined, { username: "arimendelow", uid: 501 })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "unset" }))
  })
})
