import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore, type ApprovalStore, type JsonObject, type PrepareApprovalInput } from "../../heart/approval-store"
import {
  ApprovalExecutionIndeterminateError,
  ApprovalExecutionFailedError,
  commitApprovalProposal,
  digestApprovalSuspensionCheckpointPayload,
  executeApprovalDecision,
  recoverAttemptedApproval,
  recoverClaimedApproval,
  type ApprovalSuspensionCheckpoint,
  type ApprovalSuspensionCheckpointStore,
  type ApprovalTokenStore,
} from "../../heart/tool-approval"
import { digestJson } from "../../repertoire/tool-arguments"
import { approvalPolicyForToolName } from "../../repertoire/tools"
import { shellToolDefinitions } from "../../repertoire/tools-shell"
import { telegramApprovalDecisionBarrierHooks } from "../../senses/telegram-approval-runtime"

const UUID = "11111111-1111-4111-8111-111111111111"
const BASE_REVISION = "d".repeat(64)
const SUSPENDED_REVISION = "f".repeat(64)
const roots: string[] = []

function makeRoot(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-approval-decision-"))
  roots.push(value)
  return value
}

function checkpointStore(): ApprovalSuspensionCheckpointStore & { records: Map<string, ApprovalSuspensionCheckpoint> } {
  const records = new Map<string, ApprovalSuspensionCheckpoint>()
  return {
    records,
    write: (draft) => {
      const checkpoint = {
        ...structuredClone(draft),
        checkpointDigest: digestApprovalSuspensionCheckpointPayload(draft),
        suspendedSessionRevision: SUSPENDED_REVISION,
      }
      records.set(checkpoint.approvalId, checkpoint)
      return { checkpointDigest: checkpoint.checkpointDigest, suspendedSessionRevision: checkpoint.suspendedSessionRevision }
    },
    read: (approvalId) => structuredClone(records.get(approvalId) ?? null),
    list: () => [...records.values()].map((record) => structuredClone(record)),
    remove: (approvalId) => { records.delete(approvalId) },
  }
}

function tokenStore(): ApprovalTokenStore & { records: Map<string, string> } {
  const records = new Map<string, string>()
  return {
    records,
    put: (approvalId, token) => { records.set(approvalId, token) },
    has: (approvalId) => records.has(approvalId),
    get: (approvalId) => records.get(approvalId) ?? null,
    remove: (approvalId) => { records.delete(approvalId) },
  }
}

function liveDigests(argumentsValue: JsonObject = { command: "docker restart calibre-web" }) {
  const definition = shellToolDefinitions[0]!
  const schemaDigest = digestJson(definition.tool.function.parameters as any)
  const policy = approvalPolicyForToolName("shell", argumentsValue)
  if (policy.kind !== "required") throw new Error("test policy must require approval")
  const toolDigest = digestJson({ name: "shell", schemaDigest, policyId: policy.policyId })
  const policyDigest = digestJson({
    policyId: policy.policyId,
    actionClass: policy.actionClass,
    classification: "required",
  })
  return { definition, schemaDigest, toolDigest, policyDigest, policy }
}

function proposal(argumentsValue: JsonObject = { command: "docker restart calibre-web" }): PrepareApprovalInput {
  const digests = liveDigests()
  return {
    toolCallId: "call_restart",
    toolName: "shell",
    arguments: argumentsValue,
    schemaDigest: digests.schemaDigest,
    toolDigest: digests.toolDigest,
    policyDigest: digests.policyDigest,
    policyId: digests.policy.policyId,
    sessionKey: "telegram:chat-7",
    sessionPath: "/tmp/disposable/session.json",
    baseSessionRevision: BASE_REVISION,
    checkpointDigest: "e".repeat(64),
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    expiresAt: "2026-08-17T18:30:00.000Z",
    frozenAssistantMessage: {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_restart",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify(argumentsValue) },
      }],
    },
  }
}

function ready(options: { hooks?: Parameters<typeof openApprovalStore>[0]["hooks"]; argumentsValue?: JsonObject } = {}) {
  const directory = makeRoot()
  const databasePath = path.join(directory, "approvals.sqlite")
  let now = "2026-08-17T17:30:00.000Z"
  const approvalStore = openApprovalStore({
    databasePath,
    now: () => new Date(now),
    randomUUID: () => UUID,
    randomBytes: (size) => Buffer.alloc(size, 0xab),
    hooks: options.hooks,
  })
  const checkpoints = checkpointStore()
  const tokens = tokenStore()
  const committed = commitApprovalProposal({
    approvalStore,
    checkpointStore: checkpoints,
    tokenStore: tokens,
    proposal: proposal(options.argumentsValue),
    preCallMessages: [{ role: "user", content: "restart calibre-web" }],
  })
  approvalStore.bindPrompt({
    approvalId: UUID,
    transport: "telegram",
    transportChatId: "7",
    transportMessageId: "99",
  })
  return { approvalStore, checkpoints, tokens, decisionToken: committed.decisionToken, databasePath, setNow: (value: string) => { now = value } }
}

function decision(decisionToken: string, overrides: Record<string, unknown> = {}) {
  return {
    approvalId: UUID,
    decisionToken,
    decision: "approve" as const,
    requesterId: "friend-ari",
    transport: "telegram",
    transportUserId: "42",
    transportChatId: "7",
    transportMessageId: "99",
    sessionKey: "telegram:chat-7",
    ...overrides,
  }
}

function executionOptions(fixture: ReturnType<typeof ready>, execute = vi.fn().mockResolvedValue("restarted"), overrides: Record<string, unknown> = {}) {
  return {
    approvalStore: fixture.approvalStore,
    checkpointStore: fixture.checkpoints,
    decision: decision(fixture.decisionToken),
    ownerId: "owner-a",
    currentSessionRevision: SUSPENDED_REVISION,
    resolveTool: () => shellToolDefinitions[0],
    liveGuard: () => ({ ok: true as const }),
    liveRisk: () => ({ ok: true as const }),
    execute,
    ...overrides,
  }
}

function expectLiveContext(context: any, fixture: ReturnType<typeof ready>): void {
  expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
  expect(context).toMatchObject({
    record: {
      state: "claimed",
      toolName: "shell",
      arguments: { command: "docker restart calibre-web" },
      requesterId: "friend-ari",
      transport: "telegram",
      transportUserId: "42",
      transportChatId: "7",
      transportMessageId: "99",
      sessionKey: "telegram:chat-7",
    },
    checkpoint: {
      approvalId: UUID,
      frozenAssistantMessage: proposal().frozenAssistantMessage,
    },
    definition: {
      tool: { function: { name: "shell" } },
    },
    arguments: { command: "docker restart calibre-web" },
  })
}

function resignCheckpointEvidence(fixture: ReturnType<typeof ready>): void {
  const checkpoint = fixture.checkpoints.records.get(UUID)!
  checkpoint.checkpointDigest = digestApprovalSuspensionCheckpointPayload(checkpoint)
  const database = new Database(fixture.databasePath)
  const row = database.prepare("SELECT record_json FROM approval_actions WHERE approval_id = ?").get(UUID) as { record_json: string }
  const record = JSON.parse(row.record_json)
  record.checkpointDigest = checkpoint.checkpointDigest
  record.frozenAssistantMessage = structuredClone(checkpoint.frozenAssistantMessage)
  database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?").run(JSON.stringify(record), UUID)
  database.close()
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("approval decision and crash-safe execution", () => {
  it.each([
    [2, "claimed", false],
    [3, "attempted", false],
    [4, "attempted", true],
  ] as const)("halts decision effects after barrier failure at phase %i", async (failAt, state, toolRan) => {
    const fixture = ready()
    const execute = vi.fn(async () => "restarted")
    let calls = 0
    const failure = new Error(`audit barrier ${failAt}`)
    const barrier = () => { calls += 1; if (calls === failAt) throw failure }

    barrier()
    await expect(executeApprovalDecision(executionOptions(fixture, execute, {
      hooks: telegramApprovalDecisionBarrierHooks(barrier),
    }) as any)).rejects.toBe(failure)
    expect(fixture.approvalStore.read(UUID)?.state).toBe(state)
    expect(execute).toHaveBeenCalledTimes(toolRan ? 1 : 0)

    const recovered = state === "claimed"
      ? recoverClaimedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID, reason: "audit barrier interrupted decision" })
      : recoverAttemptedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID })
    expect(recovered.state).toBe(state === "claimed" ? "abandoned_before_attempt" : "attempted_indeterminate")
    fixture.approvalStore.close()
  })

  it("marks attempted before invoking the frozen handler and records success", async () => {
    const fixture = ready()
    const resolveTool = vi.fn((name: string) => {
      expect(name).toBe("shell")
      expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
      return shellToolDefinitions[0]
    })
    const liveGuard = vi.fn((context: unknown) => {
      expectLiveContext(context, fixture)
      return { ok: true as const }
    })
    const liveRisk = vi.fn((context: unknown) => {
      expectLiveContext(context, fixture)
      return { ok: true as const }
    })
    const execute = vi.fn(async () => {
      expect(fixture.approvalStore.read(UUID)?.state).toBe("attempted")
      return "restarted"
    })

    const record = await executeApprovalDecision(executionOptions(fixture, execute, { resolveTool, liveGuard, liveRisk }) as any)

    expect(record).toMatchObject({ state: "succeeded", result: "restarted", ownerId: "owner-a", epoch: 1 })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith("shell", { command: "docker restart calibre-web" })
    expect(resolveTool).toHaveBeenCalledWith("shell")
    expect(liveGuard).toHaveBeenCalledTimes(1)
    expect(liveRisk).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it("denies without resolving or invoking the handler", async () => {
    const fixture = ready()
    const execute = vi.fn()
    const resolveTool = vi.fn()

    const record = await executeApprovalDecision(executionOptions(fixture, execute, {
      decision: decision(fixture.decisionToken, { decision: "deny" }),
      resolveTool,
    }) as any)

    expect(record.state).toBe("denied")
    expect(resolveTool).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("expires a late decision without handler eligibility", async () => {
    const fixture = ready()
    fixture.setNow("2026-08-17T18:30:00.000Z")
    const execute = vi.fn()

    const record = await executeApprovalDecision(executionOptions(fixture, execute) as any)

    expect(record.state).toBe("expired")
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it.each([
    ["token", { decisionToken: "wrong" }],
    ["requester", { requesterId: "friend-mallory" }],
    ["transport", { transport: "other" }],
    ["transport user", { transportUserId: "666" }],
    ["chat", { transportChatId: "8" }],
    ["message", { transportMessageId: "100" }],
    ["session", { sessionKey: "telegram:chat-8" }],
  ])("rejects a %s binding mismatch before claim or execution", async (_label, mismatch) => {
    const fixture = ready()
    const execute = vi.fn()

    await expect(executeApprovalDecision(executionOptions(fixture, execute, {
      decision: decision(fixture.decisionToken, mismatch),
    }) as any)).rejects.toMatchObject({ code: "decision_binding_mismatch" })
    expect(fixture.approvalStore.read(UUID)?.state).toBe("proposed")
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("makes duplicate or conflicting decisions ineligible after one winner", async () => {
    const fixture = ready()
    const execute = vi.fn().mockResolvedValue("restarted")

    await executeApprovalDecision(executionOptions(fixture, execute) as any)
    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any))
      .rejects.toMatchObject({ code: "decision_not_eligible" })
    await expect(executeApprovalDecision(executionOptions(fixture, execute, {
      decision: decision(fixture.decisionToken, { decision: "deny" }),
    }) as any)).rejects.toMatchObject({ code: "decision_not_eligible" })
    expect(execute).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it.each([
    ["approve/approve", "approve"],
    ["approve/deny", "deny"],
  ])("allows at most one attempted claimant under concurrent %s decisions", async (_label, competingDecision) => {
    const fixture = ready()
    const execute = vi.fn().mockResolvedValue("restarted")
    const attemptedOwners: Array<{ ownerId: string | null; epoch: number }> = []
    let releaseClaim!: () => void
    let signalClaimed!: () => void
    const claimHeld = new Promise<void>((resolve) => { releaseClaim = resolve })
    const claimed = new Promise<void>((resolve) => { signalClaimed = resolve })
    const first = executeApprovalDecision(executionOptions(fixture, execute, {
      ownerId: "owner-a",
      hooks: {
        afterClaim: async () => {
          expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
          signalClaimed()
          await claimHeld
        },
        afterAttempt: () => {
          const record = fixture.approvalStore.read(UUID)!
          attemptedOwners.push({ ownerId: record.ownerId, epoch: record.epoch })
        },
      },
    }) as any)
    await claimed
    expect(fixture.approvalStore.read(UUID)).toMatchObject({ state: "claimed", ownerId: "owner-a", epoch: 1 })
    const second = executeApprovalDecision(executionOptions(fixture, execute, {
      ownerId: "owner-b",
      decision: decision(fixture.decisionToken, { decision: competingDecision }),
      hooks: { afterAttempt: () => {
        const record = fixture.approvalStore.read(UUID)!
        attemptedOwners.push({ ownerId: record.ownerId, epoch: record.epoch })
      } },
    }) as any)
    await expect(second).rejects.toMatchObject({ code: "decision_not_eligible" })
    expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
    releaseClaim()

    await expect(first).resolves.toMatchObject({ state: "succeeded", ownerId: "owner-a", epoch: 1 })
    expect(attemptedOwners).toEqual([{ ownerId: "owner-a", epoch: 1 }])
    expect(execute).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it.each([
    ["missing tool", { resolveTool: () => undefined }],
    ["authority/guardrail drift", { liveGuard: () => ({ ok: false, reason: "authority changed" }) }],
    ["risk-policy drift", { liveRisk: () => ({ ok: false, reason: "risk changed" }) }],
    ["tool identity drift", { resolveTool: () => ({
      ...shellToolDefinitions[0]!,
      tool: { ...shellToolDefinitions[0]!.tool, function: { ...shellToolDefinitions[0]!.tool.function, name: "read_file" } },
    }) }],
    ["approval-policy drift", { resolveTool: () => ({ ...shellToolDefinitions[0]!, approvalPolicy: () => ({ kind: "not_required" }) }) }],
    ["approval policy id drift", { resolveTool: () => ({ ...shellToolDefinitions[0]!, approvalPolicy: () => ({
      kind: "required",
      policyId: "shell.docker-lifecycle.v2",
      actionClass: "service-control",
      requiresSoleCall: true,
    }) }) }],
    ["approval action-class drift", { resolveTool: () => ({ ...shellToolDefinitions[0]!, approvalPolicy: () => ({
      kind: "required",
      policyId: "shell.docker-lifecycle.v1",
      actionClass: "different-class",
      requiresSoleCall: true,
    }) }) }],
    ["schema/tool drift", { resolveTool: () => ({
      ...shellToolDefinitions[0]!,
      tool: {
        ...shellToolDefinitions[0]!.tool,
        function: {
          ...shellToolDefinitions[0]!.tool.function,
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      },
    }) }],
    ["missing advertised schema", { resolveTool: () => ({
      ...shellToolDefinitions[0]!,
      tool: { ...shellToolDefinitions[0]!.tool, function: { ...shellToolDefinitions[0]!.tool.function, parameters: undefined } },
    }) }],
    ["missing approval policy", { resolveTool: () => ({ ...shellToolDefinitions[0]!, approvalPolicy: undefined }) }],
  ])("terminalizes %s before attempted", async (_label, overrides) => {
    const fixture = ready()
    const execute = vi.fn()
    const markAttempted = vi.spyOn(fixture.approvalStore, "markAttempted")
    const guardedOverrides = {
      ...overrides,
      ...(overrides.resolveTool ? { resolveTool: (...args: any[]) => {
        expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
        expect(args[0]).toBe("shell")
        return (overrides.resolveTool as any)(...args)
      } } : {}),
      ...(overrides.liveGuard ? { liveGuard: (...args: any[]) => {
        expectLiveContext(args[0], fixture)
        return (overrides.liveGuard as any)(...args)
      } } : {}),
      ...(overrides.liveRisk ? { liveRisk: (...args: any[]) => {
        expectLiveContext(args[0], fixture)
        return (overrides.liveRisk as any)(...args)
      } } : {}),
    }

    const record = await executeApprovalDecision(executionOptions(fixture, execute, guardedOverrides) as any)

    expect(record.state).toBe("drifted")
    expect(markAttempted).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("terminalizes session-head drift before attempted", async () => {
    const fixture = ready()
    const execute = vi.fn()

    const record = await executeApprovalDecision(executionOptions(fixture, execute, {
      currentSessionRevision: "0".repeat(64),
    }) as any)

    expect(record.state).toBe("session_head_changed")
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it.each([
    ["missing checkpoint", (fixture: ReturnType<typeof ready>) => fixture.checkpoints.records.delete(UUID)],
    ["tampered frozen call", (fixture: ReturnType<typeof ready>) => {
      fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage = { role: "assistant", content: "tampered" }
    }],
    ["tampered checkpoint digest", (fixture: ReturnType<typeof ready>) => {
      fixture.checkpoints.records.get(UUID)!.checkpointDigest = "0".repeat(64)
    }],
    ["tampered suspended revision", (fixture: ReturnType<typeof ready>) => {
      fixture.checkpoints.records.get(UUID)!.suspendedSessionRevision = "0".repeat(64)
    }],
    ["non-assistant frozen message", (fixture: ReturnType<typeof ready>) => {
      fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage.role = "user"
      resignCheckpointEvidence(fixture)
    }],
    ["non-function frozen call", (fixture: ReturnType<typeof ready>) => {
      const frozen = fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any
      frozen.tool_calls[0].type = "custom"
      resignCheckpointEvidence(fixture)
    }],
    ["missing frozen tool calls", (fixture: ReturnType<typeof ready>) => {
      delete (fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls
      resignCheckpointEvidence(fixture)
    }],
    ["multiple frozen tool calls", (fixture: ReturnType<typeof ready>) => {
      const frozen = fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any
      frozen.tool_calls.push(structuredClone(frozen.tool_calls[0]))
      resignCheckpointEvidence(fixture)
    }],
    ["null frozen call", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls = [null]
      resignCheckpointEvidence(fixture)
    }],
    ["array frozen call", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls = [[]]
      resignCheckpointEvidence(fixture)
    }],
    ["missing frozen function", (fixture: ReturnType<typeof ready>) => {
      delete (fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].function
      resignCheckpointEvidence(fixture)
    }],
    ["array frozen function", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].function = []
      resignCheckpointEvidence(fixture)
    }],
    ["frozen call id drift", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].id = "other"
      resignCheckpointEvidence(fixture)
    }],
    ["frozen tool name drift", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].function.name = "read_file"
      resignCheckpointEvidence(fixture)
    }],
    ["non-string frozen arguments", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].function.arguments = 7
      resignCheckpointEvidence(fixture)
    }],
    ["malformed frozen arguments", (fixture: ReturnType<typeof ready>) => {
      ;(fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage as any).tool_calls[0].function.arguments = "{"
      resignCheckpointEvidence(fixture)
    }],
  ])("terminalizes %s evidence drift before attempted", async (_label, mutate) => {
    const fixture = ready()
    mutate(fixture)
    const execute = vi.fn()
    const markAttempted = vi.spyOn(fixture.approvalStore, "markAttempted")

    const record = await executeApprovalDecision(executionOptions(fixture, execute) as any)

    expect(record.state).toBe("drifted")
    expect(markAttempted).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("re-reads checkpoint evidence after claim so a claim-boundary mutation cannot pass", async () => {
    const fixture = ready()
    const execute = vi.fn()
    const markAttempted = vi.spyOn(fixture.approvalStore, "markAttempted")

    const record = await executeApprovalDecision(executionOptions(fixture, execute, {
      hooks: { afterClaim: () => {
        expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
        fixture.checkpoints.records.get(UUID)!.frozenAssistantMessage = { role: "assistant", content: "changed after claim" }
      } },
    }) as any)

    expect(record.state).toBe("drifted")
    expect(markAttempted).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it.each([
    ["null", null],
    ["array", []],
    ["string", "restart"],
    ["number", 42],
    ["boolean", true],
  ])("fails closed on structurally corrupt recovered arguments: %s", async (_label, argumentsValue) => {
    const fixture = ready()
    const database = new Database(fixture.databasePath)
    const row = database.prepare("SELECT record_json FROM approval_actions WHERE approval_id = ?").get(UUID) as { record_json: string }
    const record = JSON.parse(row.record_json)
    record.arguments = argumentsValue
    database.prepare("UPDATE approval_actions SET record_json = ? WHERE approval_id = ?").run(JSON.stringify(record), UUID)
    database.close()
    const execute = vi.fn()

    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any)).rejects.toBeTruthy()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it.each([
    ["missing required", {}],
    ["wrong type", { command: 42 }],
    ["prohibited extra", { command: "docker restart calibre-web", surprise: true }],
  ])("claims then rejects schema-invalid recovered arguments before attempted: %s", async (_label, argumentsValue) => {
    const fixture = ready({ argumentsValue: argumentsValue as JsonObject })
    const execute = vi.fn()
    const markAttempted = vi.spyOn(fixture.approvalStore, "markAttempted")
    const resolveTool = vi.fn(() => {
      expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")
      return shellToolDefinitions[0]
    })

    const record = await executeApprovalDecision(executionOptions(fixture, execute, { resolveTool }) as any)

    expect(record.state).toBe("drifted")
    expect(resolveTool).toHaveBeenCalledTimes(1)
    expect(markAttempted).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("recovers a crash after claim but before attempted as abandoned and requires fresh approval", async () => {
    const fixture = ready()
    await expect(executeApprovalDecision(executionOptions(fixture, vi.fn(), {
      hooks: { afterClaim: () => { throw new Error("crash after claim") } },
    }) as any)).rejects.toThrow("crash after claim")
    expect(fixture.approvalStore.read(UUID)?.state).toBe("claimed")

    const recovered = recoverClaimedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID, reason: "owner died" })

    expect(recovered.state).toBe("abandoned_before_attempt")
    await expect(executeApprovalDecision(executionOptions(fixture) as any)).rejects.toBeTruthy()
    fixture.approvalStore.close()
  })

  it("rejects claimed recovery when the record is not claimed", () => {
    const fixture = ready()

    expect(() => recoverClaimedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID, reason: "not claimed" }))
      .toThrowError(expect.objectContaining({ code: "claimed_recovery_not_eligible" }))
    fixture.approvalStore.close()
  })

  it("rejects attempted recovery when the record is not attempted", () => {
    const fixture = ready()

    expect(() => recoverAttemptedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID }))
      .toThrowError(expect.objectContaining({ code: "attempted_recovery_not_eligible" }))
    fixture.approvalStore.close()
  })

  it("rejects direct pre-attempt terminalization without a matching claimed owner", () => {
    const fixture = ready()

    expect(() => fixture.approvalStore.terminalizeBeforeAttempt({
      approvalId: UUID,
      ownerId: "wrong-owner",
      epoch: 0,
      state: "drifted",
      reason: "invalid direct transition",
    })).toThrowError(expect.objectContaining({ code: "pre_attempt_terminalization_not_eligible" }))
    fixture.approvalStore.close()
  })

  it("fences a stale owner paused immediately before the attempted CAS", async () => {
    let fixture: ReturnType<typeof ready>
    fixture = ready({
      hooks: {
        beforeAttemptCas: () => {
          const claimed = fixture.approvalStore.read(UUID)!
          fixture.approvalStore.abandonBeforeAttempt({
            approvalId: UUID,
            ownerId: claimed.ownerId!,
            epoch: claimed.epoch,
            reason: "fenced stale owner",
          })
        },
      },
    })
    const execute = vi.fn()

    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any))
      .rejects.toMatchObject({ code: "transition_conflict" })
    expect(fixture.approvalStore.read(UUID)?.state).toBe("abandoned_before_attempt")
    expect(execute).not.toHaveBeenCalled()
    fixture.approvalStore.close()
  })

  it("records an observable handler failure without retry", async () => {
    const fixture = ready()
    const execute = vi.fn().mockRejectedValue(new ApprovalExecutionFailedError("handler rejected before effect"))

    const record = await executeApprovalDecision(executionOptions(fixture, execute) as any)

    expect(record).toMatchObject({ state: "failed", result: expect.stringContaining("handler rejected before effect") })
    expect(execute).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it("fails closed on an ordinary post-attempt exception and never retries it", async () => {
    const fixture = ready()
    const execute = vi.fn().mockRejectedValue(new Error("timeout after external effect may have started"))

    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any))
      .rejects.toThrow("timeout after external effect may have started")
    expect(fixture.approvalStore.read(UUID)?.state).toBe("attempted")

    const recovered = recoverAttemptedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID })
    expect(recovered.state).toBe("attempted_indeterminate")
    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any)).rejects.toBeTruthy()
    expect(execute).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it("treats an unobservable crash during the handler as indeterminate and never retries", async () => {
    const fixture = ready()
    const execute = vi.fn().mockRejectedValue(new ApprovalExecutionIndeterminateError("process lost during external effect"))

    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any))
      .rejects.toBeInstanceOf(ApprovalExecutionIndeterminateError)
    expect(fixture.approvalStore.read(UUID)?.state).toBe("attempted")

    const recovered = recoverAttemptedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID })
    expect(recovered.state).toBe("attempted_indeterminate")
    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any)).rejects.toBeTruthy()
    expect(execute).toHaveBeenCalledTimes(1)
    fixture.approvalStore.close()
  })

  it.each([
    ["after attempted before handler", "afterAttempt"],
    ["after handler before completion", "afterHandler"],
  ] as const)("never retries after a crash %s", async (_label, hookName) => {
    const fixture = ready()
    const execute = vi.fn().mockResolvedValue("effect may have happened")

    await expect(executeApprovalDecision(executionOptions(fixture, execute, {
      hooks: { [hookName]: () => { throw new Error(`crash at ${hookName}`) } },
    }) as any)).rejects.toThrow(`crash at ${hookName}`)
    expect(fixture.approvalStore.read(UUID)?.state).toBe("attempted")
    const callsAtCrash = execute.mock.calls.length

    const recovered = recoverAttemptedApproval({ approvalStore: fixture.approvalStore, approvalId: UUID })
    expect(recovered.state).toBe("attempted_indeterminate")
    await expect(executeApprovalDecision(executionOptions(fixture, execute) as any)).rejects.toBeTruthy()
    expect(execute).toHaveBeenCalledTimes(callsAtCrash)
    fixture.approvalStore.close()
  })
})
