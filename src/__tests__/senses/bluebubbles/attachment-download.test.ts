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
})
