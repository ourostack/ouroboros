import { afterEach, describe, expect, it, vi } from "vitest"

const workerModulePath = "../../senses/private-runtime-worker"
const runtimeModulePath = "../../senses/private-runtime"

describe("private-runtime worker", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it("exports a canonical private-runtime turn entrypoint", async () => {
    vi.resetModules()

    const runtime = await import(runtimeModulePath) as {
      runPrivateRuntimeTurn?: unknown
    }

    expect(runtime.runPrivateRuntimeTurn).toEqual(expect.any(Function))
  })

  it("starts process listeners without running a boot model turn", async () => {
    vi.resetModules()
    const runPrivateRuntimeTurn = vi.fn(async () => undefined)
    const listeners: Record<string, (...args: any[]) => void> = {}
    const onSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: any[]) => void) => {
      listeners[event] = handler
      return process
    }) as any)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called")
    }) as any)
    vi.doMock(runtimeModulePath, () => ({ runPrivateRuntimeTurn }))

    try {
      const { startPrivateRuntimeWorker } = await import(workerModulePath) as {
        startPrivateRuntimeWorker: () => Promise<void>
      }

      await startPrivateRuntimeWorker()

      expect(runPrivateRuntimeTurn).not.toHaveBeenCalled()
      expect(listeners.message).toEqual(expect.any(Function))
      await listeners.message?.({ type: "poke", taskId: "manual-check" })
      expect(runPrivateRuntimeTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "manual-check", habitName: undefined })
      expect(() => listeners.disconnect?.()).toThrow("process.exit called")
    } finally {
      onSpy.mockRestore()
      exitSpy.mockRestore()
    }
  })

  it("still allows explicit private turns through the canonical worker controller", async () => {
    vi.resetModules()
    const runPrivateRuntimeTurn = vi.fn(async () => undefined)
    vi.doMock(runtimeModulePath, () => ({ runPrivateRuntimeTurn }))
    const { createPrivateRuntimeWorker } = await import(workerModulePath) as {
      createPrivateRuntimeWorker: (
        runTurn?: (options: { reason: string; taskId?: string; habitName?: string }) => Promise<unknown>,
      ) => {
        run(reason: "instinct", taskId?: string): Promise<void>
      }
    }
    const worker = createPrivateRuntimeWorker()

    await worker.run("instinct", "manual-check")

    expect(runPrivateRuntimeTurn).toHaveBeenCalledWith({ reason: "instinct", taskId: "manual-check", habitName: undefined })
  })

  it("runs approved await messages through the await turn path", async () => {
    vi.resetModules()
    const runPrivateRuntimeTurn = vi.fn(async () => undefined)
    vi.doMock(runtimeModulePath, () => ({ runPrivateRuntimeTurn }))
    const { createPrivateRuntimeWorker } = await import(workerModulePath) as {
      createPrivateRuntimeWorker: () => {
        handleMessage(message: unknown): Promise<void>
      }
    }
    const worker = createPrivateRuntimeWorker()

    await worker.handleMessage({
      type: "await",
      awaitName: "hey_export",
      privateTurnDecision: { result: "allow", triggerSource: "await-poke" },
    })

    expect(runPrivateRuntimeTurn).toHaveBeenCalledWith({
      reason: "await",
      taskId: undefined,
      habitName: undefined,
      awaitName: "hey_export",
    })
  })

  it("checks the default pending directory from the explicit agent argv", async () => {
    vi.resetModules()
    const runPrivateRuntimeTurn = vi.fn(async () => undefined)
    const getInnerDialogPendingDir = vi.fn((agentName: string) => `/pending/${agentName}`)
    const hasPendingMessages = vi.fn(() => false)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "private-runtime-worker.js",
      "--agent",
      "slugger",
    ])
    vi.doMock(runtimeModulePath, () => ({ runPrivateRuntimeTurn }))
    vi.doMock("../../mind/pending", () => ({
      getInnerDialogPendingDir,
      hasPendingMessages,
    }))
    const { createPrivateRuntimeWorker } = await import(workerModulePath) as {
      createPrivateRuntimeWorker: () => {
        run(reason: "instinct", taskId?: string): Promise<void>
      }
    }
    const worker = createPrivateRuntimeWorker()

    try {
      await worker.run("instinct", "manual-check")
    } finally {
      argvSpy.mockRestore()
    }

    expect(getInnerDialogPendingDir).toHaveBeenCalledWith("slugger")
    expect(hasPendingMessages).toHaveBeenCalledWith("/pending/slugger")
  })
})
