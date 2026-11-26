import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  sendBb: vi.fn(),
  sendTelegram: vi.fn(),
  sendTeams: vi.fn(),
}))

vi.mock("../../senses/bluebubbles", () => ({ sendProactiveBlueBubblesMessageToSession: mocks.sendBb }))
vi.mock("../../senses/telegram", () => ({ sendTelegramAwaitFollowUp: mocks.sendTelegram }))
vi.mock("../../senses/teams-off-turn", () => ({ sendTeamsOffTurn: mocks.sendTeams }))

import { routeSurfaceToFriend, sendSpontaneousOutreach, spontaneousOutreachSenders, surfaceImageRefusal } from "../../repertoire/tools-surface"

const target = { friendId: "f", channel: "bluebubbles", key: "chat:any;-;a@b.c", lastActivityMs: Date.now() }

describe("surface imagePath", () => {
  beforeEach(() => {
    mocks.sendBb.mockReset()
    mocks.sendTelegram.mockReset()
    mocks.sendTeams.mockReset()
  })

  it("refuses an image that cannot ride the delivery, and allows the rest", () => {
    expect(surfaceImageRefusal(undefined, { heldThought: false })).toBeUndefined()
    expect(surfaceImageRefusal({ channel: "auto" }, { heldThought: false })).toBeUndefined()
    expect(surfaceImageRefusal({ imagePath: "/tmp/a.png" }, { heldThought: false })).toBeUndefined()
    expect(surfaceImageRefusal({ imagePath: "a.png" }, { heldThought: false })).toContain("relative-path")
    expect(surfaceImageRefusal({ imagePath: "/tmp/a.png", channel: "voice" }, { heldThought: false })).toContain("image-unsupported")
    expect(surfaceImageRefusal({ imagePath: "/tmp/a.png", channel: "teams" }, { heldThought: false })).toContain("image-unsupported")
    expect(surfaceImageRefusal({ imagePath: "/tmp/a.png" }, { heldThought: true })).toContain("image-unsupported")
  })

  it("fails a surface with a bad image before routing anywhere", async () => {
    const result = await routeSurfaceToFriend("agent", "f", "hi", undefined, { imagePath: "a.png" })
    expect(result.status).toBe("failed")
    expect(mocks.sendBb).not.toHaveBeenCalled()
  })

  it("passes the image to the iMessage sender and reports delivery", async () => {
    mocks.sendBb.mockResolvedValue({ delivered: true })
    const senders = spontaneousOutreachSenders("agent", "/root", "hi", undefined, "/tmp/a.png")
    expect(await senders.bluebubbles(target)).toEqual({ status: "delivered", detail: "texted them by iMessage now" })
    expect(mocks.sendBb).toHaveBeenCalledWith(expect.objectContaining({ imagePath: "/tmp/a.png" }))
  })

  it("omits imagePath when none was named", async () => {
    mocks.sendBb.mockResolvedValue({ delivered: true })
    await spontaneousOutreachSenders("agent", "/root", "hi").bluebubbles(target)
    expect(mocks.sendBb.mock.calls[0][0]).not.toHaveProperty("imagePath")
  })

  it("turns an unsendable image into a refusal that stops the search", async () => {
    mocks.sendBb.mockResolvedValue({ delivered: false, reason: "image_unsendable", detail: "a.png is empty" })
    const senders = spontaneousOutreachSenders("agent", "/root", "hi", undefined, "/tmp/a.png")
    expect(await senders.bluebubbles(target)).toEqual({ status: "refused", why: "a.png is empty", imageProblem: true })
    const out = await sendSpontaneousOutreach("f", [target], senders, Date.now())
    expect(out).toMatchObject({ sent: { status: "failed" } })
    expect((out as any).sent.detail).toContain("image-unsendable")
    expect((out as any).sent.detail).toContain("a.png is empty")
  })

  it("falls back to a generic reason when the image refusal names none", async () => {
    mocks.sendBb.mockResolvedValue({ delivered: false, reason: "image_unsendable" })
    const senders = spontaneousOutreachSenders("agent", "/root", "hi", undefined, "/tmp/a.png")
    expect(await senders.bluebubbles(target)).toMatchObject({ why: "the image could not be sent" })
  })

  it("does not send an image on Telegram or Teams", async () => {
    const senders = spontaneousOutreachSenders("agent", "/root", "hi", undefined, "/tmp/a.png")
    expect(await senders.telegram({ ...target, channel: "telegram" })).toMatchObject({ status: "unsent" })
    expect(await senders.teams({ ...target, channel: "teams" })).toMatchObject({ status: "unsent" })
    expect(mocks.sendTelegram).not.toHaveBeenCalled()
    expect(mocks.sendTeams).not.toHaveBeenCalled()
  })
})
