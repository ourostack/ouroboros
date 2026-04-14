import { describe, expect, it } from "vitest"

import * as daemonCli from "../../../heart/daemon/daemon-cli"

describe("daemon-cli re-export shim", () => {
  it("re-exports the public cli surface", () => {
    expect(daemonCli.parseOuroCommand).toBeTypeOf("function")
    expect(daemonCli.runOuroCli).toBeTypeOf("function")
    expect(daemonCli.ensureDaemonRunning).toBeTypeOf("function")
    expect(daemonCli.createDefaultOuroCliDeps).toBeTypeOf("function")
    expect(daemonCli.readFirstBundleMetaVersion).toBeTypeOf("function")
  })
})
