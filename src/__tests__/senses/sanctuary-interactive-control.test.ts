import * as fs from "node:fs"
import { createConnection } from "node:net"

import { describe, expect, it, vi } from "vitest"

import { createSanctuaryInteractiveControl, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"

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
