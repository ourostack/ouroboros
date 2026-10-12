import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it } from "vitest"
import { rsvpBlueBubblesHostOptions } from "../../rsvp/cli"

describe("rsvpBlueBubblesHostOptions", () => {
  it("leaves the host account unset when the agent config cannot be read, so sending fails closed", () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rsvp-host-options-"))
    expect(rsvpBlueBubblesHostOptions("slugger", path.join(agentRoot, "missing.ouro")))
      .toEqual({ agent: "slugger", hostUsername: undefined })
  })
})
