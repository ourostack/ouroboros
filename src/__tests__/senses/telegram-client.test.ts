import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  TelegramApiError,
  createTelegramBotApi,
  escapeTelegramHtml,
  sendTelegramText,
  splitTelegramText,
  FileTelegramOffsetStore,
  createTelegramLongPoll,
  type TelegramBotApi,
} from "../../senses/telegram-client"

const token = "123456:super-secret-token"
const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function makeTempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

describe("Telegram Bot API HTTP core", () => {
  it("posts JSON to the exact bot method and returns a validated result", async () => {
    const fetch = vi.fn(async () => jsonResponse({ ok: true, result: { id: 42 } }))
    const api = createTelegramBotApi({ token, fetch })

    await expect(api.request("getMe", { probe: true })).resolves.toEqual({ id: 42 })
    expect(fetch).toHaveBeenCalledWith(`https://api.telegram.org/bot${token}/getMe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ probe: true }),
      signal: expect.any(AbortSignal),
    })
  })

  it.each([
    ["Bot API error", jsonResponse({ ok: false, error_code: 400, description: `bad ${token}` }, 400)],
    ["HTTP failure", new Response("gateway failure", { status: 502 })],
    ["invalid envelope", jsonResponse({ result: {} })],
    ["missing result", jsonResponse({ ok: true })],
  ])("fails safely for %s without leaking the token", async (_label, response) => {
    const api = createTelegramBotApi({ token, fetch: vi.fn(async () => response) })
    const error = await api.request("sendMessage", { text: token }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramApiError)
    expect(String(error)).not.toContain(token)
  })

  it("redacts the token from transport failures", async () => {
    const api = createTelegramBotApi({
      token,
      fetch: vi.fn(async () => { throw new Error(`socket failed for ${token}`) }),
    })
    const error = await api.request("getUpdates", {}).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(TelegramApiError)
    expect(String(error)).not.toContain(token)
  })
})

describe("Telegram durable authorized long poll", () => {
  it("restores offsets, suppresses duplicates, and advances past foreign updates before dispatch", async () => {
    const directory = makeTempDirectory("ouro-telegram-offset-")
    const path = join(directory, "offset.json")
    writeFileSync(path, JSON.stringify({ nextUpdateId: 5 }))
    const store = new FileTelegramOffsetStore(path)
    const onMessage = vi.fn(async () => undefined)
    const request = vi.fn(async () => [
      { update_id: 4, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "duplicate" } },
      { update_id: 5, message: { message_id: 2, from: { id: 10 }, chat: { id: 10, type: "private" }, text: "hello" } },
      { update_id: 6, message: { message_id: 3, from: { id: 99 }, chat: { id: 99, type: "private" }, text: "foreign" } },
    ])
    const api: TelegramBotApi = { request, stop: vi.fn() }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore: store, onMessage })

    await expect(poll.pollOnce()).resolves.toBe(7)
    expect(request).toHaveBeenCalledWith("getUpdates", { offset: 5, timeout: 50, allowed_updates: ["message", "callback_query"] }, expect.any(AbortSignal))
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ updateId: 5, userId: "10", chatId: "10", text: "hello" }))
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ nextUpdateId: 7 })

    const restartedRequest = vi.fn(async () => [])
    const restarted = createTelegramLongPoll({
      api: { request: restartedRequest, stop: vi.fn() },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: new FileTelegramOffsetStore(path),
      onMessage,
    })
    await restarted.pollOnce()
    expect(restartedRequest).toHaveBeenCalledWith("getUpdates", expect.objectContaining({ offset: 7 }), expect.any(AbortSignal))
  })

  it("drops malformed, non-private, foreign-chat, and message-less updates with zero dispatch", async () => {
    let offset = 0
    const offsetStore = { load: () => offset, save: (value: number) => { offset = value } }
    const onMessage = vi.fn(async () => undefined)
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async () => [
        { update_id: 0 },
        { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "group" }, text: "group" } },
        { update_id: 2, message: { message_id: 2, from: { id: 10 }, chat: { id: 11, type: "private" }, text: "other chat" } },
        { update_id: 3, message: { message_id: 3, chat: { id: 10, type: "private" }, text: "no sender" } },
      ]),
    }
    const poll = createTelegramLongPoll({ api, expectedUserId: "10", expectedChatId: "10", offsetStore, onMessage })
    await poll.pollOnce()
    expect(onMessage).not.toHaveBeenCalled()
    expect(offset).toBe(4)
  })

  it("fails closed on corrupt offset state and stops an active poll", async () => {
    const directory = makeTempDirectory("ouro-telegram-corrupt-")
    const path = join(directory, "offset.json")
    writeFileSync(path, "not json")
    expect(() => new FileTelegramOffsetStore(path).load()).toThrow("Telegram offset state is corrupt")

    const api: TelegramBotApi = { request: vi.fn(async () => []), stop: vi.fn() }
    const poll = createTelegramLongPoll({
      api,
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: vi.fn(),
    })
    poll.stop()
    await expect(poll.pollOnce()).rejects.toThrow("stopped")
  })
})

describe("Telegram HTML rendering and chunking", () => {
  it("escapes the complete Telegram HTML metacharacter set", () => {
    expect(escapeTelegramHtml("a < b & c > d")).toBe("a &lt; b &amp; c &gt; d")
  })

  it("prefers paragraph, newline, then whitespace boundaries near 1200 units", () => {
    const text = `${"a".repeat(1190)}\n\n${"b".repeat(30)}\n${"c".repeat(30)} ${"d".repeat(30)}`
    const chunks = splitTelegramText(text)
    expect(chunks[0]).toBe(`${"a".repeat(1190)}\n\n`)
    expect(chunks.join("")).toBe(text)
  })

  it("hard-splits without breaking surrogate pairs and never exceeds 4000 rendered UTF-16 units", () => {
    const text = `${"x".repeat(3999)}😀${"y".repeat(4000)}`
    const chunks = splitTelegramText(text, { targetUnits: 4000, maxUnits: 4000 })
    expect(chunks).toHaveLength(3)
    expect(chunks.every((chunk) => chunk.length <= 4000)).toBe(true)
    expect(chunks.join("")).toBe(text)
  })

  it("sends canonical HTML and retries exactly once as identical plaintext on HTTP 400", async () => {
    const calls: Array<{ method: string; body: Record<string, unknown> }> = []
    const api: TelegramBotApi = {
      stop: vi.fn(),
      request: vi.fn(async (method: string, body: Record<string, unknown>) => {
        calls.push({ method, body })
        if (calls.length === 1) throw new TelegramApiError("bad html", { status: 400 })
        return { message_id: 7 }
      }),
    }
    await expect(sendTelegramText(api, "42", "a < b")).resolves.toEqual([{ message_id: 7 }])
    expect(calls).toEqual([
      { method: "sendMessage", body: { chat_id: "42", text: "a &lt; b", parse_mode: "HTML" } },
      { method: "sendMessage", body: { chat_id: "42", text: "a < b" } },
    ])
  })

  it("does not retry non-400 failures or retry a failed plaintext fallback", async () => {
    const non400: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => { throw new TelegramApiError("down", { status: 500 }) }) }
    await expect(sendTelegramText(non400, "42", "hello")).rejects.toThrow("down")
    expect(non400.request).toHaveBeenCalledTimes(1)

    const always400: TelegramBotApi = { stop: vi.fn(), request: vi.fn(async () => { throw new TelegramApiError("bad", { status: 400 }) }) }
    await expect(sendTelegramText(always400, "42", "hello")).rejects.toThrow("bad")
    expect(always400.request).toHaveBeenCalledTimes(2)
  })
})

describe("Telegram rate limiting and shutdown", () => {
  it("retries at most three 429 responses with exact 1..30 second clamping", async () => {
    const retryAfter = [0, 31, 1]
    const fetch = vi.fn(async () => {
      const next = retryAfter.shift()
      return next === undefined
        ? jsonResponse({ ok: true, result: "done" })
        : jsonResponse({ ok: false, error_code: 429, description: "slow", parameters: { retry_after: next } }, 429)
    })
    const sleep = vi.fn(async () => undefined)
    const api = createTelegramBotApi({ token, fetch, sleep })

    await expect(api.request("sendMessage", {})).resolves.toBe("done")
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(sleep.mock.calls.map(([milliseconds]) => milliseconds)).toEqual([1_000, 30_000, 1_000])
  })

  it("fails on the fourth 429 and on malformed retry metadata", async () => {
    const sleep = vi.fn(async () => undefined)
    const repeated = createTelegramBotApi({
      token,
      sleep,
      fetch: vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429)),
    })
    await expect(repeated.request("sendMessage", {})).rejects.toMatchObject({ status: 429 })
    expect(sleep).toHaveBeenCalledTimes(3)

    const malformedSleep = vi.fn(async () => undefined)
    const malformed = createTelegramBotApi({
      token,
      sleep: malformedSleep,
      fetch: vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 1.5 } }, 429)),
    })
    await expect(malformed.request("sendMessage", {})).rejects.toMatchObject({ status: 429 })
    expect(malformedSleep).not.toHaveBeenCalled()
  })

  it("aborts during backoff and shutdown without a post-abort retry", async () => {
    const controller = new AbortController()
    const fetch = vi.fn(async () => jsonResponse({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429))
    const sleep = vi.fn(async (_milliseconds: number, signal: AbortSignal) => {
      controller.abort()
      signal.throwIfAborted()
    })
    const api = createTelegramBotApi({ token, fetch, sleep })
    await expect(api.request("sendMessage", {}, controller.signal)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledTimes(1)

    const blockingFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
    }))
    const stoppable = createTelegramBotApi({ token, fetch: blockingFetch })
    const pending = stoppable.request("getUpdates", {})
    stoppable.stop()
    await expect(pending).rejects.toThrow()
    expect(blockingFetch).toHaveBeenCalledTimes(1)
  })
})
