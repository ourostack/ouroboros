import * as fs from "node:fs"
import { createConnection } from "node:net"

import { describe, expect, it, vi } from "vitest"

import { createSanctuaryInteractiveControl, executeSanctuaryInteractiveEngine, proveSanctuaryAttemptedRecoveryWithoutRetry, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"

function request(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let raw = ""
    socket.setEncoding("utf8")
    socket.on("error", reject)
    socket.on("data", (chunk) => { raw += chunk })
    socket.on("end", () => resolve(JSON.parse(raw) as Record<string, unknown>))
    socket.end(JSON.stringify(payload))
  })
}

describe("Sanctuary interactive daemon control", () => {
  it.each([null, 1, []])("rejects non-object interactive payload %j", async (payload) => {
    await expect(executeSanctuaryInteractiveEngine(payload, {} as never)).rejects.toThrow("must be an object")
  })

  it("rejects an interactive payload with extra authority fields", async () => {
    await expect(executeSanctuaryInteractiveEngine({ operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest: "a".repeat(64), extra: true }, {} as never))
      .rejects.toThrow("shape is invalid")
  })

  it("rejects ambiguous approvals, pending prompts, tombstones, checkpoints, and lifecycle states", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const request = { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }
    const approval = { approvalId: "approval-1", state: "proposed", epoch: 0, toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64) }
    const common = { agentRoot: "/unused", readPending: () => [], createSession: vi.fn(), proveIndeterminateRecovery: vi.fn(), writeCredentialObserved: vi.fn() }
    await expect(executeSanctuaryInteractiveEngine(request, { ...common, readApprovals: () => [] } as never)).rejects.toThrow("absent or ambiguous")
    await expect(executeSanctuaryInteractiveEngine(request, { ...common, readApprovals: () => [{ approval: { ...approval, suspendedSessionRevision: null }, continuation: null }] } as never)).rejects.toThrow("checkpoint is unavailable")
    await expect(executeSanctuaryInteractiveEngine(request, { ...common, readApprovals: () => [{ approval, continuation: null }] } as never)).rejects.toThrow("pending approval is absent")
    await expect(executeSanctuaryInteractiveEngine(request, { ...common, readApprovals: () => [{ approval: { ...approval, state: "failed" }, continuation: null }] } as never)).rejects.toThrow("not expired without a claim")
    await expect(executeSanctuaryInteractiveEngine(request, {
      ...common, readApprovals: () => [{ approval: { ...approval, state: "expired" }, continuation: null }],
      readPending: () => [{ approvalId: "approval-1", messageId: "42", deliveryState: "terminal_tombstone", approveCallbackData: "a", denyCallbackData: "d", expiresAt: 1 }],
    } as never)).rejects.toThrow("terminal tombstone is absent")
    await expect(executeSanctuaryInteractiveEngine({ operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }, {
      ...common, readApprovals: () => [{ approval: { ...approval, state: "expired" }, continuation: null }],
    } as never)).rejects.toThrow("not currently proposed")
  })

  it("resumes timeout stale settlement from a durable terminal tombstone after daemon loss", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    let state: "proposed" | "expired" = "proposed"
    const pending = { approvalId: "approval-1", messageId: "42", deliveryState: "bound" as const, approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: 300_000 }
    const tombstone = { ...pending, deliveryState: "terminal_tombstone" as const, terminalizedAt: 301_000, tombstoneExpiresAt: 901_000,
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 300_000, observedAt: 300_500, evidenceMac: "f".repeat(64) } }
    const projection = () => [{ approval: {
      approvalId: "approval-1", state, epoch: 0, toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64),
    } as never, continuation: null }]
    const handle = vi.fn(async () => ({ handled: true, accepted: false, reason: "stale_callback" }))
    const deps = {
      agentRoot: "/unused", readApprovals: projection, readPending: () => state === "proposed" ? [pending] : [tombstone],
      createSession: async () => ({ handle, pendingApprovalIds: () => [], close: vi.fn() }),
      proveIndeterminateRecovery: vi.fn(), writeCredentialObserved: () => false,
    }
    const request = { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }
    await expect(executeSanctuaryInteractiveEngine(request, deps)).resolves.toEqual({ state: "waiting" })
    expect(handle).not.toHaveBeenCalled()
    state = "expired"
    await expect(executeSanctuaryInteractiveEngine(request, deps)).resolves.toMatchObject({
      schemaVersion: "sanctuary-timeout-stale-driver-receipt-v1", phase: "complete", callbackAttempts: 1,
      distinctQueryCount: 1, settledCount: 1, claimCount: 0, mutationCount: 0, staleAcknowledged: true, promptTerminal: true,
    })
    expect(handle).toHaveBeenCalledOnce()
    expect(handle).toHaveBeenCalledOnce()
  })

  it("fails closed when stale settlement or isolated recovery proof is not exact", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const baseApproval = {
      approvalId: "approval-1", epoch: 0, toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64),
    }
    const tombstone = {
      approvalId: "approval-1", messageId: "42", deliveryState: "terminal_tombstone" as const, approveCallbackData: "a:opaque", denyCallbackData: "d:opaque",
      expiresAt: 300_000, terminalizedAt: 301_000, tombstoneExpiresAt: 901_000,
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1" as const, deadlineAt: 300_000, observedAt: 300_500, evidenceMac: "f".repeat(64) },
    }
    const common = {
      agentRoot: "/unused", readPending: () => [tombstone],
      createSession: async () => ({ handle: vi.fn(async () => ({ handled: true, accepted: true, reason: "accepted" })), pendingApprovalIds: () => [], close: vi.fn() }),
      proveIndeterminateRecovery: vi.fn(), writeCredentialObserved: () => false,
    }
    await expect(executeSanctuaryInteractiveEngine({ operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }, {
      ...common, readApprovals: () => [{ approval: { ...baseApproval, state: "expired" } as never, continuation: null }],
    })).rejects.toThrow("timeout stale callback proof failed")
    await expect(executeSanctuaryInteractiveEngine({ operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }, {
      ...common,
      readApprovals: () => [{ approval: { ...baseApproval, state: "proposed" } as never, continuation: null }],
      readPending: () => [{ ...tombstone, deliveryState: "bound" as const }],
      proveIndeterminateRecovery: () => ({ observed: true, retryCount: 0, reopened: true, attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "7".repeat(64) }),
    })).rejects.toThrow("isolated attempted recovery proof failed")

    await expect(executeSanctuaryInteractiveEngine({ operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }, {
      ...common,
      readApprovals: () => [{ approval: { ...baseApproval, state: "proposed" } as never, continuation: null }],
      readPending: () => [{ approvalId: "approval-1", messageId: "42", deliveryState: "bound", approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: 300_000 }],
      proveIndeterminateRecovery: () => ({ observed: true, retryCount: 0, reopened: true, attemptedRecordDigest: "7".repeat(64), recoveredRecordDigest: "8".repeat(64) }),
    } as never)).resolves.toMatchObject({ phase: "prepared" })
  })

  it("reports conservative duplicate and continuation outcomes without inventing success", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const pending = { approvalId: "approval-1", messageId: "42", deliveryState: "bound" as const, approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: 300_000 }
    const approval = { approvalId: "approval-1", state: "proposed", epoch: 4, toolName: "unraid_restart_container", arguments: { container: "calibre-web" }, checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64) }
    const handle = vi.fn(async () => ({ handled: false, accepted: false, reason: "stale_callback" }))
    const session = { handle, pendingApprovalIds: () => ["approval-1"], close: vi.fn() }
    const deps = { agentRoot: "/unused", readPending: () => [pending], createSession: async () => session, proveIndeterminateRecovery: vi.fn(), writeCredentialObserved: () => true }
    await expect(executeSanctuaryInteractiveEngine({ operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest }, {
      ...deps, readApprovals: () => [{ approval, continuation: null }],
    } as never)).resolves.toMatchObject({ claimCount: 0, mutationCount: 0, staleReplaySettled: false, promptTerminal: false, writeCredentialObserved: true })
    await expect(executeSanctuaryInteractiveEngine({ operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }, {
      ...deps, readApprovals: () => [{ approval, continuation: null }],
    } as never)).rejects.toThrow("continuation did not complete")

    let reads = 0
    await expect(executeSanctuaryInteractiveEngine({ operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }, {
      ...deps,
      readApprovals: () => {
        reads += 1
        return [{ approval: reads === 1 ? approval : { ...approval, state: "succeeded" }, continuation: reads === 1 ? null : { continuationEpoch: 2 } }]
      },
    } as never)).resolves.toMatchObject({ mutationCount: 0, continuationEpochAfter: 2 })
  })

  it("rejects malformed recovery input and mismatched operation bindings before effects", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    const approval = {
      toolCallId: "call-1", frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [] },
    }
    expect(() => proveSanctuaryAttemptedRecoveryWithoutRetry("/unused", "invalid", approval as never))
      .toThrow("attempted recovery scenario is invalid")
    const root = fs.mkdtempSync("/tmp/oi-invalid-recovery-")
    try {
      expect(() => proveSanctuaryAttemptedRecoveryWithoutRetry(root, scenarioHandleDigest, approval as never))
        .toThrow("frozen tool call is invalid")
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
    await expect(executeSanctuaryInteractiveEngine({ operation: "drive_duplicate_callbacks", label: "unit-16k-timeout-stale", scenarioHandleDigest }, {
      agentRoot: "/unused", readApprovals: vi.fn(), readPending: vi.fn(), createSession: vi.fn(), proveIndeterminateRecovery: vi.fn(), writeCredentialObserved: vi.fn(),
    })).rejects.toThrow("operation binding is invalid")
  })

  it("proves attempted recovery through a durable SQLite close and reopen", () => {
    const agentRoot = fs.mkdtempSync("/tmp/oi-recovery-")
    const approval = {
      approvalId: "11111111-1111-4111-8111-111111111111", state: "proposed", epoch: 0, toolCallId: "call-1", toolName: "unraid_restart_container",
      arguments: { container: "calibre-web" }, argumentDigest: "a".repeat(64), schemaDigest: "b".repeat(64), toolDigest: "c".repeat(64), policyDigest: "d".repeat(64), policyId: "restart",
      sessionKey: "telegram:test", sessionPath: "/tmp/session", baseSessionRevision: "e".repeat(64), suspendedSessionRevision: "f".repeat(64), checkpointDigest: "1".repeat(64),
      requesterId: "tg_test", transport: "telegram", transportUserId: "tg_test", transportChatId: "tg_test", transportMessageId: "message", decisionTokenDigest: "2".repeat(64),
      expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ownerId: null, attemptedAt: null, result: null, reason: null,
      frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":\"calibre-web\"}" } }] },
    }
    try {
      const proof = proveSanctuaryAttemptedRecoveryWithoutRetry(agentRoot, "a".repeat(64), approval as never)
      expect(proof).toMatchObject({ observed: true, retryCount: 0, reopened: true, attemptedRecordDigest: expect.stringMatching(/^[0-9a-f]{64}$/u), recoveredRecordDigest: expect.stringMatching(/^[0-9a-f]{64}$/u) })
      expect(fs.existsSync(`${agentRoot}/state/acceptance/attempted-recovery-probes/${"a".repeat(64)}.sqlite`)).toBe(true)
      expect(() => proveSanctuaryAttemptedRecoveryWithoutRetry(agentRoot, "a".repeat(64), approval as never)).toThrow("inspect-before-retry")
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("owns a private readiness-bound socket for the existing Telegram transport lifecycle", async () => {
    const agentRoot = fs.mkdtempSync("/tmp/oi-")
    const transport = {
      handleUpdate: vi.fn(),
      listPendingDeliveries: vi.fn(() => []),
    }
    const owners: string[] = []
    let owner = "startup-owner"
    const runRequest = vi.fn(async <T>(operation: () => T | Promise<T>): Promise<T> => {
      owners.push(owner)
      return operation()
    })
    const control = createSanctuaryInteractiveControl({ agentRoot, transport: transport as never, authorizedUserId: "42", authorizedChatId: "42", runRequest })
    fs.mkdirSync(`${agentRoot}/state/acceptance`, { recursive: true })
    fs.writeFileSync(control.socketPath, "stale")
    expect(await sanctuaryInteractiveControlReady(control.socketPath, 20)).toBe(false)
    await control.start()
    try {
      expect(fs.statSync(control.socketPath).mode & 0o777).toBe(0o600)
      expect(await sanctuaryInteractiveControlReady(control.socketPath, 100)).toBe(true)
      owner = "scenario-a-owner"
      const scenarioHandleDigest = "a".repeat(64)
      await expect(request(control.socketPath, { operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest }))
        .resolves.toEqual({ ok: true, result: { ready: true } })
      await expect(request(control.socketPath, { operation: "interactive_runtime_ready", label: "wrong", scenarioHandleDigest }))
        .resolves.toEqual({ ok: false, error: "interactive runtime operation failed" })
      await expect(request(control.socketPath, { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }))
        .resolves.toEqual({ ok: false, error: "interactive runtime operation failed" })
      expect(transport.handleUpdate).not.toHaveBeenCalled()
      expect(runRequest).toHaveBeenCalledTimes(4)
      expect(owners).toEqual(["scenario-a-owner", "scenario-a-owner", "scenario-a-owner", "scenario-a-owner"])
    } finally {
      await control.stop()
      fs.writeFileSync(control.socketPath, "stale-after-stop")
      await control.stop()
      expect(fs.existsSync(control.socketPath)).toBe(false)
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
    expect(await sanctuaryInteractiveControlReady(control.socketPath, 20)).toBe(false)
  })

  it("returns a bounded failure when request ownership rejects before dispatch", async () => {
    const agentRoot = fs.mkdtempSync("/tmp/oi-owner-rejection-")
    const control = createSanctuaryInteractiveControl({
      agentRoot, transport: { handleUpdate: vi.fn(), listPendingDeliveries: vi.fn(() => []) } as never,
      authorizedUserId: "42", authorizedChatId: "42",
      runRequest: async () => { throw new Error("owner unavailable") },
    })
    await control.start()
    try {
      await expect(request(control.socketPath, { operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest: "a".repeat(64) }))
        .resolves.toEqual({ ok: false, error: "interactive runtime operation failed" })
    } finally {
      await control.stop()
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })

  it("destroys an interactive connection whose request exceeds the fixed bound", async () => {
    const agentRoot = fs.mkdtempSync("/tmp/oi-oversized-request-")
    const control = createSanctuaryInteractiveControl({
      agentRoot, transport: { handleUpdate: vi.fn(), listPendingDeliveries: vi.fn(() => []) } as never,
      authorizedUserId: "42", authorizedChatId: "42",
    })
    await control.start()
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(control.socketPath)
        socket.once("error", (error) => { if ((error as NodeJS.ErrnoException).code === "ECONNRESET") resolve(); else reject(error) })
        socket.once("close", () => resolve())
        socket.end("x".repeat(16 * 1024 + 1))
      })
    } finally {
      await control.stop()
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
