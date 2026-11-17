import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  resolve: vi.fn(),
}))

vi.mock("../../../heart/runtime-credentials", () => ({ refreshRuntimeCredentialConfig: mocks.refresh }))
vi.mock("../../../mailroom/reader", () => ({ resolveMailroomReader: mocks.resolve }))

import { runOuroCli } from "../../../heart/daemon/daemon-cli"
import type { OuroCliDeps } from "../../../heart/daemon/daemon-cli"
import { parseOuroCommand } from "../../../heart/daemon/cli-parse"

const result = { scanned: 5, referenced: 3, orphaned: 2, deletable: 1, deleted: 1, skippedYoung: 1, dryRun: false }

describe("mail sweep-orphans", () => {
  it("parses dry run by default, --live, and rejects other tokens", () => {
    expect(parseOuroCommand(["mail", "sweep-orphans", "--agent", "Slugger"])).toEqual({ kind: "mail.sweep-orphans", agent: "Slugger" })
    expect(parseOuroCommand(["mail", "sweep-orphans", "--live"])).toEqual({ kind: "mail.sweep-orphans", live: true })
    expect(() => parseOuroCommand(["mail", "sweep-orphans", "--force"])).toThrow("Usage")
  })

  it("runs a dry run then a live sweep through the hosted store and reports counts", async () => {
    mocks.refresh.mockResolvedValue({ ok: true })
    const sweep = vi.fn()
      .mockResolvedValueOnce({ ...result, deleted: 0, dryRun: true })
      .mockResolvedValueOnce(result)
    mocks.resolve.mockReturnValue({ ok: true, storeKind: "azure-blob", store: { sweepOrphanedEncryptedRaw: sweep } })
    const output: string[] = []
    const deps = { writeStdout: (line: string) => output.push(line) } as OuroCliDeps

    const dry = await runOuroCli(["mail", "sweep-orphans", "--agent", "Slugger"], deps)
    expect(sweep).toHaveBeenLastCalledWith({ dryRun: true })
    expect(dry).toContain("dry run")
    expect(dry).toContain("orphans found: 2")
    expect(dry).toContain("would delete: 1")

    const live = await runOuroCli(["mail", "sweep-orphans", "--agent", "Slugger", "--live"], deps)
    expect(sweep).toHaveBeenLastCalledWith({ dryRun: false })
    expect(live).toContain("swept:")
    expect(live).toContain("deleted: 1")
    expect(output).toEqual([dry, live])
  })

  it("fails with guidance when credentials, store, or store kind are unusable", async () => {
    const deps = { writeStdout: () => undefined } as unknown as OuroCliDeps
    mocks.refresh.mockResolvedValueOnce({ ok: false, itemPath: "runtime/config", error: "locked" })
    await expect(runOuroCli(["mail", "sweep-orphans", "--agent", "Slugger"], deps)).rejects.toThrow("requires fresh runtime/config: locked")
    mocks.refresh.mockResolvedValue({ ok: true })
    mocks.resolve.mockReturnValueOnce({ ok: false, error: "no mailroom" })
    await expect(runOuroCli(["mail", "sweep-orphans", "--agent", "Slugger"], deps)).rejects.toThrow("no mailroom")
    mocks.resolve.mockReturnValueOnce({ ok: true, storeKind: "file", store: {} })
    await expect(runOuroCli(["mail", "sweep-orphans", "--agent", "Slugger"], deps)).rejects.toThrow("requires hosted Azure Mailroom; resolved file")
  })
})
