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
    } finally { fs.rmSync(agentRoot, { recursive: true, force: true }) }
  })

  it("owns a private readiness-bound socket for the existing Telegram transport lifecycle", async () => {
    const agentRoot = fs.mkdtempSync("/tmp/oi-")
    const transport = {
      handleUpdate: vi.fn(),
      listPendingDeliveries: vi.fn(() => []),
    }
    const control = createSanctuaryInteractiveControl({ agentRoot, transport: transport as never, authorizedUserId: "42", authorizedChatId: "42" })
    expect(await sanctuaryInteractiveControlReady(control.socketPath, 20)).toBe(false)
    await control.start()
    try {
      expect(fs.statSync(control.socketPath).mode & 0o777).toBe(0o600)
      expect(await sanctuaryInteractiveControlReady(control.socketPath, 100)).toBe(true)
      const scenarioHandleDigest = "a".repeat(64)
      await expect(request(control.socketPath, { operation: "interactive_runtime_ready", label: "unit-16m-restart-continuation", scenarioHandleDigest }))
        .resolves.toEqual({ ok: true, result: { ready: true } })
      await expect(request(control.socketPath, { operation: "interactive_runtime_ready", label: "wrong", scenarioHandleDigest }))
        .resolves.toEqual({ ok: false, error: "interactive runtime operation failed" })
      await expect(request(control.socketPath, { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }))
        .resolves.toEqual({ ok: false, error: "interactive runtime operation failed" })
      expect(transport.handleUpdate).not.toHaveBeenCalled()
    } finally {
      await control.stop()
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
    expect(await sanctuaryInteractiveControlReady(control.socketPath, 20)).toBe(false)
  })
})
