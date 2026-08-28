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
  it("surfaces real lease parent creation failures", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-bad-parent-"))
    const blocked = path.join(root, "blocked")
    fs.writeFileSync(blocked, "not a directory")
    const statePath = path.join(blocked, "health", "state.json")
    try {
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 0 }))
        .rejects.toMatchObject({ code: "ENOTDIR" })
      expect(fs.existsSync(`${statePath}.lease`)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("waits for a live owner and then times out without disturbing its lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-live-lease-"))
    const statePath = path.join(root, "state.json")
    const leasePath = `${statePath}.lease`
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.writeFileSync(path.join(leasePath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: process.pid, nonce: "a".repeat(64) })}\n`, { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 5 }))
        .rejects.toThrow("lease timed out")
      expect(fs.existsSync(path.join(leasePath, "owner.json"))).toBe(true)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("retries an owner-file creation race and recovers the completed stale lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-owner-race-"))
    const statePath = path.join(root, "state.json")
    const leasePath = `${statePath}.lease`
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
      setTimeout(() => fs.writeFileSync(path.join(leasePath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: "a".repeat(64) })}\n`, { mode: 0o600 }), 1)
      await expect(withSanctuaryHealthStateLease(statePath, async () => "recovered", { timeoutMs: 100 }))
        .resolves.toBe("recovered")
      expect(fs.existsSync(leasePath)).toBe(false)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("fails closed on unreadable ownership, unexpected lease entries, and release-time owner drift", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-lease-corruption-"))
    const statePath = path.join(root, "state.json")
    const leasePath = `${statePath}.lease`
    try {
      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.writeFileSync(path.join(leasePath, "owner.json"), "not-json\n", { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 0 }))
        .rejects.toThrow("ownership is invalid")

      fs.rmSync(leasePath, { recursive: true, force: true })
      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.mkdirSync(path.join(leasePath, "unexpected"))
      fs.writeFileSync(path.join(leasePath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: "a".repeat(64) })}\n`, { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 0 }))
        .rejects.toThrow("unexpected entries")

      fs.rmSync(leasePath, { recursive: true, force: true })
      await expect(withSanctuaryHealthStateLease(statePath, async () => {
        const ownerPath = path.join(leasePath, "owner.json")
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"))
        fs.writeFileSync(ownerPath, `${JSON.stringify({ ...owner, nonce: "b".repeat(64) })}\n`)
      })).rejects.toThrow("ownership changed")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it("rejects a forged transaction lease", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-forged-lease-"))
    const statePath = path.join(root, "state.json")
    try {
      const sweep = createSanctuaryHealthSweep({
        toolContext: healthyContext(), statePath,
        lease: { statePath, nonce: "a".repeat(64) } as never,
        fetch: async () => new Response(null, { status: 204 }),
        now: () => new Date("2026-08-18T15:00:00.000Z"),
      })
      await expect(sweep()).rejects.toThrow("state lease is invalid")
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

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

      fs.rmSync(leasePath, { recursive: true, force: true })
      fs.mkdirSync(leasePath, { mode: 0o700 })
      fs.writeFileSync(path.join(leasePath, "owner.json"), "null\n", { mode: 0o600 })
      await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 10 }))
        .rejects.toThrow(/ownership is invalid/u)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
