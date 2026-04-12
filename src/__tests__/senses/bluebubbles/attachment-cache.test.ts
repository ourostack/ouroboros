import { describe, expect, it } from "vitest"

import {
  lookupBlueBubblesAttachment,
  cacheBlueBubblesAttachment,
  resetBlueBubblesAttachmentCache,
} from "../../../senses/bluebubbles/attachment-cache"

describe("bluebubbles attachment cache", () => {
  it("caches, trims, and resets cached attachments", () => {
    resetBlueBubblesAttachmentCache()

    cacheBlueBubblesAttachment({ guid: "GUID-1", transferName: "first.png" })
    cacheBlueBubblesAttachment({ guid: "GUID-2", transferName: "second.png" })

    expect(lookupBlueBubblesAttachment("GUID-1")?.transferName).toBe("first.png")
    expect(lookupBlueBubblesAttachment(" GUID-2 ")?.transferName).toBe("second.png")

    resetBlueBubblesAttachmentCache()
    expect(lookupBlueBubblesAttachment("GUID-1")).toBeUndefined()
  })

  it("ignores blank guids and evicts the oldest entries past the cache limit", () => {
    resetBlueBubblesAttachmentCache()

    cacheBlueBubblesAttachment({ guid: "   ", transferName: "ignored.png" })
    for (let index = 0; index < 51; index += 1) {
      cacheBlueBubblesAttachment({ guid: `GUID-${index}`, transferName: `shot-${index}.png` })
    }

    expect(lookupBlueBubblesAttachment("")).toBeUndefined()
    expect(lookupBlueBubblesAttachment("GUID-0")).toBeUndefined()
    expect(lookupBlueBubblesAttachment("GUID-50")?.transferName).toBe("shot-50.png")
  })

  it("refreshes an existing guid by replacing the old cached value", () => {
    resetBlueBubblesAttachmentCache()

    cacheBlueBubblesAttachment({ guid: "GUID-1", transferName: "old.png" })
    cacheBlueBubblesAttachment({ guid: "GUID-1", transferName: "new.png" })

    expect(lookupBlueBubblesAttachment("GUID-1")?.transferName).toBe("new.png")
  })
})
