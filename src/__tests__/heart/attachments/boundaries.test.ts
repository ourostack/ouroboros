import * as fs from "node:fs"
import * as path from "node:path"
import { describe, expect, it } from "vitest"

const attachmentsRoot = path.resolve(import.meta.dirname, "../../../heart/attachments")

function readAttachmentSource(relativePath: string): string {
  return fs.readFileSync(path.join(attachmentsRoot, relativePath), "utf-8")
}

describe("attachment boundary guards", () => {
  it("keeps generic attachment types free of BlueBubbles-specific imports", () => {
    const source = readAttachmentSource("types.ts")

    expect(source).not.toContain("senses/bluebubbles")
    expect(source).not.toContain("buildBlueBubblesAttachmentRecord")
    expect(source).not.toContain("buildCliLocalFileAttachmentRecord")
  })

  it("keeps generic materialization orchestration free of BlueBubbles download/config details", () => {
    const source = readAttachmentSource("materialize.ts")

    expect(source).not.toContain("downloadBlueBubblesAttachment")
    expect(source).not.toContain("getBlueBubblesConfig")
    expect(source).not.toContain("getBlueBubblesChannelConfig")
    expect(source).not.toContain("persistBlueBubblesAttachmentSource")
  })
})
