import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { materializeAttachment } from "../../../heart/attachments/materialize"
import { rememberRecentAttachment } from "../../../heart/attachments/store"
import { buildCliLocalFileAttachmentRecord } from "../../../heart/attachments/types"

const tempDirs: string[] = []

function makeAgentRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-materialize-"))
  tempDirs.push(dir)
  return dir
}

function makeFile(dir: string, name: string, content: string): string {
  const target = path.join(dir, name)
  fs.writeFileSync(target, content, "utf-8")
  return target
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe("materializeAttachment", () => {
  it("returns the original CLI file path for original variants", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "capture.png", "not-really-a-png")
    const record = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/png",
      byteCount: 17,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    const materialized = await materializeAttachment("slugger", record.id, {
      agentRoot,
      variant: "original",
    })

    expect(materialized.path).toBe(sourcePath)
    expect(materialized.displayName).toBe("capture.png")
    expect(materialized.variant).toBe("original")
    expect(materialized.byteCount).toBe(17)
  })

  it("delegates image normalization for vision_safe variants", async () => {
    const agentRoot = makeAgentRoot()
    const sourcePath = makeFile(agentRoot, "capture.tiff", "tiff-bytes")
    const normalizedPath = makeFile(agentRoot, "capture.jpg", "jpeg-bytes")
    const record = buildCliLocalFileAttachmentRecord({
      path: sourcePath,
      mimeType: "image/tiff",
      byteCount: 18,
    })
    rememberRecentAttachment("slugger", record, agentRoot)

    const normalizeImage = vi.fn().mockResolvedValue({
      path: normalizedPath,
      mimeType: "image/jpeg",
      byteCount: 11,
    })

    const materialized = await materializeAttachment("slugger", record.id, {
      agentRoot,
      variant: "vision_safe",
      normalizeImage,
    })

    expect(normalizeImage).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: expect.objectContaining({ id: record.id }),
        sourcePath,
      }),
    )
    expect(materialized.path).toBe(normalizedPath)
    expect(materialized.mimeType).toBe("image/jpeg")
    expect(materialized.variant).toBe("vision_safe")
  })

  it("rejects unknown attachment ids", async () => {
    const agentRoot = makeAgentRoot()

    await expect(
      materializeAttachment("slugger", "attachment:bluebubbles:missing", { agentRoot }),
    ).rejects.toThrow("Attachment not found: attachment:bluebubbles:missing")
  })
})
