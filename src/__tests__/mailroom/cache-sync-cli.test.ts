import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  resolveReader: vi.fn(),
  resolveAuthority: vi.fn(),
  sync: vi.fn(),
}))

vi.mock("../../heart/runtime-credentials", () => ({
  refreshRuntimeCredentialConfig: mocks.refresh,
}))
vi.mock("../../mailroom/reader", () => ({
  resolveMailroomReader: mocks.resolveReader,
  resolveHostedMailAuthority: mocks.resolveAuthority,
}))
vi.mock("../../mailroom/hosted-cache-sync", () => ({
  syncHostedMailSearchCache: mocks.sync,
}))

import { runHostedMailCacheSync } from "../../mailroom/cache-sync-cli"

describe("foreground hosted mail cache sync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.refresh.mockResolvedValue({
      ok: true,
      itemPath: "vault:slugger:runtime/config",
      config: {},
      revision: "fresh",
      updatedAt: "2026-08-17T20:00:00.000Z",
    })
    mocks.resolveReader.mockReturnValue({
      ok: true,
      agentName: "slugger",
      config: { privateKeys: { key_current: "private" } },
      store: { mailSearchCacheOptions: () => ({ cacheDirForAgent: () => "/tmp/cache" }), recordAccess: vi.fn() },
      storeKind: "azure-blob",
      storeLabel: "hosted",
    })
    mocks.resolveAuthority.mockReturnValue({
      ok: true,
      agentName: "slugger",
      authority: { observeMessageIndexAuthority: vi.fn() },
      storeLabel: "hosted",
    })
    mocks.sync.mockResolvedValue({
      coverage: {
        visibleMessageCount: 7,
        decryptableMessageCount: 5,
        indexedAt: "2026-08-17T20:01:00.000Z",
      },
      fetched: 3,
      alreadyCached: 2,
      removed: 4,
      skipped: 2,
    })
  })

  it("requires fresh credentials, invokes full convergence, and renders exact counts", async () => {
    const progressLines: string[] = []
    mocks.sync.mockImplementationOnce(async (input: { onProgress?: (progress: unknown) => void }) => {
      input.onProgress?.({ phase: "settled", pass: 2, settled: 250, total: 500 })
      return {
        coverage: {
          visibleMessageCount: 7,
          decryptableMessageCount: 5,
          indexedAt: "2026-08-17T20:01:00.000Z",
        },
        fetched: 3,
        alreadyCached: 2,
        removed: 4,
        skipped: 2,
      }
    })
    const text = await runHostedMailCacheSync("slugger", (line) => progressLines.push(line))

    expect(mocks.refresh).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: false })
    expect(mocks.sync).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "slugger",
      mode: "full-convergence",
      privateKeys: { key_current: "private" },
      storeKind: "azure-blob",
      onProgress: expect.any(Function),
    }))
    expect(progressLines).toEqual(["mail cache sync pass 2: 250/500 settled (settled)"])
    expect(text).toContain("hosted mail cache converged for slugger")
    expect(text).toContain("visible authoritative messages: 7")
    expect(text).toContain("decryptable cached messages: 5")
    expect(text).toContain("fetched this run: 3")
    expect(text).toContain("already current: 2")
    expect(text).toContain("removed stale local files: 4")
    expect(text).toContain("skipped unavailable messages: 2")
    expect(mocks.resolveReader.mock.results[0]?.value.store.recordAccess).not.toHaveBeenCalled()
  })

  it("stops before reader resolution when fresh credentials fail", async () => {
    mocks.refresh.mockResolvedValue({ ok: false, itemPath: "vault:slugger:runtime/config", error: "vault locked" })
    await expect(runHostedMailCacheSync("slugger")).rejects.toThrow("vault locked")
    expect(mocks.resolveReader).not.toHaveBeenCalled()
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it("surfaces reader resolution failure", async () => {
    mocks.resolveReader.mockReturnValue({ ok: false, error: "mail reader unavailable" })
    await expect(runHostedMailCacheSync("slugger")).rejects.toThrow("mail reader unavailable")
    expect(mocks.resolveAuthority).not.toHaveBeenCalled()
  })

  it("rejects local Mailroom without inspecting authority", async () => {
    mocks.resolveReader.mockReturnValue({
      ok: true,
      config: { privateKeys: {} },
      store: {},
      storeKind: "file",
    })
    await expect(runHostedMailCacheSync("slugger")).rejects.toThrow("requires hosted Azure Mailroom")
    expect(mocks.resolveAuthority).not.toHaveBeenCalled()
  })

  it("surfaces read-only authority resolution failure", async () => {
    mocks.resolveAuthority.mockReturnValue({ ok: false, error: "authority unavailable" })
    await expect(runHostedMailCacheSync("slugger")).rejects.toThrow("authority unavailable")
    expect(mocks.sync).not.toHaveBeenCalled()
  })
})
