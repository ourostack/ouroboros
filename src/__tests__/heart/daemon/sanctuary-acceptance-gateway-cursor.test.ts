import { describe, expect, it, vi } from "vitest"
import { executeSanctuaryAcceptanceAdapter, type SanctuaryAcceptanceAdapterDependencies } from "../../../heart/daemon/sanctuary-acceptance-adapter"

describe("acceptance gateway cursor ownership", () => {
  const request = { operation: "snapshot", schema: "telegram-cursor-v1", allowGenesis: true }
  function dependencies() {
    const readFixedFile = vi.fn((file: string) => {
      if (file.endsWith("identity.key")) return "k".repeat(43)
      if (file.endsWith("offset.json")) return '{"nextUpdateId":999999}'
      throw Object.assign(new Error("absent"), { code: "ENOENT" })
    })
    return { readFixedFile } as unknown as SanctuaryAcceptanceAdapterDependencies
  }
  it("refuses absent gateway evidence even when a resident offset is present, fresh or frozen", async () => {
    await expect(executeSanctuaryAcceptanceAdapter(request, dependencies())).rejects.toThrow(/gateway/u)
  })
  it("uses verified root logical progress and never reads the resident offset", async () => {
    const deps = dependencies()
    const gatewayCursor = vi.fn(async () => ({ nextUpdateId: 7, progressDigest: `sha256:${"a".repeat(64)}` }))
    Object.assign(deps, { gatewayCursor })
    expect(await executeSanctuaryAcceptanceAdapter(request, deps)).toMatchObject({ offsetDigest: "a".repeat(64) })
    expect(gatewayCursor).toHaveBeenCalledOnce()
    expect(vi.mocked(deps.readFixedFile!).mock.calls.some(([file]) => file.endsWith("offset.json"))).toBe(false)
    gatewayCursor.mockResolvedValue({ nextUpdateId: 7, progressDigest: `sha256:${"b".repeat(64)}` })
    expect(await executeSanctuaryAcceptanceAdapter(request, deps)).toMatchObject({ offsetDigest: "b".repeat(64) })
  })
})
