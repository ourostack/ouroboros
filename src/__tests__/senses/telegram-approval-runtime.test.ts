import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"

const runtimeMocks = vi.hoisted(() => {
  const store = {
    bindPrompt: vi.fn(),
    claimContinuation: vi.fn(),
    close: vi.fn(),
    completeContinuation: vi.fn(),
    expire: vi.fn(),
    markContinuationAttempted: vi.fn(),
    markContinuationMaterialized: vi.fn(),
    read: vi.fn(),
    abandonPromptBinding: vi.fn(),
    migrateTelegramIdentity: vi.fn(),
    listTelegramIdentitySubjects: vi.fn(),
  }
  const checkpoints = { read: vi.fn() }
  const tokenState = { value: undefined as string | undefined }
  const tokens = {
    get: vi.fn(() => tokenState.value),
    remove: vi.fn(() => { tokenState.value = undefined }),
  }
  const transport = {
    handleUpdate: vi.fn(),
    listPendingDeliveries: vi.fn(),
    reconcileExpired: vi.fn(),
    sendApproval: vi.fn(),
    terminalizeOrphaned: vi.fn(),
    terminalizeRecovered: vi.fn(),
  }
  return {
    store,
    checkpoints,
    tokenState,
    tokens,
    transport,
    openApprovalStore: vi.fn(() => store),
    commitApprovalProposal: vi.fn(),
    executeApprovalDecision: vi.fn(),
    recoverAttemptedApproval: vi.fn(),
    recoverClaimedApproval: vi.fn(),
    resumeApprovalContinuation: vi.fn(),
    runAgent: vi.fn(),
    getAgentRoot: vi.fn(() => "/agents/sanctuary.ouro"),
    saveSession: vi.fn(),
    readSessionTransaction: vi.fn(() => ({ revision: "revision-current" })),
    withSessionTurnLease: vi.fn(async (_path: string, callback: (lease: object) => unknown) => callback({ lease: true })),
    execTool: vi.fn(),
    resolveToolDefinition: vi.fn(),
    emitNervesEvent: vi.fn(),
    readSanctuaryAcceptanceMarker: vi.fn(),
    createTelegramApprovalTransport: vi.fn(() => transport),
    sendTelegramText: vi.fn(),
  }
})

vi.mock("../../heart/approval-files", () => ({
  FileApprovalCheckpointStore: class {
    constructor() { return runtimeMocks.checkpoints }
  },
  FileApprovalTokenStore: class {
    constructor() { return runtimeMocks.tokens }
  },
}))

vi.mock("../../heart/approval-store", () => ({
  openApprovalStore: runtimeMocks.openApprovalStore,
}))

vi.mock("../../heart/tool-approval", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../heart/tool-approval")>()
  return {
    ...actual,
    commitApprovalProposal: runtimeMocks.commitApprovalProposal,
    executeApprovalDecision: runtimeMocks.executeApprovalDecision,
    recoverAttemptedApproval: runtimeMocks.recoverAttemptedApproval,
    recoverClaimedApproval: runtimeMocks.recoverClaimedApproval,
  }
})

vi.mock("../../heart/core", () => ({
  resumeApprovalContinuation: runtimeMocks.resumeApprovalContinuation,
  runAgent: runtimeMocks.runAgent,
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: runtimeMocks.getAgentRoot }))
vi.mock("../../mind/context", () => ({ saveSession: runtimeMocks.saveSession }))
vi.mock("../../mind/session-transaction", () => ({
  readSessionTransaction: runtimeMocks.readSessionTransaction,
  withSessionTurnLease: runtimeMocks.withSessionTurnLease,
}))
vi.mock("../../repertoire/tools", () => ({
  execTool: runtimeMocks.execTool,
  resolveToolDefinition: runtimeMocks.resolveToolDefinition,
}))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: runtimeMocks.emitNervesEvent }))
vi.mock("../../heart/daemon/sanctuary-acceptance-marker", () => ({
  readSanctuaryAcceptanceMarker: runtimeMocks.readSanctuaryAcceptanceMarker,
  runWithSanctuaryAcceptanceApproval: (_binding: unknown, operation: () => unknown) => operation(),
}))
vi.mock("../../senses/telegram-client", () => ({
  createTelegramApprovalTransport: runtimeMocks.createTelegramApprovalTransport,
  FileTelegramPendingApprovalStore: class {},
  sendTelegramText: runtimeMocks.sendTelegramText,
}))

import {
  approvalContinuationRunAgentOptions,
  createTelegramApprovalRuntime,
  executeApprovedTelegramTool,
} from "../../senses/telegram-approval-runtime"
import { ApprovalExecutionFailedError } from "../../heart/tool-approval"

const baseRecord = {
  approvalId: "approval-1",
  toolName: "unraid_restart_container",
  arguments: { container: "calibre-web" },
  argumentDigest: "d".repeat(64),
  state: "succeeded",
  sessionPath: "/sessions/telegram.json",
  sessionKey: "telegram:tg_stable-subject",
  checkpointDigest: "c".repeat(64),
  suspendedSessionRevision: "s".repeat(64),
  continuationEpoch: 7,
}

function makeRuntime() {
  return createTelegramApprovalRuntime({
    agentName: "sanctuary",
    api: { request: vi.fn(), stop: vi.fn() },
    authorizedUserId: "10",
    authorizedChatId: "20",
    subject: "tg_stable-subject",
    identityKey: "k".repeat(43),
    toolContext: { agentName: "sanctuary" },
  })
}

function transportOptions() {
  return runtimeMocks.createTelegramApprovalTransport.mock.calls.at(-1)![0]
}

beforeEach(() => {
  vi.clearAllMocks()
  runtimeMocks.openApprovalStore.mockReturnValue(runtimeMocks.store)
  runtimeMocks.createTelegramApprovalTransport.mockReturnValue(runtimeMocks.transport)
  runtimeMocks.transport.sendApproval.mockResolvedValue({
    messageId: "99",
    approveCallbackData: "a:callback-token",
    denyCallbackData: "d:callback-token",
    expiresAt: 1_300_000,
  })
  runtimeMocks.transport.listPendingDeliveries.mockReturnValue([])
  runtimeMocks.transport.terminalizeOrphaned.mockResolvedValue({ terminalEditSucceeded: true })
  runtimeMocks.transport.terminalizeRecovered.mockResolvedValue(undefined)
  runtimeMocks.commitApprovalProposal.mockReturnValue({
    record: { ...baseRecord, state: "awaiting_prompt_binding" },
    decisionToken: "server-secret",
  })
  runtimeMocks.store.claimContinuation.mockReturnValue({
    claimed: true,
    record: { ...baseRecord, continuationEpoch: 8 },
  })
  runtimeMocks.store.abandonPromptBinding.mockImplementation(({ approvalId }) => ({ ...baseRecord, approvalId, state: "failed" }))
  runtimeMocks.checkpoints.read.mockReturnValue({
    preCallMessages: [{ role: "user", content: "restart calibre-web" }],
  })
  runtimeMocks.tokenState.value = "server-secret"
  runtimeMocks.executeApprovalDecision.mockResolvedValue({ ...baseRecord, state: "succeeded" })
  runtimeMocks.recoverClaimedApproval.mockImplementation(({ approvalId }) => ({ ...baseRecord, approvalId, state: "failed" }))
  runtimeMocks.recoverAttemptedApproval.mockImplementation(({ approvalId }) => ({ ...baseRecord, approvalId, state: "attempted_indeterminate" }))
  runtimeMocks.resumeApprovalContinuation.mockResolvedValue(undefined)
  runtimeMocks.saveSession.mockReturnValue(undefined)
  runtimeMocks.sendTelegramText.mockResolvedValue(undefined)
  runtimeMocks.readSanctuaryAcceptanceMarker.mockReturnValue(null)
})

describe("Telegram approval runtime safety", () => {
  it("reuses the approval coordinator when the resumed provider turn requests another gated tool", () => {
    const approvalCoordinator = { propose: vi.fn() }
    const toolContext = { agentName: "sanctuary" }

    expect(approvalContinuationRunAgentOptions(toolContext, approvalCoordinator)).toEqual({
      toolContext,
      approvalCoordinator,
    })
  })

  it("preserves a successful approved restart result", async () => {
    const result = '{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":false}}'
    const execute = vi.fn().mockResolvedValue(result)

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .resolves.toBe(result)
  })

  it("binds approved restart lifecycle events to the exact approval and scenario", async () => {
    const result = '{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":false}}'
    await executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, vi.fn().mockResolvedValue(result), "a".repeat(64), "approval-1")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.telegram_approved_restart_start", meta: { scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1" } }))
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.telegram_approved_restart_end", meta: { scenarioHandleDigest: "a".repeat(64), approvalId: "approval-1", observedRestart: true } }))

    runtimeMocks.emitNervesEvent.mockClear()
    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, vi.fn().mockRejectedValue(new Error("failed")), "b".repeat(64), "approval-2")).rejects.toThrow("failed")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "senses.telegram_approved_restart_error", meta: expect.objectContaining({ scenarioHandleDigest: "b".repeat(64), approvalId: "approval-2" }) }))
  })

  it.each([
    ['{"ok":false,"error":{"code":"ambiguous","message":"restart outcome is ambiguous","degraded":true}}', "restart outcome is ambiguous"],
    ['{"ok":false,"error":{"message":"' + "x".repeat(300) + '"}}', "x".repeat(240)],
    ['{"ok":false,"error":"failed"}', "approved restart failed"],
    ['{"ok":false,"error":{}}', "approved restart failed"],
    ["not-json", "approved restart returned an invalid result"],
    ["null", "approved restart returned an invalid result"],
    ["true", "approved restart returned an invalid result"],
    ["[]", "approved restart returned an invalid result"],
    ['{"data":{}}', "approved restart returned an invalid result"],
    ['{"ok":true}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":null}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":true}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":true}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"name":"calibre-web"}}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"","name":"calibre-web"}}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc"}}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":""}}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"}}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running"}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":false,"degraded":false}}', "approved restart returned an invalid result"],
    ['{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":true}}', "approved restart returned an invalid result"],
  ])("turns failed and structurally invalid approved restarts into failed approvals", async (result, message) => {
    const execute = vi.fn().mockResolvedValue(result)

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .rejects.toEqual(expect.objectContaining({ name: ApprovalExecutionFailedError.name, message }))
  })

  it("does not reinterpret ordinary approved tool output", async () => {
    const execute = vi.fn().mockResolvedValue("ordinary output")

    await expect(executeApprovedTelegramTool("ponder", {}, execute)).resolves.toBe("ordinary output")
  })
})

describe("Telegram approval runtime orchestration", () => {
  it("defaults legacy approval subjects to empty for a compatibility store without discovery", () => {
    const discover = runtimeMocks.store.listTelegramIdentitySubjects
    ;(runtimeMocks.store as any).listTelegramIdentitySubjects = undefined
    try {
      expect(makeRuntime().legacySubjects()).toEqual([])
    } finally {
      runtimeMocks.store.listTelegramIdentitySubjects = discover
    }
  })

  it("creates durable stores, proposes only function calls, sends a prompt, and binds its message", async () => {
    const runtime = makeRuntime()
    const coordinator = runtime.coordinator({ sessionPath: "/sessions/telegram.json", baseSessionRevision: "base-revision" })
    await expect(coordinator.propose({ toolCall: { id: "call-0", type: "custom" } } as never))
      .rejects.toThrow("approval requires a function tool call")

    const request = {
      toolCall: { id: "call-1", type: "function" as const, function: { name: "unraid_restart_container", arguments: "{}" } },
      arguments: { container: "calibre-web" },
      schemaDigest: "schema",
      toolDigest: "tool",
      policyDigest: "policy",
      policyId: "restart-policy",
      frozenAssistantMessage: { role: "assistant", content: null },
      preCallMessages: [{ role: "user", content: "restart calibre-web" }],
    }
    await expect(coordinator.propose(request as never)).resolves.toEqual({
      approvalId: "approval-1",
      checkpointDigest: "c".repeat(64),
      suspendedSessionRevision: "s".repeat(64),
    })

    expect(runtimeMocks.getAgentRoot).toHaveBeenCalledWith("sanctuary")
    expect(runtimeMocks.openApprovalStore).toHaveBeenCalledWith({ databasePath: "/agents/sanctuary.ouro/state/approvals/approvals.sqlite", now: expect.any(Function) })
    expect(runtimeMocks.store.migrateTelegramIdentity).not.toHaveBeenCalled()
    runtimeMocks.store.listTelegramIdentitySubjects.mockReturnValue([`tg_${"l".repeat(43)}`, "tg_stable-subject"])
    expect(runtime.legacySubjects()).toEqual([`tg_${"l".repeat(43)}`])
    runtime.migrateIdentity([`tg_${"l".repeat(43)}`])
    expect(runtimeMocks.store.migrateTelegramIdentity).toHaveBeenNthCalledWith(1, {
      legacyUserId: `tg_${"l".repeat(43)}`,
      legacyChatId: `tg_${"l".repeat(43)}`,
      subject: "tg_stable-subject",
    })
    expect(runtimeMocks.store.migrateTelegramIdentity).toHaveBeenNthCalledWith(2, {
      legacyUserId: "10",
      legacyChatId: "20",
      subject: "tg_stable-subject",
    })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.telegram_approval_runtime_create",
      meta: { agentName: "sanctuary" },
    }))
    expect(runtimeMocks.commitApprovalProposal).toHaveBeenCalledWith(expect.objectContaining({
      proposal: expect.objectContaining({
        toolCallId: "call-1",
        sessionKey: "telegram:tg_stable-subject",
        requesterId: "tg_stable-subject",
        transportUserId: "tg_stable-subject",
        transportChatId: "tg_stable-subject",
      }),
    }))
    expect(runtimeMocks.transport.sendApproval).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: "approval-1",
      decisionToken: "server-secret",
      prompt: 'Approve unraid_restart_container with exact arguments {"container":"calibre-web"}?',
    }))
    expect(runtimeMocks.store.bindPrompt).toHaveBeenCalledWith(expect.objectContaining({
      transportChatId: "tg_stable-subject",
      transportMessageId: expect.stringMatching(/^tgm_[A-Za-z0-9_-]{43}$/u),
    }))
    runtime.close()
    expect(runtimeMocks.store.close).toHaveBeenCalledOnce()
  })

  it("binds acceptance prompts and resumed observed-result delivery to authenticated action evidence", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    runtimeMocks.readSanctuaryAcceptanceMarker.mockReturnValue({ scenarioHandleDigest })
    runtimeMocks.sendTelegramText.mockResolvedValue([77])
    runtimeMocks.resumeApprovalContinuation.mockImplementation(async (options) => { await options.deliver("observed restart result") })
    const runtime = makeRuntime()
    const coordinator = runtime.coordinator({ sessionPath: "/sessions/telegram.json", baseSessionRevision: "base-revision" })
    await coordinator.propose({
      toolCall: { id: "call-1", type: "function", function: { name: "unraid_restart_container", arguments: "{}" } },
      arguments: { container: "calibre-web" }, schemaDigest: "schema", toolDigest: "tool", policyDigest: "policy", policyId: "restart-policy",
      frozenAssistantMessage: { role: "assistant", content: null }, preCallMessages: [{ role: "user", content: "restart calibre-web" }],
    } as never)
    const sent = runtimeMocks.transport.sendApproval.mock.calls.at(-1)![0]
    expect(sent.acceptanceBinding).toEqual({
      scenarioHandleDigest,
      actionDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      targetDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
      checkpointDigest: baseRecord.checkpointDigest,
      suspendedSessionRevisionDigest: createHash("sha256").update(baseRecord.suspendedSessionRevision!, "utf8").digest("hex"),
    })

    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "succeeded" })
    const acceptanceBinding = { ...sent.acceptanceBinding, messageIdDigest: "4".repeat(64), boundAt: 1_000 }
    await transportOptions().onDecision({ approvalId: "approval-1", acceptanceBinding })
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.telegram_approval_continuation_delivered",
      meta: expect.objectContaining({ approvalId: "approval-1", ...acceptanceBinding, resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), deliveryMessageIdDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), evidenceMac: expect.stringMatching(/^[0-9a-f]{64}$/u) }),
    }))
  })

  it("expires approvals and resolves decision tokens without exposing missing secrets", async () => {
    makeRuntime()
    const options = transportOptions()

    await expect(options.resolveDecisionToken("approval-1")).resolves.toBe("server-secret")
    runtimeMocks.tokens.get.mockReturnValueOnce(undefined)
    await expect(options.resolveDecisionToken("missing")).resolves.toBe("")
    await options.onExpire("approval-1")

    expect(runtimeMocks.store.expire).toHaveBeenCalledWith({ approvalId: "approval-1" })
    expect(runtimeMocks.tokens.remove).toHaveBeenCalledWith("approval-1")
    expect(options.createOpaqueHandle()).toMatch(/^[A-Za-z0-9_-]{16}$/u)
  })

  it("rejects missing and unrecoverable decisions before continuation", async () => {
    makeRuntime()
    const options = transportOptions()
    runtimeMocks.store.read.mockReturnValueOnce(undefined)
    await expect(options.onDecision({ approvalId: "missing" })).resolves.toEqual({
      accepted: false,
      terminalText: "⚠️ Approval is no longer valid",
    })

    runtimeMocks.store.read.mockReturnValueOnce({ ...baseRecord, state: "preparing" })
    await expect(options.onDecision({ approvalId: "approval-1" })).resolves.toEqual({
      accepted: false,
      terminalText: "⚠️ Approval is not recoverable",
    })
  })

  it.each([
    ["claimed", runtimeMocks.recoverClaimedApproval],
    ["attempted", runtimeMocks.recoverAttemptedApproval],
  ])("recovers an interrupted %s decision before continuing", async (state, recovery) => {
    makeRuntime()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state })

    await transportOptions().onDecision({ approvalId: "approval-1" })

    expect(recovery).toHaveBeenCalled()
    expect(runtimeMocks.resumeApprovalContinuation).toHaveBeenCalled()
  })

  it("executes a proposed decision under the session lease and passes the approved tool seam", async () => {
    makeRuntime()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "proposed" })
    runtimeMocks.execTool.mockResolvedValue("ordinary output")
    runtimeMocks.executeApprovalDecision.mockImplementation(async (options) => {
      await expect(options.liveGuard()).resolves.toEqual({ ok: true })
      await expect(options.liveRisk()).resolves.toEqual({ ok: true })
      expect(options.resolveTool).toBe(runtimeMocks.resolveToolDefinition)
      await expect(options.execute("ponder", { thought: "safe" })).resolves.toBe("ordinary output")
      return { ...baseRecord, state: "succeeded" }
    })

    await expect(transportOptions().onDecision({ approvalId: "approval-1", decision: "approve" }))
      .resolves.toEqual({ accepted: true, terminalText: "✅ Approved — action completed" })

    expect(runtimeMocks.executeApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({
        requesterId: "tg_stable-subject",
        transportUserId: "tg_stable-subject",
        transportChatId: "tg_stable-subject",
        transportMessageId: expect.stringMatching(/^tgm_[A-Za-z0-9_-]{43}$/u),
        sessionKey: "telegram:tg_stable-subject",
      }),
      currentSessionRevision: "revision-current",
    }))
    expect(runtimeMocks.execTool).toHaveBeenCalledWith("ponder", { thought: "safe" }, { agentName: "sanctuary" })
  })

  it.each([
    ["succeeded", true, "✅ Approved — action completed"],
    ["denied", false, "❌ Denied — no action taken"],
    ["attempted_indeterminate", false, "⚠️ Action outcome is indeterminate after restart — it was not retried"],
    ["failed", false, "⚠️ Approval did not complete"],
  ])("continues terminal state %s with the matching user outcome", async (state, accepted, terminalText) => {
    makeRuntime()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state })

    await expect(transportOptions().onDecision({ approvalId: "approval-1" })).resolves.toEqual({ accepted, terminalText })
    expect(runtimeMocks.tokens.remove).toHaveBeenCalledWith("approval-1")
  })

  it("consumes the decision token before reporting a missing continuation checkpoint", async () => {
    makeRuntime()
    const options = transportOptions()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "failed" })
    runtimeMocks.checkpoints.read.mockReturnValue(undefined)

    await expect(options.onDecision({ approvalId: "approval-1" })).resolves.toEqual({
      accepted: false,
      terminalText: "⚠️ Approval checkpoint is unavailable",
    })
    expect(runtimeMocks.resumeApprovalContinuation).not.toHaveBeenCalled()
    expect(runtimeMocks.tokens.remove).toHaveBeenCalledWith("approval-1")
    await expect(options.resolveDecisionToken("approval-1")).resolves.toBe("")
  })

  it("consumes the decision token before a continuation attempt that fails", async () => {
    makeRuntime()
    const options = transportOptions()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "failed" })
    runtimeMocks.resumeApprovalContinuation.mockRejectedValueOnce(new Error("resume state is unavailable"))

    await expect(options.onDecision({ approvalId: "approval-1" })).rejects.toThrow("resume state is unavailable")
    expect(runtimeMocks.tokens.remove).toHaveBeenCalledWith("approval-1")
    await expect(options.resolveDecisionToken("approval-1")).resolves.toBe("")
  })

  it("wires continuation claims, persistence, delivery, and recursively gated proposals", async () => {
    makeRuntime()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "succeeded" })
    runtimeMocks.resumeApprovalContinuation.mockImplementation(async (options) => {
      expect(options.claimContinuation()).toEqual(expect.objectContaining({ claimed: true }))
      options.markContinuationMaterialized()
      options.markContinuationAttempted()
      options.completeContinuation()
      await options.persist([{ role: "assistant", content: "done" }], { usage: { inputTokens: 1 } })
      await options.deliver("calibre-web is back")
      await options.runAgentOptions.approvalCoordinator.propose({
        toolCall: { id: "call-2", type: "function", function: { name: "unraid_restart_container", arguments: "{}" } },
        arguments: { container: "calibre" },
        schemaDigest: "schema",
        toolDigest: "tool",
        policyDigest: "policy",
        policyId: "restart-policy",
        frozenAssistantMessage: { role: "assistant", content: null },
        preCallMessages: [],
      })
    })

    await transportOptions().onDecision({ approvalId: "approval-1" })

    expect(runtimeMocks.store.claimContinuation).toHaveBeenCalledWith(expect.objectContaining({ ownerId: expect.stringMatching(/^telegram-continuation-/u) }))
    expect(runtimeMocks.store.markContinuationMaterialized).toHaveBeenCalledWith(expect.objectContaining({ epoch: 8 }))
    expect(runtimeMocks.store.markContinuationAttempted).toHaveBeenCalledWith(expect.objectContaining({ epoch: 8 }))
    expect(runtimeMocks.store.completeContinuation).toHaveBeenCalledWith(expect.objectContaining({ epoch: 8 }))
    expect(runtimeMocks.saveSession).toHaveBeenCalledWith(
      "/sessions/telegram.json",
      [{ role: "assistant", content: "done" }],
      { inputTokens: 1 },
      undefined,
      { lease: true },
    )
    expect(runtimeMocks.sendTelegramText).toHaveBeenCalledWith(expect.anything(), "20", "calibre-web is back")
    expect(runtimeMocks.readSessionTransaction).toHaveBeenCalledTimes(2)
  })

  it("reconciles terminal tombstones, missing journals, and interrupted prompt deliveries", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([
      { approvalId: "terminal", terminal: { terminalText: "already terminal" } },
      { approvalId: "missing" },
      { approvalId: "missing-terminal", deliveryState: "delivery_indeterminate", terminal: { terminalText: "interrupted" } },
      { approvalId: "pending-prompt", deliveryState: "pending" },
      { approvalId: "indeterminate-prompt", deliveryState: "delivery_indeterminate" },
    ])
    runtimeMocks.store.read.mockImplementation((approvalId) => ({
      "terminal": { ...baseRecord, approvalId, state: "succeeded" },
      "missing": undefined,
      "missing-terminal": undefined,
      "pending-prompt": { ...baseRecord, approvalId, state: "awaiting_prompt_binding" },
      "indeterminate-prompt": { ...baseRecord, approvalId, state: "awaiting_prompt_binding" },
    })[approvalId])

    await runtime.recover()

    expect(runtimeMocks.store.abandonPromptBinding).toHaveBeenNthCalledWith(1, {
      approvalId: "pending-prompt",
      reason: "approval prompt was interrupted before delivery; action was not executed",
    })
    expect(runtimeMocks.store.abandonPromptBinding).toHaveBeenNthCalledWith(2, {
      approvalId: "indeterminate-prompt",
      reason: "approval prompt delivery was indeterminate; action was not executed",
    })
    expect(runtimeMocks.transport.terminalizeRecovered).toHaveBeenCalledTimes(3)
    expect(runtimeMocks.transport.terminalizeOrphaned).toHaveBeenCalledWith(
      "missing",
      "⚠️ Approval record is unavailable — no action was taken",
    )
    expect(runtimeMocks.transport.terminalizeOrphaned).toHaveBeenCalledWith(
      "missing-terminal",
      "⚠️ Approval record is unavailable — no action was taken",
    )
    expect(runtimeMocks.store.expire).not.toHaveBeenCalled()
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      component: "senses",
      event: "senses.telegram_approval_orphan_recovered",
      meta: { agentName: "sanctuary", recovery: "missing_journal", terminalEditSucceeded: true },
    }))
    expect(JSON.stringify(runtimeMocks.emitNervesEvent.mock.calls)).not.toContain('\"approvalId\":\"missing\"')
    expect(JSON.stringify(runtimeMocks.emitNervesEvent.mock.calls)).not.toContain("missing-terminal")
  })

  it("isolates every startup recovery record and surfaces one sanitized aggregate after processing later work", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([
      { approvalId: "first", terminal: { terminalText: "first terminal" } },
      { approvalId: "second", terminal: { terminalText: "second terminal" } },
      { approvalId: "bound", deliveryState: "bound", messageId: "101" },
    ])
    runtimeMocks.store.read.mockImplementation((approvalId) => ({
      ...baseRecord,
      approvalId,
      state: approvalId === "bound" ? "awaiting_prompt_binding" : "succeeded",
    }))
    runtimeMocks.transport.terminalizeRecovered
      .mockRejectedValueOnce(new Error("private upstream detail"))
      .mockResolvedValue(undefined)

    await expect(runtime.recover()).resolves.toBeUndefined()

    expect(runtimeMocks.transport.terminalizeRecovered).toHaveBeenCalledTimes(2)
    expect(runtimeMocks.store.bindPrompt).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "bound" }))
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.telegram_approval_recovery_error",
      meta: { failureCount: 1 },
    }))
    expect(JSON.stringify(runtimeMocks.emitNervesEvent.mock.calls)).not.toContain("private upstream detail")
  })

  it("rebinds delivered prompts and leaves nonterminal proposal phases pending", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([
      { approvalId: "bound", messageId: "101" },
      { approvalId: "bound-no-message" },
      { approvalId: "proposed" },
      { approvalId: "preparing" },
    ])
    runtimeMocks.store.read.mockImplementation((approvalId) => ({
      ...baseRecord,
      approvalId,
      state: approvalId === "bound" || approvalId === "bound-no-message" ? "awaiting_prompt_binding" : approvalId,
    }))

    await runtime.recover()

    expect(runtimeMocks.store.bindPrompt).toHaveBeenCalledWith({
      approvalId: "bound",
      transport: "telegram",
      transportChatId: "tg_stable-subject",
      transportMessageId: expect.stringMatching(/^tgm_[A-Za-z0-9_-]{43}$/u),
    })
    expect(runtimeMocks.resumeApprovalContinuation).not.toHaveBeenCalled()
  })

  it("recovers claimed and attempted deliveries and terminalizes other completed records", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([
      { approvalId: "claimed" },
      { approvalId: "attempted" },
      { approvalId: "failed" },
    ])
    runtimeMocks.store.read.mockImplementation((approvalId) => ({ ...baseRecord, approvalId, state: approvalId }))

    await runtime.recover()

    expect(runtimeMocks.recoverClaimedApproval).toHaveBeenCalled()
    expect(runtimeMocks.recoverAttemptedApproval).toHaveBeenCalled()
    expect(runtimeMocks.resumeApprovalContinuation).toHaveBeenCalledTimes(3)
    expect(runtimeMocks.transport.terminalizeRecovered).toHaveBeenCalledTimes(3)
  })
})
