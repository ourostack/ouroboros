import { describe, expect, it, vi } from "vitest"

import { downloadBlueBubblesAttachment } from "../../../senses/bluebubbles/attachment-download"

describe("downloadBlueBubblesAttachment", () => {
  const config = {
    serverUrl: "http://bluebubbles.local",
    password: "secret",
    accountId: "default",
  }

  const channelConfig = {
    port: 1234,
    webhookPath: "/bb",
    requestTimeoutMs: 1_000,
  }

  it("rejects images that exceed the actual downloaded byte limit", async () => {
    await expect(
      downloadBlueBubblesAttachment(
        {
          guid: "IMG-1",
          transferName: "capture.png",
          mimeType: "application/octet-stream",
        },
        config,
        channelConfig,
        vi.fn().mockResolvedValue(
          new Response(new Uint8Array(32 * 1024 * 1024 + 1), {
            status: 200,
            headers: { "content-type": "image/png" },
          }),
        ),
      ),
    ).rejects.toThrow("attachment exceeds 33554432 byte limit")
  })

  it("treats extension-only images as images even when content-type is missing", async () => {
    await expect(
      downloadBlueBubblesAttachment(
        {
          guid: "IMG-2",
          transferName: "capture.png",
        },
        config,
        channelConfig,
        vi.fn().mockResolvedValue(
          new Response(new Uint8Array(32 * 1024 * 1024 + 1), {
            status: 200,
          }),
        ),
      ),
    ).rejects.toThrow("attachment exceeds 33554432 byte limit")
  })

  it("stops at the limit without the whole body, passes other failures through, and accepts an empty body", async () => {
    const download = (response: Response) => downloadBlueBubblesAttachment({ guid: "VOICE-1", transferName: "note.caf" }, config, channelConfig, vi.fn().mockResolvedValue(response))
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024 * 1024)) } })
    await expect(download(new Response(endless, { status: 200, headers: { "content-type": "audio/x-caf" } }))).rejects.toThrow(/byte limit/)
    expect(pulled).toBeLessThan(1024)

    const broken = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error("connection reset")) } })
    await expect(download(new Response(broken, { status: 200 }))).rejects.toThrow("connection reset")

    await expect(download(new Response(null, { status: 200 }))).resolves.toEqual({ buffer: Buffer.alloc(0), contentType: undefined })
  })
})
