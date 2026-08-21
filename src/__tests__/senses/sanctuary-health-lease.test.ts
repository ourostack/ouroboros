import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { describe, expect, it } from "vitest"

import {
  createSanctuaryHealthSweep,
  withSanctuaryHealthStateLease,
} from "../../senses/sanctuary-health"

function healthyContext() {
  return { sanctuary: {
    listContainers: async () => ({ ok: true, data: { containers: [], truncated: false } }),
    getStorage: async () => ({ ok: true, data: { array: { usedPercent: 10, degraded: false }, shares: [] } }),
    getDisks: async () => ({ ok: true, data: { disks: [], parity: { result: "success", ageHours: 1 } } }),
    getNotifications: async () => ({ ok: true, data: { unacknowledged: [] } }),
  } } as any
}

describe("Sanctuary cross-process health lease", () => {
  it("permits reentrant sweeps only through the exact transaction lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-lease-"))
    const statePath = path.join(root, "state.json")
    try {
      await withSanctuaryHealthStateLease(statePath, async (lease) => {
        const sweep = createSanctuaryHealthSweep({
          toolContext: healthyContext(),
          statePath,
          lease,
          fetch: async () => new Response(null, { status: 204 }),
          now: () => new Date("2026-08-18T15:00:00.000Z"),
        })
        await expect(sweep()).resolves.toMatchObject({ message: null, incidents: [] })
        expect(fs.existsSync(`${statePath}.lease`)).toBe(true)
      })
      expect(fs.existsSync(`${statePath}.lease`)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("recovers a canonical stale lease but fails closed on malformed ownership", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-stale-lease-"))
    const statePath = path.join(root, "state.json")
    const leasePath = `${statePath}.lease`
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.writeFileSync(path.join(leasePath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: "a".repeat(64) })}\n`, { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => "recovered", { timeoutMs: 100 }))
        .resolves.toBe("recovered")
      expect(fs.existsSync(leasePath)).toBe(false)

      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.writeFileSync(path.join(leasePath, "owner.json"), "{}\n", { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 10 }))
        .rejects.toThrow(/ownership is invalid/u)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
