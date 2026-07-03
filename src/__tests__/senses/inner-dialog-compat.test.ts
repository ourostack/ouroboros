import { afterEach, describe, expect, it, vi } from "vitest"

describe("inner-dialog compatibility shims", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("legacy worker startup delegates to the canonical private-runtime worker without a boot turn", async () => {
    vi.resetModules()
    const startPrivateRuntimeWorker = vi.fn(async () => undefined)
    const runInnerDialogTurn = vi.fn(async () => undefined)
    const listeners: Record<string, (...args: any[]) => void> = {}
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => void) => {
      listeners[event] = handler
      return process
    }) as any)

    vi.doMock("../../senses/private-runtime-worker", () => ({ startPrivateRuntimeWorker }))
    vi.doMock("../../senses/inner-dialog", () => ({ runInnerDialogTurn }))
    vi.doMock("../../heart/identity", () => ({
      getAgentName: () => "slugger",
      getAgentRoot: () => "/bundles/slugger.ouro",
    }))
    vi.doMock("../../mind/pending", () => ({
      getInnerDialogPendingDir: () => "/mock/pending/self/inner/dialog",
      hasPendingMessages: () => false,
    }))

    try {
      const { startInnerDialogWorker } = await import("../../senses/inner-dialog-worker")

      await startInnerDialogWorker()

      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(runInnerDialogTurn).not.toHaveBeenCalled()
      expect(listeners.message).toBeUndefined()
      expect(listeners.disconnect).toBeUndefined()
    } finally {
      onSpy.mockRestore()
    }
  })
})
