import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ attachmentTurnLines: vi.fn() }))
vi.mock("../../heart/attachments/understand", () => ({ attachmentTurnLines: mocks.attachmentTurnLines, ATTACHMENT_WORDS_TIMEOUT_MS: 120_000 }))

import { ingestTeamsAttachments, teamsInboundText } from "../../senses/teams-attachments"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "teams-attachments-"))
})

afterEach(() => {
  vi.resetAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

const okFetch = () => vi.fn(async () => new Response("bytes", { headers: { "content-type": "application/pdf" } })) as unknown as typeof fetch & ReturnType<typeof vi.fn>
const headersOf = (fetchImpl: ReturnType<typeof vi.fn>, call: number) => (fetchImpl.mock.calls[call]![1] as { headers: Record<string, string> }).headers

describe("ingestTeamsAttachments", () => {
  it("keeps an uploaded file without the bot token, and an inline image with it", async () => {
    const fetchImpl = okFetch()
    const getBotToken = vi.fn(async () => "bot-token")
    const result = await ingestTeamsAttachments({
      agentName: "butler",
      agentRoot: root,
      getBotToken,
      fetch: fetchImpl,
      attachments: [
        { contentType: "application/vnd.microsoft.teams.file.download.info", name: "plan.pdf", content: { downloadUrl: "https://contoso.sharepoint.com/plan.pdf" } },
        { contentType: "image/png", contentUrl: "https://smba.trafficmanager.net/amer/v3/attachments/1/views/original" },
        { contentType: "text/html", content: "<p>hi</p>" },
      ],
    })
    expect(result.notices).toEqual([])
    expect(result.attachments.map((record) => [record.displayName, record.mimeType, record.kind])).toEqual([
      ["plan.pdf", "application/pdf", "document"],
      ["image.png", "image/png", "image"],
    ])
    expect(headersOf(fetchImpl, 0)).toEqual({})
    expect(headersOf(fetchImpl, 1)).toEqual({ authorization: "Bearer bot-token" })
    expect(getBotToken).toHaveBeenCalledOnce()
  })

  it("never sends the bot token to a host that is not Microsoft's, and sends none when there is no token", async () => {
    const fetchImpl = okFetch()
    await ingestTeamsAttachments({
      agentName: "butler",
      agentRoot: root,
      getBotToken: async () => undefined,
      fetch: fetchImpl,
      attachments: [
        { contentType: "image/jpeg", contentUrl: "https://example.com/x.jpg", name: "x.jpg" },
        { contentType: "audio/ogg", contentUrl: "https://smba.trafficmanager.net/clip" },
      ],
    })
    expect(headersOf(fetchImpl, 0)).toEqual({})
    expect(headersOf(fetchImpl, 1)).toEqual({})
  })

  it("ignores attachments with nothing to download and caps a message at eight", async () => {
    const fetchImpl = okFetch()
    const images = Array.from({ length: 10 }, (_, index) => ({ contentType: "image/png", contentUrl: `https://example.com/${index}.png` }))
    const result = await ingestTeamsAttachments({
      agentName: "butler",
      agentRoot: root,
      getBotToken: async () => "t",
      fetch: fetchImpl,
      attachments: [{ contentType: "application/vnd.microsoft.teams.file.download.info", content: {} }, { contentType: "image/png" }, {}, ...images],
    })
    expect(result.attachments).toHaveLength(8)
    expect(fetchImpl).toHaveBeenCalledTimes(8)
  })

  it("says which attachment failed and why", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response("", { status: 403 }))
      .mockRejectedValueOnce("socket hang up") as unknown as typeof fetch
    const result = await ingestTeamsAttachments({
      agentName: "butler",
      agentRoot: root,
      getBotToken: async () => "t",
      fetch: fetchImpl,
      attachments: [
        { contentType: "application/vnd.microsoft.teams.file.download.info", name: "plain.txt", content: { downloadUrl: "http://contoso.example/plain.txt" } },
        { contentType: "application/vnd.microsoft.teams.file.download.info", name: "denied.pdf", content: { downloadUrl: "https://contoso.example/denied.pdf" } },
        { contentType: "video/mp4", contentUrl: "https://contoso.example/v.mp4", name: "v.mp4" },
      ],
    })
    expect(result.attachments).toEqual([])
    expect(result.notices).toEqual([
      "attachment unavailable: plain.txt (attachment URL is not https)",
      "attachment unavailable: denied.pdf (download failed with HTTP 403)",
      "attachment unavailable: v.mp4 (socket hang up)",
    ])
  })

  it("names an unnamed upload \"file\" and leaves its type unknown when the server gives none", async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([1, 2]))) as unknown as typeof fetch
    const result = await ingestTeamsAttachments({
      agentName: "butler",
      agentRoot: root,
      getBotToken: async () => "t",
      fetch: fetchImpl,
      attachments: [
        { contentType: "application/vnd.microsoft.teams.file.download.info", content: { downloadUrl: "https://contoso.example/x" } },
        { contentType: "application/vnd.microsoft.teams.file.download.info" },
      ],
    })
    expect(result.attachments.map((record) => [record.displayName, record.mimeType])).toEqual([["file", undefined]])
  })

  it("uses the global fetch and treats a missing list as no attachments", async () => {
    const globalFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x"))
    const result = await ingestTeamsAttachments({ agentName: "butler", agentRoot: root, getBotToken: async () => "t", attachments: undefined })
    expect(result).toEqual({ attachments: [], notices: [] })
    await ingestTeamsAttachments({ agentName: "butler", agentRoot: root, getBotToken: async () => "t", attachments: [{ contentType: "image/png", contentUrl: "https://example.com/a.png", name: "a.png" }] })
    expect(globalFetch).toHaveBeenCalledOnce()
  })
})

describe("teamsInboundText", () => {
  it("adds the attachment lines and any notices after what was typed", async () => {
    mocks.attachmentTurnLines.mockResolvedValue(["[attachments]\n- a", "voice note transcript: hi"])
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("ogg")).mockResolvedValueOnce(new Response("", { status: 500 })) as unknown as typeof fetch
    const text = await teamsInboundText("listen", {
      agentName: "butler",
      agentRoot: root,
      getBotToken: async () => "t",
      fetch: fetchImpl,
      attachments: [
        { contentType: "audio/ogg", contentUrl: "https://example.com/a.ogg", name: "a.ogg" },
        { contentType: "audio/ogg", contentUrl: "https://example.com/b.ogg", name: "b.ogg" },
      ],
    })
    expect(text).toBe("listen\n[attachments]\n- a\nvoice note transcript: hi\nattachment unavailable: b.ogg (download failed with HTTP 500)")
    expect(mocks.attachmentTurnLines).toHaveBeenCalledWith([expect.objectContaining({ displayName: "a.ogg" })], { agentName: "butler", agentRoot: root, userText: "listen", timeoutMs: 120_000 })
  })
})
