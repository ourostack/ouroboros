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
    expect(readMailboxDoors().commands.map((c) => c.name)).toEqual(["mailbox list"])
    const { CLI_COMMANDS } = await import("../../../heart/daemon/cli-manifest")
    expect(CLI_COMMANDS.map((c) => c.name)).toContain("mailbox list")
  })
})
