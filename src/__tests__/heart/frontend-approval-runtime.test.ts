import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApprovalProposalRequest, ChannelCallbacks } from "../../heart/core"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { ToolContext } from "../../repertoire/tools-base"
import type { FrontendTurnRequest } from "../../heart/frontend-session-service"
import type { FrontendTurnEvent, RunSenseTurnResult } from "../../senses/shared-turn"
import { a003RetainedHistoryEnvelope } from "../fixtures/a003-session"
import { channelToFacing } from "@ouro.bot/friends"
import { approvalPolicyForInvocation, executeTool, preflightToolCall, resolveToolDefinition, selectToolsForChannel } from "../../repertoire/tools"
import type { ExecuteApprovalDecisionOptions } from "../../heart/tool-approval"
import { ApprovalExecutionFailedError, digestApprovalToolDefinition, executeApprovalDecision } from "../../heart/tool-approval"
import { resumeApprovalContinuation } from "../../heart/core"
import { readSessionTransaction, withSessionTurnLease } from "../../mind/session-transaction"
import { loadSession, postTurnPersist } from "../../mind/context"
import { withTurnExecutionLease } from "../../heart/turn-execution-lease"
import { openApprovalStore } from "../../heart/approval-store"
import { digestJson, validateAdvertisedToolArguments } from "../../repertoire/tool-arguments"
import { createMinimaxProviderRuntime } from "../../heart/providers/minimax"

function turn(): FrontendTurnRequest {
  return {
    turnId: "turn-1",
    agent: "boss",
    friendId: "11111111-1111-4111-8111-111111111111",
    channel: "mcp",
    sessionKey: "session-1",
    message: "restart it",
  }
}

function proposal(): ApprovalProposalRequest {
  return {
    toolCall: {
      id: "call-1",
      type: "function",
      function: { name: "unraid_restart_container", arguments: '{"container":"calibre-web"}' },
    },
    arguments: { container: "calibre-web" },
    preCallMessages: [{ role: "user", content: "restart it" }],
    frozenAssistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call-1",
        type: "function",
        function: { name: "unraid_restart_container", arguments: '{"container":"calibre-web"}' },
      }],
    },
    schemaDigest: "a".repeat(64),
    toolDigest: "b".repeat(64),
    policyDigest: "c".repeat(64),
    policyId: "unraid.restart.v1",
    actionClass: "unraid.container.restart",
  }
}

function settled(response = "done"): RunSenseTurnResult {
  return {
    response,
    ponderDeferred: false,
    deliveries: [],
    deliveryFailures: [],
    turnOutcome: "settled",
  }
}

describe("frontend approval runtime", () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  it("durably binds a proposal before publishing and settles one correlated answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-approval-"))
    roots.push(root)
    const published: Array<{ type: string; data: Record<string, unknown>; journalType?: string }> = []
    const settleApproval = vi.fn(async (input: any) => {
      expect(input.approvalStore.read(input.suspension.approvalId)?.state).toBe("proposed")
      expect(input.tokenStore.get(input.suspension.approvalId)).toBeTruthy()
      return settled()
    })
    const { createFrontendApprovalRuntime } = await import("../../heart/frontend-approval-runtime")
    const runtime = createFrontendApprovalRuntime({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      settleApproval,
    })
    const request = turn()
    const coordinator = runtime.approvalCoordinatorFactory({
      request,
      publish: (type, data, journalType) => published.push({ type, data, journalType }),
    })({
      sessionPath: path.join(root, "boss.ouro", "state", "sessions", request.friendId, "mcp", "session-1.json"),
      baseSessionRevision: "d".repeat(64),
    })

    const suspension = await coordinator.propose(proposal())

    expect(runtime.pendingPermissions({
      agent: request.agent,
      friendId: request.friendId,
      sessionKey: request.sessionKey,
    })).toEqual([{
      requestId: suspension.approvalId,
      turnId: request.turnId,
      toolCallId: "call-1",
      title: "Approve unraid_restart_container",
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    }])
    expect(runtime.pendingPermissions({
      agent: request.agent,
      friendId: "other",
      sessionKey: request.sessionKey,
    })).toEqual([])
    expect(published).toEqual([{
      type: "permission_requested",
      journalType: "permission_requested",
      data: {
        requestId: suspension.approvalId,
        toolCallId: "call-1",
        title: "Approve unraid_restart_container",
        options: [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    }])
    expect(runtime.resolvePermission(suspension.approvalId, "allow-once")).toBe(true)
    expect(runtime.pendingPermissions({
      agent: request.agent,
      friendId: request.friendId,
      sessionKey: request.sessionKey,
    })).toEqual([])
    expect(runtime.resolvePermission(suspension.approvalId, "reject-once")).toBe(false)
    await expect(runtime.resumeApproval({
      request,
      suspension,
      signal: new AbortController().signal,
      frontendEventSink: { onEvent: vi.fn() },
    })).resolves.toMatchObject({ turnOutcome: "settled", response: "done" })
    expect(settleApproval).toHaveBeenCalledWith(expect.objectContaining({
      optionId: "allow-once",
      request,
      suspension,
    }))
    expect(published.at(-1)).toEqual({
      type: "permission_resolved",
      journalType: "permission_resolved",
      data: { requestId: suspension.approvalId, optionId: "allow-once" },
    })
    runtime.close()
  })

  it("settles cancellation, abort, and expiry without accepting a late answer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-approval-terminal-"))
    roots.push(root)
    const settledOptions: string[] = []
    const { createFrontendApprovalRuntime } = await import("../../heart/frontend-approval-runtime")
    const runtime = createFrontendApprovalRuntime({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      approvalTimeoutMs: 10,
      settleApproval: async (input) => {
        settledOptions.push(input.optionId)
        return settled(input.optionId)
      },
    })

    async function create(turnId: string) {
      const request = { ...turn(), turnId, sessionKey: turnId }
      const suspension = await runtime.approvalCoordinatorFactory({
        request,
        publish: () => undefined,
      })({
        sessionPath: path.join(root, "boss.ouro", "state", "sessions", request.friendId, "mcp", `${turnId}.json`),
        baseSessionRevision: "d".repeat(64),
      }).propose(proposal())
      return { request, suspension }
    }

    const cancelled = await create("cancelled")
    const cancelling = runtime.resumeApproval({
      ...cancelled,
      signal: new AbortController().signal,
      frontendEventSink: { onEvent: vi.fn() },
    })
    runtime.cancelTurn("other-turn")
    runtime.cancelTurn("cancelled")
    await expect(cancelling).resolves.toMatchObject({ response: "cancelled" })
    expect(runtime.resolvePermission(cancelled.suspension.approvalId, "allow-once")).toBe(false)

    const aborted = await create("aborted")
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.resumeApproval({
      ...aborted,
      signal: controller.signal,
      frontendEventSink: { onEvent: vi.fn() },
    })).resolves.toMatchObject({ response: "cancelled" })

    const expired = await create("expired")
    await expect(runtime.resumeApproval({
      ...expired,
      signal: new AbortController().signal,
      frontendEventSink: { onEvent: vi.fn() },
    })).resolves.toMatchObject({ response: "expired" })
    expect(settledOptions).toEqual(["cancelled", "cancelled", "expired"])
    runtime.close()
  })

  it("rejects invalid requests, options, ownership, and closed state", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-approval-invalid-"))
    roots.push(root)
    const { createFrontendApprovalRuntime } = await import("../../heart/frontend-approval-runtime")
    const runtime = createFrontendApprovalRuntime({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      settleApproval: async () => settled(),
    })
    const request = turn()
    const coordinator = runtime.approvalCoordinatorFactory({
      request,
      publish: () => undefined,
    })({
      sessionPath: path.join(root, "boss.ouro", "state", "sessions", request.friendId, "mcp", "session-1.json"),
      baseSessionRevision: "d".repeat(64),
    })

    await expect(coordinator.propose({
      ...proposal(),
      toolCall: { id: "call-1", type: "custom" },
    } as never)).rejects.toThrow("function tool call")
    const suspension = await coordinator.propose(proposal())
    expect(runtime.resolvePermission("missing", "allow-once")).toBe(false)
    expect(runtime.resolvePermission(suspension.approvalId, "allow-always")).toBe(false)
    await expect(runtime.resumeApproval({
      request: { ...request, turnId: "other-turn" },
      suspension,
      signal: new AbortController().signal,
      frontendEventSink: { onEvent: vi.fn() },
    })).rejects.toThrow("does not own")
    runtime.close()
    expect(runtime.resolvePermission(suspension.approvalId, "reject-once")).toBe(false)
  })
})

describe("frontend approval settlement", () => {
  function settlementFixture() {
    const leaseOrder: string[] = []
    const revision = { value: "d".repeat(64) }
    const record = {
      approvalId: "approval-1",
      state: "proposed",
      toolCallId: "call-1",
      toolName: "unraid_restart_container",
      arguments: { container: "calibre-web" },
      argumentDigest: "e".repeat(64),
      schemaDigest: "a".repeat(64),
      toolDigest: "b".repeat(64),
      policyDigest: "c".repeat(64),
      policyId: "unraid.restart.v1",
      sessionKey: "session-1",
      sessionPath: "/sessions/frontend.json",
      baseSessionRevision: revision.value,
      suspendedSessionRevision: revision.value,
      checkpointDigest: "f".repeat(64),
      requesterId: turn().friendId,
      transport: "frontend",
      transportUserId: turn().friendId,
      transportChatId: "session-1",
      transportMessageId: "approval-1",
      decisionTokenDigest: "0".repeat(64),
      expiresAt: "2026-09-04T00:05:00.000Z",
      createdAt: "2026-09-04T00:00:00.000Z",
      updatedAt: "2026-09-04T00:00:00.000Z",
      ownerId: null,
      epoch: 0,
      attemptedAt: null,
      result: null,
      reason: null,
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    }
    const checkpoint = {
      approvalId: record.approvalId,
      checkpointDigest: record.checkpointDigest,
      baseSessionRevision: record.baseSessionRevision,
      suspendedSessionRevision: record.suspendedSessionRevision,
      argumentDigest: record.argumentDigest,
      schemaDigest: record.schemaDigest,
      toolDigest: record.toolDigest,
      policyDigest: record.policyDigest,
      preCallDigest: "1".repeat(64),
      preCallMessages: proposal().preCallMessages,
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    }
    const approvalStore = {
      read: vi.fn(() => record),
      claimContinuation: vi.fn(() => ({ claimed: true, interruptedAfterAttempt: false, record: { ...record, continuationEpoch: 1 } })),
      markContinuationMaterialized: vi.fn(),
      markContinuationAttempted: vi.fn(),
      completeContinuation: vi.fn(),
    }
    const checkpointStore = { read: vi.fn(() => checkpoint) }
    const tokenStore = { get: vi.fn(() => "decision-token"), remove: vi.fn() }
    const events: any[] = []
    const nestedPropose = vi.fn(async () => ({
      approvalId: "approval-2",
      checkpointDigest: "2".repeat(64),
      suspendedSessionRevision: revision.value,
    }))
    const nestedFactory = vi.fn(() => ({ propose: nestedPropose }))
    const approvalCoordinatorFactory = vi.fn(() => nestedFactory)
    const executeTool = vi.fn(async () => ({ kind: "handler_succeeded", text: "restarted" }))
    const definition = resolveToolDefinition(record.toolName)!
    const selection = Object.freeze({ ordinary: Object.freeze([definition]), engine: Object.freeze([]) })
    const providerRuntime = { model: "fixture-model", capabilities: new Set() }
    const executeApprovalDecision = vi.fn(async (options: any) => {
      await options.resolveTool(record.toolName)
      await options.resolveApprovalPolicy(record.toolName, record.arguments)
      await options.liveGuard({})
      await options.liveRisk({})
      await options.execute(record.toolName, record.arguments)
      return { ...record, state: "succeeded", result: "restarted" }
    })
    const postTurnPersist = vi.fn(() => {
      revision.value = "9".repeat(64)
      return []
    })
    const loadSession = vi.fn()
      .mockReturnValueOnce({ state: { version: 1 }, structuredOutputs: [{ id: "existing", kind: "ordered_list", items: [] }] })
      .mockReturnValue({
        state: { version: 1 },
        structuredOutputs: [
          { id: "existing", kind: "ordered_list", items: [] },
          { id: "plan-1", kind: "ordered_list", items: [{ text: "done" }] },
        ],
      })
    const resumeApprovalContinuation = vi.fn(async (options: any) => {
      await options.persist([{ role: "user", content: "restart it" }])
      options.callbacks.onModelStart()
      options.callbacks.onModelStreamStart()
      options.callbacks.onReasoningChunk("thinking")
      options.callbacks.onTextChunk("discarded")
      options.callbacks.onClearText()
      options.callbacks.onTextChunk("done")
      options.callbacks.onToolStart("read_file", { path: "a" })
      options.callbacks.onToolEnd("read_file", "ok", true)
      options.callbacks.onError(new Error("transient"), "transient")
      await options.runAgentOptions.approvalCoordinator.propose(proposal())
      await options.persist([{ role: "assistant", content: "done" }], {
        usage: { input_tokens: 1, output_tokens: 1 },
        outcome: "settled",
      })
      options.claimContinuation()
      await options.markContinuationMaterialized()
      await options.markContinuationAttempted()
      await options.completeContinuation()
      await options.deliver("done")
      return { outcome: "settled", messages: [] }
    })
    const liveToolContext = { signin: vi.fn(), currentUserMessage: "restart it" } as unknown as ToolContext
    return {
      input: {
        request: turn(),
        approvalRequest: { ...proposal(), liveToolContext } as ApprovalProposalRequest,
        suspension: {
          approvalId: record.approvalId,
          toolCallId: record.toolCallId,
          checkpointDigest: record.checkpointDigest,
          suspendedSessionRevision: record.suspendedSessionRevision,
        },
        optionId: "allow-once" as const,
        signal: new AbortController().signal,
        frontendEventSink: { onEvent: (event: any) => events.push(event) },
        publish: vi.fn(),
        agentRoot: "/agents/boss.ouro",
        approvalStore: approvalStore as any,
        checkpointStore: checkpointStore as any,
        tokenStore: tokenStore as any,
        approvalCoordinatorFactory,
      },
      deps: {
        withTurnExecutionLease: async (work: () => Promise<unknown>) => {
          leaseOrder.push("lease:start")
          try {
            return await work()
          } finally {
            leaseOrder.push("lease:end")
          }
        },
        setAgentName: vi.fn(),
        withSessionTurnLease: async (_path: string, work: (lease: object) => Promise<unknown>) => work({ lease: true }),
        readSessionTransaction: vi.fn(() => ({ revision: revision.value })),
        executeApprovalDecision,
        resolveToolDefinition: vi.fn(resolveToolDefinition),
        approvalPolicyForInvocation: vi.fn(async () => ({ kind: "required", policyId: record.policyId })),
        executeTool,
        preflightToolCall: vi.fn(async () => ({ kind: "ready" })),
        selectToolsForChannel: vi.fn(() => selection),
        getProviderRuntime: vi.fn(async () => providerRuntime),
        getSharedMcpManager: vi.fn(async () => ({ manager: true })),
        releaseRuntimeMcpServers: vi.fn(async () => {
          leaseOrder.push("runtime:release")
        }),
        loadSession,
        postTurnTrim: vi.fn((messages) => ({ messages })),
        postTurnPersist,
        resumeApprovalContinuation,
        runAgent: vi.fn(),
        randomUUID: vi.fn(() => "continuation-owner"),
      },
      events,
      record,
      checkpoint,
      liveToolContext,
      nestedPropose,
      nestedFactory,
      approvalCoordinatorFactory,
      executeApprovalDecision,
      executeTool,
      leaseOrder,
      postTurnPersist,
      tokenStore,
      definition,
      selection,
      providerRuntime,
    }
  }

  it("refreshes exact owner metadata, selection and preflight before execution and continuation", async () => {
    const fixture = settlementFixture()
    const envelope = {
      profileId: "scoped-profile",
      authorizedContextScopes: ["session.read"],
      advertisedToolNames: [fixture.record.toolName],
      actor: { friendId: turn().friendId, trustLevel: "family" as const, sessionEventId: "evt-1" },
      authorizeTool: vi.fn(() => ({ allowed: true as const, receiptId: "current" })),
    }
    const refresh = vi.fn(async () => envelope)
    Object.assign(fixture.liveToolContext, {
      agentName: "boss", agentRoot: fixture.input.agentRoot,
      relationshipAuthorization: { ...envelope, resolveCurrent: refresh },
    })
    fixture.deps.executeApprovalDecision.mockImplementationOnce(async (options: ExecuteApprovalDecisionOptions) => {
      const definition = await options.resolveTool(fixture.record.toolName)
      expect(definition).toBe(fixture.definition)
      await options.resolveApprovalPolicy(fixture.record.toolName, fixture.record.arguments)
      expect(await options.preflight({
        record: fixture.record as never, arguments: fixture.record.arguments, definition: definition!,
      })).toEqual({ ok: true })
      expect(await options.execute(fixture.record.toolName, fixture.record.arguments))
        .toEqual({ kind: "handler_succeeded", text: "restarted" })
      return { ...fixture.record, state: "succeeded", result: "restarted" }
    })
    fixture.deps.resumeApprovalContinuation.mockImplementationOnce(async (options) => {
      const current = await options.revalidate()
      expect(current.toolContext.relationshipAuthorization).toBe(envelope)
      expect(current.toolContext.toolSelection).toBe(fixture.selection)
      expect(current.providerRuntimeOverride).toBe(fixture.providerRuntime)
      expect(current.approvalCoordinator).toBeDefined()
      return { outcome: "settled", messages: [] }
    })
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")
    await settleFrontendApproval(fixture.input, fixture.deps as never)
    expect(refresh.mock.calls.length).toBeGreaterThanOrEqual(5)
    expect(fixture.deps.getProviderRuntime).toHaveBeenCalledWith(channelToFacing(turn().channel), {
      agentName: "boss", agentRoot: fixture.input.agentRoot,
    })
    expect(fixture.deps.preflightToolCall).toHaveBeenCalledWith(fixture.record.toolName, fixture.record.arguments, expect.objectContaining({
      agentName: "boss", agentRoot: fixture.input.agentRoot,
      relationshipAuthorization: envelope, selectCurrentTools: expect.any(Function),
    }))
  })

  it.each(["missing-producer", "missing-name", "missing-root", "revoked", "non-error", "wrong-name", "wrong-root", "unscoped-wrong-name", "unscoped-wrong-root", "wrong-friend", "profile", "trust", "scopes", "provider", "mcp"] as const)(
    "fails closed instead of borrowing suspended frontend authority: %s",
    async (change) => {
      const fixture = settlementFixture()
      const envelope = {
        profileId: "scoped-profile",
        authorizedContextScopes: ["session.read"],
        advertisedToolNames: [fixture.record.toolName],
        actor: { friendId: turn().friendId, trustLevel: "family" as const, sessionEventId: "evt-1" },
        authorizeTool: vi.fn(() => ({ allowed: true as const, receiptId: "stale" })),
      }
      const current = { ...envelope, actor: { ...envelope.actor, trustLevel: change === "trust" ? "stranger" as const : envelope.actor.trustLevel } }
      const refresh = vi.fn(async () => current)
      Object.assign(fixture.liveToolContext, {
        agentName: change === "wrong-name" || change === "unscoped-wrong-name" ? "other" : "boss",
        agentRoot: change === "wrong-root" || change === "unscoped-wrong-root" ? "/agents/other.ouro" : fixture.input.agentRoot,
        relationshipAuthorization: { ...envelope, ...(change === "missing-producer" ? {} : { resolveCurrent: refresh }) },
      })
      if (change === "missing-name") delete fixture.liveToolContext.agentName
      if (change === "missing-root") delete fixture.liveToolContext.agentRoot
      if (change.startsWith("unscoped-")) delete fixture.liveToolContext.relationshipAuthorization
      if (change === "revoked") refresh.mockRejectedValue(new Error("relationship revoked"))
      if (change === "non-error") refresh.mockRejectedValue("relationship revoked")
      if (change === "wrong-friend") current.actor.friendId = "other"
      if (change === "profile") current.profileId = "different-profile"
      if (change === "scopes") current.authorizedContextScopes = []
      if (change === "provider") fixture.deps.getProviderRuntime.mockRejectedValue(new Error("provider unavailable"))
      if (change === "mcp") fixture.deps.getSharedMcpManager.mockRejectedValue(new Error("MCP configuration unavailable"))
      fixture.deps.executeApprovalDecision.mockImplementationOnce(async (options: ExecuteApprovalDecisionOptions) => {
        expect(await options.resolveTool(fixture.record.toolName)).toBeUndefined()
        expect(await options.resolveApprovalPolicy(fixture.record.toolName, fixture.record.arguments)).toEqual({ kind: "not_required" })
        expect(await options.preflight({
          record: fixture.record as never, arguments: fixture.record.arguments, definition: fixture.definition,
        })).toMatchObject({ ok: false })
        expect(await options.execute(fixture.record.toolName, fixture.record.arguments)).toMatchObject({ kind: "rejected_before_handler" })
        return { ...fixture.record, state: "drifted", result: null }
      })
      fixture.deps.resumeApprovalContinuation.mockImplementationOnce(async (options) => {
        expect(await options.revalidate()).toBeNull()
        return { outcome: "terminal_notice", messages: [] }
      })
      const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")
      await settleFrontendApproval(fixture.input, fixture.deps as never)
      expect(fixture.executeTool).not.toHaveBeenCalled()
      expect(fixture.deps.runAgent).not.toHaveBeenCalled()
    },
  )

  it("keeps disabled frontend approvals empty without MCP startup or cleanup", async () => {
    const fixture = settlementFixture()
    fixture.input.request.disableTools = true
    fixture.input.request.runtimeMcpServers = { ignored: { command: "must-not-start" } }
    fixture.deps.executeApprovalDecision.mockImplementationOnce(async (options: ExecuteApprovalDecisionOptions) => {
      expect(await options.resolveTool(fixture.record.toolName)).toBeUndefined()
      return { ...fixture.record, state: "drifted", result: null }
    })
    fixture.deps.resumeApprovalContinuation.mockImplementationOnce(async (options) => {
      expect(await options.revalidate()).toMatchObject({
        hardDisableTools: true, tools: [],
        toolContext: { toolSelection: { ordinary: [], engine: [] } },
      })
      return { outcome: "settled", messages: [] }
    })
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")
    await settleFrontendApproval(fixture.input, fixture.deps as never)
    expect(fixture.deps.getSharedMcpManager).not.toHaveBeenCalled()
    expect(fixture.deps.releaseRuntimeMcpServers).not.toHaveBeenCalled()
    expect(fixture.deps.selectToolsForChannel).not.toHaveBeenCalled()
    expect(fixture.executeTool).not.toHaveBeenCalled()
  })

  it.each(["unchanged", "retained-history", "before-decision", "guard-held", "after-attempt", "before-continuation", "known-failure", "uncertain-effect"] as const)(
    "uses the real store, dispatcher and continuation without replay: %s",
    async (change) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-native-approval-"))
      const fixture = settlementFixture()
      const request = { ...turn(), agent: "sanctuary" }
      const sessionPath = path.join(root, "state", "sessions", request.friendId, request.channel, "session-1.json")
      const retainedHistory = change === "retained-history" ? a003RetainedHistoryEnvelope() : null
      if (retainedHistory) {
        retainedHistory.events[4]!.content = request.message
        retainedHistory.projection = { ...retainedHistory.projection, eventIds: ["evt-000005"], trimmed: true }
        fs.mkdirSync(path.dirname(sessionPath), { recursive: true })
        fs.writeFileSync(sessionPath, JSON.stringify(retainedHistory), { mode: 0o600 })
        expect(loadSession(sessionPath)!.structuredOutputs).toEqual([])
      }
      const frontendEvents: FrontendTurnEvent[] = []
      const answer = retainedHistory ? "New choices:\n1. Completed\n2. Ready" : change === "known-failure" ? "The action failed." : "The action completed."
      let active = true
      let effects = 0
      const handler = vi.fn(async () => {
        if (change === "known-failure") throw new ApprovalExecutionFailedError("verified action failure")
        effects += 1
        if (change === "uncertain-effect") throw new Error("response lost after effect")
        return { ok: true }
      })
      const model = vi.fn(async (messages: ChatCompletionMessageParam[], callbacks: ChannelCallbacks) => {
        callbacks.onTextChunk(answer)
        if (retainedHistory) messages.push({ role: "assistant", content: answer })
        return { outcome: "settled" as const }
      })
      const relationship = {
        profileId: "sanctuary-owner", authorizedContextScopes: ["session.read"], advertisedToolNames: ["unraid_restart_container"],
        actor: { friendId: request.friendId, trustLevel: "family" as const, sessionEventId: retainedHistory ? "evt-000005" : "fixture-ingress" },
        authorizeTool: async () => active ? { allowed: true as const, receiptId: "current-owner" } : { allowed: false as const, reason: "revoked" },
        resolveCurrent: async () => {
          if (!active) throw new Error("revoked")
          return relationship
        },
      }
      const liveToolContext: ToolContext = {
        signin: async () => undefined, agentName: request.agent, agentRoot: root, relationshipAuthorization: relationship,
        currentSession: { friendId: request.friendId, channel: request.channel, key: request.sessionKey, sessionPath },
        context: { friend: { id: request.friendId, trustLevel: "family" }, channel: request.channel } as ToolContext["context"],
        sanctuary: { restartContainer: handler } as ToolContext["sanctuary"],
      }
      if (change === "guard-held") liveToolContext.orientationFrame = {
        actionPolicy: { mode: "correction_hold", blockedMutationKinds: ["external_side_effect"], reason: "current guard hold" },
      } as ToolContext["orientationFrame"]
      const { createFrontendApprovalRuntime, settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")
      const runtime = createFrontendApprovalRuntime({
        agentRoot: () => root,
        settleApproval: (input) => settleFrontendApproval(input, {
          ...fixture.deps,
          withTurnExecutionLease, withSessionTurnLease, readSessionTransaction,
          executeApprovalDecision: (options) => executeApprovalDecision({
            ...options, hooks: { ...options.hooks, afterAttempt: async (context) => {
              await options.hooks?.afterAttempt?.(context)
              if (change === "after-attempt") active = false
            } },
          }),
          executeTool: async (name, args, context) => {
            const outcome = await executeTool(name, args, context)
            if (change === "before-continuation") active = false
            return outcome
          },
          approvalPolicyForInvocation, resolveToolDefinition, selectToolsForChannel, preflightToolCall,
          getProviderRuntime: async () => createMinimaxProviderRuntime("MiniMax-M3", { apiKey: "isolated-fixture" }),
          getSharedMcpManager: async () => null,
          loadSession, postTurnPersist, resumeApprovalContinuation, runAgent: model,
          postTurnTrim: (messages) => ({
            currentMessages: [...messages], trimmedMessages: [...messages],
            currentIngressTimes: messages.map(() => null), currentIngressRelations: messages.map(() => null),
            maxTokens: 80_000, contextMargin: 20,
          }),
        }),
      })
      try {
        const definition = resolveToolDefinition("unraid_restart_container")!
        const draft = proposal()
        const validation = validateAdvertisedToolArguments(JSON.stringify(draft.arguments), definition.tool.function.parameters!)
        if (!validation.ok) throw new Error(validation.reason)
        const policy = definition.approvalPolicy!(draft.arguments)
        if (policy.kind !== "required") throw new Error("fixture action must require approval")
        const suspension = await withSessionTurnLease(sessionPath, async (lease) => runtime.approvalCoordinatorFactory({ request, publish: vi.fn() })({
          sessionPath, baseSessionRevision: readSessionTransaction(sessionPath, lease).revision,
        }).propose({
          ...draft, liveToolContext, schemaDigest: validation.value.schemaDigest, policyId: policy.policyId,
          toolDigest: digestApprovalToolDefinition(definition, validation.value.schemaDigest, policy.policyId),
          policyDigest: digestJson({ policyId: policy.policyId, actionClass: policy.actionClass, classification: "required" }),
        }))
        if (change === "before-decision") active = false
        expect(runtime.resolvePermission(suspension.approvalId, "allow-once")).toBe(true)
        const result = await runtime.resumeApproval({
          request, suspension, signal: new AbortController().signal, frontendEventSink: { onEvent: (event) => frontendEvents.push(event) },
        })
        const store = openApprovalStore({ databasePath: path.join(root, "state", "approvals", "approvals.sqlite") })
        try {
          const record = store.read(suspension.approvalId)!
          expect(record.state).toBe(change === "before-decision" || change === "guard-held" ? "drifted" : change === "after-attempt" || change === "known-failure" ? "failed" : change === "uncertain-effect" ? "attempted_indeterminate" : "succeeded")
          expect(store.claimContinuation({ approvalId: suspension.approvalId, ownerId: "late-continuation" }))
            .toMatchObject({ claimed: false, record: { continuationState: "completed" } })
        } finally { store.close() }
        expect(handler).toHaveBeenCalledTimes(change === "before-decision" || change === "guard-held" || change === "after-attempt" ? 0 : 1)
        expect(effects).toBe(change === "before-decision" || change === "guard-held" || change === "after-attempt" || change === "known-failure" ? 0 : 1)
        expect(model).toHaveBeenCalledTimes(change === "unchanged" || change === "retained-history" || change === "known-failure" ? 1 : 0)
        if (retainedHistory) {
          const after = loadSession(sessionPath)!
          expect(after.events.slice(0, retainedHistory.events.length)).toEqual(retainedHistory.events)
          expect(after.events).toHaveLength(10)
          expect(after.events.filter((event) => event.role === "user" && event.content === request.message).map((event) => event.id)).toEqual(["evt-000005"])
          expect(after.structuredOutputs.map((output) => output.sourceEventId)).toEqual(["evt-000010"])
          expect(frontendEvents.filter((event) => event.type === "structured_output")).toEqual([{
            type: "structured_output", data: { output: expect.objectContaining({ sourceEventId: "evt-000010", heading: "New choices:" }) },
          }])
          expect(result.response).toBe(answer)
        }
        if (change === "before-continuation") {
          expect(result.response).toContain("action completed")
          expect(result.response).not.toMatch(/not executed|no action/i)
        }
        expect(runtime.resolvePermission(suspension.approvalId, "allow-once")).toBe(false)
        expect(loadSession(sessionPath)).not.toBeNull()
      } finally {
        runtime.close()
        fs.rmSync(root, { recursive: true, force: true })
      }
    },
  )

  it("executes and resumes under fresh leases with the original tool context and MCP set", async () => {
    const fixture = settlementFixture()
    fixture.input.request.runtimeMcpServers = {
      ouro_workbench: { command: "/Applications/OuroWorkbenchMCP" },
    }
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")

    await expect(settleFrontendApproval(fixture.input, fixture.deps as never)).resolves.toMatchObject({
      response: "done",
      turnOutcome: "settled",
      sessionPath: fixture.record.sessionPath,
    })
    expect(fixture.deps.setAgentName).toHaveBeenCalledWith("boss")
    expect(fixture.deps.getSharedMcpManager).toHaveBeenCalledWith({
      agentName: "boss",
      agentRoot: fixture.input.agentRoot,
      runtimeServers: fixture.input.request.runtimeMcpServers,
    })
    expect(fixture.deps.releaseRuntimeMcpServers).toHaveBeenCalledOnce()
    expect(fixture.deps.releaseRuntimeMcpServers).toHaveBeenCalledWith({
      agentName: "boss", agentRoot: fixture.input.agentRoot,
    })
    expect(fixture.leaseOrder).toEqual(["lease:start", "runtime:release", "lease:end"])
    expect(fixture.executeApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      currentSessionRevision: "d".repeat(64),
      decision: expect.objectContaining({
        approvalId: "approval-1",
        decisionToken: "decision-token",
        decision: "approve",
        transport: "frontend",
      }),
    }))
    expect(fixture.executeTool).toHaveBeenCalledWith(
      "unraid_restart_container",
      { container: "calibre-web" },
      expect.objectContaining({
        ...fixture.liveToolContext,
        agentName: "boss", agentRoot: fixture.input.agentRoot,
        toolSelection: { ordinary: [fixture.definition], engine: [] },
        selectCurrentTools: expect.any(Function),
      }),
    )
    expect(fixture.approvalCoordinatorFactory).toHaveBeenLastCalledWith(expect.objectContaining({
      request: fixture.input.request,
    }))
    expect(fixture.nestedFactory).toHaveBeenCalledWith({
      sessionPath: fixture.record.sessionPath,
      baseSessionRevision: "9".repeat(64),
    })
    expect(fixture.nestedPropose).toHaveBeenCalledOnce()
    expect(fixture.postTurnPersist).toHaveBeenCalledTimes(2)
    expect(fixture.tokenStore.remove).toHaveBeenCalledWith("approval-1")
    expect(fixture.events.map((event) => event.type)).toEqual([
      "model_started",
      "model_stream_started",
      "reasoning_delta",
      "text_delta",
      "text_cleared",
      "text_delta",
      "tool_started",
      "tool_completed",
      "error",
      "assistant_delivery",
      "structured_output",
    ])
  })

  it("uses a pre-aborted continuation for cancellation and an expiry decision timestamp", async () => {
    const cancelled = settlementFixture()
    cancelled.input.optionId = "cancelled"
    cancelled.deps.resumeApprovalContinuation.mockImplementationOnce(async (options: any) => {
      expect(options.signal.aborted).toBe(true)
      return { outcome: "aborted", messages: [] }
    })

    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")

    await expect(settleFrontendApproval(cancelled.input, cancelled.deps as never)).resolves.toMatchObject({
      turnOutcome: "aborted",
    })
    expect(cancelled.executeApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({ decision: "deny" }),
    }))

    const expired = settlementFixture()
    expired.input.optionId = "expired"
    await settleFrontendApproval(expired.input, expired.deps as never)
    expect(expired.executeApprovalDecision).toHaveBeenCalledWith(expect.objectContaining({
      decision: expect.objectContaining({
        decision: "deny",
        decisionAt: Date.parse(expired.record.expiresAt),
      }),
    }))
  })

  it("uses a minimal live context, no MCP manager, and maps terminal continuation outcomes", async () => {
    const fixture = settlementFixture()
    delete (fixture.input.approvalRequest as any).liveToolContext
    fixture.deps.getSharedMcpManager.mockResolvedValue(null)
    fixture.deps.loadSession.mockReset().mockReturnValue(null)
    fixture.deps.resumeApprovalContinuation.mockImplementationOnce(async (options: any) => {
      await expect(options.runAgentOptions.toolContext.signin("none")).resolves.toBeUndefined()
      expect(options.runAgentOptions.toolContext).toMatchObject({
        agentName: "boss",
        agentRoot: "/agents/boss.ouro",
        currentSession: {
          friendId: turn().friendId,
          channel: "mcp",
          key: "session-1",
          sessionPath: fixture.record.sessionPath,
        },
        currentUserMessage: "restart it",
      })
      return { outcome: "terminal_notice", messages: [] }
    })
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")

    await expect(settleFrontendApproval(fixture.input, fixture.deps as never)).resolves.toMatchObject({
      turnOutcome: "settled",
      response: "",
      deliveries: [],
    })
    expect(fixture.deps.getSharedMcpManager).toHaveBeenCalledWith({
      agentName: "boss", agentRoot: fixture.input.agentRoot, runtimeServers: undefined,
    })
    expect(fixture.deps.releaseRuntimeMcpServers).not.toHaveBeenCalled()

    const duplicate = settlementFixture()
    duplicate.deps.resumeApprovalContinuation.mockResolvedValueOnce({ outcome: "already_continued", messages: [] })
    await expect(settleFrontendApproval(duplicate.input, duplicate.deps as never)).resolves.toMatchObject({
      turnOutcome: "superseded",
    })

    const nested = settlementFixture()
    nested.deps.resumeApprovalContinuation.mockResolvedValueOnce({
      outcome: "suspended",
      messages: [],
      suspension: {
        approvalId: "approval-2",
        toolCallId: "call-2",
        checkpointDigest: "2".repeat(64),
        suspendedSessionRevision: "3".repeat(64),
      },
    })
    await expect(settleFrontendApproval(nested.input, nested.deps as never)).resolves.toMatchObject({
      turnOutcome: "suspended",
      suspension: { approvalId: "approval-2" },
    })

    const malformed = settlementFixture()
    malformed.deps.resumeApprovalContinuation.mockResolvedValueOnce({ outcome: "suspended", messages: [] })
    await expect(settleFrontendApproval(malformed.input, malformed.deps as never))
      .rejects.toThrow("omitted its nested suspension")
  })

  it("releases runtime MCPs before the turn lease exits when continuation fails", async () => {
    const fixture = settlementFixture()
    fixture.input.request.runtimeMcpServers = {
      ouro_workbench: { command: "/Applications/OuroWorkbenchMCP" },
    }
    fixture.deps.resumeApprovalContinuation.mockRejectedValueOnce(new Error("continuation failed"))
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")

    await expect(settleFrontendApproval(fixture.input, fixture.deps as never))
      .rejects.toThrow("continuation failed")
    expect(fixture.deps.releaseRuntimeMcpServers).toHaveBeenCalledOnce()
    expect(fixture.deps.releaseRuntimeMcpServers).toHaveBeenCalledWith({
      agentName: "boss", agentRoot: fixture.input.agentRoot,
    })
    expect(fixture.leaseOrder).toEqual(["lease:start", "runtime:release", "lease:end"])
  })

  it("routes the default runtime release adapter through the initiating owner", async () => {
    const fixture = settlementFixture()
    fixture.input.request.runtimeMcpServers = { ouro_workbench: { command: "/Applications/OuroWorkbenchMCP" } }
    vi.resetModules()
    const manager = await import("../../repertoire/mcp-manager")
    const transaction = await import("../../mind/session-transaction")
    const acquire = vi.spyOn(manager, "getSharedMcpManager").mockResolvedValue(null)
    const release = vi.spyOn(manager, "releaseRuntimeMcpServers").mockResolvedValue(undefined)
    const lease = vi.spyOn(transaction, "withSessionTurnLease").mockRejectedValue(new Error("controlled stop before action"))
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")
    try {
      await expect(settleFrontendApproval(fixture.input)).rejects.toThrow("controlled stop before action")
      expect(release).toHaveBeenCalledExactlyOnceWith({ agentName: "boss", agentRoot: fixture.input.agentRoot })
    } finally {
      acquire.mockRestore()
      release.mockRestore()
      lease.mockRestore()
    }
  })

  it.each([
    ["token", { token: null, checkpoint: true }, "decision token"],
    ["checkpoint", { token: "decision-token", checkpoint: false }, "checkpoint"],
    ["record", { token: "decision-token", checkpoint: true, record: false }, "record"],
  ])("fails closed when the approval %s is unavailable", async (_label, fixtureState, message) => {
    const fixture = settlementFixture()
    fixture.tokenStore.get.mockReturnValue(fixtureState.token)
    if (!fixtureState.checkpoint) fixture.input.checkpointStore.read = vi.fn(() => null) as never
    if (fixtureState.record === false) fixture.input.approvalStore.read = vi.fn(() => null) as never
    const { settleFrontendApproval } = await import("../../heart/frontend-approval-runtime")

    await expect(settleFrontendApproval(fixture.input, fixture.deps as never)).rejects.toThrow(message)
    expect(fixture.executeApprovalDecision).not.toHaveBeenCalled()
  })

  it("validates runtime defaults and closes deferred state after a pending cancellation", async () => {
    const { createFrontendApprovalRuntime } = await import("../../heart/frontend-approval-runtime")
    expect(() => createFrontendApprovalRuntime({ approvalTimeoutMs: 0 })).toThrow("positive integer")
    expect(() => createFrontendApprovalRuntime({ approvalTimeoutMs: 1.5 })).toThrow("positive integer")
    const defaults = createFrontendApprovalRuntime({})
    defaults.close()
    defaults.close()

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "frontend-approval-close-"))
    const runtime = createFrontendApprovalRuntime({
      agentRoot: (agent) => path.join(root, `${agent}.ouro`),
      settleApproval: async (input) => settled(input.optionId),
    })
    const request = turn()
    const coordinator = runtime.approvalCoordinatorFactory({
      request,
      publish: () => undefined,
    })({
      sessionPath: path.join(root, "boss.ouro", "state", "sessions", request.friendId, "mcp", "session.json"),
      baseSessionRevision: "d".repeat(64),
    })
    const suspension = await coordinator.propose(proposal())
    runtime.close()
    await expect(coordinator.propose(proposal())).rejects.toThrow("runtime is closed")
    await expect(runtime.resumeApproval({
      request,
      suspension,
      signal: new AbortController().signal,
      frontendEventSink: { onEvent: vi.fn() },
    })).resolves.toMatchObject({ response: "cancelled" })
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
})
