import { describe, expect, it } from "vitest"

import { createShepherdHost } from "../../../senses/shepherd/host"

describe("Shepherd host factory", () => {
  it("opens the host this machine's connection names", () => {
    expect(createShepherdHost({ host: "herdr", socketPath: "/tmp/no-herdr.sock" }, { agentName: "ouroboros" }).name).toBe("herdr")
    expect(createShepherdHost({ host: "cmux", socketPath: "/tmp/no-cmux.sock", auth: { kind: "none" } }, { agentName: "ouroboros" }).name).toBe("cmux")
  })
})
