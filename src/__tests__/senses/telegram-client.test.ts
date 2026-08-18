import { describe, expect, it, vi } from "vitest"

import {
  TelegramApiError,
  createTelegramBotApi,
  escapeTelegramHtml,
  sendTelegramText,
  splitTelegramText,
  type TelegramBotApi,
} from "../../senses/telegram-client"

const token = "123456:super-secret-token"

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
      signal: undefined,
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
    const non400: TelegramBotApi = { request: vi.fn(async () => { throw new TelegramApiError("down", { status: 500 }) }) }
    await expect(sendTelegramText(non400, "42", "hello")).rejects.toThrow("down")
    expect(non400.request).toHaveBeenCalledTimes(1)

    const always400: TelegramBotApi = { request: vi.fn(async () => { throw new TelegramApiError("bad", { status: 400 }) }) }
    await expect(sendTelegramText(always400, "42", "hello")).rejects.toThrow("bad")
    expect(always400.request).toHaveBeenCalledTimes(2)
  })
})
