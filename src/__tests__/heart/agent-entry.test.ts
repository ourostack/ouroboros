import { afterEach, describe, expect, it, vi } from "vitest"

function runtimeCredentialMock(overrides: Record<string, unknown> = {}) {
  return {
    applyRuntimeCredentialBootstrapMessage: vi.fn(() => false),
    waitForRuntimeCredentialBootstrap: vi.fn(async () => false),
    readRuntimeCredentialConfig: vi.fn(() => ({ ok: false, reason: "missing" })),
    readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    refreshRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    refreshMachineRuntimeCredentialConfig: vi.fn(async () => ({ ok: false, reason: "missing" })),
    ...overrides,
  }
}

function providerCredentialPool() {
  return {
    ok: true,
    poolPath: "vault:slugger:providers/*",
    pool: {
      schemaVersion: 1,
      updatedAt: "2026-07-07T00:00:00.000Z",
      providers: {
        minimax: {
          provider: "minimax",
          revision: "vault_test",
          updatedAt: "2026-07-07T00:00:00.000Z",
          credentials: { apiKey: "test-key" },
          config: {},
          provenance: { source: "manual", updatedAt: "2026-07-07T00:00:00.000Z" },
        },
      },
    },
  }
}

function providerCredentialMock(overrides: Record<string, unknown> = {}) {
  return {
    readProviderCredentialPool: vi.fn(() => providerCredentialPool()),
    refreshProviderCredentialPool: vi.fn(async () => providerCredentialPool()),
    ...overrides,
  }
}

function mockProviderCredentialModule(overrides: Record<string, unknown> = {}) {
  const module = providerCredentialMock(overrides)
  vi.doMock("../../heart/provider-credentials", () => module)
  return module
}

function createWorkerControllerMock() {
  return {
    run: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }
}

function mockWorkerModules(
  startPrivateRuntimeWorker = vi.fn(async () => createWorkerControllerMock()),
  options: { mockProviderCredentials?: boolean } = {},
) {
  const startLegacyWorker = vi.fn(async () => undefined)
  vi.doMock("../../senses/private-runtime-worker", () => ({ startPrivateRuntimeWorker }))
  vi.doMock("../../senses/inner-dialog-worker", () => ({ startInnerDialogWorker: startLegacyWorker }))
  if (options.mockProviderCredentials !== false) mockProviderCredentialModule()
  return { startPrivateRuntimeWorker, startLegacyWorker }
}

describe("agent entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("starts the canonical private-runtime worker instead of the legacy worker shim", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("starts unified agent runtime when --agent is present", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    expect(configureCliRuntimeLogger).toHaveBeenCalledWith("self")
    await vi.waitFor(() => {
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("continues startup when runtime config refresh is unavailable", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => {
      throw new Error("vault locked")
    })
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("starts unified agent runtime without waiting for runtime config refresh", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(() => new Promise(() => undefined))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      refreshRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(refreshRuntimeCredentialConfig).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    argvSpy.mockRestore()
  })

  it("accepts daemon runtime bootstrap before starting work", async () => {
    vi.resetModules()

    const { startPrivateRuntimeWorker, startLegacyWorker } = mockWorkerModules()
    const configureCliRuntimeLogger = vi.fn()
    const refreshRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    const refreshMachineRuntimeCredentialConfig = vi.fn(async () => ({ ok: false, reason: "missing" }))
    const waitForRuntimeCredentialBootstrap = vi.fn(async () => true)
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      waitForRuntimeCredentialBootstrap,
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      refreshRuntimeCredentialConfig,
      refreshMachineRuntimeCredentialConfig,
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")

    await vi.waitFor(() => {
      expect(waitForRuntimeCredentialBootstrap).toHaveBeenCalledWith("slugger")
      expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      expect(startLegacyWorker).not.toHaveBeenCalled()
    })
    expect(refreshRuntimeCredentialConfig).not.toHaveBeenCalled()
    expect(refreshMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
    argvSpy.mockRestore()
  })

  it("buffers work messages that arrive while credential bootstrap is still pending", async () => {
    vi.resetModules()

    ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("ouro.agentEntry.ipcState")] = {
      bufferedRuntimeCredentialMessages: [],
      bufferedMessages: [],
      installed: false,
      workerMessageHandler: null,
    }
    let messageHandler: ((message: unknown) => void) | undefined
    const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") messageHandler = handler
      return process
    }) as never)
    const controller = createWorkerControllerMock()
    let resolveWorkerStart!: (value: typeof controller) => void
    const workerStart = new Promise<typeof controller>((resolve) => {
      resolveWorkerStart = resolve
    })
    const startPrivateRuntimeWorker = vi.fn(() => workerStart)
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    let resolveBootstrap!: (value: boolean) => void
    const waitForRuntimeCredentialBootstrap = vi.fn(() => new Promise<boolean>((resolve) => {
      resolveBootstrap = resolve
    }))
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      waitForRuntimeCredentialBootstrap,
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    try {
      await import("../../heart/agent-entry")

      await vi.waitFor(() => {
        expect(waitForRuntimeCredentialBootstrap).toHaveBeenCalledWith("slugger")
      })
      expect(messageHandler).toEqual(expect.any(Function))
      messageHandler?.({
        type: "ouro.runtimeCredentialBootstrap",
        agentName: "slugger",
        runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
      })
      messageHandler?.([])
      messageHandler?.({ type: "poke", taskId: "testflight-feedback" })
      resolveBootstrap(true)

      await vi.waitFor(() => {
        expect(startPrivateRuntimeWorker).toHaveBeenCalledWith({
          attachProcessListeners: false,
          bufferedMessages: [{ type: "poke", taskId: "testflight-feedback" }],
        })
      })

      messageHandler?.({ type: "message" })
      resolveWorkerStart(controller)
      await vi.waitFor(() => {
        expect(controller.handleMessage).toHaveBeenCalledWith({ type: "message" })
      })

      messageHandler?.({ type: "chat" })
      await vi.waitFor(() => {
        expect(controller.handleMessage).toHaveBeenCalledWith({ type: "chat" })
      })
    } finally {
      argvSpy.mockRestore()
      processOnSpy.mockRestore()
    }
  })

  it("applies credential bootstrap that arrives before the credential waiter attaches", async () => {
    vi.resetModules()

    const bootstrapMessage = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "slugger@ouro.bot" } },
      providerCredentialRecords: [{
        provider: "minimax",
        revision: "vault_test",
        updatedAt: "2026-07-07T00:00:00.000Z",
        credentials: { apiKey: "test-key" },
        config: {},
        provenance: { source: "manual", updatedAt: "2026-07-07T00:00:00.000Z" },
      }],
    }
    const otherAgentBootstrapMessage = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "fresh-agent",
      runtimeConfig: { mailroom: { mailboxAddress: "fresh-agent@ouro.bot" } },
    }
    const staleBootstrapMessage = {
      type: "ouro.runtimeCredentialBootstrap",
      agentName: "slugger",
      runtimeConfig: { mailroom: { mailboxAddress: "stale@ouro.bot" } },
    }
    const workMessage = { type: "poke", taskId: "testflight-feedback" }
    ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("ouro.agentEntry.ipcState")] = {
      bufferedRuntimeCredentialMessages: [],
      bufferedMessages: [],
      installed: false,
      workerMessageHandler: null,
    }
    const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") {
        handler(otherAgentBootstrapMessage)
        handler(bootstrapMessage)
        handler(staleBootstrapMessage)
        handler(workMessage)
      }
      return process
    }) as never)
    const controller = createWorkerControllerMock()
    const startPrivateRuntimeWorker = vi.fn(async () => controller)
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    const applyRuntimeCredentialBootstrapMessage = vi.fn((message: unknown) => message === bootstrapMessage)
    const waitForRuntimeCredentialBootstrap = vi.fn(async () => false)
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      applyRuntimeCredentialBootstrapMessage,
      waitForRuntimeCredentialBootstrap,
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    try {
      await import("../../heart/agent-entry")

      await vi.waitFor(() => {
        expect(applyRuntimeCredentialBootstrapMessage).toHaveBeenCalledWith(bootstrapMessage)
        expect(applyRuntimeCredentialBootstrapMessage).toHaveBeenCalledWith(staleBootstrapMessage)
        expect(applyRuntimeCredentialBootstrapMessage).not.toHaveBeenCalledWith(otherAgentBootstrapMessage)
        expect(waitForRuntimeCredentialBootstrap).not.toHaveBeenCalled()
        expect(startPrivateRuntimeWorker).toHaveBeenCalledWith({
          attachProcessListeners: false,
          bufferedMessages: [workMessage],
        })
      })
    } finally {
      argvSpy.mockRestore()
      processOnSpy.mockRestore()
    }
  })

  it("waits for provider credentials before flushing buffered private-runtime work", async () => {
    vi.resetModules()

    ;(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("ouro.agentEntry.ipcState")] = {
      bufferedRuntimeCredentialMessages: [],
      bufferedMessages: [],
      installed: false,
      workerMessageHandler: null,
    }
    let messageHandler: ((message: unknown) => void) | undefined
    const processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      if (event === "message") messageHandler = handler
      return process
    }) as never)
    const controller = createWorkerControllerMock()
    const startPrivateRuntimeWorker = vi.fn(async () => controller)
    mockWorkerModules(startPrivateRuntimeWorker, { mockProviderCredentials: false })
    const configureCliRuntimeLogger = vi.fn()
    let resolveProviderRefresh!: (value: ReturnType<typeof providerCredentialPool>) => void
    const providerRefresh = new Promise<ReturnType<typeof providerCredentialPool>>((resolve) => {
      resolveProviderRefresh = resolve
    })
    const readProviderCredentialPool = vi.fn(() => ({
      ok: false,
      reason: "missing",
      poolPath: "vault:slugger:providers/*",
      error: "provider credentials have not been loaded from vault",
    }))
    const refreshProviderCredentialPool = vi.fn(() => providerRefresh)
    mockProviderCredentialModule({
      readProviderCredentialPool,
      refreshProviderCredentialPool,
    })
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    try {
      await import("../../heart/agent-entry")

      await vi.waitFor(() => {
        expect(refreshProviderCredentialPool).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
      })
      messageHandler?.({ type: "poke", taskId: "testflight-feedback" })
      expect(startPrivateRuntimeWorker).not.toHaveBeenCalled()

      resolveProviderRefresh(providerCredentialPool())

      await vi.waitFor(() => {
        expect(startPrivateRuntimeWorker).toHaveBeenCalledWith({
          attachProcessListeners: false,
          bufferedMessages: [{ type: "poke", taskId: "testflight-feedback" }],
        })
      })
    } finally {
      argvSpy.mockRestore()
      processOnSpy.mockRestore()
    }
  })

  it("continues startup when provider credential refresh is unavailable", async () => {
    vi.resetModules()

    const controller = createWorkerControllerMock()
    const startPrivateRuntimeWorker = vi.fn(async () => controller)
    mockWorkerModules(startPrivateRuntimeWorker, { mockProviderCredentials: false })
    const configureCliRuntimeLogger = vi.fn()
    const refreshProviderCredentialPool = vi.fn(async () => {
      throw new Error("vault locked")
    })
    mockProviderCredentialModule({
      readProviderCredentialPool: vi.fn(() => ({
        ok: false,
        reason: "unavailable",
        poolPath: "vault:slugger:providers/*",
        error: "vault locked",
      })),
      refreshProviderCredentialPool,
    })
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock({
      readRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/config", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
      readMachineRuntimeCredentialConfig: vi.fn(() => ({ ok: true, itemPath: "runtime/machine", config: {}, revision: "rev", updatedAt: "2026-05-08T00:00:00.000Z" })),
    }))

    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    try {
      await import("../../heart/agent-entry")

      await vi.waitFor(() => {
        expect(refreshProviderCredentialPool).toHaveBeenCalledWith("slugger", { preserveCachedOnFailure: true })
        expect(startPrivateRuntimeWorker).toHaveBeenCalledTimes(1)
      })
    } finally {
      argvSpy.mockRestore()
    }
  })

  it("fails fast when --agent is missing", async () => {
    vi.resetModules()

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue(["node", "agent-entry.js"])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(1)
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Missing required --agent"),
      )
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("prints worker startup errors and exits", async () => {
    vi.resetModules()

    const startPrivateRuntimeWorker = vi.fn(async () => {
      throw new Error("worker failed")
    })
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("worker failed")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })

  it("stringifies non-Error worker startup failures", async () => {
    vi.resetModules()

    const startPrivateRuntimeWorker = vi.fn(async () => {
      throw "worker string failure"
    })
    mockWorkerModules(startPrivateRuntimeWorker)
    const configureCliRuntimeLogger = vi.fn()
    vi.doMock("../../nerves/cli-logging", () => ({ configureCliRuntimeLogger }))
    vi.doMock("../../heart/runtime-credentials", () => runtimeCredentialMock())

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    const argvSpy = vi.spyOn(process, "argv", "get").mockReturnValue([
      "node",
      "agent-entry.js",
      "--agent",
      "slugger",
    ])

    await import("../../heart/agent-entry")
    await vi.waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith("worker string failure")
      expect(exitSpy).toHaveBeenCalledWith(1)
    })

    argvSpy.mockRestore()
    exitSpy.mockRestore()
    consoleError.mockRestore()
  })
})
