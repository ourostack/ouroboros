import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readRecentAttachments } from "../../heart/attachments/store"
import { materializeAttachment } from "../../heart/attachments/materialize"
import { buildTelegramAttachmentRecord, telegramAttachmentSourceAdapter } from "../../heart/attachments/sources/telegram"
import { ingestTelegramAttachments } from "../../senses/telegram-attachments"

const roots: string[] = []
const root = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-attachments-"))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true })
})

describe("Telegram attachment ingestion", () => {
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
      return { file_path: "empty.bin" }
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
