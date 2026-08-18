import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import {
  appendSyntheticAssistantMessage,
  deleteSession,
  loadSession,
  postTurnPersist,
  postTurnTrim,
  saveSession,
} from "../../mind/context"

const roots: string[] = []

function sessionPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ouro-context-transaction-"))
  roots.push(root)
  return path.join(root, "session.json")
}

async function transaction(): Promise<any> {
  return import("../../mind/session-transaction")
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("context mutation transaction routing", () => {
  it("routes saveSession through the caller-owned canonical lease", async () => {
    const { acquireSessionTurnLease } = await transaction()
    const file = sessionPath()
    const lease = await acquireSessionTurnLease(file, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })

    expect(() => (saveSession as any)(file, [{ role: "user", content: "saved" }], undefined, undefined, {
      ...lease,
      sessionPath: `${file}.other`,
    })).toThrow(/session path/i)
    ;(saveSession as any)(file, [{ role: "user", content: "saved" }], undefined, undefined, lease)
    expect(loadSession(file)?.messages).toEqual([expect.objectContaining({ role: "user", content: "saved" })])
    await lease.release()
  })

  it("routes synthetic append through the same lease and preserves its write", async () => {
    const { acquireSessionTurnLease } = await transaction()
    const file = sessionPath()
    const lease = await acquireSessionTurnLease(file, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    ;(saveSession as any)(file, [{ role: "user", content: "saved" }], undefined, undefined, lease)

    expect((appendSyntheticAssistantMessage as any)(file, "synthetic", { ...lease, ownerToken: "forged" })).toBe(false)
    expect((appendSyntheticAssistantMessage as any)(file, "synthetic", lease)).toBe(true)
    expect(loadSession(file)?.messages.at(-1)).toEqual(expect.objectContaining({ role: "assistant", content: "synthetic" }))
    await lease.release()
  })

  it("routes postTurnPersist through revision-checked durable replacement", async () => {
    const { acquireSessionTurnLease, readSessionTransaction } = await transaction()
    const file = sessionPath()
    const lease = await acquireSessionTurnLease(file, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    ;(saveSession as any)(file, [{ role: "user", content: "base" }], undefined, undefined, lease)
    const before = readSessionTransaction(file, lease).revision
    const messages = [{ role: "user" as const, content: "base" }, { role: "assistant" as const, content: "answer" }]
    const prepared = postTurnTrim(messages)

    ;(postTurnPersist as any)(file, prepared, undefined, undefined, lease)
    const after = readSessionTransaction(file, lease).revision
    expect(after).not.toBe(before)
    expect(loadSession(file)?.messages.at(-1)).toEqual(expect.objectContaining({ role: "assistant", content: "answer" }))
    await lease.release()
  })

  it("routes deleteSession through ownership validation", async () => {
    const { acquireSessionTurnLease } = await transaction()
    const file = sessionPath()
    const lease = await acquireSessionTurnLease(file, { ownerId: "owner-a", timeoutMs: 20, pollIntervalMs: 1 })
    ;(saveSession as any)(file, [{ role: "user", content: "base" }], undefined, undefined, lease)

    expect(() => (deleteSession as any)(file, { ...lease, ownerToken: "forged" })).toThrow(/owner|token/i)
    ;(deleteSession as any)(file, lease)
    expect(fs.existsSync(file)).toBe(false)
    await lease.release()
  })
})
