import { describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execSync: vi.fn() }))

describe("terminal process lookup module", () => {
  it("does not initialize subprocess dependencies when no terminals are attached", async () => {
    const { identifyTerminalProcesses } = await import("../../../senses/shepherd/terminal-process")
    expect(await identifyTerminalProcesses([])).toEqual(new Map())
  })
})
