import { describe, expect, it, vi } from "vitest"

const sab = vi.hoisted(() => ({
  create: vi.fn(),
  loadApiKey: vi.fn(async () => "test-only-secret"),
  readQueue: vi.fn(async () => ({ paused: true, observedAt: "2026-08-29T00:00:00.000Z" })),
}))

vi.mock("../../senses/sanctuary-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../senses/sanctuary-runtime")>()),
  loadSanctuarySabApiKey: sab.loadApiKey,
}))

vi.mock("../../senses/sanctuary-sab", () => ({
  createSanctuarySabClient: sab.create,
}))

import { createSabQueueProtectiveStateVerifier } from "../../senses/telegram"

describe("Telegram SAB verifier cache coverage", () => {
  it("uses the shared vault loader and reuses the typed SAB client", async () => {
    sab.create.mockReturnValue({ readQueue: sab.readQueue })
    const verify = createSabQueueProtectiveStateVerifier()
    const action = {
      action: "sabnzbd.pause" as const,
      actionReceipt: "receipt",
      transitionId: "transition",
      critical: true,
      createdAt: "2026-08-29T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
      verification: { verified: false, digest: "not-the-live-digest", observedAt: "2026-08-29T00:00:00.000Z" },
    }

    await expect(verify(action)).resolves.toMatchObject({ verified: false })
    await expect(verify(action)).resolves.toMatchObject({ verified: false })

    expect(sab.create).toHaveBeenCalledOnce()
    expect(sab.create).toHaveBeenCalledWith(expect.objectContaining({ loadApiKey: expect.any(Function) }))
    await expect(sab.create.mock.calls[0]![0].loadApiKey()).resolves.toBe("test-only-secret")
    expect(sab.loadApiKey).toHaveBeenCalledWith("sanctuary")
    expect(sab.readQueue).toHaveBeenCalledTimes(2)
  })
})
