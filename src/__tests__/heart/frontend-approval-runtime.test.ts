import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ApprovalProposalRequest } from "../../heart/core"
import type { ToolContext } from "../../repertoire/tools-base"
import type { FrontendTurnRequest } from "../../heart/frontend-session-service"
import type { RunSenseTurnResult } from "../../senses/shared-turn"

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
    const executeTool = vi.fn(async () => "restarted")
    const executeApprovalDecision = vi.fn(async (options: any) => {
      options.resolveTool(record.toolName)
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
        withTurnExecutionLease: async (work: () => Promise<unknown>) => work(),
        setAgentName: vi.fn(),
        withSessionTurnLease: async (_path: string, work: (lease: object) => Promise<unknown>) => work({ lease: true }),
        readSessionTransaction: vi.fn(() => ({ revision: revision.value })),
        executeApprovalDecision,
        resolveToolDefinition: vi.fn(() => ({ tool: { function: { name: record.toolName } } })),
        approvalPolicyForInvocation: vi.fn(async () => ({ kind: "required", policyId: record.policyId })),
        execTool: executeTool,
        getSharedMcpManager: vi.fn(async () => ({ manager: true })),
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
      postTurnPersist,
      tokenStore,
    }
  }

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
      runtimeServers: fixture.input.request.runtimeMcpServers,
    })
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
      fixture.liveToolContext,
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
    expect(fixture.deps.getSharedMcpManager).toHaveBeenCalledWith(undefined)

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
