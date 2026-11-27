import { beforeEach, describe, expect, it, vi } from "vitest"
import { useButlerProduct } from "../test-helpers/butler-product"

const mocks = vi.hoisted(() => ({
  runSenseTurn: vi.fn(async () => ({ response: "ok" })),
  houseRuntime: { getDownloadQueue: () => [] },
}))

vi.mock("../../senses/shared-turn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../senses/shared-turn")>()),
  runSenseTurn: mocks.runSenseTurn,
}))
vi.mock("../../senses/sanctuary-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../senses/sanctuary-runtime")>()),
  createSanctuaryToolContext: (agentName: string) => ({ agentRoot: `/bundles/${agentName}.ouro`, sanctuary: mocks.houseRuntime }),
}))

const turn = { peerAgentId: "did:example:peer", peerName: "Peer", sessionKey: "a2a-session", message: "is the house up?" }

describe("the default A2A turn runner", () => {
  useButlerProduct()
  beforeEach(() => { mocks.runSenseTurn.mockClear() })

  it("gives a Butler A2A turn its product's house runtime, so a verified friend's house reads work", async () => {
    const { defaultTurnRunner } = await import("../../a2a/server")
    await expect(defaultTurnRunner({ ...turn, agentName: "butler" })).resolves.toEqual({ response: "ok" })
    const input = (mocks.runSenseTurn.mock.calls[0] as unknown as [{ channel: string; toolContext: Record<string, unknown> }])[0]
    expect(input.channel).toBe("a2a")
    expect(input.toolContext).toMatchObject({ sanctuary: mocks.houseRuntime, agentRoot: "/bundles/butler.ouro" })
  })

  it("gives another agent's A2A turn no house runtime", async () => {
    const { defaultTurnRunner } = await import("../../a2a/server")
    await defaultTurnRunner({ ...turn, agentName: "slugger" })
    const input = (mocks.runSenseTurn.mock.calls[0] as unknown as [{ toolContext: Record<string, unknown> }])[0]
    expect(input.toolContext.sanctuary).toBeUndefined()
  })
})
