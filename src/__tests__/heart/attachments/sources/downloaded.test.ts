import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { buildDownloadedAttachmentRecord, downloadedAttachmentSourceAdapter } from "../../../../heart/attachments/sources/downloaded"
import { getAttachmentSourceAdapter } from "../../../../heart/attachments/sources"
import type { AttachmentRecord } from "../../../../heart/attachments/types"

let root = ""

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "downloaded-source-"))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

const owned = (name: string) => path.join(root, "state", "attachments", "materialized", "teams", name)

describe("downloaded attachment records", () => {
  it("builds a record for each downloading sense", () => {
    const record = buildDownloadedAttachmentRecord("teams", { sourceId: "id1", displayName: "photo.png", mimeType: "image/png", byteCount: 4, localPath: owned("photo.png") }, 7)
    expect(record).toMatchObject({ id: "attachment:teams:id1", source: "teams", kind: "image", createdAt: 7, sourceData: { localPath: owned("photo.png") } })
  })

  it("names the sense when the id or path is wrong", () => {
    expect(() => buildDownloadedAttachmentRecord("teams", { sourceId: " ", displayName: "x", localPath: owned("x") })).toThrow("Teams attachment file id is required")
    expect(() => buildDownloadedAttachmentRecord("telegram", { sourceId: "a", displayName: "x", localPath: "relative/x" })).toThrow("Telegram attachment local path must be absolute")
  })
})

describe("downloaded attachment adapter", () => {
  it("is registered for Teams and materializes a file inside the Teams folder", async () => {
    fs.mkdirSync(path.dirname(owned("a.png")), { recursive: true })
    fs.writeFileSync(owned("a.png"), "png")
    const record = buildDownloadedAttachmentRecord("teams", { sourceId: "a", displayName: "a.png", mimeType: "image/png", localPath: owned("a.png") })
    await expect(getAttachmentSourceAdapter("teams").materializeOriginal({ attachment: record, agentRoot: root } as never)).resolves.toMatchObject({ path: owned("a.png") })
  })

  it("refuses another sense's record, a bad path, and a path outside its folder", async () => {
    const adapter = downloadedAttachmentSourceAdapter("teams")
    const telegram = buildDownloadedAttachmentRecord("telegram", { sourceId: "t", displayName: "t", localPath: owned("t") })
    await expect(adapter.materializeOriginal({ attachment: telegram, agentRoot: root } as never)).rejects.toThrow("teams adapter cannot materialize telegram attachments")

    const noPath = { ...buildDownloadedAttachmentRecord("teams", { sourceId: "n", displayName: "n", localPath: owned("n") }), sourceData: {} } as AttachmentRecord
    await expect(adapter.materializeOriginal({ attachment: noPath, agentRoot: root } as never)).rejects.toThrow("Teams attachment local path is invalid")

    const outside = buildDownloadedAttachmentRecord("teams", { sourceId: "o", displayName: "o", localPath: path.join(root, "elsewhere", "o") })
    await expect(adapter.materializeOriginal({ attachment: outside, agentRoot: root } as never)).rejects.toThrow("Teams attachment local path is outside the owned attachment root")
  })
})
