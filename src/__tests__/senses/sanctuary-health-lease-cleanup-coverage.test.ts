import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it, vi } from "vitest"

const fault = vi.hoisted(() => ({ armed: false, ownerExists: false, cleanupFails: false, emptyLeaseRead: false }))

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>()
  return {
    ...actual,
    mkdirSync: (target: Parameters<typeof actual.mkdirSync>[0], options?: Parameters<typeof actual.mkdirSync>[1]) => {
      const rendered = String(target)
      if (!fault.armed || !rendered.endsWith(".lease")) return actual.mkdirSync(target, options as never)
      fault.armed = false
      actual.mkdirSync(target, options as never)
      if (fault.ownerExists) actual.writeFileSync(path.join(rendered, "owner.json"), "synthetic owner")
      throw Object.assign(new Error("synthetic lease mkdir failure"), { code: "EACCES" })
    },
    rmdirSync: (target: Parameters<typeof actual.rmdirSync>[0], options?: Parameters<typeof actual.rmdirSync>[1]) => {
      if (fault.cleanupFails && String(target).endsWith(".lease")) throw new Error("synthetic cleanup failure")
      return actual.rmdirSync(target, options as never)
    },
    readdirSync: (target: Parameters<typeof actual.readdirSync>[0], options?: Parameters<typeof actual.readdirSync>[1]) => {
      if (fault.emptyLeaseRead && String(target).endsWith(".lease")) {
        fault.emptyLeaseRead = false
        actual.unlinkSync(path.join(String(target), "owner.json"))
        return []
      }
      return actual.readdirSync(target, options as never)
    },
  }
})

const roots: string[] = []

afterEach(async () => {
  const fs = await import("node:fs")
  fault.armed = false
  fault.ownerExists = false
  fault.cleanupFails = false
  fault.emptyLeaseRead = false
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("Sanctuary health lease partial-creation cleanup", () => {
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
  ])("preserves the original mkdir failure (owner=%s cleanupFailure=%s)", async (ownerExists, cleanupFails, leaseRemains) => {
    vi.resetModules()
    const fs = await import("node:fs")
    const { withSanctuaryHealthStateLease } = await import("../../senses/sanctuary-health")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-partial-lease-")); roots.push(root)
    const statePath = path.join(root, "state.json")
    fault.ownerExists = ownerExists
    fault.cleanupFails = cleanupFails
    fault.armed = true

    await expect(withSanctuaryHealthStateLease(statePath, async () => undefined, { timeoutMs: 0 }))
      .rejects.toThrow("synthetic lease mkdir failure")
    expect(fs.existsSync(`${statePath}.lease`)).toBe(leaseRemains)
  })

  it("removes a stale lease whose owner disappears immediately before directory inspection", async () => {
    vi.resetModules()
    const fs = await import("node:fs")
    const { withSanctuaryHealthStateLease } = await import("../../senses/sanctuary-health")
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sanctuary-health-empty-stale-")); roots.push(root)
    const statePath = path.join(root, "state.json")
    const leasePath = `${statePath}.lease`
    fs.mkdirSync(leasePath)
    fs.writeFileSync(path.join(leasePath, "owner.json"), `${JSON.stringify({ schemaVersion: 1, pid: 2_147_483_647, nonce: "a".repeat(64) })}\n`)
    fault.emptyLeaseRead = true

    await expect(withSanctuaryHealthStateLease(statePath, async () => "recovered", { timeoutMs: 100 })).resolves.toBe("recovered")
  })
})
