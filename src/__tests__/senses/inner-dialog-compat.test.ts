import { afterEach, describe, expect, it, vi } from "vitest"

describe("inner-dialog compatibility shims", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("legacy runtime exports point to the canonical private-runtime module", async () => {
    vi.resetModules()
    vi.doUnmock("../../senses/inner-dialog")
    vi.doUnmock("../../senses/private-runtime")

    const privateRuntime = await import("../../senses/private-runtime")
    const innerDialog = await import("../../senses/inner-dialog")

    expect(innerDialog.buildInnerDialogBootstrapMessage).toBe(privateRuntime.buildPrivateRuntimeBootstrapMessage)
    expect(innerDialog.loadInnerDialogInstincts).toBe(privateRuntime.loadPrivateRuntimeInstincts)
    expect(innerDialog.innerDialogSessionPath).toBe(privateRuntime.privateRuntimeSessionPath)
    expect(innerDialog.runInnerDialogTurn).toBe(privateRuntime.runPrivateRuntimeTurn)
  })

  it("legacy worker factory delegates default turns to the canonical private-runtime turn runner", async () => {
    vi.resetModules()
    const runInnerDialogTurn = vi.fn(async () => "turn-complete")
    let delegatedTurn: Promise<unknown> | undefined
    const controller = {
      run: vi.fn(),
      handleMessage: vi.fn(),
    }
    const createPrivateRuntimeWorker = vi.fn((runTurn) => {
      delegatedTurn = runTurn({ reason: "manual" })
      return controller
    })

    vi.doMock("../../senses/inner-dialog", () => ({ runInnerDialogTurn }))
    vi.doMock("../../senses/private-runtime-worker", () => ({ createPrivateRuntimeWorker }))

    const { createInnerDialogWorker } = await import("../../senses/inner-dialog-worker")

    expect(createInnerDialogWorker()).toBe(controller)
    expect(createPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
    await expect(delegatedTurn).resolves.toBe("turn-complete")
    expect(runInnerDialogTurn).toHaveBeenCalledWith({ reason: "manual" })
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
      getPrivateRuntimePendingDir: () => "/mock/pending/self/inner/dialog",
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

  it("legacy pending-dir alias preserves the historical durable path", async () => {
    vi.resetModules()
    vi.doUnmock("../../mind/pending")
    vi.doMock("../../heart/identity", () => ({
      getAgentRoot: () => "/bundles/slugger.ouro",
    }))

    const {
      INNER_DIALOG_PENDING,
      PRIVATE_RUNTIME_PENDING,
      getInnerDialogPendingDir,
      getPrivateRuntimePendingDir,
    } = await import("../../mind/pending")

    expect(INNER_DIALOG_PENDING).toBe(PRIVATE_RUNTIME_PENDING)
    expect(getInnerDialogPendingDir("slugger")).toBe(getPrivateRuntimePendingDir("slugger"))
    expect(getInnerDialogPendingDir("slugger")).toBe("/bundles/slugger.ouro/state/pending/self/inner/dialog")
  })
})
