import { describe, expect, it, vi } from "vitest"

import { runSanctuaryHealthHabit } from "../../senses/sanctuary-health-runner"

describe("native Sanctuary health habit", () => {
  it("runs deterministic checks and fences Telegram delivery without a model turn", async () => {
    const order: string[] = []
    const sweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", incidents: [{ id: "array", summary: "degraded" }], deliveryId: "delivery-1" })),
      {
        markDeliveryAttempting: vi.fn(async () => { order.push("attempting") }),
        markDelivered: vi.fn(async (_id: string, ids: number[]) => { order.push(`delivered:${ids.join(",")}`) }),
      },
    )
    const api = {
      request: vi.fn(async () => { order.push("send"); return { message_id: 71 } }),
      stop: vi.fn(),
    }

    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => sweep,
      createApi: () => api,
      credentials: () => ({ botToken: "token", authorizedChatId: "42" }),
    })).resolves.toMatchObject({ ok: true, data: { incidentCount: 1, delivered: true } })

    expect(order).toEqual(["attempting", "send", "delivered:71"])
    expect(api.stop).toHaveBeenCalledOnce()
  })
})
