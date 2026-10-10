import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const sendBlueBubbles = vi.fn()
const sendTelegram = vi.fn()
vi.mock("../../../senses/bluebubbles", () => ({ sendProactiveBlueBubblesMessageToSession: (...args: unknown[]) => sendBlueBubbles(...args) }))
vi.mock("../../../senses/telegram", () => ({ sendTelegramAwaitFollowUp: (...args: unknown[]) => sendTelegram(...args) }))

import type { CrossChatDeliveryRequest, CrossChatDeliveryResult } from "../../../heart/cross-chat-delivery"
import { defaultOwnerNoticeDeliverers, notifyOwnerLive, type OwnerNoticeDeps } from "../../../senses/voice/local-audio-notify"

const target = { friendId: "ari", channel: "bluebubbles", key: "iMessage;-;ari" }
let queued: Array<{ agentName: string; text: string; target: typeof target }>

function deps(result: CrossChatDeliveryResult | Error): OwnerNoticeDeps & { requests: CrossChatDeliveryRequest[] } {
  const requests: CrossChatDeliveryRequest[] = []
  return {
    requests,
    deliver: async (request, d) => {
      requests.push(request)
      if (result instanceof Error) throw result
      if (result.status === "queued_for_later") d.queuePending({ from: d.agentName, friendId: request.friendId, channel: request.channel, key: request.key, content: request.content, timestamp: 1 })
      return result
    },
    queuePending: (agentName, t, text) => { queued.push({ agentName, text, target: t }) },
    deliverers: {},
  }
}

beforeEach(() => { queued = []; sendBlueBubbles.mockReset(); sendTelegram.mockReset() })

describe("notifyOwnerLive", () => {
  it("delivers through the same cross-chat path send_message uses, and queues nothing when it was delivered live", async () => {
    const d = deps({ status: "delivered_now", detail: "sent" })
    await expect(notifyOwnerLive("slugger", target, "I joined", d)).resolves.toBe("delivered_now")
    expect(d.requests).toEqual([{ friendId: "ari", channel: "bluebubbles", key: "iMessage;-;ari", content: "I joined", intent: "generic_outreach" }])
    expect(queued).toEqual([])
  })

  it("leaves a message the delivery path already queued alone (no duplicate)", async () => {
    const d = deps({ status: "queued_for_later", detail: "later" })
    const writes: string[] = []
    d.queuePending = (_a, _t, text) => { writes.push(text) }
    await expect(notifyOwnerLive("slugger", target, "I left", d)).resolves.toBe("queued_for_later")
    // The cross-chat path queued it through our queuePending exactly once.
    expect(writes).toEqual(["I left"])
  })

  it.each([
    [{ status: "failed", detail: "send failed" } as CrossChatDeliveryResult],
    [{ status: "blocked", detail: "blocked" } as CrossChatDeliveryResult],
  ])("falls back to the pending queue when live delivery %o did not happen", async (result) => {
    const d = deps(result)
    await expect(notifyOwnerLive("slugger", target, "I left", d)).resolves.toBe("queued_for_later")
    expect(queued).toEqual([{ agentName: "slugger", text: "I left", target }])
  })

  it("falls back to the pending queue when the delivery path throws, whatever it throws", async () => {
    const d = deps(new Error("boom"))
    await expect(notifyOwnerLive("slugger", target, "I left", d)).resolves.toBe("queued_for_later")
    expect(queued).toHaveLength(1)
    const odd = deps(new Error("x"))
    odd.deliver = async () => { throw "plain string" }
    await expect(notifyOwnerLive("slugger", target, "I left", odd)).resolves.toBe("queued_for_later")
    expect(queued).toHaveLength(2)
  })
})

describe("defaultOwnerNoticeDeliverers", () => {
  it("maps BlueBubbles results to delivery statuses", async () => {
    const { bluebubbles } = defaultOwnerNoticeDeliverers("slugger")
    const request = { friendId: "ari", channel: "bluebubbles", key: "k", content: "hi", intent: "generic_outreach" as const }
    sendBlueBubbles.mockResolvedValueOnce({ delivered: true })
    expect((await bluebubbles!(request)).status).toBe("delivered_now")
    sendBlueBubbles.mockResolvedValueOnce({ delivered: false, reason: "missing_target" })
    expect((await bluebubbles!(request)).status).toBe("blocked")
    sendBlueBubbles.mockResolvedValueOnce({ delivered: false, reason: "blocked_meta_content" })
    expect((await bluebubbles!(request)).status).toBe("blocked")
    sendBlueBubbles.mockResolvedValueOnce({ delivered: false, reason: "send_error" })
    expect((await bluebubbles!(request)).status).toBe("failed")
    sendBlueBubbles.mockResolvedValueOnce({ delivered: false, reason: "no_client" })
    expect((await bluebubbles!(request)).status).toBe("unavailable")
    expect(sendBlueBubbles.mock.calls[0]![0]).toMatchObject({ friendId: "ari", sessionKey: "k", text: "hi", intent: "generic_outreach" })
  })

  it("sends Telegram notices as an await follow-up with a stable delivery id", async () => {
    const { telegram } = defaultOwnerNoticeDeliverers("slugger")
    sendTelegram.mockResolvedValue({ status: "delivered_now", detail: "ok" })
    const request = { friendId: "ari", channel: "telegram", key: "12345", content: "hi", intent: "generic_outreach" as const }
    await expect(telegram!(request)).resolves.toEqual({ status: "delivered_now", detail: "ok" })
    const sent = sendTelegram.mock.calls[0]!
    expect(sent[0]).toBe("slugger")
    expect(sent[1]).toMatchObject({ friendId: "ari", content: "hi" })
    expect(sent[1].deliveryId).toMatch(/^local-audio-notice:/)
    await telegram!(request)
    expect(sendTelegram.mock.calls[1]![1].deliveryId).toBe(sent[1].deliveryId)
  })
})

describe("the default queue and deliverers", () => {
  let root: string
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "laN-")) })
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }) })

  it("queues in the session's pending directory and uses the real deliver path when no deps are given", async () => {
    const result = await notifyOwnerLive("slugger", { friendId: "ari", channel: "cli", key: "session" }, "I joined", { agentRoot: path.join(root, "slugger.ouro") })
    expect(result).toBe("queued_for_later")
    const dir = path.join(root, "slugger.ouro", "state", "pending", "ari", "cli", "session")
    expect(fs.readdirSync(dir).length).toBe(1)
    expect(fs.readFileSync(path.join(dir, fs.readdirSync(dir)[0]!), "utf8")).toContain("I joined")
  })
})
