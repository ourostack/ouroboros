import * as fs from "node:fs"
import { createConnection } from "node:net"

import { describe, expect, it, vi } from "vitest"

import { createSanctuaryInteractiveControl, executeSanctuaryInteractiveEngine, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"

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
  it("retains one callback through expiry, settles it stale without a claim, and fails closed after daemon loss", async () => {
    const scenarioHandleDigest = "a".repeat(64)
    let state: "proposed" | "expired" = "proposed"
    const timeoutCoordinates = new Map()
    const pending = { approvalId: "approval-1", messageId: "42", deliveryState: "bound" as const, approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: 300_000 }
    const projection = () => [{ approval: {
      approvalId: "approval-1", state, epoch: 0, toolName: "unraid_restart_container", arguments: { container: "calibre-web" },
      checkpointDigest: "b".repeat(64), suspendedSessionRevision: "c".repeat(64),
    } as never, continuation: null }]
    const handle = vi.fn(async () => ({ handled: true, accepted: false, reason: "stale_callback" }))
    const deps = {
      agentRoot: "/unused", readApprovals: projection, readPending: () => state === "proposed" ? [pending] : [], timeoutCoordinates,
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
    await expect(executeSanctuaryInteractiveEngine(request, { ...deps, timeoutCoordinates: new Map() }))
      .rejects.toThrow(/not retained by this daemon/iu)
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
      expect(transport.handleUpdate).not.toHaveBeenCalled()
    } finally {
      await control.stop()
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
    expect(await sanctuaryInteractiveControlReady(control.socketPath, 20)).toBe(false)
  })
})
