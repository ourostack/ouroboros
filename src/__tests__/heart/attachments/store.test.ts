import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  MAX_RECENT_ATTACHMENTS,
  getRecentAttachmentsPath,
  listRecentAttachments,
  readRecentAttachments,
  rememberRecentAttachment,
} from "../../../heart/attachments/store"
import {
  buildAttachmentId,
  buildBlueBubblesAttachmentRecord,
  buildCliLocalFileAttachmentRecord,
} from "../../../heart/attachments/types"
import { renderAttachmentBlock } from "../../../heart/attachments/render"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-store-"))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("attachment ids", () => {
  it("builds stable cross-sense ids", () => {
    expect(buildAttachmentId("bluebubbles", "GUID-123")).toBe("attachment:bluebubbles:GUID-123")
    expect(buildAttachmentId("cli-local-file", "abc123")).toBe("attachment:cli-local-file:abc123")
  })
})

describe("recent attachment store", () => {
  it("persists attachments in newest-first order", () => {
    const agentRoot = makeAgentRoot()
    const first = buildBlueBubblesAttachmentRecord(
      {
        guid: "GUID-1",
        transferName: "hotel-confirmation.tiff",
        mimeType: "image/tiff",
        totalBytes: 12_400_000,
      },
      1_000,
    )
    const second = buildCliLocalFileAttachmentRecord(
      {
        path: "/tmp/flight.png",
        mimeType: "image/png",
        byteCount: 40_000,
      },
      2_000,
    )

    rememberRecentAttachment("slugger", first, agentRoot)
    rememberRecentAttachment("slugger", second, agentRoot)

    expect(readRecentAttachments("slugger", agentRoot).map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ])

    expect(fs.existsSync(getRecentAttachmentsPath("slugger", agentRoot))).toBe(true)
  })

  it("deduplicates by attachment id and keeps the newest copy", () => {
    const agentRoot = makeAgentRoot()
    const original = buildBlueBubblesAttachmentRecord(
      {
        guid: "GUID-2",
        transferName: "receipt.jpg",
        mimeType: "image/jpeg",
        totalBytes: 1_024,
      },
      1_000,
    )
    const updated = {
      ...original,
      byteCount: 2_048,
      lastSeenAt: 2_000,
      displayName: "receipt-updated.jpg",
    }

    rememberRecentAttachment("slugger", original, agentRoot)
    rememberRecentAttachment("slugger", updated, agentRoot)

    const stored = readRecentAttachments("slugger", agentRoot)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.displayName).toBe("receipt-updated.jpg")
    expect(stored[0]?.byteCount).toBe(2_048)
  })

  it("filters recent attachments by kind", () => {
    const agentRoot = makeAgentRoot()
    const image = buildBlueBubblesAttachmentRecord(
      {
        guid: "GUID-3",
        transferName: "screen.png",
        mimeType: "image/png",
        totalBytes: 8_000,
      },
      1_000,
    )
    const audio = buildBlueBubblesAttachmentRecord(
      {
        guid: "GUID-4",
        transferName: "memo.m4a",
        mimeType: "audio/mp4",
        totalBytes: 99_000,
      },
      2_000,
    )

    rememberRecentAttachment("slugger", image, agentRoot)
    rememberRecentAttachment("slugger", audio, agentRoot)

    const images = listRecentAttachments("slugger", { kind: "image" }, agentRoot)
    const audioOnly = listRecentAttachments("slugger", { kind: "audio" }, agentRoot)

    expect(images.map((entry) => entry.id)).toEqual([image.id])
    expect(audioOnly.map((entry) => entry.id)).toEqual([audio.id])
  })

  it("caps the recent attachment list to the configured limit", () => {
    const agentRoot = makeAgentRoot()

    for (let index = 0; index < MAX_RECENT_ATTACHMENTS + 5; index += 1) {
      rememberRecentAttachment(
        "slugger",
        buildBlueBubblesAttachmentRecord(
          {
            guid: `GUID-${index}`,
            transferName: `shot-${index}.png`,
            mimeType: "image/png",
            totalBytes: 10_000 + index,
          },
          index,
        ),
        agentRoot,
      )
    }

    const recent = readRecentAttachments("slugger", agentRoot)
    expect(recent).toHaveLength(MAX_RECENT_ATTACHMENTS)
    expect(recent[0]?.id).toBe("attachment:bluebubbles:GUID-104")
    expect(recent.at(-1)?.id).toBe("attachment:bluebubbles:GUID-5")
  })
})

describe("attachment rendering", () => {
  it("renders additive transcript blocks with ids, kinds, mime types, and byte sizes", () => {
    const rendered = renderAttachmentBlock([
      buildBlueBubblesAttachmentRecord({
        guid: "GUID-5",
        transferName: "Screenshot 2026-04-08 at 11.33.44 AM.tiff",
        mimeType: "image/tiff",
        totalBytes: 12_400_000,
      }),
      buildCliLocalFileAttachmentRecord({
        path: "/tmp/notes.pdf",
        mimeType: "application/pdf",
        byteCount: 204_800,
      }),
    ])

    expect(rendered).toContain("[attachments]")
    expect(rendered).toContain("attachment:bluebubbles:GUID-5 | image | Screenshot 2026-04-08 at 11.33.44 AM.tiff | image/tiff | 11.8 MB")
    expect(rendered).toContain("attachment:cli-local-file:")
    expect(rendered).toContain("| document | notes.pdf | application/pdf | 200 KB")
  })
})
