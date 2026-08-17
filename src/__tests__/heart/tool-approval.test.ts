import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import Database from "better-sqlite3"
import { afterEach, describe, expect, it, vi } from "vitest"

import { openApprovalStore, type ApprovalStore, type JsonObject, type PrepareApprovalInput } from "../../heart/approval-store"
import {
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
  const digests = liveDigests(argumentsValue)
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

function ready(options: { hooks?: Parameters<typeof openApprovalStore>[0]["hooks"] } = {}) {
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
    proposal: proposal(),
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
    execute,
    ...overrides,
  }
}

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe("approval decision and crash-safe execution", () => {
  it("marks attempted before invoking the frozen handler and records success", async () => {
    const fixture = ready()
    const execute = vi.fn(async () => {
      expect(fixture.approvalStore.read(UUID)?.state).toBe("attempted")
      return "restarted"
    })

    const record = await executeApprovalDecision(executionOptions(fixture, execute) as any)

    expect(record).toMatchObject({ state: "succeeded", result: "restarted", ownerId: "owner-a", epoch: 1 })
    expect(execute).toHaveBeenCalledTimes(1)
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
    ["missing tool", { resolveTool: () => undefined }],
    ["guardrail drift", { liveGuard: () => ({ ok: false, reason: "authority changed" }) }],
    ["approval-policy drift", { resolveTool: () => ({ ...shellToolDefinitions[0]!, approvalPolicy: () => ({ kind: "not_required" }) }) }],
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
  ])("terminalizes %s before attempted", async (_label, overrides) => {
    const fixture = ready()
    const execute = vi.fn()

    const record = await executeApprovalDecision(executionOptions(fixture, execute, overrides) as any)

    expect(record.state).toBe("drifted")
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
    ["null", null],
    ["array", []],
    ["string", "restart"],
    ["number", 42],
    ["boolean", true],
    ["missing required", {}],
    ["wrong type", { command: 42 }],
    ["prohibited extra", { command: "docker restart calibre-web", surprise: true }],
  ])("fails closed on corrupt or schema-invalid recovered arguments: %s", async (_label, argumentsValue) => {
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
    const execute = vi.fn().mockRejectedValue(new Error("handler failed"))

    const record = await executeApprovalDecision(executionOptions(fixture, execute) as any)

    expect(record).toMatchObject({ state: "failed", result: expect.stringContaining("handler failed") })
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
