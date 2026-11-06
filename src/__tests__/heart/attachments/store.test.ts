import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})

import {
  MAX_RECENT_ATTACHMENTS,
  getAttachment,
  getAttachmentCatalogPath,
  getRecentAttachmentsPath,
  listRecentAttachments,
  readRecentAttachments,
  cacheRecentAttachment,
  removeAttachment,
} from "../../../heart/attachments/store"
import {
  buildAttachmentId,
  classifyAttachmentKind,
} from "../../../heart/attachments/types"
import { buildBlueBubblesAttachmentRecord } from "../../../heart/attachments/sources/bluebubbles"
import { buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/sources/cli-local-file"
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

  it("classifies document-ish files and rejects missing guids", () => {
    const doc = buildCliLocalFileAttachmentRecord({
      path: "/tmp/report",
      displayName: "report.docx",
    })
    const binary = buildCliLocalFileAttachmentRecord({
      path: "/tmp/blob",
      displayName: "blob.bin",
    })

    expect(doc.kind).toBe("document")
    expect(binary.kind).toBe("binary")
    expect(classifyAttachmentKind()).toBe("unknown")
    expect(() => buildBlueBubblesAttachmentRecord({ transferName: "missing-guid.jpg" } as any)).toThrow(
      "BlueBubbles attachment guid is required",
    )
  })
})

describe("recent attachment store", () => {
  it("removes only the selected catalog entry and tolerates repeated rollback", () => {
    const agentRoot = makeAgentRoot()
    const owned = buildCliLocalFileAttachmentRecord({ path: "/tmp/owned.txt", mimeType: "text/plain" })
    const retained = buildCliLocalFileAttachmentRecord({ path: "/tmp/retained.txt", mimeType: "text/plain" })
    cacheRecentAttachment("slugger", owned, agentRoot)
    cacheRecentAttachment("slugger", retained, agentRoot)
    removeAttachment("slugger", owned.id, agentRoot)
    expect(getAttachment("slugger", owned.id, agentRoot)).toBeNull()
    expect(readRecentAttachments("slugger", agentRoot)).toEqual([retained])
    removeAttachment("slugger", owned.id, agentRoot)
    expect(getAttachment("slugger", retained.id, agentRoot)).toEqual(retained)
    expect(readRecentAttachments("slugger", agentRoot)).toEqual([retained])
  })

  it("returns an empty list when the persisted store is invalid or not an array", () => {
    const agentRoot = makeAgentRoot()
    const storePath = getRecentAttachmentsPath("slugger", agentRoot)
    fs.mkdirSync(path.dirname(storePath), { recursive: true })

    fs.writeFileSync(storePath, "{not json", "utf-8")
    expect(readRecentAttachments("slugger", agentRoot)).toEqual([])

    fs.writeFileSync(storePath, JSON.stringify({ nope: true }), "utf-8")
    expect(readRecentAttachments("slugger", agentRoot)).toEqual([])
  })

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

    cacheRecentAttachment("slugger", first, agentRoot)
    cacheRecentAttachment("slugger", second, agentRoot)

    expect(readRecentAttachments("slugger", agentRoot).map((entry) => entry.id)).toEqual([
      second.id,
      first.id,
    ])

    expect(fs.existsSync(getRecentAttachmentsPath("slugger", agentRoot))).toBe(true)
    expect(fs.statSync(getRecentAttachmentsPath("slugger", agentRoot)).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(getRecentAttachmentsPath("slugger", agentRoot))).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("replaces an unreadable interrupted registry with a complete parseable snapshot", () => {
    const agentRoot = makeAgentRoot()
    const storePath = getRecentAttachmentsPath("slugger", agentRoot)
    fs.mkdirSync(path.dirname(storePath), { recursive: true })
    fs.writeFileSync(storePath, "[", "utf8")
    const recovered = buildCliLocalFileAttachmentRecord({ path: "/tmp/recovered.pdf", mimeType: "application/pdf", byteCount: 12 })

    cacheRecentAttachment("slugger", recovered, agentRoot)

    expect(JSON.parse(fs.readFileSync(storePath, "utf8"))).toEqual([recovered])
    expect(fs.readdirSync(path.dirname(storePath)).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  it("surfaces unexpected temporary-file cleanup failures after the durable rename", () => {
    const agentRoot = makeAgentRoot()
    const attachment = buildCliLocalFileAttachmentRecord({ path: "/tmp/durable.pdf", mimeType: "application/pdf", byteCount: 12 })
    const cleanupError = Object.assign(new Error("cleanup denied"), { code: "EACCES" })
    const unlink = vi.mocked(fs.unlinkSync).mockImplementationOnce(() => { throw cleanupError })

    expect(() => cacheRecentAttachment("slugger", attachment, agentRoot)).toThrow(cleanupError)
    unlink.mockRestore()
    expect(getAttachment("slugger", attachment.id, agentRoot)).toEqual(attachment)
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

    cacheRecentAttachment("slugger", original, agentRoot)
    cacheRecentAttachment("slugger", updated, agentRoot)

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

    cacheRecentAttachment("slugger", image, agentRoot)
    cacheRecentAttachment("slugger", audio, agentRoot)

    const images = listRecentAttachments("slugger", { kind: "image" }, agentRoot)
    const audioOnly = listRecentAttachments("slugger", { kind: "audio" }, agentRoot)

    expect(images.map((entry) => entry.id)).toEqual([image.id])
    expect(audioOnly.map((entry) => entry.id)).toEqual([audio.id])
  })

  it("caps the recent attachment list to the configured limit", () => {
    const agentRoot = makeAgentRoot()

    for (let index = 0; index < MAX_RECENT_ATTACHMENTS + 5; index += 1) {
      cacheRecentAttachment(
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

describe("durable attachment catalog", () => {
  it("keeps evicted attachments resolvable after the recency cache rolls over", () => {
    const agentRoot = makeAgentRoot()
    const evicted = buildCliLocalFileAttachmentRecord(
      { path: "/tmp/session-bound.png", mimeType: "image/png", byteCount: 512 },
      1,
    )
    cacheRecentAttachment("slugger", evicted, agentRoot)

    for (let index = 0; index < MAX_RECENT_ATTACHMENTS + 5; index += 1) {
      cacheRecentAttachment(
        "slugger",
        buildBlueBubblesAttachmentRecord(
          { guid: `NEWER-${index}`, transferName: `newer-${index}.png`, mimeType: "image/png", totalBytes: 10 },
          index + 2,
        ),
        agentRoot,
      )
    }

    expect(readRecentAttachments("slugger", agentRoot).some((entry) => entry.id === evicted.id)).toBe(false)
    expect(getAttachment("slugger", evicted.id, agentRoot)).toEqual(evicted)
  })

  it("falls back to the recency cache when no durable record exists", () => {
    const agentRoot = makeAgentRoot()
    const attachment = buildCliLocalFileAttachmentRecord({ path: "/tmp/cache-only.png", mimeType: "image/png", byteCount: 8 })
    cacheRecentAttachment("slugger", attachment, agentRoot)
    fs.rmSync(getAttachmentCatalogPath("slugger", agentRoot), { recursive: true, force: true })

    expect(getAttachment("slugger", attachment.id, agentRoot)).toEqual(attachment)
    expect(getAttachment("slugger", "attachment:cli-local-file:missing", agentRoot)).toBeNull()
  })

  it("ignores unreadable or mismatched durable records instead of returning them", () => {
    const agentRoot = makeAgentRoot()
    const attachment = buildCliLocalFileAttachmentRecord({ path: "/tmp/corrupt.png", mimeType: "image/png", byteCount: 8 })
    cacheRecentAttachment("slugger", attachment, agentRoot)
    const catalogDirectory = getAttachmentCatalogPath("slugger", agentRoot)
    const recordFile = path.join(catalogDirectory, fs.readdirSync(catalogDirectory)[0]!)

    fs.writeFileSync(recordFile, "{not json", "utf-8")
    expect(getAttachment("slugger", attachment.id, agentRoot)).toEqual(attachment)

    fs.writeFileSync(recordFile, JSON.stringify(null), "utf-8")
    expect(getAttachment("slugger", attachment.id, agentRoot)).toEqual(attachment)

    fs.writeFileSync(recordFile, JSON.stringify({ ...attachment, id: "attachment:cli-local-file:other" }), "utf-8")
    expect(getAttachment("slugger", attachment.id, agentRoot)).toEqual(attachment)
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
