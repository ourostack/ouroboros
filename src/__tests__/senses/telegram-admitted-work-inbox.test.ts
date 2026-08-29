import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileTelegramUpdateInboxStore } from "../../senses/telegram-client"

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
})
