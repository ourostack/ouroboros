import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it, vi } from "vitest"

import { openApprovalStore } from "../../../heart/approval-store"
import {
  readDefaultSanctuaryScenarioFacts,
  type SanctuaryAcceptanceAdapterDependencies,
} from "../../../heart/daemon/sanctuary-acceptance-adapter"
import { createSanctuaryHealthSweep } from "../../../senses/sanctuary-health"

function healthContext() {
  return { sanctuary: {
    listContainers: vi.fn().mockResolvedValue({ ok: true, data: { containers: [
      { id: "Docker:calibre-web", name: "calibre-web", autostart: true, state: "exited", exitCode: 1, degraded: false },
    ], truncated: false } }),
    getStorage: vi.fn().mockResolvedValue({ ok: true, data: { array: { state: "STARTED", usedPercent: 40, degraded: false }, shares: [], truncated: false } }),
    getDisks: vi.fn().mockResolvedValue({ ok: true, data: { disks: [], parity: { result: "success", ageHours: 1, degraded: false }, truncated: false } }),
    getNotifications: vi.fn().mockResolvedValue({ ok: true, data: { unacknowledged: [], truncated: false } }),
  } } as any
}

describe("Sanctuary health acceptance integration", () => {
  it("reads one tagged delivered transition from the sweep's durable state", async () => {
    const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-acceptance-"))
    const scenarioHandleDigest = "a".repeat(64)
    const healthPath = path.join(agentRoot, "state", "health", "sanctuary-health.json")
    const approvalPath = path.join(agentRoot, "state", "approvals", "approvals.sqlite")
    fs.mkdirSync(path.dirname(approvalPath), { recursive: true })
    openApprovalStore({ databasePath: approvalPath }).close()
    try {
      const sweep = createSanctuaryHealthSweep({
        toolContext: healthContext(),
        statePath: healthPath,
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })),
        now: () => new Date("2026-08-18T15:00:00.000Z"),
        acceptanceEventMeta: () => ({ scenarioHandleDigest }),
      })
      const result = await sweep()
      await sweep.markDeliveryAttempting(result.deliveryId!)
      await sweep.markDelivered(result.deliveryId!, [7001])

      const dependencies: SanctuaryAcceptanceAdapterDependencies = {
        readKeyFiles: () => [],
        readDescriptor: () => "",
        execFile: async () => ({ status: 0, stdout: "" }),
        fetch: vi.fn().mockResolvedValue(new Response(null, { status: 204 })) as typeof fetch,
        readFixedFile: (filePath) => fs.readFileSync(filePath, "utf8"),
        hostRequest: async () => ({
          imageId: `sha256:${"b".repeat(64)}`,
          running: true,
          health: "healthy",
          user: "10001:10001",
          readOnlyRoot: true,
          mountCount: 2,
          publishedPortCount: 0,
          restartPolicy: "unless-stopped",
          restartCount: 0,
          autostartExact: true,
          updaterDisabled: true,
          vaultUnlocked: true,
          manualAuthRequired: false,
        }),
      }

      const facts = await readDefaultSanctuaryScenarioFacts(
        "unit-16g-health-transition",
        scenarioHandleDigest,
        dependencies,
        agentRoot,
      )

      expect(facts.health).toEqual({ transitionCount: 1, alertCount: 1, productionRestored: true })
      expect(facts.sourceValues["health-runtime"]).toMatchObject({
        outbox: null,
        sweepReceipts: [expect.objectContaining({
          scenarioHandleDigest,
          deliveryId: result.deliveryId,
          opened: 1,
          recovered: 0,
          digestDue: false,
        })],
        deliveredReceipts: [expect.objectContaining({
          deliveryId: result.deliveryId,
          kind: "transition",
          messageIds: [7001],
        })],
      })
    } finally {
      fs.rmSync(agentRoot, { recursive: true, force: true })
    }
  })
})
