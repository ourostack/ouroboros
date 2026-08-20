import { describe, expect, it, vi } from "vitest"

import { runSanctuaryHealthHabit } from "../../senses/sanctuary-health-runner"

describe("native Sanctuary health habit", () => {
  it("enqueues one private turn and fences its single Telegram delivery", async () => {
    const order: string[] = []
    const sweep = Object.assign(
      vi.fn(async () => ({ message: "Array degraded", incidents: [{ id: "array", summary: "degraded" }], deliveryId: "delivery-1" })),
      {
        cacheDeliveryPayload: vi.fn(async () => { order.push("cached") }),
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
      runPrivateTurn: vi.fn(async ({ eventId, payload, deliver }) => {
        order.push(`private:${eventId}:${payload}`)
        await deliver("summarized alert")
        return { delivered: true }
      }),
    })).resolves.toMatchObject({ ok: true, data: { incidentCount: 1, delivered: true } })

    expect(order).toEqual(["private:delivery-1:Array degraded", "cached", "attempting", "send", "delivered:71"])
    expect(api.stop).toHaveBeenCalledOnce()
  })

  it("stops unchanged sweeps before credentials, provider, or Telegram work", async () => {
    const sweep = Object.assign(
      vi.fn(async () => ({ message: null, incidents: [] })),
      { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() },
    )
    const credentials = vi.fn()
    const createApi = vi.fn()
    const runPrivateTurn = vi.fn()

    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => sweep,
      credentials,
      createApi,
      runPrivateTurn,
    })).resolves.toMatchObject({ ok: true, data: { incidentCount: 0, delivered: false } })

    expect(credentials).not.toHaveBeenCalled()
    expect(createApi).not.toHaveBeenCalled()
    expect(runPrivateTurn).not.toHaveBeenCalled()
  })

  it("permits at most one Telegram attempt per private turn", async () => {
    const sweep = Object.assign(
      vi.fn(async () => ({ message: "degraded", incidents: [], deliveryId: "delivery-2" })),
      { markDeliveryAttempting: vi.fn(), markDelivered: vi.fn() },
    )
    const api = { request: vi.fn(async () => ({ message_id: 72 })), stop: vi.fn() }

    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => sweep,
      createApi: () => api,
      credentials: () => ({ botToken: "token", authorizedChatId: "42" }),
      runPrivateTurn: async ({ deliver }) => {
        await deliver("first")
        await expect(deliver("second")).rejects.toThrow("already attempted")
        return { delivered: true }
      },
    })).resolves.toMatchObject({ ok: true, data: { delivered: true } })

    expect(api.request).toHaveBeenCalledOnce()
  })

  it("resumes a cached private-turn payload after a crash without another provider turn", async () => {
    const order: string[] = []
    const sweep = Object.assign(
      vi.fn(async () => ({ message: "raw", cachedMessage: "cached summary", incidents: [], deliveryId: "delivery-3" })),
      {
        cacheDeliveryPayload: vi.fn(async () => { order.push("cache-confirmed") }),
        markDeliveryAttempting: vi.fn(async () => { order.push("attempting") }),
        markDelivered: vi.fn(async () => { order.push("delivered") }),
      },
    )
    const api = { request: vi.fn(async () => { order.push("send"); return { message_id: 73 } }), stop: vi.fn() }
    const runPrivateTurn = vi.fn()

    await runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => sweep,
      createApi: () => api,
      credentials: () => ({ botToken: "token", authorizedChatId: "42" }),
      runPrivateTurn,
    })

    expect(runPrivateTurn).not.toHaveBeenCalled()
    expect(order).toEqual(["cache-confirmed", "attempting", "send", "delivered"])
  })

  it("keeps an undelivered private event pending", async () => {
    const sweep = vi.fn(async () => ({ message: "degraded", incidents: [], deliveryId: "delivery-4" }))
    const api = { request: vi.fn(), stop: vi.fn() }
    await expect(runSanctuaryHealthHabit("sanctuary", {
      createSweep: () => sweep,
      createApi: () => api,
      credentials: () => ({ botToken: "token", authorizedChatId: "42" }),
      runPrivateTurn: async () => ({ delivered: false }),
    })).resolves.toMatchObject({ message: "health event remains pending", data: { delivered: false } })
    expect(api.stop).toHaveBeenCalledOnce()
  })
})
