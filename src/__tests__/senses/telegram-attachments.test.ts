import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const fsPromiseFaults = vi.hoisted(() => ({ open: undefined as undefined | ((...args: any[]) => any), unlink: undefined as undefined | ((...args: any[]) => any) }))
vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>()
  return {
    ...actual,
    open: (...args: any[]) => fsPromiseFaults.open ? fsPromiseFaults.open(...args) : (actual.open as any)(...args),
    unlink: (...args: any[]) => fsPromiseFaults.unlink ? fsPromiseFaults.unlink(...args) : (actual.unlink as any)(...args),
  }
})
import { cacheRecentAttachment, readRecentAttachments } from "../../heart/attachments/store"
import { materializeAttachment } from "../../heart/attachments/materialize"
import { originalStoragePath } from "../../heart/attachments/originals"
import { buildTelegramAttachmentRecord, telegramAttachmentSourceAdapter } from "../../heart/attachments/sources/telegram"
import { ingestTelegramAttachments } from "../../senses/telegram-attachments"
import { createTelegramLongPoll, type TelegramInboundMessage } from "../../senses/telegram-client"

const roots: string[] = []
const root = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-attachments-"))
  roots.push(value)
  return value
}

afterEach(() => {
  fsPromiseFaults.open = undefined
  fsPromiseFaults.unlink = undefined
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Telegram attachment ingestion", () => {
  it.each([
    ["absent", {}],
    ["generic", { "content-type": "application/octet-stream" }],
  ])("keeps a Telegram photo vision-safe when the CDN Content-Type is %s", async (_label, headers) => {
    const agentRoot = root()
    let inbound: TelegramInboundMessage | undefined
    const poll = createTelegramLongPoll({
      api: { request: vi.fn(async () => [{ update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" }, photo: [{ file_id: `photo-${_label}`, file_size: 4 }] } }]), stop: vi.fn() },
      expectedUserId: "10",
      expectedChatId: "10",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: async (message) => { inbound = message },
    })
    await poll.pollOnce()
    const candidate = inbound?.attachments?.[0]
    expect(candidate).toMatchObject({ kind: "image", mimeType: "image/jpeg" })
    const result = await ingestTelegramAttachments({
      agentName: "sanctuary",
      agentRoot,
      botToken: "123:secret",
      api: { request: vi.fn(async () => ({ file_path: `photos/${_label}.jpg`, file_size: 4 })), stop: vi.fn() },
      fetch: vi.fn(async () => new Response(Buffer.from("jpeg"), { status: 200, headers })),
      attachments: [candidate!],
    })
    expect(result.attachments[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" })
    const normalized = path.join(agentRoot, `${_label}.vision-safe.jpg`)
    fs.writeFileSync(normalized, "normalized")
    await expect(materializeAttachment("sanctuary", result.attachments[0]!.id, {
      agentRoot,
      variant: "vision_safe",
      normalizeImage: vi.fn(async () => ({ path: normalized, mimeType: "image/jpeg", byteCount: 10 })),
    })).resolves.toMatchObject({ variant: "vision_safe", mimeType: "image/jpeg" })
  })

  it("downloads, bounds, persists, and caches authorized attachments through the shared attachment store", async () => {
    const agentRoot = root()
    const request = vi.fn(async () => ({ file_path: "documents/file.pdf", file_size: 4 }))
    const fetch = vi.fn(async () => new Response(Buffer.from("data"), { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } }))

    const result = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, fetch, attachments: [{ fileId: "file-1", kind: "document", displayName: "notes.pdf", mimeType: "application/pdf", byteCount: 4 }] })

    expect(result.notices).toEqual([])
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({ source: "telegram", sourceId: "file-1", displayName: "notes.pdf", byteCount: 4 })
    expect(readRecentAttachments("sanctuary", agentRoot)).toEqual(result.attachments)
    expect(fetch).toHaveBeenCalledWith("https://api.telegram.org/file/bot123:secret/documents/file.pdf", expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(fs.readFileSync(result.attachments[0]!.sourceData.localPath, "utf8")).toBe("data")
    await expect(materializeAttachment("sanctuary", result.attachments[0]!.id, { agentRoot, variant: "original" })).resolves.toMatchObject({ path: result.attachments[0]!.sourceData.localPath })

    const replay = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, fetch, attachments: [{ fileId: "file-1", kind: "document", displayName: "notes.pdf" }] })
    expect(replay.attachments).toHaveLength(1)
    expect(request).toHaveBeenCalledOnce()
  })

  it("deduplicates file ids and reports malformed, oversized, HTTP, and streamed-overflow failures without caching them", async () => {
    const agentRoot = root()
    const request = vi.fn(async (_method: string, body: Record<string, unknown>) => {
      if (body.file_id === "malformed") return { file_path: "../secret" }
      if (body.file_id === "oversized") return { file_path: "big.bin", file_size: 20_000_001 }
      return { file_path: `${body.file_id}.bin` }
    })
    const fetch = vi.fn(async (url: string) => url.includes("http")
      ? new Response("no", { status: 500 })
      : new Response(Buffer.alloc(20_000_001), { status: 200 }))
    const attachments = ["malformed", "oversized", "http", "streamed", "streamed"].map((fileId) => ({ fileId, kind: "document" as const, displayName: `${fileId}.bin` }))

    const result = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, fetch: fetch as typeof globalThis.fetch, attachments })

    expect(result.attachments).toEqual([])
    expect(result.notices).toHaveLength(4)
    expect(result.notices.every((notice) => notice.startsWith("attachment unavailable:"))).toBe(true)
    expect(request).toHaveBeenCalledTimes(4)
    expect(readRecentAttachments("sanctuary", agentRoot)).toEqual([])
  })

  it("recovers an atomically persisted pre-cache file without redownloading after a crash", async () => {
    const agentRoot = root()
    const persisted = path.join(agentRoot, "state", "attachments", "materialized", "telegram", "orphan", "original.pdf")
    fs.mkdirSync(path.dirname(persisted), { recursive: true })
    fs.writeFileSync(persisted, "saved")
    const request = vi.fn()
    const result = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, fetch: vi.fn(), attachments: [{ fileId: "orphan", kind: "document", displayName: "orphan.pdf", mimeType: "application/pdf" }] })
    expect(result.attachments).toHaveLength(1)
    expect(result.attachments[0]).toMatchObject({ byteCount: 5, sourceData: { localPath: persisted } })
    expect(request).not.toHaveBeenCalled()
  })

  it("contains every local validation and transport boundary without leaking the token", async () => {
    const agentRoot = root()
    const request = vi.fn(async (_method: string, body: Record<string, unknown>) => {
      if (body.file_id === "missing-path") return {}
      if (body.file_id === "bad-size") return { file_path: "bad.bin", file_size: -1 }
      if (body.file_id === "primitive") throw "primitive failure"
      return { file_path: `${body.file_id}.bin` }
    })
    const fetch = vi.fn(async (url: string) => url.includes("header")
      ? new Response("x", { status: 200, headers: { "content-length": "20000001" } })
      : new Response(null, { status: 200 }))
    const candidates = [
      { fileId: "../bad", kind: "document" as const, displayName: "bad" },
      { fileId: "bad-byte", kind: "document" as const, displayName: "bad-byte", byteCount: -1 },
      { fileId: "missing-path", kind: "document" as const, displayName: "missing" },
      { fileId: "bad-size", kind: "document" as const, displayName: "bad-size" },
      { fileId: "primitive", kind: "document" as const, displayName: "primitive" },
      { fileId: "header", kind: "document" as const, displayName: "header" },
      { fileId: "empty", kind: "document" as const, displayName: "empty" },
    ]
    const result = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, fetch, attachments: candidates })
    expect(result.notices).toHaveLength(candidates.length)
    expect(JSON.stringify(result)).not.toContain("123:secret")
  })

  it("covers global fetch, the eight-file cap, malformed cache metadata, and MIME fallbacks", async () => {
    const agentRoot = root()
    const malformedCached = buildTelegramAttachmentRecord({ fileId: "cached", displayName: "cached.bin", localPath: path.join(agentRoot, "cached.bin") })
    cacheRecentAttachment("sanctuary", { ...malformedCached, sourceData: { localPath: 42 } } as any, agentRoot)
    const request = vi.fn(async (_method: string, body: Record<string, unknown>) => ({ file_path: `${body.file_id}.bin`, file_size: 1 }))
    const globalFetch = vi.fn(async (url: string) => new Response(new Uint8Array([1]), { status: 200, headers: url.includes("/typed.") ? { "content-type": "text/plain" } : {} }))
    vi.stubGlobal("fetch", globalFetch)
    const candidates = [
      { fileId: "cached", kind: "binary" as const, displayName: "cached.bin" },
      { fileId: "typed", kind: "document" as const, displayName: "typed" },
      { fileId: "untyped", kind: "binary" as const, displayName: "untyped" },
      ...Array.from({ length: 7 }, (_, index) => ({ fileId: `extra-${index}`, kind: "binary" as const, displayName: `extra-${index}.bin` })),
    ]

    const result = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request, stop: vi.fn() }, attachments: candidates })
    vi.unstubAllGlobals()

    expect(result.attachments).toHaveLength(8)
    expect(request).toHaveBeenCalledTimes(8)
    expect(result.attachments.find((attachment) => attachment.sourceId === "typed")?.mimeType).toBe("text/plain")
    expect(result.attachments.find((attachment) => attachment.sourceId === "untyped")?.mimeType).toBeUndefined()
  })

  it("rejects invalid persisted originals and contains cancellation and atomic-cleanup failures", async () => {
    const agentRoot = root()
    const descriptor = (fileId: string) => ({ fileId, kind: "binary" as const, displayName: `${fileId}.bin` })
    const record = (fileId: string) => buildTelegramAttachmentRecord({ ...descriptor(fileId), localPath: path.join(agentRoot, "pending", fileId) })
    const directoryPath = originalStoragePath(agentRoot, record("directory"))
    fs.mkdirSync(directoryPath, { recursive: true })
    const oversizedPath = originalStoragePath(agentRoot, record("oversized-persisted"))
    fs.mkdirSync(path.dirname(oversizedPath), { recursive: true })
    fs.closeSync(fs.openSync(oversizedPath, "w"))
    fs.truncateSync(oversizedPath, 20_000_001)
    const api = { request: vi.fn(async (_method: string, body: Record<string, unknown>) => ({ file_path: `${body.file_id}.bin`, file_size: 20_000_001 })), stop: vi.fn() }
    const invalid = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api, fetch: vi.fn(), attachments: [descriptor("directory"), descriptor("oversized-persisted")] })
    expect(invalid.notices).toHaveLength(2)
    expect(api.request).not.toHaveBeenCalled()

    const cancelFailure = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(20_000_001)) },
      cancel() { throw new Error("cancel failed") },
    })
    const streamed = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request: vi.fn(async () => ({ file_path: "cancel.bin" })), stop: vi.fn() }, fetch: vi.fn(async () => new Response(cancelFailure)), attachments: [descriptor("cancel")] })
    expect(streamed.notices).toEqual(["attachment unavailable: cancel.bin"])

    const close = vi.fn(async () => { throw new Error("close failed") })
    fsPromiseFaults.open = async () => ({ writeFile: vi.fn(async () => { throw new Error("write failed") }), close })
    const failedWrite = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request: vi.fn(async () => ({ file_path: "write.bin", file_size: 1 })), stop: vi.fn() }, fetch: vi.fn(async () => new Response("x")), attachments: [descriptor("write")] })
    fsPromiseFaults.open = undefined
    expect(failedWrite.notices).toEqual(["attachment unavailable: write.bin"])
    expect(close).toHaveBeenCalled()

    fsPromiseFaults.unlink = async () => { throw Object.assign(new Error("unlink denied"), { code: "EACCES" }) }
    const failedCleanup = await ingestTelegramAttachments({ agentName: "sanctuary", agentRoot, botToken: "123:secret", api: { request: vi.fn(async () => ({ file_path: "cleanup.bin", file_size: 1 })), stop: vi.fn() }, fetch: vi.fn(async () => new Response("x")), attachments: [descriptor("cleanup")] })
    fsPromiseFaults.unlink = undefined
    expect(failedCleanup.notices).toEqual(["attachment unavailable: cleanup.bin"])
  })

  it("rejects malformed Telegram source records and paths outside the owned attachment root", async () => {
    const agentRoot = root()
    expect(() => buildTelegramAttachmentRecord({ fileId: "", displayName: "bad", localPath: "/tmp/bad" })).toThrow("file id")
    expect(() => buildTelegramAttachmentRecord({ fileId: "ok", displayName: "bad", localPath: "relative" })).toThrow("absolute")
    const outside = buildTelegramAttachmentRecord({ fileId: "ok", displayName: "bad", localPath: "/tmp/outside" })
    await expect(telegramAttachmentSourceAdapter.materializeOriginal({ agentName: "sanctuary", agentRoot, attachment: outside })).rejects.toThrow("owned attachment root")
    await expect(telegramAttachmentSourceAdapter.materializeOriginal({ agentName: "sanctuary", agentRoot, attachment: { ...outside, source: "cli-local-file" } as any })).rejects.toThrow("cannot materialize")
    await expect(telegramAttachmentSourceAdapter.materializeOriginal({ agentName: "sanctuary", agentRoot, attachment: { ...outside, sourceData: { localPath: "relative" } } })).rejects.toThrow("local path is invalid")
  })
})
