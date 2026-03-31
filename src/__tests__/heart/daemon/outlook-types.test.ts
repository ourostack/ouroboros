import { describe, expect, it, vi } from "vitest"

vi.mock("../../../nerves/runtime", () => ({
  emitNervesEvent: vi.fn(),
}))

describe("outlook types", () => {
  it("defines the canonical Outlook identity and release defaults", async () => {
    const mod = await import("../../../heart/daemon/outlook-types")

    expect(mod.OUTLOOK_PRODUCT_NAME).toBe("Ouro Outlook")
    expect(mod.OUTLOOK_RELEASE_INTERACTION_MODEL).toBe("read-only")
    expect(mod.OUTLOOK_DEFAULT_INNER_VISIBILITY).toBe("summary")
  })
})
