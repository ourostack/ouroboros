import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { fetchJson, subscribeToEvents } from "./api"
import { TestEventSource, jsonResponse } from "./test-fixtures"

beforeEach(() => {
  TestEventSource.instances = []
  vi.stubGlobal("EventSource", TestEventSource)
})

afterEach(() => vi.unstubAllGlobals())

describe("Mailbox event connection", () => {
  it("reports disconnect and refreshes on reconnect without waiting for a change event", () => {
    const states: string[] = []
    const events: string[] = []
    const stop = subscribeToEvents((event) => events.push(event), (state) => states.push(state))
    const source = TestEventSource.instances[0]!
    expect(states).toEqual(["connecting"])
    source.open()
    source.disconnect()
    source.open()
    expect(states).toEqual(["connecting", "connected", "reconnecting", "connected"])
    expect(events).toEqual(["connected", "connected"])
    stop()
  })

  it("does not publish queued events after the subscriber has stopped", () => {
    const events: string[] = []
    const stop = subscribeToEvents((event) => events.push(event))
    const source = TestEventSource.instances[0]!
    stop()
    source.change()
    source.open()
    expect(source.closed).toBe(true)
    expect(events).toEqual([])
  })

  it("forwards cancellation to the actual fetch boundary", async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.signal !== controller.signal) throw new Error("request has no cancellation signal")
      return jsonResponse({ ok: true })
    })
    vi.stubGlobal("fetch", fetch)
    await expect(fetchJson("/machine", { signal: controller.signal })).resolves.toEqual({ ok: true })
  })
})
