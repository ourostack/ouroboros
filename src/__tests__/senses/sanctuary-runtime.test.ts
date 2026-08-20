import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const runtimeMocks = vi.hoisted(() => {
  const readTools = {
    listContainers: vi.fn(),
    getContainerLogs: vi.fn(),
    getStorage: vi.fn(),
    getDisks: vi.fn(),
    getNotifications: vi.fn(),
    getSystem: vi.fn(),
  }
  const restart = vi.fn()
  const state: { restartOptions?: Record<string, unknown> } = {}
  return {
    readTools,
    restart,
    state,
    readMachineRuntimeCredentialConfig: vi.fn(),
    getAgentRoot: vi.fn(),
    unraidClient: vi.fn(function () { return { read: vi.fn() } }),
    createUnraidReadTools: vi.fn(() => readTools),
    createApprovedUnraidRestartExecutor: vi.fn((options: Record<string, unknown>) => {
      state.restartOptions = options
      return restart
    }),
    emitNervesEvent: vi.fn(),
  }
})

vi.mock("../../heart/identity", () => ({ getAgentRoot: runtimeMocks.getAgentRoot }))
vi.mock("../../heart/runtime-credentials", () => ({
  readMachineRuntimeCredentialConfig: runtimeMocks.readMachineRuntimeCredentialConfig,
}))
vi.mock("../../repertoire/unraid-client", () => ({ UnraidClient: runtimeMocks.unraidClient }))
vi.mock("../../repertoire/tools-unraid", () => ({ createUnraidReadTools: runtimeMocks.createUnraidReadTools }))
vi.mock("../../repertoire/unraid-restart", () => ({
  createApprovedUnraidRestartExecutor: runtimeMocks.createApprovedUnraidRestartExecutor,
}))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: runtimeMocks.emitNervesEvent }))

import type { UnraidRestartAttempt } from "../../repertoire/unraid-restart"
import { createSanctuaryToolContext } from "../../senses/sanctuary-runtime"

function availableConfig(config: Record<string, unknown>) {
  return {
    ok: true as const,
    itemPath: "vault:slugger:runtime/machines/test/config",
    config,
    revision: "runtime_test",
    updatedAt: "2026-08-20T00:00:00.000Z",
  }
}

function configured(overrides: Record<string, unknown> = {}) {
  return availableConfig({
    unraidGraphqlUrl: " https://sanctuary.invalid/graphql ",
    unraidReadApiKey: " synthetic-read-key ",
    unraidWriteApiKey: " synthetic-write-key ",
    ...overrides,
  })
}

describe("Sanctuary runtime tool context", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.state.restartOptions = undefined
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured())
    runtimeMocks.getAgentRoot.mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-sanctuary-runtime-")))
  })

  it("wires read tools once and reloads the write credential only for an approved restart", async () => {
    const context = createSanctuaryToolContext("slugger")

    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith({
      component: "senses",
      event: "senses.sanctuary_runtime_create",
      message: "creating typed Sanctuary tool context",
      meta: { agentName: "slugger" },
    })
    expect(runtimeMocks.unraidClient).toHaveBeenCalledWith({
      endpoint: "https://sanctuary.invalid/graphql",
      apiKey: "synthetic-read-key",
    })
    expect(runtimeMocks.createUnraidReadTools).toHaveBeenCalledOnce()
    expect(context.sanctuary).toMatchObject({ restartContainer: runtimeMocks.restart })
    for (const key of Object.keys(runtimeMocks.readTools)) expect(context.sanctuary?.[key as keyof typeof runtimeMocks.readTools]).toEqual(expect.any(Function))
    expect(runtimeMocks.readMachineRuntimeCredentialConfig).toHaveBeenCalledTimes(1)

    runtimeMocks.readTools.getSystem.mockResolvedValueOnce({ ok: true, data: { uptime: 10 } })
    await expect(context.sanctuary!.getSystem()).resolves.toEqual({ ok: true, data: { uptime: 10 } })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.sanctuary_read_receipt", meta: expect.objectContaining({ toolName: "unraid_get_system", success: true, resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) }) }))

    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({
      unraidWriteApiKey: " rotated-synthetic-write-key ",
    }))
    const loadWriteApiKey = runtimeMocks.state.restartOptions?.loadWriteApiKey as () => Promise<string>
    await expect(loadWriteApiKey()).resolves.toBe("rotated-synthetic-write-key")
    expect(runtimeMocks.readMachineRuntimeCredentialConfig).toHaveBeenNthCalledWith(2, "slugger")
    expect(runtimeMocks.state.restartOptions).toMatchObject({
      endpoint: "https://sanctuary.invalid/graphql",
      listContainers: runtimeMocks.readTools.listContainers,
    })
  })

  it.each(["missing", "unavailable", "invalid"] as const)("fails closed when machine config is %s", (reason) => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue({
      ok: false,
      reason,
      itemPath: "vault:slugger:runtime/machines/test/config",
      error: "synthetic failure",
    })

    expect(() => createSanctuaryToolContext("slugger")).toThrow(`Sanctuary machine runtime config is ${reason}`)
    expect(runtimeMocks.unraidClient).not.toHaveBeenCalled()
  })

  it.each([
    ["unraidGraphqlUrl", undefined],
    ["unraidGraphqlUrl", "   "],
    ["unraidReadApiKey", undefined],
    ["unraidReadApiKey", "   "],
  ])("rejects a missing or blank initial %s value", (field, value) => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ [field]: value }))

    expect(() => createSanctuaryToolContext("slugger")).toThrow(`Sanctuary ${field} is missing`)
  })

  it.each([undefined, "   "])("rejects a missing or blank lazy write credential (%j)", async (value) => {
    createSanctuaryToolContext("slugger")
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ unraidWriteApiKey: value }))
    const loadWriteApiKey = runtimeMocks.state.restartOptions?.loadWriteApiKey as () => Promise<string>

    await expect(loadWriteApiKey()).rejects.toThrow("Sanctuary unraidWriteApiKey is missing")
  })

  it("atomically persists content-free restart attempts with owner-only permissions", async () => {
    const agentRoot = runtimeMocks.getAgentRoot()
    runtimeMocks.getAgentRoot.mockReturnValue(agentRoot)
    createSanctuaryToolContext("slugger")
    const persistAttempt = runtimeMocks.state.restartOptions?.persistAttempt as (attempt: UnraidRestartAttempt) => void
    const attempt: UnraidRestartAttempt = {
      state: "attempting",
      container: { id: "docker:plex", name: "plex" },
      beforeState: "exited",
      observedAt: "2026-08-20T00:00:00.000Z",
    }

    await persistAttempt(attempt)

    const approvalDir = path.join(agentRoot, "state", "approvals")
    const receiptPath = path.join(approvalDir, "unraid-restart-attempt.json")
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(`${JSON.stringify(attempt)}\n`)
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(approvalDir)).toEqual(["unraid-restart-attempt.json"])
    expect(runtimeMocks.getAgentRoot).toHaveBeenCalledWith("slugger")
  })
})
