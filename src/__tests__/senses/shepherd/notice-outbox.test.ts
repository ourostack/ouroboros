import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerGlobalLogSink, type LogEvent } from "../../../nerves"
import { claimPendingNotices, declareNoticeTargets, enqueueNotice, noticeDeliveryState, noticeRecordId, readNoticeOutbox, recordNoticeDelivery } from "../../../senses/shepherd/notice-outbox"
import { shepherdStateDir, type ReturnRecord } from "../../../senses/shepherd/returns"

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

let root: string
const record = (transition = "returned-1"): ReturnRecord => ({
  at: "2026-10-13T23:00:00.000Z", host: "cmux", session: "terminal-uuid", transition,
  agent: "Copilot", cwd: "/project", title: "Tests", workspaceTitle: "Project", task: null,
  kind: "premature", action: "respond", reason: "Tests still need to run.", reply: "Run the tests.",
  latencyMs: 1, inputTokens: 1,
})
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-notice-outbox-")) })

describe("private Shepherd notice outbox", () => {
  it("persists a return before delivery and survives a new reader", async () => {
    const value = record()
    expect(readNoticeOutbox(root)).toEqual([])
    const id = await enqueueNotice(root, value)
    expect(id).toBe(noticeRecordId(value))
    expect(readNoticeOutbox(root)).toEqual([{ id, record: value, deliveries: {} }])
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, "owner")).toBe("pending")
    expect(fs.statSync(shepherdStateDir(root)).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(shepherdStateDir(root), "notice-outbox.json")).mode & 0o777).toBe(0o600)
  })

  it("deduplicates the same return without losing a prior acceptance", async () => {
    const value = record()
    const id = await enqueueNotice(root, value)
    await recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "2026-10-13T23:00:01Z", messageId: "activity-1" })
    await enqueueNotice(root, value)
    const entries = readNoticeOutbox(root)
    expect(entries).toHaveLength(1)
    expect(noticeDeliveryState(entries[0]!, "owner")).toBe("sent")
    expect(entries[0]!.deliveries.owner).toMatchObject({ messageId: "activity-1", attempts: 1 })
    expect(noticeDeliveryState(entries[0]!, "another-family-member")).toBe("pending")
  })

  it("publishes the claim before returning a transport body and never reclaims uncertainty or acceptance", async () => {
    const id = await enqueueNotice(root, record())
    expect(await claimPendingNotices(root, [id], "owner", "now")).toHaveLength(1)
    expect(readNoticeOutbox(root)[0]!.deliveries.owner).toMatchObject({ state: "unknown", attempts: 1 })
    expect(await claimPendingNotices(root, [id], "owner", "later")).toEqual([])
    await recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "now" })
    expect(await claimPendingNotices(root, [id], "owner", "later")).toEqual([])
    await expect(claimPendingNotices(root, [id], "__proto__", "now")).rejects.toThrow("invalid notice target")
  })

  it("retains definite failures for retry and uncertain sends as explicitly unknown", async () => {
    const id = await enqueueNotice(root, record())
    await recordNoticeDelivery(root, [id], "owner", { state: "pending", at: "2026-10-13T23:00:01Z", reason: "no bot yet" })
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, "owner")).toBe("pending")
    await recordNoticeDelivery(root, [id], "owner", { state: "unknown", at: "2026-10-13T23:00:02Z", reason: "send acknowledgement lost" })
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, "owner")).toBe("unknown")
    expect(readNoticeOutbox(root)[0]!.deliveries.owner!.attempts).toBe(2)
  })

  it("serializes concurrent enqueue and per-target updates without dropping another return", async () => {
    const ids = await Promise.all([enqueueNotice(root, record("a")), enqueueNotice(root, record("b"))])
    await Promise.all([
      recordNoticeDelivery(root, ids, "owner", { state: "sent", at: "now" }),
      recordNoticeDelivery(root, ids, "other", { state: "pending", at: "now" }),
    ])
    expect(readNoticeOutbox(root)).toHaveLength(2)
    expect(readNoticeOutbox(root).every(entry => noticeDeliveryState(entry, "owner") === "sent" && noticeDeliveryState(entry, "other") === "pending")).toBe(true)
  })

  it("redacts secret-shaped telemetry before persisting a notice", async () => {
    const value = { ...record(), reason: `ghp_${"a".repeat(36)}`, reply: "token=private-test-value" }
    await enqueueNotice(root, value)
    const entry = readNoticeOutbox(root)[0]!
    expect(entry.record.reason).toBe("[redacted]")
    expect(entry.record.reply).toBe("token=[redacted]")
    expect(fs.readFileSync(path.join(shepherdStateDir(root), "notice-outbox.json"), "utf8")).not.toContain("private-test-value")
  })

  it("rejects a changed body for a known return and an unknown delivery reference", async () => {
    const value = record()
    await enqueueNotice(root, value)
    await expect(enqueueNotice(root, { ...value, reason: "different" })).rejects.toThrow("different notice body")
    await expect(recordNoticeDelivery(root, ["missing"], "owner", { state: "sent", at: "now" })).rejects.toThrow("unknown notice")
  })

  it("declares every recipient before sending so one acceptance cannot settle another recipient's intent", async () => {
    const id = await enqueueNotice(root, record())
    await declareNoticeTargets(root, [id], ["owner", "other"], "now")
    await recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "now" })
    const entry = readNoticeOutbox(root)[0]!
    expect(entry.deliveries.other).toEqual({ state: "pending", at: "now", attempts: 0 })
    expect(noticeDeliveryState(entry, "other")).toBe("pending")
    await declareNoticeTargets(root, [id], ["owner", "other"], "later")
    expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, "owner")).toBe("sent")
  })

  it("archives settled payloads while keeping unaccepted returns active and old acceptances deduplicated", async () => {
    fs.mkdirSync(shepherdStateDir(root), { recursive: true })
    const accepted = Array.from({ length: 257 }, (_, i) => {
      const value = record(`accepted-${i}`)
      return { id: noticeRecordId(value), record: value, deliveries: { owner: { state: "sent", at: "now", attempts: 1 } } }
    })
    const unknown = record("uncertain")
    fs.writeFileSync(path.join(shepherdStateDir(root), "notice-outbox.json"), JSON.stringify({ schemaVersion: 1, entries: [
      ...accepted, { id: noticeRecordId(unknown), record: unknown, deliveries: { owner: { state: "unknown", at: "now", attempts: 1 } } },
    ] }))
    await enqueueNotice(root, record("new"))
    expect(readNoticeOutbox(root)).toHaveLength(258)
    expect(readNoticeOutbox(root).some(entry => entry.id === noticeRecordId(unknown))).toBe(true)
    const archivedFile = path.join(shepherdStateDir(root), "notice-receipts", `${accepted[0]!.id}.json`)
    expect(JSON.parse(fs.readFileSync(archivedFile, "utf8")).deliveries.owner.state).toBe("sent")
    await enqueueNotice(root, accepted[0]!.record)
    await recordNoticeDelivery(root, [accepted[0]!.id], "owner", { state: "pending", at: "later" })
    expect(readNoticeOutbox(root)).toHaveLength(258)
    expect(JSON.parse(fs.readFileSync(archivedFile, "utf8")).deliveries.owner.state).toBe("sent")
  })

  it.each(["intent", "receipt"] as const)("does not log a persisted %s when atomic publication fails", async operation => {
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    const id = operation === "receipt" ? await enqueueNotice(root, record()) : ""
    events.length = 0
    vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw new Error("publication failed") })
    try {
      await expect(operation === "intent" ? enqueueNotice(root, record()) : recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "now" })).rejects.toThrow("publication failed")
      expect(events.some(event => ["senses.shepherd_notice_queued", "senses.shepherd_notice_receipt"].includes(event.event))).toBe(false)
    } finally {
      unregister()
    }
  })

  it("treats a target name that also exists on Object.prototype as an ordinary own key", async () => {
    const id = await enqueueNotice(root, record())
    await declareNoticeTargets(root, [id], ["toString"], "now")
    expect(readNoticeOutbox(root)[0]!.deliveries.toString).toEqual({ state: "pending", at: "now", attempts: 0 })
  })

  it("deduplicates omitted optional metadata and preserves nullable fields", async () => {
    const value = { ...record(), title: undefined, workspaceTitle: null, reply: null, latencyMs: null, inputTokens: null, task: "desk/task" }
    const id = await enqueueNotice(root, value)
    await expect(enqueueNotice(root, value)).resolves.toBe(id)
    expect(readNoticeOutbox(root)[0]!.record).toMatchObject({ workspaceTitle: null, reply: null, task: "desk/task" })
  })

  it.each([
    { at: 1 }, { kind: "made-up" }, { action: "made-up" }, { agent: false },
    { latencyMs: false }, { title: null }, { workspaceTitle: false },
  ])("refuses malformed return input without creating an outbox: %j", async patch => {
    await expect(enqueueNotice(root, { ...record(), ...patch } as ReturnRecord)).rejects.toThrow("invalid Shepherd return")
    expect(readNoticeOutbox(root)).toEqual([])
  })

  it("refuses an object whose custom serializer would replace the validated return", async () => {
    const value = { ...record(), toJSON: () => null }
    await expect(enqueueNotice(root, value)).rejects.toThrow("invalid normalized")
  })

  it("reports filesystem read failures and refuses oversized state or notices", async () => {
    fs.mkdirSync(path.join(shepherdStateDir(root), "notice-outbox.json"), { recursive: true })
    expect(() => readNoticeOutbox(root)).toThrow()
    const oversizedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-notice-large-"))
    fs.mkdirSync(shepherdStateDir(oversizedRoot), { recursive: true })
    fs.writeFileSync(path.join(shepherdStateDir(oversizedRoot), "notice-outbox.json"), " ".repeat(2 * 1024 * 1024 + 1))
    expect(() => readNoticeOutbox(oversizedRoot)).toThrow("2 MiB")
    await expect(enqueueNotice(fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-notice-large-write-")), { ...record(), reason: "x".repeat(2 * 1024 * 1024) })).rejects.toThrow("2 MiB")
  })

  it.each(["", "__proto__", "constructor", "prototype"])("refuses unsafe target keys: %s", async friendId => {
    const id = await enqueueNotice(root, record())
    await expect(declareNoticeTargets(root, [id], [friendId], "now")).rejects.toThrow("invalid notice target")
    await expect(recordNoticeDelivery(root, [id], friendId, { state: "sent", at: "now" })).rejects.toThrow("invalid notice target")
    expect(readNoticeOutbox(root)[0]!.deliveries).toEqual({})
  })

  it("refuses unknown well-formed references and corrupt archived receipts", async () => {
    const id = noticeRecordId(record())
    await expect(recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "now" })).rejects.toThrow("unknown notice")
    const file = path.join(shepherdStateDir(root), "notice-receipts", `${id}.json`)
    fs.mkdirSync(file, { recursive: true })
    await expect(enqueueNotice(root, record())).rejects.toThrow()
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "shepherd-notice-corrupt-archive-"))
    const otherFile = path.join(shepherdStateDir(otherRoot), "notice-receipts", `${id}.json`)
    fs.mkdirSync(path.dirname(otherFile), { recursive: true })
    fs.writeFileSync(otherFile, '{"id":"wrong","record":null,"deliveries":{}}')
    await expect(enqueueNotice(otherRoot, record())).rejects.toThrow("invalid archived")
  })

  it("never reports a new recipient update to an archived notice as applied", async () => {
    const value = record()
    const id = noticeRecordId(value)
    const file = path.join(shepherdStateDir(root), "notice-receipts", `${id}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ id, record: value, deliveries: { owner: { state: "sent", at: "now", attempts: 1 } } }))
    await expect(declareNoticeTargets(root, [id], ["new-target"], "now")).rejects.toThrow("settled")
    await expect(recordNoticeDelivery(root, [id], "new-target", { state: "pending", at: "now" })).rejects.toThrow("settled")
    await expect(claimPendingNotices(root, [id], "new-target", "now")).rejects.toThrow("settled")
    await declareNoticeTargets(root, [id], ["owner"], "later")
    expect(JSON.parse(fs.readFileSync(file, "utf8")).deliveries).not.toHaveProperty("new-target")
  })

  it("does not emit an unapplied late failure over an existing acceptance", async () => {
    const id = await enqueueNotice(root, record())
    await recordNoticeDelivery(root, [id], "owner", { state: "sent", at: "now" })
    const events: LogEvent[] = []
    const unregister = registerGlobalLogSink(event => events.push(event))
    try {
      await recordNoticeDelivery(root, [id], "owner", { state: "unknown", at: "later" })
      expect(events.some(e => e.event === "senses.shepherd_notice_receipt")).toBe(false)
      expect(noticeDeliveryState(readNoticeOutbox(root)[0]!, "owner")).toBe("sent")
    } finally { unregister() }
  })

  it.each([
    null, [], 1, "wrong", { schemaVersion: 1, entries: [null] },
    { schemaVersion: 1, entries: [{ id: 1, record: record(), deliveries: {} }] },
    ...[null, false, [], { state: "bad", at: "now", attempts: 1 }, { state: "sent", at: 1, attempts: 1 },
      { state: "sent", at: "now", attempts: -1 }, { state: "sent", at: "now", attempts: 1, reason: 1 },
      { state: "sent", at: "now", attempts: 1, messageId: 1 }]
      .map(delivery => ({ schemaVersion: 1, entries: [{ id: noticeRecordId(record()), record: record(), deliveries: { owner: delivery } }] })),
    { schemaVersion: 1, entries: [{ id: "wrong", record: record(), deliveries: {} }] },
    { schemaVersion: 1, entries: [{ id: noticeRecordId(record()), record: record(), deliveries: [] }] },
    { schemaVersion: 1, entries: Array(2).fill({ id: noticeRecordId(record()), record: record(), deliveries: {} }) },
  ].map(value => ({ value })))("rejects structurally invalid stored data: %j", ({ value }) => {
    fs.mkdirSync(shepherdStateDir(root), { recursive: true })
    fs.writeFileSync(path.join(shepherdStateDir(root), "notice-outbox.json"), JSON.stringify(value))
    expect(() => readNoticeOutbox(root)).toThrow()
  })

  it.each([
    "{broken", '{"schemaVersion":2,"entries":[]}', '{"schemaVersion":1,"entries":"bad"}',
    '{"schemaVersion":1,"entries":[{"id":"bad","record":{},"deliveries":{}}]}',
  ])("reports corrupt persisted state instead of silently losing notices: %s", value => {
    fs.mkdirSync(shepherdStateDir(root), { recursive: true })
    fs.writeFileSync(path.join(shepherdStateDir(root), "notice-outbox.json"), value)
    expect(() => readNoticeOutbox(root)).toThrow()
  })
})
