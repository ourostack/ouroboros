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
    forceUnexpectedGrounding: false,
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
import { createSanctuaryToolContext, runWithSanctuaryToolReceiptCollection } from "../../senses/sanctuary-runtime"

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
    runtimeMocks.forceUnexpectedGrounding = false
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
    expect(context.sanctuary?.restartContainer).toEqual(expect.any(Function))
    await expect(context.sanctuary?.recoverRoutineActions?.()).resolves.toEqual([])
    for (const key of Object.keys(runtimeMocks.readTools)) expect(context.sanctuary?.[key as keyof typeof runtimeMocks.readTools]).toEqual(expect.any(Function))
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
