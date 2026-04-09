import { describe, expect, it } from "vitest"

import {
  lookupBlueBubblesAttachment,
  rememberBlueBubblesAttachment,
  resetBlueBubblesAttachmentCache,
} from "../../../senses/bluebubbles/attachment-cache"

describe("bluebubbles attachment cache", () => {
  it("remembers, trims, and resets cached attachments", () => {
    resetBlueBubblesAttachmentCache()

    rememberBlueBubblesAttachment({ guid: "GUID-1", transferName: "first.png" })
    rememberBlueBubblesAttachment({ guid: "GUID-2", transferName: "second.png" })

    expect(lookupBlueBubblesAttachment("GUID-1")?.transferName).toBe("first.png")
    expect(lookupBlueBubblesAttachment(" GUID-2 ")?.transferName).toBe("second.png")

    resetBlueBubblesAttachmentCache()
    expect(lookupBlueBubblesAttachment("GUID-1")).toBeUndefined()
  })

  it("ignores blank guids and evicts the oldest entries past the cache limit", () => {
    resetBlueBubblesAttachmentCache()

    rememberBlueBubblesAttachment({ guid: "   ", transferName: "ignored.png" })
    for (let index = 0; index < 51; index += 1) {
      rememberBlueBubblesAttachment({ guid: `GUID-${index}`, transferName: `shot-${index}.png` })
    }

    expect(lookupBlueBubblesAttachment("")).toBeUndefined()
    expect(lookupBlueBubblesAttachment("GUID-0")).toBeUndefined()
    expect(lookupBlueBubblesAttachment("GUID-50")?.transferName).toBe("shot-50.png")
  })

  it("refreshes an existing guid by replacing the old cached value", () => {
    resetBlueBubblesAttachmentCache()

    rememberBlueBubblesAttachment({ guid: "GUID-1", transferName: "old.png" })
    rememberBlueBubblesAttachment({ guid: "GUID-1", transferName: "new.png" })

    expect(lookupBlueBubblesAttachment("GUID-1")?.transferName).toBe("new.png")
  })
})
