import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  runSync: vi.fn(),
}))

vi.mock("../../../mailroom/cache-sync-cli", () => ({
  runHostedMailCacheSync: mocks.runSync,
}))

import { runOuroCli } from "../../../heart/daemon/daemon-cli"
import type { OuroCliDeps } from "../../../heart/daemon/daemon-cli"

describe("mail sync-cache CLI execution", () => {
  it("forwards foreground progress and then writes the final summary through the injected stdout sink", async () => {
    const output: string[] = []
    mocks.runSync.mockImplementationOnce(async (_agent: string, writeProgress: (line: string) => void) => {
      writeProgress("mail cache sync pass 1: 250/500 settled (settled)")
      return "hosted mail cache converged for Slugger."
    })

    const result = await runOuroCli(["mail", "sync-cache", "--agent", "Slugger"], {
      writeStdout: (line: string) => output.push(line),
    } as OuroCliDeps)

    expect(mocks.runSync).toHaveBeenCalledWith("Slugger", expect.any(Function))
    expect(output).toEqual([
      "mail cache sync pass 1: 250/500 settled (settled)",
      "hosted mail cache converged for Slugger.",
    ])
    expect(result).toBe("hosted mail cache converged for Slugger.")
  })
})
