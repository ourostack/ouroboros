import * as fs from "node:fs"
import { createConnection } from "node:net"

import { afterEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  mode: "timeout" as "timeout" | "duplicate" | "prepare" | "reconcile",
  reads: 0,
  pending: [] as Record<string, unknown>[],
}))

vi.mock("../../heart/approval-store", async (importActual) => {
  const actual = await importActual<typeof import("../../heart/approval-store")>()
  return {
    ...actual,
    readApprovalsByScenarioHandleDigest: vi.fn(() => {
      state.reads += 1
      const succeeded = state.mode === "duplicate" || state.mode === "reconcile"
      const after = state.reads > 1 && succeeded
      return [{
        approval: {
          approvalId: "11111111-1111-4111-8111-111111111111",
          state: state.mode === "timeout" ? "expired" : after ? "succeeded" : "proposed",
          epoch: after && state.mode === "duplicate" ? 1 : 0,
          toolCallId: "call-1",
          toolName: "unraid_restart_container",
          arguments: { container: "calibre-web" },
          argumentDigest: "a".repeat(64), schemaDigest: "b".repeat(64), toolDigest: "c".repeat(64), policyDigest: "d".repeat(64), policyId: "restart",
          sessionKey: "telegram:test", sessionPath: "/tmp/session", baseSessionRevision: "e".repeat(64), suspendedSessionRevision: "f".repeat(64), checkpointDigest: "1".repeat(64),
          requesterId: "tg_test", transport: "telegram", transportUserId: "tg_test", transportChatId: "tg_test", transportMessageId: "message", decisionTokenDigest: "2".repeat(64),
          expiresAt: "2099-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ownerId: null, attemptedAt: null, result: null, reason: null,
          frozenAssistantMessage: { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "unraid_restart_container", arguments: "{\"container\":\"calibre-web\"}" } }] },
        },
        continuation: after && state.mode === "reconcile" ? { continuationEpoch: 1 } : null,
      }]
    }),
  }
})

vi.mock("../../senses/telegram-client", async (importActual) => {
  const actual = await importActual<typeof import("../../senses/telegram-client")>()
  return { ...actual, FileTelegramPendingApprovalStore: class { load() { return structuredClone(state.pending) } } }
})

import { createSanctuaryInteractiveControl } from "../../senses/sanctuary-interactive-control"

const roots: string[] = []

function socketRequest(socketPath: string, payload: unknown): Promise<Record<string, unknown>> {
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

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary interactive socket production dependency coverage", () => {
  it("drives every production socket dependency through the existing Telegram transport", async () => {
    const root = fs.mkdtempSync("/tmp/oi-socket-coverage-")
    roots.push(root)
    const scenarioHandleDigest = "a".repeat(64)
    const pending = {
      approvalId: "11111111-1111-4111-8111-111111111111", messageId: "42", deliveryState: "bound",
      approveCallbackData: "a:opaque", denyCallbackData: "d:opaque", expiresAt: 300_000,
    }
    const tombstone = {
      ...pending, deliveryState: "terminal_tombstone", terminalizedAt: 301_000, tombstoneExpiresAt: 901_000,
      expiryObservation: { schemaVersion: "telegram-approval-expiry-observation-v1", deadlineAt: 300_000, observedAt: 300_500, evidenceMac: "f".repeat(64) },
    }
    const handleUpdate = vi.fn(async () => state.mode === "timeout"
      ? { handled: true, accepted: false, reason: "stale_callback" }
      : { handled: true, accepted: true, reason: "accepted" })
    const transport = { handleUpdate, listPendingDeliveries: vi.fn(() => [{ approvalId: "unrelated" }]) }
    const control = createSanctuaryInteractiveControl({ agentRoot: root, transport: transport as never, authorizedUserId: "42", authorizedChatId: "42" })
    await control.start()
    await control.start()
    try {
      state.mode = "timeout"; state.reads = 0; state.pending = [tombstone]
      await expect(socketRequest(control.socketPath, { operation: "drive_timeout_stale", label: "unit-16k-timeout-stale", scenarioHandleDigest }))
        .resolves.toMatchObject({ ok: true, result: { phase: "complete" } })

      state.mode = "duplicate"; state.reads = 0; state.pending = [pending]
      await expect(socketRequest(control.socketPath, { operation: "drive_duplicate_callbacks", label: "unit-16l-duplicate-callback", scenarioHandleDigest }))
        .resolves.toMatchObject({ ok: true, result: { phase: "complete", writeCredentialObserved: false } })

      state.mode = "prepare"; state.reads = 0; state.pending = [pending]
      await expect(socketRequest(control.socketPath, { operation: "prepare_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }))
        .resolves.toMatchObject({ ok: true, result: { phase: "prepared", indeterminateRecoveryObserved: true } })

      state.mode = "reconcile"; state.reads = 0; state.pending = [pending]
      await expect(socketRequest(control.socketPath, { operation: "reconcile_restart_continuation", label: "unit-16m-restart-continuation", scenarioHandleDigest }))
        .resolves.toMatchObject({ ok: true, result: { pendingRestored: true } })
      expect(handleUpdate).toHaveBeenCalled()
    } finally {
      await control.stop()
      await control.stop()
    }
  })
})
