import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash, createHmac } from "node:crypto"

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
    recoverDecisionAttempt: vi.fn(),
    reconcileExpired: vi.fn(),
    sendApproval: vi.fn(),
    terminalizeOrphaned: vi.fn(),
    terminalizeRecovered: vi.fn(),
    validatePendingTerminalControl: vi.fn(),
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
    loadSessionEnvelopeFile: vi.fn(),
    approvalSendText: vi.fn(),
    readSessionTransaction: vi.fn(() => ({ revision: "revision-current" })),
    withSessionTurnLease: vi.fn(async (_path: string, callback: (lease: object) => unknown) => callback({ lease: true })),
    execTool: vi.fn(),
    executeTool: vi.fn(),
    preflightToolCall: vi.fn(),
    selectToolsForChannel: vi.fn(),
    getProviderRuntime: vi.fn(),
    getSharedMcpManager: vi.fn(),
    resolveToolDefinition: vi.fn(),
    approvalPolicyForInvocation: vi.fn(async () => ({ kind: "required", policyId: "restart-policy", actionClass: "unraid.container.restart", requiresSoleCall: true })),
    emitNervesEvent: vi.fn(),
    emitNervesEventDurable: vi.fn(async () => undefined),
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
  getProviderRuntime: runtimeMocks.getProviderRuntime,
}))

vi.mock("../../heart/identity", () => ({ getAgentRoot: runtimeMocks.getAgentRoot }))
vi.mock("../../heart/session-events", () => ({ loadSessionEnvelopeFile: runtimeMocks.loadSessionEnvelopeFile }))
vi.mock("../../mind/context", () => ({ saveSession: runtimeMocks.saveSession }))
vi.mock("../../mind/session-transaction", () => ({
  readSessionTransaction: runtimeMocks.readSessionTransaction,
  withSessionTurnLease: runtimeMocks.withSessionTurnLease,
}))
vi.mock("../../repertoire/tools", () => ({
  execTool: runtimeMocks.execTool,
  executeTool: runtimeMocks.executeTool,
  preflightToolCall: runtimeMocks.preflightToolCall,
  selectToolsForChannel: runtimeMocks.selectToolsForChannel,
  resolveToolDefinition: runtimeMocks.resolveToolDefinition,
  approvalPolicyForInvocation: runtimeMocks.approvalPolicyForInvocation,
}))
vi.mock("../../repertoire/mcp-manager", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../repertoire/mcp-manager")>(),
  getSharedMcpManager: runtimeMocks.getSharedMcpManager,
}))
vi.mock("../../nerves/runtime", () => ({ emitNervesEvent: runtimeMocks.emitNervesEvent, emitNervesEventDurable: runtimeMocks.emitNervesEventDurable }))
vi.mock("../../heart/daemon/sanctuary-acceptance-marker", () => ({
  readSanctuaryAcceptanceMarker: runtimeMocks.readSanctuaryAcceptanceMarker,
  runWithSanctuaryAcceptanceApproval: (_binding: unknown, operation: () => unknown) => operation(),
}))
vi.mock("../../senses/telegram-client", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../senses/telegram-client")>(),
  createTelegramApprovalTransport: runtimeMocks.createTelegramApprovalTransport,
  FileTelegramPendingApprovalStore: class {},
  sendTelegramText: runtimeMocks.sendTelegramText,
}))

import {
  approvalContinuationRunAgentOptions,
  createTelegramApprovalRuntime,
  executeApprovedTelegramTool,
  formatTelegramApprovalPrompt,
} from "../../senses/telegram-approval-runtime"
import { ApprovalExecutionFailedError } from "../../heart/tool-approval"
import type { ToolContext } from "../../repertoire/tools-base"

function success(text: string) { return { kind: "handler_succeeded" as const, text } }

it("renders phone-clear Sanctuary approval prompts without internal names or JSON", () => {
  expect(formatTelegramApprovalPrompt("sanctuary_resume_download_queue", {})).toBe("Resume household downloads? This can spend prepaid download credit. I’ll verify the queue actually resumed.")
  expect(formatTelegramApprovalPrompt("unraid_restart_container", { container: "calibre-web" })).toBe("Restart calibre-web?")
  expect(formatTelegramApprovalPrompt("other_tool", { value: 1 })).toContain('Approve other_tool with exact arguments {"value":1}?')
})

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

function makeRuntime(effectBarrier: () => void = vi.fn(), toolContext: Partial<ToolContext> = { agentName: "sanctuary" }) {
  const effects = {
    sendText: runtimeMocks.approvalSendText,
    sendCard: vi.fn(),
    edit: vi.fn(),
    acknowledge: vi.fn(),
  }
  return createTelegramApprovalRuntime({
    agentName: "sanctuary",
    api: { request: vi.fn(), stop: vi.fn() },
    authorizedUserId: "10",
    authorizedChatId: "20",
    subject: "tg_stable-subject",
    identityKey: "k".repeat(43),
    toolContext,
    resolveLiveToolContext: async (record) => ({
      signin: async () => undefined,
      agentName: "sanctuary", agentRoot: "/agents/sanctuary.ouro",
      ...toolContext,
      currentSession: { friendId: "owner", channel: "telegram", key: record.sessionKey, sessionPath: record.sessionPath },
      context: { friend: { id: "owner", trustLevel: "family" }, channel: "telegram" } as ToolContext["context"],
      relationshipAuthorization: {
        profileId: "sanctuary-owner", authorizedContextScopes: [], advertisedToolNames: [record.toolName],
        actor: { friendId: "owner", trustLevel: "family", sessionEventId: "evt-1" },
        authorizeTool: async () => ({ allowed: true, receiptId: "current-owner" }),
        ...toolContext.relationshipAuthorization,
      },
    }),
    effects,
    effectBarrier,
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
  runtimeMocks.transport.recoverDecisionAttempt.mockResolvedValue(true)
  runtimeMocks.transport.terminalizeOrphaned.mockResolvedValue({ terminalEditSucceeded: true })
  runtimeMocks.transport.terminalizeRecovered.mockResolvedValue(undefined)
  runtimeMocks.transport.validatePendingTerminalControl.mockResolvedValue(undefined)
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
  runtimeMocks.saveSession.mockReturnValue([])
  runtimeMocks.loadSessionEnvelopeFile.mockReturnValue(null)
  runtimeMocks.approvalSendText.mockImplementation(async (input: { chatId: string; text: string }) => runtimeMocks.sendTelegramText({}, input.chatId, input.text))
  runtimeMocks.sendTelegramText.mockResolvedValue(undefined)
  runtimeMocks.readSanctuaryAcceptanceMarker.mockReturnValue(null)
  runtimeMocks.getProviderRuntime.mockResolvedValue({ model: "fixture-model", capabilities: new Set() })
  runtimeMocks.getSharedMcpManager.mockResolvedValue(null)
  runtimeMocks.selectToolsForChannel.mockReturnValue({
    ordinary: [{ tool: { type: "function", function: { name: "unraid_restart_container" } } }], engine: [],
  })
  runtimeMocks.resolveToolDefinition.mockImplementation((name, selection) => selection?.ordinary.find((definition) => definition.tool.function.name === name))
  runtimeMocks.preflightToolCall.mockResolvedValue({ kind: "ready" })
  runtimeMocks.executeTool.mockResolvedValue(success('{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":false}}'))
})

describe("Telegram approval runtime safety", () => {
  it.each(["handler_failed", "handler_indeterminate", "rejected_before_handler"] as const)(
    "preserves typed %s outcomes without treating successful-looking output as an effect",
    async (kind) => {
      const outcome = { kind, text: "Everything completed successfully." }
      await expect(executeApprovedTelegramTool("unraid_restart_container", {}, async () => outcome, kind === "handler_failed" ? "scenario" : undefined, kind === "handler_failed" ? "approval" : undefined)).resolves.toBe(outcome)
      expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
        event: "senses.telegram_approved_restart_error", meta: expect.objectContaining({ outcome: kind }),
      }))
      runtimeMocks.emitNervesEvent.mockClear()
      await expect(executeApprovedTelegramTool("other_tool", {}, async () => outcome)).resolves.toBe(outcome)
      expect(runtimeMocks.emitNervesEvent).not.toHaveBeenCalled()
    },
  )

  it("checks the acceptance barrier before approval delivery and approved tool execution", async () => {
    const barrierFailure = new Error("acceptance audit exhausted")
    const barrier = vi.fn(() => { throw barrierFailure })
    const runtime = makeRuntime(barrier)
    runtimeMocks.commitApprovalProposal.mockReturnValue({
      record: { ...baseRecord, state: "proposed", toolName: "unraid_restart_container" },
      decisionToken: "decision-token",
    })
    const proposal = runtime.coordinator({ sessionPath: baseRecord.sessionPath, baseSessionRevision: "revision" })
    await expect(proposal.propose({
      toolCall: { type: "function", id: "tool-call", function: { name: "unraid_restart_container", arguments: "{}" } },
      arguments: {}, schemaDigest: "s".repeat(64), toolDigest: "t".repeat(64), policyDigest: "p".repeat(64),
      policyId: "policy", preCallMessages: [], frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [] },
    } as any)).rejects.toBe(barrierFailure)
    expect(runtimeMocks.transport.sendApproval).not.toHaveBeenCalled()

    const execute = vi.fn(async () => "ok")
    await expect(executeApprovedTelegramTool("unraid_restart_container", {}, execute, "a".repeat(64), "approval-1", barrier))
      .rejects.toBe(barrierFailure)
    expect(execute).not.toHaveBeenCalled()
  })
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
    const outcome = success(result)
    const execute = vi.fn().mockResolvedValue(outcome)

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .resolves.toBe(outcome)
  })

  it("accepts only an independently verified approved download resume", async () => {
    const result = '{"ok":true,"data":{"verified":true,"after":{"paused":false}}}'
    await expect(executeApprovedTelegramTool("sanctuary_resume_download_queue", {}, vi.fn().mockResolvedValue(success(result)))).resolves.toEqual(success(result))
    await expect(executeApprovedTelegramTool("sanctuary_resume_download_queue", {}, vi.fn().mockResolvedValue(success('{"ok":true,"data":{"verified":false,"after":{"paused":true}}}')))).rejects.toThrow("not independently verified")
    for (const malformed of ["null", '{"ok":true,"data":null}', '{"ok":true,"data":{"verified":true,"after":null}}']) {
      await expect(executeApprovedTelegramTool("sanctuary_resume_download_queue", {}, vi.fn().mockResolvedValue(success(malformed)))).rejects.toThrow("not independently verified")
    }
    await expect(executeApprovedTelegramTool("sanctuary_resume_download_queue", {}, vi.fn().mockResolvedValue(success("invalid")))).rejects.toThrow("invalid result")
  })

  it("binds approved restart lifecycle events to the exact approval and scenario", async () => {
    const result = '{"ok":true,"data":{"container":{"id":"abc","name":"calibre-web"},"beforeState":"running","afterState":"running","observedRestart":true,"degraded":false}}'
    await executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, vi.fn().mockResolvedValue(success(result)), "a".repeat(64), "approval-1")
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
    const execute = vi.fn().mockResolvedValue(success(result))

    await expect(executeApprovedTelegramTool("unraid_restart_container", { container: "calibre-web" }, execute))
      .rejects.toEqual(expect.objectContaining({ name: ApprovalExecutionFailedError.name, message }))
  })

  it("does not reinterpret ordinary approved tool output", async () => {
    const outcome = success("ordinary output")
    const execute = vi.fn().mockResolvedValue(outcome)

    await expect(executeApprovedTelegramTool("other_tool", {}, execute)).resolves.toBe(outcome)
  })

  it("rethrows ordinary and non-Error restart failures without misclassifying private detail", async () => {
    await expect(executeApprovedTelegramTool("ponder", {}, vi.fn().mockRejectedValue(new Error("ordinary failure"))))
      .rejects.toThrow("ordinary failure")
    await expect(executeApprovedTelegramTool("unraid_restart_container", {}, vi.fn().mockRejectedValue("private failure")))
      .rejects.toBe("private failure")
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      event: "senses.telegram_approved_restart_error",
      meta: expect.objectContaining({ reason: "unknown" }),
    }))
  })
})

describe("Telegram approval runtime orchestration", () => {
  it.each(["missing-producer", "wrong-root", "non-error"] as const)("refuses unavailable current authority at every decision seam: %s", async (change) => {
    if (change === "missing-producer") createTelegramApprovalRuntime({
      agentName: "sanctuary", api: { request: vi.fn(), stop: vi.fn() }, authorizedUserId: "10", authorizedChatId: "20",
      subject: "tg_stable-subject", identityKey: "k".repeat(43), toolContext: {},
      effects: { sendText: vi.fn(), sendCard: vi.fn(), edit: vi.fn(), acknowledge: vi.fn() },
    })
    else makeRuntime(vi.fn(), change === "wrong-root" ? { agentRoot: "/other.ouro" } : {})
    if (change === "non-error") runtimeMocks.getProviderRuntime.mockRejectedValue("provider unavailable")
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "proposed" })
    runtimeMocks.executeApprovalDecision.mockImplementation(async (options) => {
      await expect(options.resolveTool(baseRecord.toolName)).resolves.toBeUndefined()
      await expect(options.resolveApprovalPolicy(baseRecord.toolName, baseRecord.arguments)).resolves.toEqual({ kind: "not_required" })
      await expect(options.preflight({ record: baseRecord, arguments: baseRecord.arguments })).resolves.toMatchObject({ ok: false })
      await expect(options.execute(baseRecord.toolName, baseRecord.arguments)).resolves.toMatchObject({ kind: "rejected_before_handler" })
      return { ...baseRecord, state: "drifted" }
    })
    await transportOptions().onDecision({ approvalId: "approval-1", decision: "approve" })
    expect(runtimeMocks.executeTool).not.toHaveBeenCalled()
    expect(runtimeMocks.preflightToolCall).not.toHaveBeenCalled()
  })

  it("passes a canonical guard rejection back to the pre-attempt decision owner", async () => {
    makeRuntime()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "proposed" })
    runtimeMocks.preflightToolCall.mockResolvedValue({ kind: "rejected_before_handler", text: "guard hold" })
    runtimeMocks.executeApprovalDecision.mockImplementation(async (options) => {
      const definition = await options.resolveTool(baseRecord.toolName)
      await expect(options.preflight({ record: baseRecord, arguments: baseRecord.arguments, definition })).resolves.toEqual({ ok: false, reason: "guard hold" })
      return { ...baseRecord, state: "drifted" }
    })
    await transportOptions().onDecision({ approvalId: "approval-1", decision: "approve" })
    expect(runtimeMocks.executeTool).not.toHaveBeenCalled()
  })

  it.each([
    "edit", "ack", "author", "new-text", "missing-record", "message-null", "transport", "requester", "user", "chat", "session",
    "message-binding", "not-terminal", "accepted", "ack-text", "ack-alert", "ack-query", "ack-key",
    "edit-text", "edit-message", "edit-key", "missing-terminal", "expired-deadline", "expired-observation", "integrity-error",
  ])("keeps terminal controls bound to their exact existing record and payload: %s", async (change) => {
    const runtime = makeRuntime()
    const subject = "tg_stable-subject"
    const query = "query-1"
    const digest = createHash("sha256").update(query).digest("hex")
    const pending = {
      approvalId: baseRecord.approvalId, messageId: "99" as string | null,
      expiresAt: 1_300_000,
      terminal: { accepted: true, terminalText: "completed" } as { accepted: boolean; terminalText: string } | undefined,
      decisionAttempt: { queryIdDigest: digest },
      expiryObservation: undefined as { deadlineAt: number; observedAt: number } | undefined,
    }
    const record = {
      ...baseRecord, requesterId: subject, transportUserId: subject, transportChatId: subject,
      transport: "telegram", transportMessageId: `tgm_${createHmac("sha256", subject).update("message:99").digest("base64url")}`,
    }
    if (change === "message-null") pending.messageId = null
    if (change === "transport") record.transport = "frontend"
    if (change === "requester") record.requesterId = "other"
    if (change === "user") record.transportUserId = "other"
    if (change === "chat") record.transportChatId = "other"
    if (change === "session") record.sessionKey = "other"
    if (change === "message-binding") record.transportMessageId = "other"
    if (change === "not-terminal") record.state = "proposed"
    if (change === "accepted") pending.terminal!.accepted = false
    if (change === "missing-terminal") pending.terminal = undefined
    if (change.startsWith("expired-")) {
      record.state = "expired"
      pending.terminal = undefined
      pending.expiryObservation = {
        deadlineAt: change === "expired-deadline" ? 1_200_000 : pending.expiresAt,
        observedAt: change === "expired-observation" ? 1_200_000 : pending.expiresAt,
      }
    }
    runtimeMocks.store.read.mockReturnValue(change === "missing-record" ? undefined : record)
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([pending])
    if (change === "integrity-error") runtimeMocks.transport.validatePendingTerminalControl.mockRejectedValueOnce(new Error("native integrity rejected"))
    const acknowledgement = change === "ack" || change.startsWith("ack-")
    const text = change === "edit-text" ? "arbitrary" : change.startsWith("expired-") ? "⚠️ Approval expired" : "completed"
    const input: Parameters<NonNullable<typeof runtime.isPendingTerminalControl>>[0] = {
      authorClass: change === "author" ? "butler" : "control",
      idempotencyKey: acknowledgement
        ? change === "ack-key" ? "other" : `approval-callback:${digest}`
        : change === "edit-key" ? "other" : `approval:${baseRecord.approvalId}:edit:${createHash("sha256").update(text).digest("hex")}`,
      effect: change === "new-text" ? { kind: "text", text: "arbitrary" }
        : acknowledgement ? {
          kind: "callback_ack", callbackQueryId: change === "ack-query" ? "other" : query,
          ...(change === "ack-text" ? { text: "arbitrary" } : {}),
          ...(change === "ack-alert" ? { showAlert: true } : {}),
        }
          : { kind: "edit", messageId: change === "edit-message" ? 100 : 99, text },
    }
    if (change === "integrity-error") {
      await expect(runtime.isPendingTerminalControl!(input)).rejects.toThrow("native integrity rejected")
    } else {
      await expect(runtime.isPendingTerminalControl!(input)).resolves.toBe(change === "edit" || change === "ack")
      expect(runtimeMocks.transport.validatePendingTerminalControl).toHaveBeenCalledTimes(change === "edit" || change === "ack" ? 1 : 0)
    }
  })

  it("executes every default transport adapter and both durable settlement emitters", async () => {
    makeRuntime()
    const options = transportOptions()
    const storeOptions = runtimeMocks.openApprovalStore.mock.calls.at(-1)?.[0]
    expect(storeOptions.now()).toBeInstanceOf(Date)
    expect(options.acceptanceEventMeta()).toEqual({})
    runtimeMocks.readSanctuaryAcceptanceMarker.mockReturnValue({ scenarioHandleDigest: "a".repeat(64) })
    expect(options.acceptanceEventMeta()).toEqual({ scenarioHandleDigest: "a".repeat(64) })
    expect(options.signAcceptanceEvidence("event", { value: true })).toMatch(/^[0-9a-f]{64}$/u)
    expect(options.acceptanceMessageIdDigest("101")).toMatch(/^[0-9a-f]{64}$/u)
    runtimeMocks.tokenState.value = undefined
    await expect(options.resolveDecisionToken("missing")).resolves.toBe("")
    await options.commitAcceptanceEvidence("telegram.callback_settled", { kind: "live" })
    await options.commitAcceptanceEvidence("telegram.callback_recovery_settled", { kind: "recovery" })
    expect(runtimeMocks.emitNervesEventDurable).toHaveBeenCalledTimes(2)

    createTelegramApprovalRuntime({
      agentName: "sanctuary", api: { request: vi.fn(), stop: vi.fn() }, authorizedUserId: "10", authorizedChatId: "20",
      subject: "tg_stable-subject", identityKey: "k".repeat(43), toolContext: { agentName: "sanctuary" },
      effects: { sendText: vi.fn(), sendCard: vi.fn(), edit: vi.fn(), acknowledge: vi.fn() },
    })
    expect(() => transportOptions().effectBarrier()).not.toThrow()
  })
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
      prompt: "Restart calibre-web?",
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
    runtimeMocks.resumeApprovalContinuation.mockImplementation(async (options) => { await options.revalidate(); await options.deliver("observed restart result") })
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
    runtimeMocks.sendTelegramText.mockResolvedValueOnce(undefined)
    await transportOptions().onDecision({ approvalId: "approval-1", acceptanceBinding })
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
    runtimeMocks.executeApprovalDecision.mockImplementation(async (options) => {
      await expect(options.liveGuard()).resolves.toEqual({ ok: true })
      await expect(options.liveRisk()).resolves.toEqual({ ok: true })
      const definition = await options.resolveTool("unraid_restart_container")
      expect(definition).toBeDefined()
      await expect(options.preflight({ record: baseRecord, arguments: baseRecord.arguments, definition })).resolves.toEqual({ ok: true })
      await expect(options.execute("unraid_restart_container", baseRecord.arguments)).resolves.toMatchObject({ kind: "handler_succeeded" })
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
    expect(runtimeMocks.executeTool).toHaveBeenCalledWith("unraid_restart_container", baseRecord.arguments, expect.objectContaining({
      agentName: "sanctuary", agentRoot: "/agents/sanctuary.ouro",
      relationshipAuthorization: expect.objectContaining({ profileId: "sanctuary-owner" }),
    }), undefined)
  })

  it("does not let a proposed approval replace a lost relationship capability", async () => {
    const authorizeTool = vi.fn(async () => ({ allowed: false as const, reason: "relationship revoked" }))
    makeRuntime(vi.fn(), { agentName: "sanctuary", relationshipAuthorization: { authorizedContextScopes: [], advertisedToolNames: [], authorizeTool } })
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "proposed" })
    runtimeMocks.selectToolsForChannel.mockReturnValue({ ordinary: [], engine: [] })
    runtimeMocks.executeApprovalDecision.mockImplementation(async (options) => {
      await expect(options.resolveTool("unraid_restart_container")).resolves.toBeUndefined()
      await expect(options.execute("unraid_restart_container", { container: "calibre-web" })).resolves.toMatchObject({ kind: "rejected_before_handler" })
      return { ...baseRecord, state: "drifted" }
    })

    await expect(transportOptions().onDecision({ approvalId: "approval-1", decision: "approve" })).resolves.toMatchObject({ accepted: false })
    expect(runtimeMocks.executeTool).not.toHaveBeenCalled()
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
    expect(runtimeMocks.tokens.remove).not.toHaveBeenCalled()
  })

  it("retains the decision token while reporting a missing continuation checkpoint", async () => {
    makeRuntime()
    const options = transportOptions()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "failed" })
    runtimeMocks.checkpoints.read.mockReturnValue(undefined)

    await expect(options.onDecision({ approvalId: "approval-1" })).resolves.toEqual({
      accepted: false,
      terminalText: "⚠️ Approval checkpoint is unavailable",
    })
    expect(runtimeMocks.resumeApprovalContinuation).not.toHaveBeenCalled()
    expect(runtimeMocks.tokens.remove).not.toHaveBeenCalled()
    await expect(options.resolveDecisionToken("approval-1")).resolves.toBe("server-secret")
  })

  it("retains the decision token when a continuation attempt fails", async () => {
    makeRuntime()
    const options = transportOptions()
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "failed" })
    runtimeMocks.resumeApprovalContinuation.mockRejectedValueOnce(new Error("resume state is unavailable"))

    await expect(options.onDecision({ approvalId: "approval-1" })).rejects.toThrow("resume state is unavailable")
    expect(runtimeMocks.tokens.remove).not.toHaveBeenCalled()
    await expect(options.resolveDecisionToken("approval-1")).resolves.toBe("server-secret")
  })

  it("consumes the decision token only after durable settlement completes", async () => {
    makeRuntime()
    await transportOptions().onSettlementComplete("approval-1")
    expect(runtimeMocks.tokens.remove).toHaveBeenCalledWith("approval-1")
  })

  it("wires continuation claims, persistence, delivery, and recursively gated proposals", async () => {
    makeRuntime()
    runtimeMocks.sendTelegramText.mockResolvedValueOnce([])
    runtimeMocks.saveSession.mockReturnValueOnce([{
      id: "evt-000009", role: "assistant", content: "done", toolCalls: [],
    }])
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, state: "succeeded" })
    runtimeMocks.resumeApprovalContinuation.mockImplementation(async (options) => {
      const currentOptions = await options.revalidate()
      expect(options.claimContinuation()).toEqual(expect.objectContaining({ claimed: true }))
      options.markContinuationMaterialized()
      options.markContinuationAttempted()
      options.completeContinuation()
      await options.persist([{ role: "assistant", content: "done" }], { usage: { inputTokens: 1 } })
      await options.deliver("calibre-web is back")
      await currentOptions.approvalCoordinator.propose({
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
    expect(runtimeMocks.approvalSendText).toHaveBeenCalledWith(expect.objectContaining({ causalEventId: "evt-000009" }))
    expect(runtimeMocks.readSessionTransaction).toHaveBeenCalledTimes(2)
  })

  it("reconciles terminal tombstones, missing journals, and interrupted prompt deliveries", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([
      { approvalId: "terminal", messageId: null, deliveryState: "delivery_indeterminate", terminalKind: "delivery_interruption", terminal: { accepted: false, terminalText: "already terminal" } },
      { approvalId: "missing" },
      { approvalId: "missing-terminal", messageId: null, deliveryState: "delivery_indeterminate", terminalKind: "delivery_interruption", terminal: { accepted: false, terminalText: "interrupted" } },
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
      "⚠️ Approval record is unavailable — the action outcome is unknown and will not be retried",
    )
    expect(runtimeMocks.transport.terminalizeOrphaned).toHaveBeenCalledWith(
      "missing-terminal",
      "⚠️ Approval record is unavailable — the action outcome is unknown and will not be retried",
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
      { approvalId: "first", messageId: null, deliveryState: "delivery_indeterminate", terminalKind: "delivery_interruption", terminal: { accepted: false, terminalText: "first terminal" } },
      { approvalId: "second", messageId: null, deliveryState: "delivery_indeterminate", terminalKind: "delivery_interruption", terminal: { accepted: false, terminalText: "second terminal" } },
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

  it("fails startup when a fenced decision cannot be recovered instead of falling through to expiry", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "fenced",
      deliveryState: "bound",
      messageId: "101",
      decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve", queryIdDigest: "a".repeat(64), attemptedAt: 1, evidenceMac: "b".repeat(64) },
    }])
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, approvalId: "fenced", state: "proposed" })
    runtimeMocks.transport.recoverDecisionAttempt.mockRejectedValue(new Error("temporary decision recovery failure"))

    await expect(runtime.recover()).rejects.toThrow("temporary decision recovery failure")

    expect(runtimeMocks.transport.reconcileExpired).not.toHaveBeenCalled()
    expect(runtimeMocks.transport.terminalizeRecovered).not.toHaveBeenCalled()
    expect(runtimeMocks.emitNervesEvent).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      event: "senses.telegram_approval_recovery_error",
      meta: { failureCount: 1 },
    }))
  })

  it("fails startup and preserves transport state when a fenced decision has no canonical journal row", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "missing-fenced", deliveryState: "bound", messageId: "101",
      decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1", decision: "approve", queryIdDigest: "a".repeat(64), attemptedAt: 1, evidenceMac: "b".repeat(64) },
    }])
    runtimeMocks.store.read.mockReturnValue(undefined)

    await expect(runtime.recover()).rejects.toThrow("fenced approval journal")

    expect(runtimeMocks.transport.terminalizeOrphaned).not.toHaveBeenCalled()
    expect(runtimeMocks.transport.recoverDecisionAttempt).not.toHaveBeenCalled()
  })

  it.each(["terminalMac", "settlementReceipt"] as const)("fails startup and preserves a partial %s authority record without a canonical journal", async (field) => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "partial-authority", deliveryState: "bound", messageId: "101",
      terminal: { accepted: true, terminalText: "tampered" },
      ...(field === "terminalMac" ? { terminalMac: "a".repeat(64) } : { settlementReceipt: { schemaVersion: "telegram-approval-settlement-receipt-v1" } }),
    }])
    runtimeMocks.store.read.mockReturnValue(undefined)

    await expect(runtime.recover()).rejects.toThrow("structurally incomplete")

    expect(runtimeMocks.transport.terminalizeOrphaned).not.toHaveBeenCalled()
    expect(runtimeMocks.transport.terminalizeRecovered).not.toHaveBeenCalled()
  })

  it("rejects a partial authority record structurally before routing even when its journal exists", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "partial-authority", deliveryState: "bound", messageId: "101",
      terminal: { accepted: false, terminalText: "altered" }, terminalMac: "a".repeat(64),
    }])
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, approvalId: "partial-authority", state: "succeeded" })

    await expect(runtime.recover()).rejects.toThrow("structurally incomplete")

    expect(runtimeMocks.transport.recoverDecisionAttempt).not.toHaveBeenCalled()
    expect(runtimeMocks.transport.terminalizeRecovered).not.toHaveBeenCalled()
  })

  it.each(["", "x".repeat(4_097)])("fails startup for a typed delivery interruption with invalid terminal text length", async (terminalText) => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "invalid-interruption", messageId: null, deliveryState: "delivery_indeterminate",
      terminalKind: "delivery_interruption", terminal: { accepted: false, terminalText },
    }])
    runtimeMocks.store.read.mockReturnValue(undefined)

    await expect(runtime.recover()).rejects.toThrow("delivery-interruption terminal state is invalid")

    expect(runtimeMocks.transport.terminalizeOrphaned).not.toHaveBeenCalled()
    expect(runtimeMocks.transport.terminalizeRecovered).not.toHaveBeenCalled()
  })

  it.each(["succeeded", "denied"])("routes a persisted decision attempt through authenticated recovery even when the journal is already %s", async (state) => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{
      approvalId: "late-terminal", deliveryState: "bound", messageId: "101", terminal: { accepted: state === "succeeded", terminalText: "terminal" },
      terminalMac: "c".repeat(64),
      decisionAttempt: { schemaVersion: "telegram-approval-decision-attempt-v1", decision: state === "succeeded" ? "approve" : "deny", queryIdDigest: "a".repeat(64), attemptedAt: 1, evidenceMac: "b".repeat(64) },
    }])
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, approvalId: "late-terminal", state })

    await runtime.recover()

    expect(runtimeMocks.transport.recoverDecisionAttempt).toHaveBeenCalledWith("late-terminal")
    expect(runtimeMocks.transport.terminalizeRecovered).not.toHaveBeenCalled()
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

  it("reconciles an expired nonterminal pending prompt during startup", async () => {
    const runtime = makeRuntime()
    runtimeMocks.transport.listPendingDeliveries.mockReturnValue([{ approvalId: "expired", deliveryState: "bound", messageId: "101" }])
    runtimeMocks.store.read.mockReturnValue({ ...baseRecord, approvalId: "expired", state: "expired" })

    await runtime.recover()

    expect(runtimeMocks.transport.reconcileExpired).toHaveBeenCalledOnce()
    expect(runtimeMocks.resumeApprovalContinuation).not.toHaveBeenCalled()
  })

  it("rejects unsupported durable settlement evidence before emitting it", async () => {
    makeRuntime()
    const transportOptions = runtimeMocks.createTelegramApprovalTransport.mock.calls.at(-1)?.[0] as {
      commitAcceptanceEvidence(event: string, meta: Record<string, unknown>): Promise<void>
    }

    await expect(transportOptions.commitAcceptanceEvidence("telegram.unsupported", {}))
      .rejects.toThrow("unsupported")
  })
})
