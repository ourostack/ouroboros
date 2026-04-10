import { describe, expect, it } from "vitest"

import { type AttachmentRecord } from "../../../heart/attachments/types"
import { blueBubblesAttachmentSourceAdapter, buildBlueBubblesAttachmentRecord } from "../../../heart/attachments/sources/bluebubbles"
import { buildCliLocalFileAttachmentRecord, cliLocalFileAttachmentSourceAdapter } from "../../../heart/attachments/sources/cli-local-file"
import { getAttachmentSourceAdapter } from "../../../heart/attachments/sources"

describe("attachment source adapters", () => {
  it("rejects non-BlueBubbles attachments in the BlueBubbles adapter", async () => {
    const attachment = buildCliLocalFileAttachmentRecord({
      path: "/tmp/not-bluebubbles.png",
      mimeType: "image/png",
    })

    await expect(
      blueBubblesAttachmentSourceAdapter.materializeOriginal({
        agentName: "slugger",
        attachment: attachment as AttachmentRecord,
        agentRoot: "/tmp/agent-root",
      }),
    ).rejects.toThrow("bluebubbles adapter cannot materialize cli-local-file attachments")
  })

  it("rejects BlueBubbles attachments whose guid cannot be recovered", async () => {
    const attachment = {
      ...buildBlueBubblesAttachmentRecord({
        guid: "GUID-source-missing",
        transferName: "capture.png",
        mimeType: "image/png",
      }),
      sourceId: "   ",
      sourceData: {
        guid: "   ",
        transferName: "capture.png",
      },
    } as AttachmentRecord

    await expect(
      blueBubblesAttachmentSourceAdapter.materializeOriginal({
        agentName: "slugger",
        attachment,
        agentRoot: "/tmp/agent-root",
      }),
    ).rejects.toThrow("BlueBubbles attachment guid is required")
  })

  it("rejects non-CLI attachments in the CLI local-file adapter", async () => {
    const attachment = buildBlueBubblesAttachmentRecord({
      guid: "GUID-not-cli",
      transferName: "capture.png",
      mimeType: "image/png",
    })

    await expect(
      cliLocalFileAttachmentSourceAdapter.materializeOriginal({
        agentName: "slugger",
        attachment: attachment as AttachmentRecord,
        agentRoot: "/tmp/agent-root",
      }),
    ).rejects.toThrow("cli-local-file adapter cannot materialize bluebubbles attachments")
  })

  it("rejects CLI attachments without a usable source path", async () => {
    const attachment = {
      ...buildCliLocalFileAttachmentRecord({
        path: "/tmp/original.png",
        mimeType: "image/png",
      }),
      sourceData: {},
    } as AttachmentRecord

    await expect(
      cliLocalFileAttachmentSourceAdapter.materializeOriginal({
        agentName: "slugger",
        attachment,
        agentRoot: "/tmp/agent-root",
      }),
    ).rejects.toThrow("CLI local attachment path is required")
  })

  it("throws a targeted error when no adapter is registered for a source", () => {
    expect(() => getAttachmentSourceAdapter("unknown-source" as never)).toThrow(
      "No attachment source adapter registered for source: unknown-source",
    )
  })
})
