import { describe, expect, it, vi } from "vitest"

import { withTelegramTypingIndicator } from "../../senses/telegram"

describe("Telegram typing indicator", () => {
  it("shows typing immediately and refreshes it until the turn finishes", async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(async () => undefined)
      let finish: (value: string) => void = () => undefined
      const turn = new Promise<string>((resolve) => { finish = resolve })
      const running = withTelegramTypingIndicator(send, () => turn)

      await Promise.resolve()
      expect(send).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(4_000)
      expect(send).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(4_000)
      expect(send).toHaveBeenCalledTimes(3)

      finish("answered")
      await expect(running).resolves.toBe("answered")

      await vi.advanceTimersByTimeAsync(12_000)
      expect(send).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("never lets a failed indicator take down the reply it decorates", async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(async () => { throw new Error("telegram refused the chat action") })
      await expect(withTelegramTypingIndicator(send, async () => "answered")).resolves.toBe("answered")
      expect(send).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("stops refreshing when the turn throws", async () => {
    vi.useFakeTimers()
    try {
      const send = vi.fn(async () => undefined)
      await expect(withTelegramTypingIndicator(send, async () => { throw new Error("turn failed") })).rejects.toThrow(/turn failed/u)
      const calls = send.mock.calls.length
      await vi.advanceTimersByTimeAsync(12_000)
      expect(send).toHaveBeenCalledTimes(calls)
    } finally {
      vi.useRealTimers()
    }
  })
})
