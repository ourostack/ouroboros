import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"

// Many tests point identity's getRepoRoot at a fake root. The generated doors are found from doors.ts's own place,
// so loading the CLI manifest or the tool registry under such a mock still works.
vi.mock("../../../heart/identity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../heart/identity")>()),
  getRepoRoot: () => "/mock/repo",
}))

describe("the generated doors under a mocked repo root", () => {
  it("still reads the real generated files", async () => {
    const { readMailboxDoors } = await import("../../../heart/letters/doors")
    expect(readMailboxDoors().commands.map((c) => c.name)).toContain("mailbox list")
    const { CLI_COMMANDS } = await import("../../../heart/daemon/cli-manifest")
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("mailbox list")
  })
})

describe("where the generated doors are read from", () => {
  it("is the package root in a checkout, where ouro-actions writes them, and dist/ where only the build's copies ship", async () => {
    const { doorsRoot } = await import("../../../heart/letters/doors")
    const checkout = (file: string) => file === "/repo/actions/generated/mailbox/commands.json"
    expect(doorsRoot("/repo/dist/heart/letters", checkout)).toBe("/repo")
    expect(doorsRoot("/repo/src/heart/letters", checkout)).toBe("/repo")
    expect(doorsRoot("/opt/ouro/dist/heart/letters", checkout)).toBe("/opt/ouro/dist")
    // By default it looks on disk: this checkout has the generated files.
    expect(doorsRoot(path.resolve(__dirname, "../../../heart/letters"))).toBe(path.resolve(__dirname, "../../../.."))
  })

  it("reads them through Node's own fs even when a test mocks fs", async () => {
    vi.resetModules()
    vi.doMock("fs", () => ({ readFileSync: () => { throw new Error("mocked fs") }, existsSync: () => false }))
    try {
      const doors = await import("../../../heart/letters/doors")
      doors.resetMailboxDoorsForTest()
      expect(doors.readMailboxDoors().mcpTools.map((t) => t.name)).toContain("mailbox_list")
    } finally {
      vi.doUnmock("fs")
    }
  })
})
