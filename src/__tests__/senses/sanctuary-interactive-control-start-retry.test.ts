import * as fs from "node:fs"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSanctuaryInteractiveControl, sanctuaryInteractiveControlReady } from "../../senses/sanctuary-interactive-control"

vi.mock("node:fs", async (importActual) => ({ ...await importActual<typeof import("node:fs")>() }))

const roots: string[] = []
const controls: ReturnType<typeof createSanctuaryInteractiveControl>[] = []

function pair() {
  const agentRoot = fs.mkdtempSync("/tmp/d007-retry-")
  roots.push(agentRoot)
  const unused = async (): Promise<never> => { throw new Error("unexpected transport effect") }
  const transport = {
    sendApproval: unused, handleUpdate: unused, recoverDecisionAttempt: unused, reconcileExpired: unused,
    terminalizeOrphaned: unused, terminalizeRecovered: unused, listPendingDeliveries: () => [], validatePendingTerminalControl: unused,
  }
  const first = createSanctuaryInteractiveControl({ agentRoot, transport, authorizedUserId: "42", authorizedChatId: "42" })
  const second = createSanctuaryInteractiveControl({ agentRoot, transport, authorizedUserId: "42", authorizedChatId: "42" })
  controls.push(first, second)
  return { first, second }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const control of controls.splice(0).reverse()) await control.stop()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("D-007 retained-start retry", () => {
  it("refuses false idempotent start on a replaced endpoint and restarts only after release", async () => {
    const { first, second } = pair()
    await first.start()
    fs.unlinkSync(first.socketPath)
    await second.start()
    const before = fs.lstatSync(second.socketPath, { bigint: true })
    await expect(first.start()).rejects.toThrow(/ownership|another|replaced/i)
    expect(fs.lstatSync(second.socketPath, { bigint: true })).toEqual(before)
    expect(await sanctuaryInteractiveControlReady(second.socketPath)).toBe(true)
    await second.stop()
    await first.start()
    expect(await sanctuaryInteractiveControlReady(first.socketPath)).toBe(true)
  })

  it("retries failed startup after its refused cleanup becomes safe without an extra stop call", async () => {
    const { first, second } = pair()
    const starting = first.start()
    fs.unlinkSync(first.socketPath)
    const replacementStarting = second.start()
    await expect(starting).rejects.toThrow()
    await replacementStarting
    await second.stop()
    await first.start()
    expect(await sanctuaryInteractiveControlReady(first.socketPath)).toBe(true)
  })

  it("distinguishes a replacement's creation identity even if device and inode are reused", async () => {
    const { first, second } = pair()
    await first.start()
    const original = fs.lstatSync(first.socketPath, { bigint: true })
    fs.unlinkSync(first.socketPath)
    await second.start()
    const replacement = fs.lstatSync(second.socketPath, { bigint: true })
    expect(replacement.birthtimeNs).not.toBe(original.birthtimeNs)
    const lstat = fs.lstatSync
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      const current = Reflect.apply(lstat, fs, args)
      if (String(args[0]) === first.socketPath && current) Object.assign(current, { dev: original.dev, ino: original.ino })
      return current
    })
    try {
      await expect(first.stop()).rejects.toThrow(/ownership|another|replaced/i)
    } finally { vi.restoreAllMocks() }
    expect(fs.lstatSync(second.socketPath, { bigint: true })).toEqual(replacement)
    expect(await sanctuaryInteractiveControlReady(second.socketPath)).toBe(true)
  })
})

describe("D-007 native failure and duplicate boundaries", () => {
  it("single-flights concurrent native stops", async () => {
    const { first } = pair()
    await first.start()
    const stopping = first.stop()
    expect(first.stop()).toBe(stopping)
    await stopping
    expect(fs.existsSync(first.socketPath)).toBe(false)
  })

  it("refuses unproven startup ownership without silently deleting the endpoint", async () => {
    const { first } = pair()
    const lstat = fs.lstatSync
    let reads = 0
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === first.socketPath && ++reads === 2) return undefined
      return Reflect.apply(lstat, fs, args)
    })
    try {
      await expect(first.start()).rejects.toMatchObject({
        message: "Sanctuary interactive control startup and ownership cleanup failed",
        errors: [
          expect.objectContaining({ message: "Sanctuary interactive control startup ownership is unproven" }),
          expect.objectContaining({ message: "Sanctuary interactive control socket ownership was replaced" }),
        ],
      })
      expect(fs.lstatSync(first.socketPath).isSocket()).toBe(true)
    } finally {
      vi.restoreAllMocks()
      fs.unlinkSync(first.socketPath)
    }
    await first.start()
    expect(await sanctuaryInteractiveControlReady(first.socketPath)).toBe(true)
  })
})
