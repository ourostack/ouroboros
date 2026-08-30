import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createTelegramLongPoll, FileTelegramUpdateInboxStore } from "../../senses/telegram-client"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-admitted-inbox-"))
  roots.push(root)
  const statePath = path.join(root, "inbox.json")
  return { statePath, store: new FileTelegramUpdateInboxStore(statePath) }
}

const work = {
  admissionId: "a".repeat(20),
  friendId: "friend-1",
  sessionKey: "telegram:approved-contact",
  eventId: "evt-000001",
  reference: `telegram-admission:${"a".repeat(20)}`,
}

describe("Telegram admitted-work inbox", () => {
  it("durably captures and claims only references, then settles exactly once", () => {
    const { statePath, store } = fixture()
    expect(store.captureAdmittedWork(work)).toBe(true)
    expect(store.captureAdmittedWork(work)).toBe(false)
    expect(store.loadPendingAdmittedWork()).toEqual([work])
    expect(fs.readFileSync(statePath, "utf8")).not.toContain("approved original")
    expect(store.claimAdmittedWork(work.admissionId)).toEqual(work)
    expect(store.claimAdmittedWork(work.admissionId)).toBeNull()
    store.completeAdmittedWork(work.admissionId)
    expect(store.admittedWorkState(work.admissionId)).toBe("settled")
    store.completeAdmittedWork(work.admissionId)
    expect(() => store.captureAdmittedWork({ ...work, eventId: "evt-999999" })).toThrow("conflicting")
  })

  it("keeps pending work claimable after restart but quarantines stranded dispatch without blind rerun", () => {
    const { statePath, store } = fixture()
    store.captureAdmittedWork(work)
    const pendingRestart = new FileTelegramUpdateInboxStore(statePath)
    expect(pendingRestart.loadPendingAdmittedWork()).toEqual([work])
    expect(pendingRestart.quarantineStrandedAdmittedWork()).toEqual([])
    expect(pendingRestart.claimAdmittedWork(work.admissionId)).toEqual(work)

    const dispatchRestart = new FileTelegramUpdateInboxStore(statePath)
    expect(dispatchRestart.quarantineStrandedAdmittedWork()).toEqual([work])
    expect(dispatchRestart.admittedWorkState(work.admissionId)).toBe("indeterminate")
    expect(dispatchRestart.claimAdmittedWork(work.admissionId)).toBeNull()
    expect(dispatchRestart.quarantineStrandedAdmittedWork()).toEqual([])
  })

  it("rejects malformed or oversized reference work", () => {
    const { store } = fixture()
    expect(() => store.captureAdmittedWork({ ...work, admissionId: "bad" })).toThrow("invalid")
    expect(() => store.captureAdmittedWork({ ...work, sessionKey: "x".repeat(1_025) })).toThrow("invalid")
  })

  it("validates admitted-work identifiers and exposes every stable queue state", () => {
    const { store } = fixture()
    expect(() => store.claimAdmittedWork("bad")).toThrow("admission id is invalid")
    expect(store.claimAdmittedWork("b".repeat(20))).toBeNull()
    expect(() => store.completeAdmittedWork("bad")).toThrow("admission id is invalid")
    expect(() => store.admittedWorkState("bad")).toThrow("admission id is invalid")
    expect(store.admittedWorkState("b".repeat(20))).toBeNull()
    store.captureAdmittedWork(work)
    expect(store.admittedWorkState(work.admissionId)).toBe("pending")
    store.claimAdmittedWork(work.admissionId)
    expect(store.admittedWorkState(work.admissionId)).toBe("dispatching")
  })

  it("migrates the prior inbox shape and rejects malformed indeterminate admitted work", () => {
    const { statePath } = fixture()
    fs.writeFileSync(statePath, JSON.stringify({ version: 4, pending: [], dispatching: [], settled: [], indeterminate: [] }))
    const migrated = new FileTelegramUpdateInboxStore(statePath)
    expect(migrated.loadPendingAdmittedWork()).toEqual([])
    expect(JSON.parse(fs.readFileSync(statePath, "utf8"))).toMatchObject({ version: 5, admittedPending: [], admittedIndeterminate: [] })

    fs.writeFileSync(statePath, JSON.stringify({
      version: 5, pending: [], dispatching: [], settled: [], indeterminate: [], admittedPending: [], admittedDispatching: [], admittedSettled: [],
      admittedIndeterminate: [{ ...work, quarantinedAt: -1 }],
    }), { mode: 0o600 })
    fs.chmodSync(statePath, 0o600)
    expect(() => new FileTelegramUpdateInboxStore(statePath).loadPendingAdmittedWork()).toThrow("state is corrupt")

    fs.writeFileSync(statePath, JSON.stringify({
      version: 5, pending: [], dispatching: [], settled: [], indeterminate: [], admittedPending: [], admittedDispatching: [], admittedSettled: [], admittedIndeterminate: [null],
    }))
    fs.chmodSync(statePath, 0o600)
    expect(() => new FileTelegramUpdateInboxStore(statePath).loadPendingAdmittedWork()).toThrow("state is corrupt")

    fs.writeFileSync(statePath, JSON.stringify({
      version: 5, pending: [], dispatching: [], settled: [], indeterminate: [], admittedPending: [], admittedDispatching: [], admittedSettled: [],
      admittedIndeterminate: [
        { ...work, quarantinedAt: 900 },
        { ...work, admissionId: "b".repeat(20), reference: `telegram-admission:${"b".repeat(20)}`, quarantinedAt: 900 },
      ],
    }), { mode: 0o600 })
    fs.chmodSync(statePath, 0o600)
    expect(new FileTelegramUpdateInboxStore(statePath, { now: () => 1_000 }).loadPendingAdmittedWork()).toEqual([])
  })

  it("orders and bounds multiple stranded admitted-work receipts deterministically", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "telegram-admitted-bounds-"))
    roots.push(root)
    const store = new FileTelegramUpdateInboxStore(path.join(root, "inbox.json"), { now: () => 1_000, maxIndeterminateReceipts: 1 })
    const second = { ...work, admissionId: "b".repeat(20), reference: `telegram-admission:${"b".repeat(20)}` }
    store.captureAdmittedWork(work)
    store.captureAdmittedWork(second)
    store.claimAdmittedWork(work.admissionId)
    store.claimAdmittedWork(second.admissionId)
    expect(store.quarantineStrandedAdmittedWork()).toHaveLength(2)
    expect(store.admittedWorkState(work.admissionId)).toBeNull()
    expect(store.admittedWorkState(second.admissionId)).toBe("indeterminate")
  })

  it("does not treat the configured owner as unknown and honors a handled update", async () => {
    const sameOwnerWithoutText = { update_id: 1, message: { message_id: 1, from: { id: 10 }, chat: { id: 10, type: "private" as const }, caption: "photo", photo: [{}] } }
    const handled = { update_id: 2 }
    const onUnknownMessage = vi.fn()
    const onUpdate = vi.fn(async (update) => update.update_id === 2)
    const api = { stop: vi.fn(), request: vi.fn(async () => [sameOwnerWithoutText, handled]) }
    const poll = createTelegramLongPoll({
      api,
      expectedUserId: "10",
      expectedChatId: "10",
      botId: "777",
      offsetStore: { load: () => 0, save: vi.fn() },
      onMessage: vi.fn(),
      onUnknownMessage,
      onUpdate,
    })

    await poll.pollOnce()

    expect(onUnknownMessage).not.toHaveBeenCalled()
    expect(onUpdate).toHaveBeenCalledTimes(2)
  })
})
