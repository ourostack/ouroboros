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
    refreshMachineRuntimeCredentialConfig: vi.fn(),
    loadOrCreateMachineIdentity: vi.fn(() => ({ machineId: "machine-test" })),
    getAgentRoot: vi.fn(),
    unraidClient: vi.fn(function () { return { read: vi.fn() } }),
    createUnraidReadTools: vi.fn(() => readTools),
    createApprovedUnraidRestartExecutor: vi.fn((options: Record<string, unknown>) => {
      state.restartOptions = options
      return restart
    }),
    consumeRoutineActionGrant: vi.fn(() => ({ state: "reserved" })),
    transitionRoutineActionReceipt: vi.fn(() => ({ state: "verified" })),
    recoverRoutineActionReceipts: vi.fn(async () => []),
    inspectSanctuaryPackageManagedBundle: vi.fn(),
    resolveSanctuaryPackageManagedRoots: vi.fn(({ repoRoot, bundlesRoot }: { repoRoot: string; bundlesRoot: string }) => ({
      packageRoot: `${repoRoot}/deploy/unraid/sanctuary.ouro`,
      agentRoot: `${bundlesRoot}/sanctuary.ouro`,
    })),
    getPackageVersion: vi.fn(() => "0.1.0-alpha.798"),
    emitNervesEvent: vi.fn(),
    probeSanctuaryEndpoint: vi.fn(),
    sab: { readQueue: vi.fn(), resumeQueue: vi.fn() },
    createSanctuarySabClient: vi.fn(),
    mediaOptimization: { read: vi.fn() },
    createSanctuaryMediaOptimizationClient: vi.fn(),
    forceUnexpectedGrounding: false,
  }
})

vi.mock("../../heart/identity", () => ({ getAgentRoot: runtimeMocks.getAgentRoot, getRepoRoot: vi.fn(() => "/opt/ouro"), getAgentBundlesRoot: vi.fn(() => "/home/ouro/AgentBundles") }))
vi.mock("../../heart/daemon/sanctuary-bundle-migration", () => ({ inspectSanctuaryPackageManagedBundle: runtimeMocks.inspectSanctuaryPackageManagedBundle }))
vi.mock("../../heart/daemon/sanctuary-package-management", () => ({ resolveSanctuaryPackageManagedRoots: runtimeMocks.resolveSanctuaryPackageManagedRoots }))
vi.mock("../../mind/bundle-manifest", () => ({ getPackageVersion: runtimeMocks.getPackageVersion }))
vi.mock("../../heart/runtime-credentials", () => ({
  readMachineRuntimeCredentialConfig: runtimeMocks.readMachineRuntimeCredentialConfig,
  refreshMachineRuntimeCredentialConfig: runtimeMocks.refreshMachineRuntimeCredentialConfig,
}))
vi.mock("../../heart/machine-identity", () => ({ loadOrCreateMachineIdentity: runtimeMocks.loadOrCreateMachineIdentity }))
vi.mock("../../repertoire/unraid-client", () => ({ UnraidClient: runtimeMocks.unraidClient }))
vi.mock("../../repertoire/tools-unraid", () => ({ createUnraidReadTools: runtimeMocks.createUnraidReadTools }))
vi.mock("../../repertoire/unraid-restart", () => ({
  createApprovedUnraidRestartExecutor: runtimeMocks.createApprovedUnraidRestartExecutor,
}))
vi.mock("../../heart/steward-policy", () => ({
  consumeRoutineActionGrant: runtimeMocks.consumeRoutineActionGrant,
  transitionRoutineActionReceipt: runtimeMocks.transitionRoutineActionReceipt,
  recoverRoutineActionReceipts: runtimeMocks.recoverRoutineActionReceipts,
}))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: runtimeMocks.emitNervesEvent }))
vi.mock("../../senses/sanctuary-health", () => ({
  SANCTUARY_PUBLIC_ENDPOINTS: ["https://media.mendelow.cloud/", "https://books.mendelow.cloud/"],
  probeSanctuaryEndpoint: runtimeMocks.probeSanctuaryEndpoint,
}))
vi.mock("../../senses/sanctuary-sab", () => ({
  sanctuarySabReadUnavailableCode: (error: unknown) => {
    const message = error instanceof Error ? error.message : ""
    return message.includes("credential") ? "credential_unavailable" : message.includes("request") ? "request_unavailable" : message.includes("malformed") ? "malformed_response" : undefined
  },
  createSanctuarySabClient: runtimeMocks.createSanctuarySabClient,
}))
vi.mock("../../senses/sanctuary-media-optimization", () => ({
  createSanctuaryMediaOptimizationClient: runtimeMocks.createSanctuaryMediaOptimizationClient,
}))
vi.mock("../../senses/sanctuary-grounding", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../senses/sanctuary-grounding")>()
  return {
    ...actual,
    projectSanctuaryGrounding: (toolName: string, result: unknown) => runtimeMocks.forceUnexpectedGrounding
      ? { synthetic: true }
      : actual.projectSanctuaryGrounding(toolName, result),
  }
})

import type { UnraidRestartAttempt } from "../../repertoire/unraid-restart"
import { createSanctuaryToolContext, ensureSanctuarySourceRuntimeReady, runWithSanctuaryToolReceiptCollection } from "../../senses/sanctuary-runtime"

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
    sabnzbdApiKey: " synthetic-sab-key ",
    jellyfin: { userId: " bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb ", accessToken: " aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa ", folderIds: " library-a, library-b " },
    ...overrides,
  })
}

describe("Sanctuary runtime tool context", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.state.restartOptions = undefined
    runtimeMocks.consumeRoutineActionGrant.mockReset().mockReturnValue({ state: "reserved" })
    runtimeMocks.transitionRoutineActionReceipt.mockReset().mockReturnValue({ state: "verified" })
    runtimeMocks.recoverRoutineActionReceipts.mockReset().mockResolvedValue([])
    runtimeMocks.inspectSanctuaryPackageManagedBundle.mockReset().mockReturnValue({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.798",
        packagedBundleVersion: "0.1.0-alpha.798",
        liveBundleVersion: "0.1.0-alpha.798",
        parity: "exact",
        mismatchCodes: [],
        journalState: "absent",
        ready: true,
        repair: { actor: "none", action: "none" },
      },
    })
    runtimeMocks.forceUnexpectedGrounding = false
    runtimeMocks.probeSanctuaryEndpoint.mockReset()
    runtimeMocks.sab.readQueue.mockReset()
    runtimeMocks.sab.resumeQueue.mockReset()
    runtimeMocks.createSanctuarySabClient.mockReset().mockReturnValue(runtimeMocks.sab)
    runtimeMocks.mediaOptimization.read.mockReset()
    runtimeMocks.createSanctuaryMediaOptimizationClient.mockReset().mockReturnValue(runtimeMocks.mediaOptimization)
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured())
    runtimeMocks.refreshMachineRuntimeCredentialConfig.mockResolvedValue(configured())
    runtimeMocks.getAgentRoot.mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), "ouro-sanctuary-runtime-")))
  })

  it("reads exact package, packaged-bundle, and live-bundle truth through the shared inspector", async () => {
    const context = createSanctuaryToolContext("sanctuary")

    await expect(context.sanctuary!.getInstallState()).resolves.toEqual({
      ok: true,
      data: {
        runtimePackageVersion: "0.1.0-alpha.798",
        packagedBundleVersion: "0.1.0-alpha.798",
        liveBundleVersion: "0.1.0-alpha.798",
        parity: "exact",
        mismatchCodes: [],
        journalState: "absent",
        ready: true,
        repair: { actor: "none", action: "none" },
      },
    })
    expect(runtimeMocks.inspectSanctuaryPackageManagedBundle).toHaveBeenCalledExactlyOnceWith({
      packageRoot: "/opt/ouro/deploy/unraid/sanctuary.ouro",
      agentRoot: "/home/ouro/AgentBundles/sanctuary.ouro",
      runtimePackageVersion: "0.1.0-alpha.798",
    })
    expect(runtimeMocks.resolveSanctuaryPackageManagedRoots).toHaveBeenCalledExactlyOnceWith({ repoRoot: "/opt/ouro", bundlesRoot: "/home/ouro/AgentBundles" })
  })

  it("passes bounded install inspection failures through without exposing implementation details", async () => {
    const failure = {
      ok: false,
      error: {
        code: "invalid_journal",
        message: "Sanctuary update recovery is required",
        degraded: true,
        repair: { actor: "human-required", action: "run_verified_update_recovery" },
      },
    }
    runtimeMocks.inspectSanctuaryPackageManagedBundle.mockReturnValue(failure)

    await expect(createSanctuaryToolContext("sanctuary").sanctuary!.getInstallState()).resolves.toEqual(failure)
    expect(JSON.stringify(failure)).not.toMatch(/(?:\/opt\/|\/home\/|sha256:|credential|stack)/u)
  })

  it("waits for a missing machine credential refresh before declaring health work ready", async () => {
    let resolveRefresh!: (value: ReturnType<typeof configured>) => void
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce({ ok: false, reason: "missing" })
    runtimeMocks.refreshMachineRuntimeCredentialConfig.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve }))

    const readiness = ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")
    let settled = false
    void readiness.then(() => { settled = true })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(runtimeMocks.refreshMachineRuntimeCredentialConfig).toHaveBeenCalledWith("sanctuary", "machine-test", { preserveCachedOnFailure: true })

    resolveRefresh(configured({ unraidWriteApiKey: undefined, sabnzbdApiKey: undefined }))
    await expect(readiness).resolves.toBeUndefined()
  })

  it("requires SAB only for usenet and keeps write authority action-time gated", async () => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ unraidWriteApiKey: undefined, sabnzbdApiKey: undefined }))

    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")).resolves.toBeUndefined()
    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-usenet")).rejects.toThrow(/human-required.*sabnzbdApiKey/u)
  })

  it("fails closed with redacted actor guidance for incomplete Jellyfin and refresh failure", async () => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce(configured({ jellyfin: undefined }))
    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")).resolves.toBeUndefined()

    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce(configured({ jellyfin: null }))
    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")).rejects.toThrow(/human-required.*jellyfin/u)

    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce(configured({ jellyfin: { userId: "user", accessToken: "secret-token", folderIds: "only-one" } }))
    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")).rejects.toThrow(/human-required.*jellyfin\.folderIds/u)

    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce(configured({ jellyfin: { userId: "user", accessToken: "secret-token" } }))
    await expect(ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health")).rejects.toThrow(/human-required.*jellyfin/u)

    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValueOnce({ ok: false, reason: "missing" })
    runtimeMocks.refreshMachineRuntimeCredentialConfig.mockResolvedValueOnce({ ok: false, reason: "vault locked: secret-token" })
    const error = await ensureSanctuarySourceRuntimeReady("sanctuary", "sanctuary-health").catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/agent-runnable/u)
    expect((error as Error).message).not.toContain("secret-token")
  })

  it("is inactive for non-Sanctuary event sources", async () => {
    await expect(ensureSanctuarySourceRuntimeReady("slugger", "app-store-connect")).resolves.toBeUndefined()
    expect(runtimeMocks.readMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
    expect(runtimeMocks.refreshMachineRuntimeCredentialConfig).not.toHaveBeenCalled()
  })

  it("wires read tools once and reloads the write credential only for an approved restart", async () => {
    const context = createSanctuaryToolContext("slugger")

    expect(context.agentRoot).toBe(runtimeMocks.getAgentRoot.mock.results[0]?.value)
    expect(runtimeMocks.getAgentRoot).toHaveBeenCalledTimes(1)

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
    expect(runtimeMocks.createSanctuaryMediaOptimizationClient).toHaveBeenCalledWith({
      jellyfinUserId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      jellyfinAccessToken: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      jellyfinFolderIds: ["library-a", "library-b"],
    })
    expect(context.sanctuary?.restartContainer).toEqual(expect.any(Function))
    await expect(context.sanctuary?.recoverRoutineActions?.()).resolves.toEqual([])
    for (const key of Object.keys(runtimeMocks.readTools)) expect(context.sanctuary?.[key as keyof typeof runtimeMocks.readTools]).toEqual(expect.any(Function))
    expect(context.sanctuary?.getMediaOptimization).toEqual(expect.any(Function))
    expect(runtimeMocks.readMachineRuntimeCredentialConfig).toHaveBeenCalledTimes(1)

    runtimeMocks.readTools.getSystem.mockResolvedValueOnce({ ok: true, data: { uptime: 10 } })
    await expect(context.sanctuary!.getSystem()).resolves.toEqual({ ok: true, data: { uptime: 10 } })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.sanctuary_read_receipt", meta: expect.objectContaining({ toolName: "unraid_get_system", success: true, resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) }) }))
    const systemFacts = { sourceIdentityDigest: "9".repeat(64), serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 11, degraded: false }
    const projectedSystemFacts = { serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", degraded: false }
    runtimeMocks.readTools.getSystem.mockResolvedValueOnce({ ok: true, data: systemFacts })
    await expect(runWithSanctuaryToolReceiptCollection(() => context.sanctuary!.getSystem())).resolves.toEqual({
      result: { ok: true, data: systemFacts },
      toolResultDigests: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
      toolGroundings: [{ toolName: "unraid_get_system", resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), groundingDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), sourceIdentityDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), observedAt: expect.stringMatching(/^\d{4}-/u), facts: projectedSystemFacts }],
    })
    const rejectedObserver = { toolResultDigests: [] as string[] }
    runtimeMocks.readTools.getSystem.mockResolvedValueOnce({ ok: true, data: { uptime: 12 } })
    await expect(runWithSanctuaryToolReceiptCollection(async () => {
      await context.sanctuary!.getSystem()
      throw new Error("turn failed after tool result")
    }, rejectedObserver)).rejects.toThrow("turn failed after tool result")
    expect(rejectedObserver.toolResultDigests).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/u)])
    runtimeMocks.restart.mockResolvedValueOnce({ ok: true, data: { container: { id: "Docker:a", name: "calibre-web" }, beforeState: "running", afterState: "running", observedRestart: true, degraded: false } })
    await expect(context.sanctuary!.restartContainer({ container: "calibre-web" })).resolves.toMatchObject({ ok: true })
    expect(runtimeMocks.restart).toHaveBeenCalledWith({ container: "calibre-web" })
    const execution = { approval: { approvalId: "approval-1" } } as any
    runtimeMocks.restart.mockResolvedValueOnce({ ok: true, data: { container: { id: "Docker:a", name: "calibre-web" } } })
    await expect(context.sanctuary!.restartContainer({ container: "calibre-web" }, execution)).resolves.toMatchObject({ ok: true })
    expect(runtimeMocks.restart).toHaveBeenLastCalledWith({ container: "calibre-web" }, execution)

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
    const acceptanceScenarioHandleDigest = runtimeMocks.state.restartOptions?.acceptanceScenarioHandleDigest as () => string | undefined
    expect(acceptanceScenarioHandleDigest()).toBeUndefined()
  })

  it("records the combined media optimization read through the existing acceptance seam", async () => {
    runtimeMocks.mediaOptimization.read.mockResolvedValueOnce({ ok: true, data: { degraded: false } })
    const context = createSanctuaryToolContext("slugger")
    await expect(context.sanctuary!.getMediaOptimization()).resolves.toEqual({ ok: true, data: { degraded: false } })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.sanctuary_read_receipt",
      meta: expect.objectContaining({ toolName: "sanctuary_get_media_optimization", success: true }),
    }))
  })

  it("records semantic read failures as failed acceptance receipts without discarding typed evidence", async () => {
    const result = { ok: false, error: { code: "authorization", message: "restricted identity drifted", degraded: true }, data: { unmanic: { version: "test" } } }
    runtimeMocks.mediaOptimization.read.mockResolvedValueOnce(result)
    const context = createSanctuaryToolContext("slugger")
    await expect(context.sanctuary!.getMediaOptimization()).resolves.toEqual(result)
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.sanctuary_read_receipt_error",
      meta: expect.objectContaining({ toolName: "sanctuary_get_media_optimization", success: false, semanticCode: "authorization" }),
    }))
    runtimeMocks.mediaOptimization.read.mockResolvedValueOnce({ ok: false, error: {} })
    await context.sanctuary!.getMediaOptimization()
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ semanticCode: "unknown" }) }))
  })

  it("checks every fixed public service endpoint on demand and records one bounded read receipt", async () => {
    runtimeMocks.probeSanctuaryEndpoint
      .mockResolvedValueOnce({ url: "https://media.mendelow.cloud/", ok: true, status: 200 })
      .mockResolvedValueOnce({ url: "https://books.mendelow.cloud/", ok: false, status: 503 })
    const context = createSanctuaryToolContext("slugger")

    await expect(context.sanctuary!.checkServices()).resolves.toEqual({
      ok: true,
      data: {
        observedAt: expect.stringMatching(/^\d{4}-/u),
        services: [
          { name: "media", url: "https://media.mendelow.cloud/", ok: true, status: 200 },
          { name: "books", url: "https://books.mendelow.cloud/", ok: false, status: 503 },
        ],
        degraded: true,
      },
    })
    expect(runtimeMocks.probeSanctuaryEndpoint).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.sanctuary_read_receipt",
      meta: expect.objectContaining({ toolName: "unraid_check_services", success: true }),
    }))
  })

  it("reads and approval-resumes the download queue through one cached SAB client", async () => {
    runtimeMocks.sab.readQueue.mockResolvedValueOnce({ paused: true, queuedJobs: 2 })
    runtimeMocks.sab.resumeQueue.mockResolvedValueOnce({ changed: true, verified: true, receiptDigest: "a".repeat(64) })
    const context = createSanctuaryToolContext("slugger")
    const loadApiKey = runtimeMocks.createSanctuarySabClient.mock.calls[0]?.[0].loadApiKey as () => Promise<string>
    await expect(loadApiKey()).resolves.toBe("synthetic-sab-key")
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ sabnzbdApiKey: " rotated-sab-key " }))
    await expect(loadApiKey()).resolves.toBe("rotated-sab-key")
    await expect(context.sanctuary!.getDownloadQueue()).resolves.toEqual({ paused: true, queuedJobs: 2 })
    await expect(context.sanctuary!.resumeDownloadQueue()).resolves.toMatchObject({ ok: true, data: { changed: true, verified: true } })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.sanctuary_download_resume_receipt", meta: expect.objectContaining({ changed: true, verified: true, receiptDigest: "a".repeat(64) }) }))
    runtimeMocks.sab.resumeQueue.mockRejectedValueOnce("private failure")
    await expect(context.sanctuary!.resumeDownloadQueue()).rejects.toBe("private failure")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.sanctuary_download_resume_error", meta: { category: "unknown" } }))
    runtimeMocks.sab.resumeQueue.mockRejectedValueOnce(new TypeError("typed failure"))
    await expect(context.sanctuary!.resumeDownloadQueue()).rejects.toThrow("typed failure")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.sanctuary_download_resume_error", meta: { category: "TypeError" } }))
  })

  it("returns current typed unavailability only for the read-only queue tool while resume stays fail-closed", async () => {
    runtimeMocks.sab.readQueue.mockRejectedValueOnce(new Error("SAB queue verification credential is unavailable"))
    runtimeMocks.sab.resumeQueue.mockRejectedValueOnce(new Error("SAB queue verification credential is unavailable"))
    const context = createSanctuaryToolContext("slugger")

    await expect(context.sanctuary!.getDownloadQueue()).resolves.toEqual({
      ok: false,
      error: { code: "credential_unavailable" },
      observedAt: expect.stringMatching(/^\d{4}-/u),
    })
    await expect(context.sanctuary!.resumeDownloadQueue()).rejects.toThrow("credential is unavailable")
    for (const [message, code] of [["SAB queue request failed", "request_unavailable"], ["SAB queue response is malformed", "malformed_response"]]) {
      runtimeMocks.sab.readQueue.mockRejectedValueOnce(new Error(message))
      await expect(context.sanctuary!.getDownloadQueue()).resolves.toMatchObject({ ok: false, error: { code } })
    }
    runtimeMocks.sab.readQueue.mockRejectedValueOnce(new Error("unexpected programming failure"))
    await expect(context.sanctuary!.getDownloadQueue()).rejects.toThrow("unexpected programming failure")
  })

  it("routes routine-action reservation, transition, and recovery observations through the canonical policy seams", async () => {
    const context = createSanctuaryToolContext("slugger")
    const agentRoot = runtimeMocks.getAgentRoot()
    const reserveRoutineAction = runtimeMocks.state.restartOptions?.reserveRoutineAction as (input: Record<string, unknown>) => unknown
    const transitionRoutineAction = runtimeMocks.state.restartOptions?.transitionRoutineAction as (input: Record<string, unknown>) => unknown
    expect(reserveRoutineAction({ key: "restart:books" })).toEqual({ state: "reserved" })
    expect(transitionRoutineAction({ id: "receipt-1" })).toEqual({ state: "verified" })
    expect(runtimeMocks.consumeRoutineActionGrant).toHaveBeenCalledWith(agentRoot, { key: "restart:books" })
    expect(runtimeMocks.transitionRoutineActionReceipt).toHaveBeenCalledWith(agentRoot, { id: "receipt-1" })

    const target = { id: "Docker:books", name: "books" }
    const observe = async (containers: unknown) => {
      runtimeMocks.readTools.listContainers.mockResolvedValueOnce(containers)
      runtimeMocks.recoverRoutineActionReceipts.mockImplementationOnce(async (_root: string, options: any) => [await options.observeTarget(target)])
      return context.sanctuary!.recoverRoutineActions!()
    }
    await expect(observe({ ok: false, error: { message: "inventory unavailable" } })).rejects.toThrow("inventory unavailable")
    await expect(observe({ ok: true, data: { containers: [
      { id: "Docker:other", name: "books", state: "running" },
      { id: "Docker:books", name: "other", state: "running" },
    ] } })).resolves.toEqual([{ ...target, state: "unknown" }])
    await expect(observe({ ok: true, data: { containers: [
      { ...target, state: "running" },
      { ...target, state: "exited" },
    ] } })).resolves.toEqual([{ ...target, state: "unknown" }])
    await expect(observe({ ok: true, data: { containers: [{ ...target, state: "running" }] } })).resolves.toEqual([{ ...target, state: "running" }])
  })

  it("records a sanitized unknown category when a read rejects with a non-Error", async () => {
    const context = createSanctuaryToolContext("slugger")
    runtimeMocks.readTools.getSystem.mockRejectedValueOnce("private-string-failure")

    await expect(context.sanctuary!.getSystem()).rejects.toBe("private-string-failure")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.sanctuary_read_receipt_error",
      meta: expect.objectContaining({ toolName: "unraid_get_system", success: false, category: "unknown" }),
    }))
    expect(JSON.stringify(runtimeMocks.emitNervesEvent.mock.calls)).not.toContain("private-string-failure")
  })

  it("fails grounded reads with an invalid source identity and omits grounding for non-grounded tools", async () => {
    const context = createSanctuaryToolContext("slugger")
    runtimeMocks.readTools.getSystem.mockResolvedValueOnce({ ok: true, data: {
      sourceIdentityDigest: "invalid", serverName: "Sanctuary", unraidVersion: "7.2.3", apiVersion: "4.37.1", arrayState: "STARTED", uptimeSeconds: 11, degraded: false,
    } })
    await expect(context.sanctuary!.getSystem()).rejects.toThrow("source identity is invalid")

    runtimeMocks.readTools.getDisks.mockResolvedValueOnce({ ok: true, data: { disks: [], parity: {}, truncated: false } })
    await expect(runWithSanctuaryToolReceiptCollection(() => context.sanctuary!.getDisks())).resolves.toEqual({
      result: { ok: true, data: { disks: [], parity: {}, truncated: false } },
      toolResultDigests: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
    })

    runtimeMocks.forceUnexpectedGrounding = true
    runtimeMocks.readTools.getDisks.mockResolvedValueOnce({ ok: true, data: { sourceIdentityDigest: "9".repeat(64) } })
    await expect(runWithSanctuaryToolReceiptCollection(() => context.sanctuary!.getDisks())).resolves.toEqual({
      result: { ok: true, data: { sourceIdentityDigest: "9".repeat(64) } },
      toolResultDigests: [expect.stringMatching(/^[0-9a-f]{64}$/u)],
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

  it.each(["one", "same,same", "one,two,three"])("rejects a non-exact Jellyfin folder list (%s)", (folderIds) => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ jellyfin: { userId: "b".repeat(32), accessToken: "a".repeat(32), folderIds } }))
    expect(() => createSanctuaryToolContext("slugger")).toThrow("Sanctuary folderIds must contain exactly two unique IDs")
  })

  it("keeps Sanctuary startup and Unmanic evidence available when optional Jellyfin config is absent", async () => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ jellyfin: undefined }))
    runtimeMocks.createSanctuaryMediaOptimizationClient.mockReturnValueOnce(runtimeMocks.mediaOptimization)
    runtimeMocks.mediaOptimization.read.mockResolvedValueOnce({ ok: false, data: { unmanic: { version: "test" }, inventory: { available: false } } })
    const context = createSanctuaryToolContext("slugger")
    expect(runtimeMocks.createSanctuaryMediaOptimizationClient).toHaveBeenCalledWith({})
    await expect(context.sanctuary!.getMediaOptimization()).resolves.toMatchObject({ data: { unmanic: { version: "test" }, inventory: { available: false } } })
  })

  it.each([null, "bad", [], {}])("fails closed for malformed present Jellyfin config (%j)", (jellyfin) => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ jellyfin }))
    expect(() => createSanctuaryToolContext("slugger")).toThrow()
  })

  it.each([
    ["userId", undefined], ["userId", "   "], ["accessToken", undefined], ["accessToken", "   "], ["folderIds", undefined], ["folderIds", "   "],
  ])("fails closed for missing present Jellyfin field %s (%j)", (field, value) => {
    runtimeMocks.readMachineRuntimeCredentialConfig.mockReturnValue(configured({ jellyfin: { userId: "b".repeat(32), accessToken: "a".repeat(32), folderIds: "library-a,library-b", [field]: value } }))
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
      actionDigest: "a".repeat(64),
      argumentDigest: "b".repeat(64),
      attemptId: "attempt-1",
      mutationAcknowledged: false,
      afterState: null,
    }

    await persistAttempt(attempt)

    const approvalDir = path.join(agentRoot, "state", "approvals")
    const receiptPath = path.join(approvalDir, "unraid-restart-attempt.json")
    expect(fs.readFileSync(receiptPath, "utf8")).toBe(`${JSON.stringify(attempt)}\n`)
    expect(fs.statSync(receiptPath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(approvalDir)).toEqual(["unraid-restart-attempt.json"])
    expect(runtimeMocks.getAgentRoot).toHaveBeenCalledWith("slugger")
  })

  it("serializes and bounds scenario restart ledger appends", async () => {
    const agentRoot = runtimeMocks.getAgentRoot()
    createSanctuaryToolContext("slugger")
    const persistAttempt = runtimeMocks.state.restartOptions?.persistAttempt as (attempt: UnraidRestartAttempt) => Promise<void>
    const ledgerPath = path.join(agentRoot, "state", "acceptance", "restart-attempts.ndjson")
    const attempt = (attemptId: string): UnraidRestartAttempt => ({
      state: "attempting", container: { id: `docker:${attemptId}`, name: "calibre-web" }, beforeState: "running",
      observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64),
      scenarioHandleDigest: "c".repeat(64), approvalId: "approval-1", attemptId, mutationAcknowledged: false, afterState: null,
    })
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.writeFileSync(ledgerPath, Array.from({ length: 499 }, (_, index) => JSON.stringify(attempt(`seed-${index}`))).join("\n") + "\n")

    await Promise.all([persistAttempt(attempt("one")), persistAttempt(attempt("two")), persistAttempt(attempt("three"))])

    const lines = fs.readFileSync(ledgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toHaveLength(500)
    expect(lines.slice(-3).map((entry) => entry.attemptId)).toEqual(["one", "two", "three"])
    expect(fs.statSync(ledgerPath).mode & 0o777).toBe(0o600)
    expect(fs.readdirSync(path.dirname(ledgerPath))).toEqual(["restart-attempts.ndjson"])
  })

  it("rejects corrupt restart rows and recovers the per-path append chain", async () => {
    const agentRoot = runtimeMocks.getAgentRoot()
    createSanctuaryToolContext("slugger")
    const persistAttempt = runtimeMocks.state.restartOptions?.persistAttempt as (attempt: UnraidRestartAttempt) => Promise<void>
    const ledgerPath = path.join(agentRoot, "state", "acceptance", "restart-attempts.ndjson")
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.writeFileSync(ledgerPath, "{\"invalid\":true}\n")
    const valid: UnraidRestartAttempt = { state: "attempting", container: { id: "docker:a", name: "calibre-web" }, beforeState: "running", observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64), scenarioHandleDigest: "c".repeat(64), approvalId: "approval-1", attemptId: "attempt-1", mutationAcknowledged: false, afterState: null }
    const first = persistAttempt(valid)
    const queued = persistAttempt({ ...valid, attemptId: "attempt-queued" })
    await expect(first).rejects.toThrow("corrupt")
    await expect(queued).rejects.toThrow("corrupt")
    fs.writeFileSync(ledgerPath, "")
    await expect(persistAttempt(valid)).resolves.toBeUndefined()
    expect(JSON.parse(fs.readFileSync(ledgerPath, "utf8"))).toMatchObject({ attemptId: "attempt-1" })
  })

  it("creates a missing scenario ledger through the canonical ENOENT path", async () => {
    const agentRoot = runtimeMocks.getAgentRoot()
    createSanctuaryToolContext("slugger")
    const persist = runtimeMocks.state.restartOptions?.persistAttempt as (attempt: UnraidRestartAttempt) => Promise<void>
    const attempt: UnraidRestartAttempt = { state: "attempting", container: { id: "docker:a", name: "calibre-web" }, beforeState: "running", observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64), scenarioHandleDigest: "c".repeat(64), approvalId: "approval-1", attemptId: "attempt-1", mutationAcknowledged: false, afterState: null }

    await expect(persist(attempt)).resolves.toBeUndefined()
    expect(fs.existsSync(path.join(agentRoot, "state", "acceptance", "restart-attempts.ndjson"))).toBe(true)
  })

  it.each([
    ["oversized file", "x".repeat(4 * 1024 * 1024 + 1)],
    ["too many rows", Array.from({ length: 501 }, () => "{}").join("\n") + "\n"],
    ["oversized row", `${JSON.stringify({ padding: "x".repeat(8 * 1024) })}\n`],
    ["invalid after-state type", `${JSON.stringify({ state: "attempting", container: { id: "docker:a", name: "calibre-web" }, observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64), scenarioHandleDigest: "c".repeat(64), approvalId: "approval-1", attemptId: "attempt-1", mutationAcknowledged: false, afterState: 1 })}\n`],
    ["overlong after-state", `${JSON.stringify({ state: "attempting", container: { id: "docker:a", name: "calibre-web" }, observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64), scenarioHandleDigest: "c".repeat(64), approvalId: "approval-1", attemptId: "attempt-1", mutationAcknowledged: false, afterState: "x".repeat(65) })}\n`],
  ])("rejects a bounded-ledger violation: %s", async (_label, content) => {
    const agentRoot = runtimeMocks.getAgentRoot()
    createSanctuaryToolContext("slugger")
    const persist = runtimeMocks.state.restartOptions?.persistAttempt as (attempt: UnraidRestartAttempt) => Promise<void>
    const ledgerPath = path.join(agentRoot, "state", "acceptance", "restart-attempts.ndjson")
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true })
    fs.writeFileSync(ledgerPath, content)
    const attempt: UnraidRestartAttempt = { state: "attempting", container: { id: "docker:b", name: "calibre-web" }, beforeState: "running", observedAt: "2026-08-20T00:00:00.000Z", actionDigest: "a".repeat(64), argumentDigest: "b".repeat(64), scenarioHandleDigest: "c".repeat(64), approvalId: "approval-2", attemptId: "attempt-2", mutationAcknowledged: false, afterState: null }

    await expect(persist(attempt)).rejects.toThrow("corrupt")
  })
})
