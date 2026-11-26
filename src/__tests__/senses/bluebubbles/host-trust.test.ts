import { describe, expect, it } from "vitest"
import { imessageHostTrust } from "../../../senses/bluebubbles/host-trust"

describe("imessageHostTrust", () => {
  it("is separate only when the daemon runs under the declared host account", () => {
    expect(imessageHostTrust("slugger", "slugger")).toBe("separate")
    expect(imessageHostTrust(" slugger ", "slugger")).toBe("separate")
    expect(imessageHostTrust("slugger", "ari")).toBe("shared-apple-id")
    expect(imessageHostTrust(undefined, "ari")).toBe("shared-apple-id")
    expect(imessageHostTrust("  ", "")).toBe("shared-apple-id")
  })
})
