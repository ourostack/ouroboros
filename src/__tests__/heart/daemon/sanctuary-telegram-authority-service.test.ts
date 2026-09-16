import { generateKeyPairSync } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  createSanctuaryTelegramAuthorityServer,
  SanctuaryTelegramAuthorityService,
  SocketSanctuaryTelegramAuthorityClient,
} from "../../../heart/daemon/sanctuary-telegram-authority-service"
import {
  FileSanctuaryTelegramAuthorityGateway,
  sanctuaryAuthorityPublicKeyDigest,
} from "../../../heart/daemon/sanctuary-telegram-authority-gateway"
import { authorityArtifactDigest } from "../../../heart/daemon/sanctuary-authority-codec"
import type { TelegramBotApi, TelegramUpdate } from "../../../senses/telegram-client"

const roots: string[] = []

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-telegram-service-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

function message(updateId: number): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 100,
      from: { id: 42 },
      chat: { id: 42, type: "private" },
      text: `update ${updateId}`,
    },
  }
}

function rawRequest(socketPath: string, contents: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let response = ""
    socket.setEncoding("utf8")
    socket.once("error", reject)
    socket.on("data", (chunk) => { response += chunk })
    socket.once("close", () => resolve(response))
    socket.once("connect", () => socket.end(contents))
  })
}

function fixture() {
  const keys = generateKeyPairSync("ed25519")
  let nonce = 0
  const gateway = new FileSanctuaryTelegramAuthorityGateway(root(), {
    targetHost: "sanctuary",
    botId: "123456",
    ownerUserId: "42",
    ownerChatId: "42",
    keyId: "issuer-1",
    publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey),
    privateKey: keys.privateKey,
    now: () => "2026-09-16T22:30:00.000Z",
    nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
  })
  const updates = [message(10)]
  const api: TelegramBotApi = {
    request: vi.fn(async (method) => method === "getUpdates" ? updates : { method }),
    stop: vi.fn(),
  }
  return { api, gateway, service: new SanctuaryTelegramAuthorityService({ api, gateway }) }
}

describe("Sanctuary Telegram authority service", () => {
  it("polls Telegram from the root cursor and returns the exact signed observation with raw update", async () => {
    const f = fixture()
    const result = await f.service.dispatch("telegram.poll", {})
    expect(f.api.request).toHaveBeenCalledWith("getUpdates", {
      offset: 0,
      timeout: 50,
      allowed_updates: ["message", "callback_query"],
    })
    expect(result).toMatchObject({
      update: message(10),
      observation: { domain: "ouro.sanctuary.telegram-observation.v1", payload: { updateId: 10 } },
    })
    expect(await f.service.dispatch("telegram.poll", {})).toEqual(result)
  })

  it("settles the exact observation and exposes the advanced logical cursor", async () => {
    const f = fixture()
    const polled = await f.service.dispatch("telegram.poll", {}) as any
    await expect(f.service.dispatch("telegram.settle", {
      updateId: 10,
      observationDigest: authorityArtifactDigest(polled.observation.domain, polled.observation.payload),
      outcome: "completed",
    })).resolves.toEqual({ settled: true, cursor: 11 })
    expect(await f.service.dispatch("telegram.cursor", {})).toEqual({ cursor: 11 })
  })

  it("refuses malformed methods, params, and Telegram poll responses", async () => {
    const f = fixture()
    await expect(f.service.dispatch("telegram.poll", { extra: true })).rejects.toThrow(/params/u)
    await expect(f.service.dispatch("telegram.settle", {})).rejects.toThrow(/settlement/u)
    await expect(f.service.dispatch("host.execute", {})).rejects.toThrow(/method/u)
    vi.mocked(f.api.request).mockResolvedValueOnce({ not: "updates" } as never)
    await expect(f.service.dispatch("telegram.poll", {})).rejects.toThrow(/array/u)
    vi.mocked(f.api.request).mockResolvedValueOnce([])
    await expect(f.service.dispatch("telegram.poll", {})).resolves.toBeNull()
    await expect(f.service.dispatch("telegram.cursor", { extra: true })).rejects.toThrow(/params/u)

    const unavailable = new SanctuaryTelegramAuthorityService({
      api: f.api,
      gateway: {
        cursor: () => 0,
        capture: () => undefined,
        poll: () => ({ payload: { updateId: 10 } }),
        record: () => null,
      } as never,
    })
    vi.mocked(f.api.request).mockResolvedValueOnce([])
    await expect(unavailable.dispatch("telegram.poll", {})).rejects.toThrow(/unavailable/u)
  })

  it("proxies only exact owner, observed callback, and observed file requests", async () => {
    const f = fixture()
    await f.service.dispatch("telegram.poll", {})
    await expect(f.service.dispatch("telegram.request", { method: "getMe", body: {} })).resolves.toEqual({ method: "getMe" })
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "hello", parse_mode: "HTML" },
    })).resolves.toEqual({ method: "sendMessage" })
    await expect(f.service.dispatch("telegram.request", {
      method: "editMessageText",
      body: { chat_id: "42", message_id: 71, text: "updated" },
    })).resolves.toEqual({ method: "editMessageText" })
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "84", text: "wrong target" },
    })).rejects.toThrow(/target/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "getUpdates",
      body: {},
    })).rejects.toThrow(/method/u)
    await expect(f.service.dispatch("telegram.request", {
      method: "sendMessage",
      body: { chat_id: "42", text: "" },
    })).rejects.toThrow(/body/u)
    for (const body of [
      null,
      { chat_id: "42" },
      { chat_id: "42", text: "hello", parse_mode: "Markdown" },
      { chat_id: "42", text: "hello", reply_markup: "bad" },
      { chat_id: "42", text: "hello", extra: true },
    ]) {
      await expect(f.service.dispatch("telegram.request", { method: "sendMessage", body })).rejects.toThrow(/body|target/u)
    }
    for (const body of [
      { chat_id: "84", message_id: 71, text: "updated" },
      { chat_id: "42", message_id: 0, text: "updated" },
      { chat_id: "42", message_id: 71, text: "" },
      { chat_id: "42", message_id: 71, text: "updated", parse_mode: "Markdown" },
      { chat_id: "42", message_id: 71, text: "updated", reply_markup: "bad" },
    ]) {
      await expect(f.service.dispatch("telegram.request", { method: "editMessageText", body })).rejects.toThrow(/body|target/u)
    }
    await expect(f.service.dispatch("telegram.request", { method: "getMe", body: { extra: true } })).rejects.toThrow(/body/u)
    await expect(f.service.dispatch("telegram.request", { body: {} } as never)).rejects.toThrow(/params/u)
  })

  it("allows callback acknowledgement and file lookup only after root observation", async () => {
    const keys = generateKeyPairSync("ed25519")
    let nonce = 0
    const gateway = new FileSanctuaryTelegramAuthorityGateway(root(), {
      targetHost: "sanctuary", botId: "123456", ownerUserId: "42", ownerChatId: "42", keyId: "issuer-1",
      publicKeyDigest: sanctuaryAuthorityPublicKeyDigest(keys.privateKey), privateKey: keys.privateKey,
      now: () => "2026-09-16T22:30:00.000Z", nonce: () => Buffer.alloc(32, ++nonce).toString("base64url"),
    })
    gateway.capture([
      { update_id: 20, callback_query: { id: "callback-20", from: { id: 42 }, message: { message_id: 120, chat: { id: 42 } } } },
      { update_id: 21, message: { message_id: 121, from: { id: 42 }, chat: { id: 42, type: "private" }, document: { file_id: "file-21" } } },
    ])
    const api = { request: vi.fn(async (method: string) => ({ method })), stop: vi.fn() }
    const service = new SanctuaryTelegramAuthorityService({ api, gateway })
    await expect(service.dispatch("telegram.request", {
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-20" },
    })).resolves.toEqual({ method: "answerCallbackQuery" })
    await expect(service.dispatch("telegram.request", {
      method: "getFile",
      body: { file_id: "file-21" },
    })).resolves.toEqual({ method: "getFile" })
    await expect(service.dispatch("telegram.request", {
      method: "answerCallbackQuery",
      body: { callback_query_id: "callback-missing" },
    })).rejects.toThrow(/callback/u)
    await expect(service.dispatch("telegram.request", {
      method: "getFile",
      body: { file_id: "file-missing" },
    })).rejects.toThrow(/file/u)
    for (const body of [
      {},
      { callback_query_id: "" },
      { callback_query_id: "callback-20", text: "" },
      { callback_query_id: "callback-20", show_alert: false },
      { callback_query_id: "callback-20", extra: true },
    ]) {
      await expect(service.dispatch("telegram.request", { method: "answerCallbackQuery", body })).rejects.toThrow(/callback/u)
    }
    for (const body of [{}, { file_id: "" }, { file_id: "file-21", extra: true }]) {
      await expect(service.dispatch("telegram.request", { method: "getFile", body })).rejects.toThrow(/file/u)
    }
  })

  it("round-trips bounded requests over the Unix socket and closes cleanly", async () => {
    const f = fixture()
    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({
      socketPath,
      dispatch: (method, params) => f.service.dispatch(method, params),
    })
    await server.listen()
    const client = new SocketSanctuaryTelegramAuthorityClient(socketPath)
    const result = await client.request("telegram.poll", {})
    expect(result).toMatchObject({ observation: { payload: { updateId: 10 } }, update: message(10) })
    client.close()
    await server.close()
  })

  it("returns closed errors for invalid protocol frames, dispatch failures, and oversized requests", async () => {
    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({
      socketPath,
      maxRequestBytes: 128,
      dispatch: async (method) => {
        if (method === "fail") throw new Error("private root failure")
        return true
      },
    })
    await server.listen()
    const client = new SocketSanctuaryTelegramAuthorityClient(socketPath)
    await expect(client.request("fail", {})).rejects.toThrow("Sanctuary authority request failed")
    await expect(client.request("", {})).rejects.toThrow(/method/u)
    await expect(client.request("bad", null as never)).rejects.toThrow(/params/u)
    await expect(client.request("large", { value: "x".repeat(256) })).rejects.toThrow(/closed|large/u)
    client.close()
    await server.close()
    await expect(server.close()).rejects.toThrow()
  })

  it("refuses invalid server/client configuration and malformed raw protocol frames", async () => {
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: "relative.sock", dispatch: vi.fn() })).toThrow(/absolute/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "small.sock"), maxRequestBytes: 1, dispatch: vi.fn() })).toThrow(/limit/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "float.sock"), maxRequestBytes: 128.5, dispatch: vi.fn() })).toThrow(/limit/u)
    expect(() => createSanctuaryTelegramAuthorityServer({ socketPath: path.join(root(), "timeout.sock"), connectionTimeoutMs: 0, dispatch: vi.fn() })).toThrow(/timeout/u)
    expect(() => new SocketSanctuaryTelegramAuthorityClient("relative.sock")).toThrow(/absolute/u)

    const socketPath = path.join(root(), "authority.sock")
    const server = createSanctuaryTelegramAuthorityServer({ socketPath, dispatch: vi.fn(async () => true) })
    await server.listen()
    expect(await rawRequest(socketPath, "\n{not-json}\n")).toContain("Sanctuary authority request failed")
    for (const frame of [
      null,
      {},
      { protocolVersion: 2, id: "1", method: "ok", params: {} },
      { protocolVersion: 1, id: "", method: "ok", params: {} },
      { protocolVersion: 1, id: "1", method: "", params: {} },
      { protocolVersion: 1, id: "1", method: "ok", params: [] },
      { protocolVersion: 1, id: "1", method: "ok", params: {}, extra: true },
    ]) {
      expect(await rawRequest(socketPath, `${JSON.stringify(frame)}\n`)).toContain("Sanctuary authority request failed")
    }
    await server.close()

    const idleSocketPath = path.join(root(), "idle.sock")
    const idleServer = createSanctuaryTelegramAuthorityServer({
      socketPath: idleSocketPath,
      connectionTimeoutMs: 5,
      dispatch: vi.fn(),
    })
    await idleServer.listen()
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(idleSocketPath)
      socket.once("error", reject)
      socket.once("close", () => resolve())
    })
    await idleServer.close()
  })
})
